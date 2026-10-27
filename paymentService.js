/**
 * Centralizes the three money-moving operations that touch the ledger, so
 * routes/orders.js, routes/admin.js, and routes/payments.js all go through
 * the same code path instead of each posting ledger entries themselves.
 * That's what keeps the "only post once" guarantee simple: each function
 * here checks the order is in the expected status before doing anything,
 * and the status change is what prevents a second call from double-posting.
 */
const db = require("../db");

async function safeNotify(notification) {
  try {
    await db.notifications.create(notification);
  } catch (err) {
    // Notifications are best-effort - never let a notification failure
    // break a payment flow.
    console.error("Failed to create notification:", err.message);
  }
}

/**
 * Confirm a buyer's payment landed (card verified via Flutterwave, or an
 * admin confirming a bank transfer / crypto transaction). Posts the ledger
 * entries, moves the order to 'paid', and notifies the seller(s).
 */
async function confirmPayment({ order, method, reference, actorId }) {
  if (!["pending_payment", "pending_verification"].includes(order.status)) {
    throw new Error(`Order is currently '${order.status}', not awaiting payment confirmation.`);
  }

  await db.ledger.recordBuyerPayment({ order, method, reference, actorId });

  const now = new Date().toISOString();
  const statusHistory = [...order.statusHistory, { status: "paid", at: now, method }];
  const updates = { status: "paid", statusHistory };
  if (method === "bank_transfer") {
    updates.paymentVerifiedBy = actorId;
    updates.paymentVerifiedAt = now;
  }
  if (method === "card" && reference) updates.flwTransactionId = String(reference);

  const updated = await db.orders.updateById(order.id, updates);

  const sellerIds = [...new Set(order.lineItems.map((li) => li.sellerId))];
  for (const sellerId of sellerIds) {
    await safeNotify({
      userId: sellerId,
      type: "order_paid",
      payload: { orderId: order.id, orderNumber: order.orderNumber },
    });
  }
  return updated;
}

/**
 * Release escrow to every seller on an order (buyer confirmed receipt).
 * Posts the offsetting ledger entries and creates a `payouts` row per
 * seller for operational tracking (see db/payouts.js).
 */
async function releasePayouts({ order, actorId }) {
  if (order.status !== "shipped") {
    throw new Error("Order must be marked shipped before receipt can be confirmed.");
  }

  await db.ledger.releasePayouts({ order, actorId });

  const now = new Date().toISOString();
  const statusHistory = [...order.statusHistory, { status: "completed", at: now }];
  const updated = await db.orders.updateById(order.id, { status: "completed", statusHistory });

  const sellerIds = [...new Set(order.lineItems.map((li) => li.sellerId))];
  for (const sellerId of sellerIds) {
    await safeNotify({
      userId: sellerId,
      type: "payout_released",
      payload: { orderId: order.id, orderNumber: order.orderNumber },
    });
  }
  return updated;
}

/**
 * Record a refund (full or partial) against an order. This posts the
 * accounting entries and marks the order's refund status; it does NOT
 * itself call out to a payment provider's refund API - see db/ledger.js
 * for the caveat about orders that already had payouts released.
 */
async function refundOrder({ order, amount, reason, actorId }) {
  if (amount <= 0 || amount > order.orderTotal) {
    throw new Error(`Refund amount must be between 0 and the order total (${order.orderTotal}).`);
  }
  await db.ledger.recordRefund({ order, amount, reason, actorId });

  const refundStatus = amount >= order.orderTotal ? "full_pending" : "partial_pending";
  const updated = await db.orders.updateById(order.id, { refundStatus, refundAmount: amount });

  await safeNotify({
    userId: order.buyerId,
    type: "refund_recorded",
    payload: { orderId: order.id, orderNumber: order.orderNumber, amount },
  });
  return updated;
}

module.exports = { confirmPayment, releasePayouts, refundOrder, safeNotify };
