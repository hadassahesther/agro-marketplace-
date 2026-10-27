/**
 * Run with: npm run seed-admin
 * Creates the first admin account from ADMIN_EMAIL / ADMIN_PASSWORD in .env.
 * Refuses to run if an admin already exists (use the admin dashboard or the
 * database directly to create additional admins after that).
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");

async function run() {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first.");
  }
  if (process.env.ADMIN_PASSWORD.length < 12) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
  }

  const existing = await db.users.findAdmin();
  if (existing) {
    console.log(`Admin already exists: ${existing.email}`);
    return;
  }

  const user = await db.users.create({
    id: uuidv4(),
    fullName: "Platform Admin",
    email: process.env.ADMIN_EMAIL.toLowerCase(),
    passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
    role: "admin",
    country: "Nigeria",
    verified: true,
    emailVerified: true,
    kycStatus: "approved",
  });
  console.log(`Admin created: ${user.email}`);
}

// Run, then always close the pool before exiting - otherwise the open
// Postgres connection keeps the Node process alive indefinitely instead of
// returning to the terminal.
run()
  .then(() => { process.exitCode = 0; })
  .catch((err) => {
    console.error("Failed to seed admin:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.pool.end();
    } catch (_) {
      /* already closed or never opened - fine */
    }
  });
