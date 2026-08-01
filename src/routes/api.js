const express = require("express");
const scheduler = require("../scheduler");
const scheduleSource = require("../scheduleSource");
const streamer = require("../streamer");

const router = express.Router();

// The "live" merged JSON: channel name/logo (JSON source, overridden by
// dashboard if set) + the full show list. This is the JSON your channel logo
// and schedule are effectively "fetched from" at runtime.
router.get("/config", (req, res) => {
  const config = scheduleSource.getConfig();
  if (!config) {
    return res.status(503).json({ error: "Schedule not loaded yet" });
  }
  res.json({
    channel_name: config.channel_name,
    channel_logo: config.channel_logo,
    channel_logo_source: config.channel_logo_source,
    total_cycle_seconds: config.totalDuration,
    shows: config.shows,
  });
});

router.get("/nowplaying", (req, res) => {
  const now = scheduler.getNowPlaying();
  if (!now) {
    return res.status(503).json({ error: "Schedule not loaded yet" });
  }
  res.json({
    show_name: now.show.name,
    show_logo: now.show.logo,
    video_url: now.show.video_url,
    offset_seconds: Math.floor(now.offsetSeconds),
    remaining_seconds: Math.floor(now.remainingSeconds),
    channel_name: now.channel_name,
    channel_logo: now.channel_logo,
  });
});

router.get("/status", (req, res) => {
  res.json({
    schedule: scheduleSource.getStatus(),
    streamer: streamer.getStatus(),
  });
});

module.exports = router;
