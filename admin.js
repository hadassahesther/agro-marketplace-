const express = require("express");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const paymentService = require("../services/paymentService");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

/**
 * GET /api/admin/overview - headline counts plus a ledger-backed financial
 * summary (platform revenue earned, cash currently held in escrow, and
 * whether the books balance - see db/ledger.js).
 */
router.get("/overview", async (req, res) => {
  const [users, products, orders, disputesOpen, quotes, payouts, platformRevenue, escrowBalance, imbalances] =
    await Promise.all([
      db.users.list(),
      db.products.listAll(),
      db.orders.listAll(),
      db.disputes.countOpen(),
      db.quotes.listAll(),
      db.payouts.listAll(),
      db.ledger.getPlatformRevenue(),
      db.ledger.getPlatformEscrowBalance(),
      db.ledger.checkBalanced(),
    ]);

  res.json({
    counts: {
      users: users.length,
      sellers: users.filter((u) => u.role === "seller").length,
      buyers: users.filter((u) => u.role === "buyer").length,
      pendingKyc: users.filter((u) => u.role === "seller" && u.kycStatus === "pending").length,
      products: products.length,
      orders: orders.length,
      pendingPayments: orders.filter((o) => ["pending_payment", "pending_verification"].includes(o.status)).length,
      disputes: disputesOpen,
      quotes: quotes.filter((q) => q.status === "open").length,
      payoutsPending: payouts.filter((p) => ["pending", "processing"].includes(p.status)).length,
    },
    ledger: {
      platformRevenue,
      platformEscrowBalance: escrowBalance,
      isBalanced: imbalances.length === 0,
      imbalances, // non-empty here would mean a bug - the books should always net to zero per currency
    },
    recentOrders: orders.slice(0, 10),
  });
});

router.get("/users", async (req, res) => {
  const users = await db.users.list();
  res.json({ users: users.map(db.users.publicUser) });
});

router.put("/users/:id/verify", async (req, res) => {
  const user = await db.users.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });
  const updated = await db.users.updateById(user.id, {
    verified: true,
    kycStatus: "approved",
    kycReviewedAt: new Date().toISOString(),
    kycReviewedBy: req.user.id,
  });
  res.json({ user: db.users.publicUser(updated) });
});

router.put("/users/:id/reject-kyc", async (req, res) => {
  const user = await db.users.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });
  const updated = await db.users.updateById(user.id, {
    verified: false,
    kycStatus: "rejected",
    kycReviewNote: String(req.body.note || "KYC requires correction.").slice(0, 1000),
    kycReviewedAt: new Date().toISOString(),
    kycReviewedBy: req.user.id,
  });
  res.json({ user: db.users.publicUser(updated) });
});

router.get("/orders", async (req, res) => {
  const orders = await db.orders.listAll();
  res.json({ orders });
});

/** Same action as POST /api/orders/:id/verify-bank-transfer - see paymentService.confirmPayment. */
router.post("/orders/:id/verify-bank-transfer", async (req, res) => {
  const order = await db.orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  try {
    const updated = await paymentService.confirmPayment({
      order, method: order.paymentMethod === "crypto" ? "crypto" : "bank_transfer", actorId: req.user.id,
    });
    res.json({ order: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/admin/orders/:id/refund - records a refund against the ledger.
 * Does not itself call a payment provider's refund API (see paymentService.refundOrder).
 */
router.post("/orders/:id/refund", async (req, res) => {
  const order = await db.orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  const amount = Math.min(Number(req.body.amount || order.orderTotal), order.orderTotal);
  try {
    const updated = await paymentService.refundOrder({ order, amount, reason: req.body.reason, actorId: req.user.id });
    res.json({
      order: updated,
      message: "Refund recorded in the ledger. Connect your payment provider's refund API to execute the actual transfer.",
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/orders/:id/resolve-dispute", async (req, res) => {
  const order = await db.orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  const resolution = String(req.body.resolution || "").slice(0, 1000);
  if (!resolution) return res.status(400).json({ error: "resolution is required." });

  const updated = await db.orders.updateById(order.id, {
    disputeResolution: resolution,
    disputeResolvedAt: new Date().toISOString(),
    disputeResolvedBy: req.user.id,
    status: req.body.status || "completed",
  });
  await db.disputes.resolveAllForOrder(order.id, { resolution, resolvedBy: req.user.id });
  res.json({ order: updated });
});

router.get("/quotes", async (req, res) => {
  res.json({ quotes: await db.quotes.listAll() });
});

/** The payment ledger - see db/ledger.js. Replaces the old flat "transactions" list. */
router.get("/ledger", async (req, res) => {
  res.json({ entries: await db.ledger.listAll() });
});

/** Standing integrity check: an empty array means the books balance. */
router.get("/ledger/balance-check", async (req, res) => {
  res.json({ imbalances: await db.ledger.checkBalanced() });
});

/**
 * GET /api/admin/payouts - the operational payout queue: money the ledger
 * says is owed to sellers, and whether it's actually been sent yet.
 */
router.get("/payouts", async (req, res) => {
  res.json({ payouts: await db.payouts.listAll() });
});

/**
 * PUT /api/admin/payouts/:id/status - mark a payout as processing/paid/failed
 * once you've actually sent (or attempted to send) the transfer via your
 * bank/payment provider. This does NOT execute the transfer itself - connect
 * a payout API (Flutterwave Transfers, Wise, etc.) to automate that.
 * body: { status: 'processing'|'paid'|'failed'|'reversed', providerReference?, failureReason? }
 */
router.put("/payouts/:id/status", async (req, res) => {
  const { status, providerReference, failureReason } = req.body;
  if (!["processing", "paid", "failed", "reversed"].includes(status)) {
    return res.status(400).json({ error: "status must be one of: processing, paid, failed, reversed." });
  }
  const payout = await db.payouts.updateStatus(req.params.id, status, { providerReference, failureReason });
  if (!payout) return res.status(404).json({ error: "Payout not found." });
  res.json({ payout });
});

router.post("/seed-admin", async (req, res) => {
  const existingAdmin = await db.users.findAdmin();
  if (existingAdmin) return res.status(409).json({ error: "An admin already exists." });

  const email = String(req.body.email || process.env.ADMIN_EMAIL || "").toLowerCase();
  const password = String(req.body.password || process.env.ADMIN_PASSWORD || "");
  if (!email || password.length < 12) {
    return res.status(400).json({ error: "Provide an admin email and a password of at least 12 characters." });
  }

  const user = await db.users.create({
    id: uuidv4(),
    fullName: req.body.fullName || "Platform Admin",
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: "admin",
    country: "Nigeria",
    verified: true,
    kycStatus: "approved",
  });
  res.status(201).json({ user: db.users.publicUser(user) });
});

module.exports = router;
