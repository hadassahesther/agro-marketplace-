const express = require("express");
const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { calculateOrderBreakdown } = require("../utils/commission");
const paymentService = require("../services/paymentService");

const router = express.Router();

/**
 * ORDER STATUS LIFECYCLE (escrow-style - platform "holds" the money until
 * the buyer confirms the shipment arrived, then releases payout to seller):
 *
 *  pending_payment      -> order created, waiting for buyer to pay
 *  pending_verification -> buyer chose bank transfer/crypto, proof submitted, awaiting admin confirmation
 *  paid                 -> payment confirmed - ledger posted, funds held in platform_escrow, seller should ship
 *  shipped               -> seller marked it shipped, buyer should confirm on arrival
 *  completed             -> buyer confirmed receipt -> ledger releases seller payout(s)
 *  disputed               -> buyer or seller raised an issue -> needs admin resolution
 *  cancelled              -> order cancelled before payment
 *
 * The money-moving transitions (paid, completed, and refunds) all go
 * through services/paymentService.js so the ledger is only ever posted
 * from one place - see that file for why.
 */

const proofStorage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads", "payment-proofs"),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const uploadProof = multer({ storage: proofStorage, limits: { fileSize: 5 * 1024 * 1024 } });

/**
 * POST /api/orders - create an order from cart items (buyers only)
 * body: { items: [{ productId, quantity }], shippingAddress, paymentMethod: "card" | "bank_transfer" | "crypto" }
 */
router.post("/", requireAuth, requireRole("buyer"), async (req, res) => {
  const { items, shippingAddress, paymentMethod } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items (array of { productId, quantity }) is required." });
  }
  if (!shippingAddress || !shippingAddress.country) {
    return res.status(400).json({ error: "shippingAddress with at least a country is required." });
  }
  if (!["card", "bank_transfer", "crypto"].includes(paymentMethod)) {
    return res.status(400).json({ error: "paymentMethod must be 'card', 'bank_transfer', or 'crypto'." });
  }

  try {
    const lineItems = [];
    for (const item of items) {
      const product = await db.products.findById(item.productId);
      if (!product) return res.status(404).json({ error: `Product ${item.productId} not found.` });
      if (product.status !== "active") {
        return res.status(400).json({ error: `${product.name} is not currently available.` });
      }
      if (item.quantity > product.quantityAvailable) {
        return res.status(400).json({
          error: `Only ${product.quantityAvailable} ${product.unit} of ${product.name} available.`,
        });
      }
      const breakdown = calculateOrderBreakdown(product.unitPrice, item.quantity);
      lineItems.push({
        id: uuidv4(),
        productId: product.id,
        productName: product.name,
        sellerId: product.sellerId,
        unitPrice: product.unitPrice,
        unit: product.unit,
        quantity: item.quantity,
        ...breakdown,
      });
    }

    // createWithLineItems re-checks and reserves stock atomically inside a
    // DB transaction - the checks above give a fast, friendly error message,
    // but this is what actually prevents overselling under concurrent load.
    const order = await db.orders.createWithLineItems({
      id: uuidv4(),
      buyerId: req.user.id,
      shippingAddress,
      paymentMethod,
      currency: "USD",
      lineItems,
    });

    res.status(201).json({ order });
  } catch (err) {
    if (err instanceof db.orders.InsufficientStockError) {
      return res.status(409).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Could not create the order. Please try again." });
  }
});

router.get("/mine", requireAuth, requireRole("buyer"), async (req, res) => {
  const orders = await db.orders.findByBuyer(req.user.id);
  res.json({ orders });
});

router.get("/selling", requireAuth, requireRole("seller"), async (req, res) => {
  const orders = await db.orders.findBySeller(req.user.id);
  res.json({ orders });
});

router.get("/:id", requireAuth, async (req, res) => {
  const order = await db.orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });

  const isBuyer = order.buyerId === req.user.id;
  const isSeller = order.lineItems.some((li) => li.sellerId === req.user.id);
  const isAdmin = req.user.role === "admin";
  if (!isBuyer && !isSeller && !isAdmin) {
    return res.status(403).json({ error: "You do not have access to this order." });
  }
  res.json({ order });
});

