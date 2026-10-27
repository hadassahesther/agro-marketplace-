/**
 * Run with: npm run migrate
 * Applies schema.sql to whatever database DATABASE_URL points at.
 * Safe to run multiple times - every statement in schema.sql uses
 * CREATE ... IF NOT EXISTS / CREATE OR REPLACE VIEW.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

async function migrate() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");

  console.log("Applying schema.sql ...");
  await pool.query(sql);
  console.log("Migration complete.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
