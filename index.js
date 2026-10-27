/**
 * backend/db/index.js
 * ---------------------------------------------------------------------------
 * PostgreSQL-backed replacement for the old backend/db.js JSON-file store.
 * Routes that used to `require("../db")` now get this module instead - same
 * import path, since Node resolves `../db` to this directory's index.js.
 *
 * Each entity gets its own query module (users.js, products.js, orders.js,
 * ledger.js, payouts.js, disputes.js, quotes.js, messages.js,
 * notifications.js) rather than one generic table interface, because a
 * relational store needs real queries (joins, transactions, atomic stock
 * reservation) that a generic findOne(table, predicate) API can't express
 * safely. See db/schema.sql for the table design and db/ledger.js for the
 * payment ledger this upgrade adds.
 * ---------------------------------------------------------------------------
 */
const { pool, query, withTransaction } = require("./pool");

module.exports = {
  pool,
  query,
  withTransaction,
  users: require("./users"),
  products: require("./products"),
  orders: require("./orders"),
  ledger: require("./ledger"),
  payouts: require("./payouts"),
  disputes: require("./disputes"),
  quotes: require("./quotes"),
  messages: require("./messages"),
  notifications: require("./notifications"),
};