/**
 * POST /api/orders/:id/upload-payment-proof - for bank_transfer orders
 */
router.post(
  "/:id/upload-payment-proof",
  requireAuth,
  requireRole("buyer"),
  uploadProof.single("proof"),
  async (req, res) => {
    const order = await db.orders.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    if (order.buyerId !== req.user.id) {
      return res.status(403).json({ error: "You can only upload proof for your own orders." });
    }
    if (order.paymentMethod !== "bank_transfer") {
      return res.status(400).json({ error: "This order was not set up for bank transfer." });
    }
    if (!req.file) return res.status(400).json({ error: "A proof file is required." });

    const now = new Date().toISOString();
    const updated = await db.orders.updateById(order.id, {
      paymentProofUrl: `/uploads/payment-proofs/${req.file.filename}`,
      status: "pending_verification",
      statusHistory: [...order.statusHistory, { status: "pending_verification", at: now }],
    });
    res.json({ order: updated });
  }
);

/**
 * POST /api/orders/:id/verify-bank-transfer - admin confirms funds received.
 * (routes/admin.js exposes the same action under /api/admin/orders/:id/verify-bank-transfer;
 * both call paymentService.confirmPayment, so a payment is only ever posted to the ledger once.)
 */
router.post("/:id/verify-bank-transfer", requireAuth, requireRole("admin"), async (req, res) => {
  const order = await db.orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  try {
    const updated = await paymentService.confirmPayment({ order, method: "bank_transfer", actorId: req.user.id });
    res.json({ order: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/:id/ship", requireAuth, requireRole("seller"), async (req, res) => {
  const order = await db.orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  const isSeller = order.lineItems.some((li) => li.sellerId === req.user.id);
  if (!isSeller) return res.status(403).json({ error: "You are not a seller on this order." });
  if (order.status !== "paid") {
    return res.status(400).json({ error: "Order must be paid before it can be marked as shipped." });
  }

  const { carrier, trackingNumber, notes } = req.body;
  const now = new Date().toISOString();
  const updated = await db.orders.updateById(order.id, {
    status: "shipped",
    trackingInfo: { carrier: carrier || null, trackingNumber: trackingNumber || null, notes: notes || null },
    statusHistory: [...order.statusHistory, { status: "shipped", at: now }],
  });
  await paymentService.safeNotify({
    userId: order.buyerId,
    type: "order_shipped",
    payload: { orderId: order.id, orderNumber: order.orderNumber },
  });
  res.json({ order: updated });
});

/**
 * PUT /api/orders/:id/confirm-receipt - buyer confirms goods arrived
 * -> releases seller payout(s) via the ledger (see paymentService.releasePayouts)
 */
router.put("/:id/confirm-receipt", requireAuth, requireRole("buyer"), async (req, res) => {
  const order = await db.orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.buyerId !== req.user.id) {
    return res.status(403).json({ error: "You can only confirm your own orders." });
  }
  try {
    const updated = await paymentService.releasePayouts({ order, actorId: req.user.id });
    res.json({ order: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/:id/dispute", requireAuth, async (req, res) => {
  const order = await db.orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  const isBuyer = order.buyerId === req.user.id;
  const isSeller = order.lineItems.some((li) => li.sellerId === req.user.id);
  if (!isBuyer && !isSeller) return res.status(403).json({ error: "You do not have access to this order." });

  const { reason } = req.body;
  const now = new Date().toISOString();
  const updated = await db.orders.updateById(order.id, {
    status: "disputed",
    disputeReason: reason || null,
    disputeRaisedBy: req.user.id,
    statusHistory: [...order.statusHistory, { status: "disputed", at: now, by: req.user.id }],
  });
  await db.disputes.create({ id: uuidv4(), orderId: order.id, openedBy: req.user.id, reason: reason || null });
  res.json({ order: updated });
});

module.exports = { router };
