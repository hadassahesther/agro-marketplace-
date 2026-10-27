const { query } = require("./pool");
const { rowToCamel, rowsToCamel, buildSetClause } = require("./mappers");

const UPDATABLE_FIELDS = [
  "fullName", "email", "passwordHash", "country", "phone", "verified", "emailVerified",
  "kycStatus", "kycDocuments", "kycReviewNote", "kycReviewedAt", "kycReviewedBy",
  "businessName", "farmLocation", "bankDetails", "resetToken", "resetTokenExpiresAt",
];

async function create(user) {
  const { rows } = await query(
    `INSERT INTO users (
       id, full_name, email, password_hash, role, country, phone,
       verified, email_verified, kyc_status, business_name, farm_location
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      user.id, user.fullName, user.email, user.passwordHash, user.role, user.country,
      user.phone || null, user.verified || false, user.emailVerified || false,
      user.kycStatus || "not_submitted", user.businessName || null, user.farmLocation || null,
    ]
  );
  return rowToCamel(rows[0]);
}

async function findById(id) {
  const { rows } = await query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rowToCamel(rows[0]);
}

async function findByEmail(email) {
  const { rows } = await query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
  return rowToCamel(rows[0]);
}

async function findByResetToken(token) {
  const { rows } = await query(
    `SELECT * FROM users WHERE reset_token = $1 AND reset_token_expires_at > now()`,
    [token]
  );
  return rowToCamel(rows[0]);
}

async function findAdmin() {
  const { rows } = await query(`SELECT * FROM users WHERE role = 'admin' LIMIT 1`);
  return rowToCamel(rows[0]);
}

async function list() {
  const { rows } = await query(`SELECT * FROM users ORDER BY created_at DESC`);
  return rowsToCamel(rows);
}

// node-postgres serializes plain JS objects to JSON automatically for JSONB
// columns, but it serializes JS *arrays* using Postgres array syntax
// instead (a footgun for jsonb array columns) - so array-valued fields need
// an explicit JSON.stringify before they reach the query. kycDocuments is
// the only array-typed field on users; bankDetails is a plain object and
// doesn't need this.
const JSONB_ARRAY_FIELDS = new Set(["kycDocuments"]);

async function updateById(id, updates) {
  const prepared = { ...updates };
  for (const field of JSONB_ARRAY_FIELDS) {
    if (prepared[field] !== undefined) prepared[field] = JSON.stringify(prepared[field]);
  }
  const { setParts, values } = buildSetClause(prepared, UPDATABLE_FIELDS, 1);
  if (setParts.length === 0) return findById(id);
  values.push(id);
  const { rows } = await query(
    `UPDATE users SET ${setParts.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
    values
  );
  return rowToCamel(rows[0]);
}

/** Strip fields that should never leave the server in an API response. */
function publicUser(user) {
  if (!user) return user;
  const { passwordHash, resetToken, resetTokenExpiresAt, ...safe } = user;
  return safe;
}

module.exports = { create, findById, findByEmail, findByResetToken, findAdmin, list, updateById, publicUser };
