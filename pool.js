const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Copy backend/.env.example to backend/.env and point it at your Postgres instance."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most managed Postgres providers (Render, Railway, RDS, Supabase, etc.)
  // require SSL and present a certificate that isn't in Node's default CA
  // store. Set PGSSL=true in .env for those; leave unset for local Postgres.
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  // Fired on idle client errors (e.g. the connection was dropped) - log
  // rather than crash the whole process.
  console.error("Unexpected Postgres pool error:", err);
});

/**
 * Run a query with the pool directly (auto-checkout/release a connection).
 * Use this for simple, single-statement queries.
 */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run a function with a single dedicated client inside a transaction.
 * Use this whenever more than one write must succeed or fail together —
 * e.g. posting several ledger entries for one payment event.
 *
 * Usage:
 *   await withTransaction(async (client) => {
 *     await client.query('UPDATE ...');
 *     await client.query('INSERT ...');
 *   });
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
