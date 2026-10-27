const express = require("express");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/:userId", requireAuth, async (req, res) => {
  const messages = await db.messages.findConversation(req.user.id, req.params.userId);
  res.json({ messages });
});

router.post("/", requireAuth, async (req, res) => {
  const { receiverId, message } = req.body;
  if (!receiverId || !message) return res.status(400).json({ error: "receiverId and message are required." });

  const recipient = await db.users.findById(receiverId);
  if (!recipient) return res.status(404).json({ error: "Recipient not found." });

  const saved = await db.messages.create({
    id: uuidv4(), senderId: req.user.id, receiverId, message: String(message).slice(0, 5000),
  });
  res.status(201).json({ message: saved });
});

router.put("/:id/read", requireAuth, async (req, res) => {
  const message = await db.messages.findById(req.params.id);
  if (!message || message.receiverId !== req.user.id) return res.status(404).json({ error: "Message not found." });
  res.json({ message: await db.messages.markRead(message.id) });
});

module.exports = router;
