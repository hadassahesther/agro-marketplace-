const { query } = require("./pool");
const { rowToCamel, rowsToCamel } = require("./mappers");

/**
 * Insert a payout row. Pass a transaction `client` when calling this from
 * inside ledger.releasePayouts() so the payout row commits atomically with
 * the ledger entries that back it. Pass the shared pool for standalone
 * calls (e.g. seeding, tests).
 */
async function create(client, d) {
  const runner = client || { query };
  const { rows } = await runner.query(
    `INSERT INTO payouts (
       id, seller_id, order_id, line_item_id, ledger_entry_id, amount, currency, method, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      d.id, d.sellerId, d.orderId || null, d.lineItemId || null, d.ledgerEntryId || null,
      d.amount, d.currency || "USD", d.method || "bank_transfer", d.status || "pending",
    ]
  );
  return rowToCamel(rows[0]);
}

async function findBySeller(sellerId) {
  const { rows } = await query(
    `SELECT * FROM payouts WHERE seller_id = $1 ORDER BY requested_at DESC`,
    [sellerId]
  );
  return rowsToCamel(rows);
}

async function listAll() {
  const { rows } = await query(`SELECT * FROM payouts ORDER BY requested_at DESC`);
  return rowsToCamel(rows);
}

async function updateStatus(id, status, { providerReference, failureReason } = {}) {
  const { rows } = await query(
    `UPDATE payouts
     SET status = $2, provider_reference = COALESCE($3, provider_reference),
         failure_reason = $4, processed_at = CASE WHEN $2 IN ('paid','failed','reversed') THEN now() ELSE processed_at END
     WHERE id = $1
     RETURNING *`,
    [id, status, providerReference || null, failureReason || null]
  );
  return rowToCamel(rows[0]);
}

module.exports = { create, findBySeller, listAll, updateStatus };
