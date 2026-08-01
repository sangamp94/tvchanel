const express = require("express");
const db = require("../db");
const scheduleSource = require("../scheduleSource");

const router = express.Router();

router.patch("/channel", async (req, res) => {
  const { logo_url, channel_name } = req.body || {};
  if (!logo_url && !channel_name) {
    return res.status(400).json({ error: "Provide logo_url and/or channel_name" });
  }
  try {
    const updated = await db.setChannelOverride({ logo_url, channel_name });
    await scheduleSource.applyLogoOverrideOnly();
    res.json({ ok: true, channel: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/schedule/refresh", async (req, res) => {
  try {
    await scheduleSource.refresh();
    res.json({ ok: true, config: scheduleSource.getConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/whoami", (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
