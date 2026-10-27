const express = require("express");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.post("/", requireAuth, requireRole("buyer"), async (req, res) => {
  const { productId, quantity, destinationCountry, destinationCity, packaging, frequency, message } = req.body;
  if (!productId || !quantity || !destinationCountry) {
    return res.status(400).json({ error: "productId, quantity and destinationCountry are required." });
  }
  const product = await db.products.findById(productId);
  if (!product) return res.status(404).json({ error: "Product not found." });

  const quote = await db.quotes.create({
    id: uuidv4(),
    quoteNumber: `Q-${Date.now().toString().slice(-8)}`,
    buyerId: req.user.id,
    sellerId: product.sellerId,
    productId,
    productName: product.name,
    quantity: Number(quantity),
    destinationCountry,
    destinationCity: destinationCity || null,
    packaging: packaging || null,
    frequency: frequency || "one_time",
    message: message || null,
  });
  res.status(201).json({ quote });
});

router.get("/mine", requireAuth, async (req, res) => {
  const quotes = await db.quotes.findForUser(req.user.id);
  res.json({ quotes });
});

router.post("/:id/offer", requireAuth, requireRole("seller"), async (req, res) => {
  const quote = await db.quotes.findById(req.params.id);
  if (!quote || quote.sellerId !== req.user.id) return res.status(404).json({ error: "Quote not found." });

  const price = Number(req.body.unitPrice);
  if (!(price > 0)) return res.status(400).json({ error: "unitPrice must be greater than zero." });

  const updated = await db.quotes.addOffer(quote.id, {
    id: uuidv4(),
    unitPrice: price,
    currency: "USD",
    shippingPrice: Number(req.body.shippingPrice || 0),
    validUntil: req.body.validUntil || null,
    message: req.body.message || null,
  });
  res.json({ quote: updated });
});

router.put("/:id/status", requireAuth, async (req, res) => {
  const quote = await db.quotes.findById(req.params.id);
  if (!quote || (quote.buyerId !== req.user.id && quote.sellerId !== req.user.id)) {
    return res.status(404).json({ error: "Quote not found." });
  }
  const allowed = ["open", "offered", "accepted", "declined", "closed"];
  if (!allowed.includes(req.body.status)) {
    return res.status(400).json({ error: `status must be one of ${allowed.join(", ")}` });
  }
  res.json({ quote: await db.quotes.updateStatus(quote.id, req.body.status) });
});

module.exports = router;
