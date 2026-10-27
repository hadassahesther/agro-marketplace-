const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const VALID_ROLES = ["seller", "buyer"]; // admin accounts are created via seed.js / admin routes only

router.post("/register", async (req, res) => {
  try {
    const { fullName, email, password, role, country, phone } = req.body;
    if (!fullName || !email || !password || !role || !country) {
      return res.status(400).json({
        error: "fullName, email, password, role, and country are required.",
      });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(", ")}` });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const normalized = email.toLowerCase().trim();
    const existing = await db.users.findByEmail(normalized);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const user = await db.users.create({
      id: uuidv4(),
      fullName: fullName.trim(),
      email: normalized,
      passwordHash: await bcrypt.hash(password, 12),
      role,
      country,
      phone: phone || null,
    });

    res.status(201).json({
      token: signToken(user),
      user: db.users.publicUser(user),
      message: "Account created. Complete email/KYC verification before production payouts.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const password = String(req.body.password || "");

    const user = await db.users.findByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    res.json({ token: signToken(user), user: db.users.publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await db.users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json({ user: db.users.publicUser(user) });
});

router.put("/bank-details", requireAuth, async (req, res) => {
  const { accountName, accountNumber, bankName, country, swiftCode } = req.body;
  if (!accountName || !accountNumber || !bankName || !country) {
    return res.status(400).json({
      error: "accountName, accountNumber, bankName, and country are required.",
    });
  }
  const updated = await db.users.updateById(req.user.id, {
    bankDetails: { accountName, accountNumber, bankName, country, swiftCode: swiftCode || null },
  });
  res.json({ user: db.users.publicUser(updated) });
});

router.post("/forgot-password", async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  const user = await db.users.findByEmail(email);
  if (user) {
    const token = crypto.randomBytes(32).toString("hex");
    await db.users.updateById(user.id, {
      resetToken: token,
      resetTokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    // NOTE: the reset link/token needs to actually be emailed to the user -
    // connect an email provider (Postmark, SES, etc.) before production.
  }
  // Always return the same response whether or not the email exists, so
  // this endpoint can't be used to enumerate registered emails.
  res.json({
    message: "If that email exists, a password reset can be completed using the secure reset flow. Configure email delivery before production.",
  });
});

router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8) {
    return res.status(400).json({ error: "Valid token and password of at least 8 characters are required." });
  }
  const user = await db.users.findByResetToken(token);
  if (!user) return res.status(400).json({ error: "Invalid or expired reset token." });

  const updated = await db.users.updateById(user.id, {
    passwordHash: await bcrypt.hash(password, 12),
    resetToken: null,
    resetTokenExpiresAt: null,
  });
  res.json({ success: true, user: db.users.publicUser(updated) });
});

function signToken(user) {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not configured");
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, fullName: user.fullName },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

module.exports = router;
