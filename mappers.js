/**
 * Postgres columns are snake_case; every existing route, and the whole
 * frontend, was written against camelCase JSON (sellerId, unitPrice, ...).
 * Rather than touch every call site, these helpers convert at the query
 * boundary so the rest of the app is unaffected by the storage change.
 */

function toCamel(str) {
  return str.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}
function toSnake(str) {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function rowToCamel(row) {
  if (row === null || row === undefined) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[toCamel(key)] = value;
  }
  return out;
}

function rowsToCamel(rows) {
  return rows.map(rowToCamel);
}

/**
 * Build a `col1 = $1, col2 = $2, ...` SET clause (and matching values array)
 * from a camelCase updates object, restricted to an allow-list of columns.
 * Prevents callers from ever writing to a column that wasn't explicitly
 * whitelisted by the route, and prevents SQL injection via key names.
 */
function buildSetClause(updates, allowedCamelColumns, startIndex = 1) {
  const setParts = [];
  const values = [];
  let i = startIndex;
  for (const key of Object.keys(updates)) {
    if (!allowedCamelColumns.includes(key)) continue;
    setParts.push(`${toSnake(key)} = $${i}`);
    values.push(updates[key]);
    i += 1;
  }
  return { setParts, values, nextIndex: i };
}

module.exports = { toCamel, toSnake, rowToCamel, rowsToCamel, buildSetClause };
