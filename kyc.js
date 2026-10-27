const express = require("express");
const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads", "kyc"),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ["image/jpeg", "image/png", "application/pdf"].includes(file.mimetype)),
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await db.users.findById(req.user.id);
  res.json({
    kycStatus: user.kycStatus || "not_submitted",
    documents: user.kycDocuments || [],
    note: user.kycReviewNote || null,
  });
});

router.post(
  "/submit",
  requireAuth,
  requireRole("seller", "buyer"),
  upload.fields([{ name: "identity", maxCount: 1 }, { name: "business", maxCount: 1 }]),
  async (req, res) => {
    const identity = req.files?.identity?.[0];
    if (!identity) return res.status(400).json({ error: "An identity document is required." });

    const docs = [{ type: "identity", url: `/uploads/kyc/${identity.filename}`, originalName: identity.originalname }];
    if (req.files?.business?.[0]) {
      docs.push({
        type: "business",
        url: `/uploads/kyc/${req.files.business[0].filename}`,
        originalName: req.files.business[0].originalname,
      });
    }

    const updated = await db.users.updateById(req.user.id, {
      kycStatus: "pending",
      verified: false,
      kycDocuments: docs,
      businessName: req.body.businessName || null,
      farmLocation: req.body.farmLocation || null,
    });
    res.json({ status: updated.kycStatus, user: db.users.publicUser(updated) });
  }
);

module.exports = router;
