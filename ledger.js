/**
 * ledger.js
 * ---------------------------------------------------------------------------
 * Every function here posts a *balanced* group of rows to ledger_entries:
 * the sum of 'debit' amounts always equals the sum of 'credit' amounts in
 * the group. That invariant is what makes the ledger trustworthy - see
 * schema.sql for the accounting model this implements, and the
 * `ledger_is_balanced` view for a standing integrity check.
 *
 * All posting happens inside a single DB transaction per function, so a
 * partial write (e.g. the escrow debit lands but a seller credit fails)
 * can never happen.
 * ---------------------------------------------------------------------------
 */
const { v4: uuidv4 } = require("uuid");
const { query, withTransaction } = require("./pool");
const { rowToCamel, rowsToCamel } = require("./mappers");
const payouts = require("./payouts");

function sellerAccount(sellerId) {
  return `seller:${sellerId}`;
}

async function insertEntry(client, { orderId, lineItemId, account, direction, amount, currency, entryType, reference, description, createdBy }) {
  if (!(amount > 0)) return null; // skip zero-amount legs quietly (e.g. zero-fee orders)
  const { rows } = await client.query(
    `INSERT INTO ledger_entries (
       id, order_id, line_item_id, account, direction, amount, currency,
       entry_type, reference, description, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [uuidv4(), orderId, lineItemId || null, account, direction, amount, currency, entryType, reference || null, description || null, createdBy || null]
  );
  return rowToCamel(rows[0]);
}

/**
 * Post the ledger entries for a confirmed buyer payment (card, bank
 * transfer, or crypto - the payment method doesn't change the accounting,
 * only how the cash arrived).
 *
 *   Debit  platform_escrow       orderTotal
 *   Credit platform_revenue      sum(buyerServiceFee + sellerCommission)
 *   Credit seller:<id>  (x N)    sellerPayout, one per line item
 *
 * These three legs always net to zero (see schema.sql comment for the proof).
 */
async function recordBuyerPayment({ order, method, reference, actorId }) {
  return withTransaction(async (client) => {
    const entries = [];
    entries.push(
      await insertEntry(client, {
        orderId: order.id, account: "platform_escrow", direction: "debit",
        amount: order.orderTotal, currency: order.currency, entryType: "buyer_payment",
        reference, description: `Buyer payment received via ${method} for order ${order.orderNumber}`,
        createdBy: actorId,
      })
    );

    const totalFee = round2(
      order.lineItems.reduce((s, li) => s + Number(li.buyerServiceFee) + Number(li.sellerCommission), 0)
    );
    entries.push(
      await insertEntry(client, {
        orderId: order.id, account: "platform_revenue", direction: "credit",
        amount: totalFee, currency: order.currency, entryType: "platform_fee",
        reference, description: `Platform fee earned on order ${order.orderNumber}`, createdBy: actorId,
      })
    );

    for (const li of order.lineItems) {
      entries.push(
        await insertEntry(client, {
          orderId: order.id, lineItemId: li.id, account: sellerAccount(li.sellerId), direction: "credit",
          amount: li.sellerPayout, currency: order.currency, entryType: "escrow_hold",
          reference, description: `Held for seller on order ${order.orderNumber} (${li.productName})`,
          createdBy: actorId,
        })
      );
    }
    return entries.filter(Boolean);
  });
}

/**
 * Release escrow to each seller on an order (called when the buyer confirms
 * receipt). Posts the offsetting pair per line item and creates a `payouts`
 * row per seller so the operational transfer can be tracked separately from
 * the accounting event.
 *
 *   Debit  seller:<id>       sellerPayout   (what we owed them, now settled)
 *   Credit platform_escrow   sellerPayout   (cash leaving the escrow pool)
 */
async function releasePayouts({ order, actorId }) {
  return withTransaction(async (client) => {
    const created = [];
    for (const li of order.lineItems) {
      const debitEntry = await insertEntry(client, {
        orderId: order.id, lineItemId: li.id, account: sellerAccount(li.sellerId), direction: "debit",
        amount: li.sellerPayout, currency: order.currency, entryType: "seller_payout",
        description: `Payout released for order ${order.orderNumber} (${li.productName})`, createdBy: actorId,
      });
      const creditEntry = await insertEntry(client, {
        orderId: order.id, lineItemId: li.id, account: "platform_escrow", direction: "credit",
        amount: li.sellerPayout, currency: order.currency, entryType: "seller_payout",
        description: `Payout released for order ${order.orderNumber} (${li.productName})`, createdBy: actorId,
      });

      const payout = await payouts.create(client, {
        id: uuidv4(), sellerId: li.sellerId, orderId: order.id, lineItemId: li.id,
        ledgerEntryId: debitEntry.id, amount: li.sellerPayout, currency: order.currency,
        method: "bank_transfer", status: "pending",
      });
      created.push({ debitEntry, creditEntry, payout });
    }
    return created;
  });
}

/**
 * Reverse a payment, in full or in part, before payout was released.
 * Reverses the three original legs proportionally to `amount` /
 * order.orderTotal.
 *
 * CAVEAT: if the order already reached 'completed' (payout already sent to
 * the seller), the escrow_hold legs no longer represent cash the platform
 * is holding - the money already left as a seller payout. Reversing in that
 * case still posts correct ledger entries (so the books stay balanced and
 * auditable) but does NOT claw back funds from the seller automatically;
 * that's a business decision (dispute resolution, chargeback recovery)
 * that needs a human to also collect from or invoice the seller.
 */
async function recordRefund({ order, amount, reason, actorId }) {
  return withTransaction(async (client) => {
    const ratio = amount / order.orderTotal;
    const entries = [];

    entries.push(
      await insertEntry(client, {
        orderId: order.id, account: "platform_escrow", direction: "credit",
        amount, currency: order.currency, entryType: "refund",
        description: `Refund issued for order ${order.orderNumber}${reason ? `: ${reason}` : ""}`,
        createdBy: actorId,
      })
    );

    const totalFee = round2(
      order.lineItems.reduce((s, li) => s + Number(li.buyerServiceFee) + Number(li.sellerCommission), 0)
    );
    const feeReversal = round2(totalFee * ratio);
    entries.push(
      await insertEntry(client, {
        orderId: order.id, account: "platform_revenue", direction: "debit",
        amount: feeReversal, currency: order.currency, entryType: "refund",
        description: `Fee reversed for refunded order ${order.orderNumber}`, createdBy: actorId,
      })
    );

    for (const li of order.lineItems) {
      const reversal = round2(Number(li.sellerPayout) * ratio);
      entries.push(
        await insertEntry(client, {
          orderId: order.id, lineItemId: li.id, account: sellerAccount(li.sellerId), direction: "debit",
          amount: reversal, currency: order.currency, entryType: "refund",
          description: `Escrow reversed for refunded order ${order.orderNumber} (${li.productName})`,
          createdBy: actorId,
        })
      );
    }
    return entries.filter(Boolean);
  });
}

/** Sum(credits) - sum(debits) on an account = what's currently owed/held on that account. */
async function getAccountBalance(account) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0) AS balance
     FROM ledger_entries WHERE account = $1`,
    [account]
  );
  return parseFloat(rows[0].balance);
}

async function getSellerBalance(sellerId) {
  return getAccountBalance(sellerAccount(sellerId));
}

async function getPlatformRevenue() {
  return getAccountBalance("platform_revenue");
}

async function getPlatformEscrowBalance() {
  return getAccountBalance("platform_escrow");
}

async function listForOrder(orderId) {
  const { rows } = await query(
    `SELECT * FROM ledger_entries WHERE order_id = $1 ORDER BY created_at ASC`,
    [orderId]
  );
  return rowsToCamel(rows);
}

async function listAll(limit = 200) {
  const { rows } = await query(`SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rowsToCamel(rows);
}

/** Returns rows from the `ledger_is_balanced` view - an empty array means the books balance. */
async function checkBalanced() {
  const { rows } = await query(`SELECT * FROM ledger_is_balanced`);
  return rowsToCamel(rows);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = {
  recordBuyerPayment, releasePayouts, recordRefund,
  getSellerBalance, getPlatformRevenue, getPlatformEscrowBalance,
  listForOrder, listAll, checkBalanced, sellerAccount,
};
