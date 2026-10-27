const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  res.json({ notifications: await db.notifications.findForUser(req.user.id) });
});

router.put("/:id/read", requireAuth, async (req, res) => {
  const notification = await db.notifications.findById(req.params.id);
  if (!notification || notification.userId !== req.user.id) {
    return res.status(404).json({ error: "Notification not found." });
  }
  res.json({ notification: await db.notifications.markRead(notification.id) });
});

module.exports = router;
