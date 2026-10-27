require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/products");
const { router: orderRoutes } = require("./routes/orders");
const paymentRoutes = require("./routes/payments");
const adminRoutes = require("./routes/admin");
const quoteRoutes = require("./routes/quotes");
const kycRoutes = require("./routes/kyc");
const messageRoutes = require("./routes/messages");
const notificationRoutes = require("./routes/notifications");
const { rateLimit } = require("./middleware/security");

const app = express();
const PORT = process.env.PORT || 4000;

// Make sure upload folders exist
["uploads/products", "uploads/payment-proofs", "uploads/kyc"].forEach((dir) => {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, max: 300 }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/quotes", quoteRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/notifications", notificationRoutes);

// Fallback 404 for unknown API routes
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Route not found." });
});

// Generic error handler (multer errors, etc.)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Something went wrong." });
});

app.listen(PORT, () => {
  console.log(`Agro Marketplace API running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
