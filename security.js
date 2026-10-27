// Lightweight security helpers for the demo/MVP. For production, place the API
// behind a reverse proxy/WAF and use a managed rate limiter + persistent store.
const buckets = new Map();

function rateLimit({ windowMs = 60_000, max = 120 } = {}) {
  return (req, res, next) => {
    const key = `${req.ip || 'unknown'}:${req.path}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.startedAt >= windowMs) b = { startedAt: now, count: 0 };
    b.count += 1;
    buckets.set(key, b);
    if (b.count > max) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    next();
  };
}

function cleanString(value, max = 5000) {
  if (value === undefined || value === null) return value;
  return String(value).trim().slice(0, max);
}

module.exports = { rateLimit, cleanString };
