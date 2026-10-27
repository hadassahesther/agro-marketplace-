const express = require("express");
const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

const CATEGORIES = ["Garri", "Palm Oil", "Crayfish", "Cocoa", "Cashew", "Spices", "Other Products"];

const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads", "products"),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only JPEG, PNG, or WEBP images are allowed."), ok);
  },
});

/**
 * GET /api/products - public catalog, with filters
 * query: ?category=&search=&minPrice=&maxPrice=&sellerId=
 */
router.get("/", async (req, res) => {
  try {
    const products = await db.products.listActive(req.query);
    const enriched = await Promise.all(products.map(attachSellerSummary));
    res.json({ products: enriched, categories: CATEGORIES });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load products." });
  }
});

router.get("/:id", async (req, res) => {
  const product = await db.products.findById(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found." });
  res.json({ product: await attachSellerSummary(product) });
});

/**
 * POST /api/products - create a listing (sellers only)
 */
router.post("/", requireAuth, requireRole("seller"), upload.single("image"), async (req, res) => {
  const { name, description, category, unitPrice, unit, quantityAvailable, originCountry } = req.body;

  if (!name || !description || !category || !unitPrice || !unit || !quantityAvailable || !originCountry) {
    return res.status(400).json({
      error: "name, description, category, unitPrice, unit, quantityAvailable, and originCountry are required.",
    });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
  }

  const product = await db.products.create({
    id: uuidv4(),
    sellerId: req.user.id,
    name,
    description,
    category,
    unitPrice: parseFloat(unitPrice),
    unit,
    quantityAvailable: parseFloat(quantityAvailable),
    originCountry,
    imageUrl: req.file ? `/uploads/products/${req.file.filename}` : null,
    status: "active",
  });
  res.status(201).json({ product });
});

/**
 * PUT /api/products/:id - update a listing (owner only)
 */
router.put("/:id", requireAuth, requireRole("seller"), upload.single("image"), async (req, res) => {
  const product = await db.products.findById(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found." });
  if (product.sellerId !== req.user.id) {
    return res.status(403).json({ error: "You can only edit your own listings." });
  }

  const updates = {};
  const editable = ["name", "description", "category", "unitPrice", "unit", "quantityAvailable", "originCountry", "status"];
  for (const field of editable) {
    if (req.body[field] !== undefined) {
      updates[field] = field === "unitPrice" || field === "quantityAvailable"
        ? parseFloat(req.body[field])
        : req.body[field];
    }
  }
  if (req.file) updates.imageUrl = `/uploads/products/${req.file.filename}`;

  const updated = await db.products.updateById(req.params.id, updates);
  res.json({ product: updated });
});

router.delete("/:id", requireAuth, requireRole("seller"), async (req, res) => {
  const product = await db.products.findById(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found." });
  if (product.sellerId !== req.user.id) {
    return res.status(403).json({ error: "You can only delete your own listings." });
  }
  await db.products.deleteById(req.params.id);
  res.json({ success: true });
});

router.get("/mine/list", requireAuth, requireRole("seller"), async (req, res) => {
  const products = await db.products.findBySeller(req.user.id);
  res.json({ products });
});

async function attachSellerSummary(product) {
  const seller = await db.users.findById(product.sellerId);
  return {
    ...product,
    seller: seller
      ? { id: seller.id, fullName: seller.fullName, country: seller.country, verified: seller.verified }
      : null,
  };
}

module.exports = router;
