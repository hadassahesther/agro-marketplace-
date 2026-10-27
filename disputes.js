const { query } = require("./pool");
const { rowToCamel, rowsToCamel } = require("./mappers");

async function create({ id, orderId, openedBy, reason }) {
  const { rows } = await query(
    `INSERT INTO disputes (id, order_id, opened_by, reason, status)
     VALUES ($1,$2,$3,$4,'open') RETURNING *`,
    [id, orderId, openedBy, reason || null]
  );
  return rowToCamel(rows[0]);
}

async function findByOrder(orderId) {
  const { rows } = await query(`SELECT * FROM disputes WHERE order_id = $1 ORDER BY created_at DESC`, [orderId]);
  return rowsToCamel(rows);
}

async function countOpen() {
  const { rows } = await query(`SELECT COUNT(*)::int AS count FROM disputes WHERE status = 'open'`);
  return rows[0].count;
}

/** Mark every open dispute on an order as resolved (an order usually has just one, but this is safe either way). */
async function resolveAllForOrder(orderId, { resolution, resolvedBy }) {
  const { rows } = await query(
    `UPDATE disputes
     SET status = 'resolved', resolution = $2, resolved_at = now(), resolved_by = $3
     WHERE order_id = $1 AND status = 'open'
     RETURNING *`,
    [orderId, resolution, resolvedBy]
  );
  return rowsToCamel(rows);
}

module.exports = { create, findByOrder, countOpen, resolveAllForOrder };
