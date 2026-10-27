const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const paymentService = require("../services/paymentService");

const router = express.Router();
const FLW_BASE_URL = "https://api.flutterwave.com/v3";

/**
 * POST /api/payments/initiate - start a Flutterwave hosted checkout for a "card" order.
 */
router.post("/initiate", requireAuth, requireRole("buyer"), async (req, res) => {
  try {
    const order = await db.orders.findById(req.body.orderId);
    if (!order || order.buyerId !== req.user.id) return res.status(404).json({ error: "Order not found." });
    if (order.paymentMethod !== "card") {
      return res.status(400).json({ error: "This order is not set up for card payment." });
    }
    if (order.status !== "pending_payment") {
      return res.status(400).json({ error: `Order is currently '${order.status}', not payable.` });
    }
    if (!process.env.FLW_SECRET_KEY) {
      return res.status(503).json({ error: "Card payments are not configured. Add FLW_SECRET_KEY to backend/.env." });
    }

    const buyer = await db.users.findById(req.user.id);
    const txRef = `${order.orderNumber}-${Date.now()}`;

    const response = await axios.post(
      `${FLW_BASE_URL}/payments`,
      {
        tx_ref: txRef,
        amount: order.orderTotal,
        currency: order.currency,
        redirect_url: `${process.env.FRONTEND_URL}/checkout-complete.html`,
        customer: { email: buyer.email, name: buyer.fullName, phonenumber: buyer.phone || undefined },
        customizations: { title: "Agro Marketplace", description: `Payment for order ${order.orderNumber}` },
        meta: { orderId: order.id },
      },
      { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );

    await db.orders.updateById(order.id, { flwTxRef: txRef });
    res.json({ checkoutUrl: response.data.data.link });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(502).json({ error: "Could not start card payment. Check Flutterwave configuration." });
  }
});

/**
 * POST /api/payments/crypto/create - generate a crypto payment intent
 * (receiving address + expected amount). Does NOT confirm payment - that
 * requires either an admin review of the submitted tx hash, or connecting a
 * real wallet-monitoring / crypto payment processor (see README).
 */
router.post("/crypto/create", requireAuth, requireRole("buyer"), async (req, res) => {
  const order = await db.orders.findById(req.body.orderId);
  if (!order || order.buyerId !== req.user.id) return res.status(404).json({ error: "Order not found." });
  if (order.paymentMethod !== "crypto") return res.status(400).json({ error: "Order is not configured for crypto." });
  if (order.status !== "pending_payment") return res.status(400).json({ error: "Order is not payable." });

  const asset = (req.body.asset || "USDT").toUpperCase();
  const network = (req.body.network || process.env.CRYPTO_DEFAULT_NETWORK || "TRC20").toUpperCase();
  const address = process.env[`CRYPTO_${asset}_${network}_ADDRESS`];
  if (!address) {
    return res.status(503).json({
      error: `No ${asset} ${network} receiving address is configured. Add it to backend/.env or connect a crypto payment provider.`,
    });
  }

  const paymentId = uuidv4();
  const cryptoPayment = { id: paymentId, asset, network, address, expectedAmount: order.orderTotal, status: "awaiting_transfer" };
  const updated = await db.orders.updateById(order.id, { cryptoPayment, paymentReference: paymentId });
  res.json({ payment: cryptoPayment, order: updated });
});

/**
 * POST /api/payments/crypto/confirm - buyer submits the transaction hash
 * once they've sent the transfer. Moves the order to pending_verification;
 * an admin (or a connected wallet-monitoring service) must still confirm it
 * via POST /api/orders/:id/verify-bank-transfer before it counts as paid.
 */
router.post("/crypto/confirm", requireAuth, requireRole("buyer"), async (req, res) => {
  const order = await db.orders.findById(req.body.orderId);
  if (!order || order.buyerId !== req.user.id) return res.status(404).json({ error: "Order not found." });
  if (!order.cryptoPayment) return res.status(400).json({ error: "Create the crypto payment first." });

  const now = new Date().toISOString();
  const updated = await db.orders.updateById(order.id, {
    cryptoPayment: { ...order.cryptoPayment, txHash: req.body.txHash || null, status: "pending_confirmation" },
    status: "pending_verification",
    statusHistory: [...order.statusHistory, { status: "pending_verification", at: now, method: "crypto" }],
  });
  res.json({
    order: updated,
    message: "Transaction submitted for review. An admin or connected crypto provider must verify it before funds are released.",
  });
});

/**
 * GET /api/payments/verify?transaction_id=... - called by the frontend after
 * Flutterwave redirects the buyer back. Always re-checks with Flutterwave's
 * server before trusting it.
 */
router.get("/verify", requireAuth, async (req, res) => {
  try {
    const { transaction_id } = req.query;
    if (!transaction_id) return res.status(400).json({ error: "transaction_id is required." });
    if (!process.env.FLW_SECRET_KEY) return res.status(503).json({ error: "Flutterwave is not configured." });

    const response = await axios.get(`${FLW_BASE_URL}/transactions/${transaction_id}/verify`, {
      headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` },
    });
    const txData = response.data.data;

    const order = await db.orders.findByFlwTxRef(txData.tx_ref);
    if (!order) return res.status(404).json({ error: "Matching order not found." });

    if (txData.status === "successful" && txData.amount >= order.orderTotal && txData.currency === order.currency) {
      const updated = await paymentService.confirmPayment({
        order, method: "card", reference: txData.id, actorId: order.buyerId,
      });
      return res.json({ verified: true, order: updated });
    }
    res.json({ verified: false, order, reason: "Payment could not be confirmed as successful." });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(502).json({ error: "Could not verify payment." });
  }
});

/**
 * POST /api/payments/webhook - Flutterwave server-to-server confirmation.
 * The reliable source of truth (a buyer who closes their browser before the
 * /verify redirect completes would otherwise leave the order unpaid).
 */
router.post("/webhook", express.json(), async (req, res) => {
  const signature = req.headers["verif-hash"];
  if (!signature || signature !== process.env.FLW_WEBHOOK_HASH) {
    return res.status(401).end();
  }

  try {
    const event = req.body;
    if (event.event === "charge.completed" && event.data.status === "successful") {
      const order = await db.orders.findByFlwTxRef(event.data.tx_ref);
      if (order && order.status === "pending_payment") {
        await paymentService.confirmPayment({
          order, method: "card", reference: event.data.id, actorId: order.buyerId,
        });
      }
    }
    res.status(200).end();
  } catch (err) {
    console.error("Webhook processing error:", err.message);
    res.status(200).end(); // still acknowledge so Flutterwave doesn't retry forever on our bug
  }
});

module.exports = router;
