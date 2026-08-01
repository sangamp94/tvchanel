const { spawn } = require("child_process");
const db = require("./db");

let cachedConfig = null; // { channel_name, channel_logo, epoch, shows: [...], totalDuration }
let lastFetchError = null;
let lastFetchAt = null;

function ffprobeDuration(videoUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoUrl,
    ];
    const proc = spawn("ffprobe", args);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => {
      const val = parseFloat(out.trim());
      if (code === 0 && !Number.isNaN(val) && val > 0) {
        resolve(val);
      } else {
        reject(new Error(`ffprobe failed for ${videoUrl}: ${err || "unknown error"}`));
      }
    });
    proc.on("error", (e) => reject(e));
  });
}

async function resolveDuration(show) {
  if (show.duration && Number(show.duration) > 0) {
    return Number(show.duration);
  }
  const cached = await db.getCachedDuration(show.video_url);
  if (cached) return cached;

  console.log(`[schedule] Probing duration for "${show.name}"...`);
  const probed = await ffprobeDuration(show.video_url);
  const rounded = Math.round(probed);
  await db.cacheDuration(show.video_url, rounded);
  return rounded;
}

async function fetchRawJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to fetch schedule JSON: HTTP ${res.status}`);
  }
  return res.json();
}

async function refresh() {
  const sourceUrl = process.env.SCHEDULE_SOURCE_URL;
  if (!sourceUrl) {
    throw new Error(
      "SCHEDULE_SOURCE_URL is not set. Point it at a JSON file (see data/schedule.example.json)."
    );
  }

  const raw = await fetchRawJson(sourceUrl);

  if (!Array.isArray(raw.shows) || raw.shows.length === 0) {
    throw new Error('Schedule JSON must contain a non-empty "shows" array.');
  }

  const shows = [];
  for (const show of raw.shows) {
    if (!show.name || !show.video_url) {
      console.warn("[schedule] Skipping invalid show entry (missing name/video_url):", show);
      continue;
    }
    const duration = await resolveDuration(show);
    shows.push({
      name: show.name,
      logo: show.logo || null,
      video_url: show.video_url,
      duration,
    });
  }

  if (shows.length === 0) {
    throw new Error("No valid shows found after validation.");
  }

  const totalDuration = shows.reduce((sum, s) => sum + s.duration, 0);
  const epochDate = raw.epoch ? new Date(raw.epoch) : new Date(0);

  // Dashboard-set logo overrides the JSON's channel_logo, if present.
  const override = await db.getChannelOverride();

  cachedConfig = {
    channel_name: (override && override.channel_name) || raw.channel_name || "My Channel",
    channel_logo: (override && override.logo_url) || raw.channel_logo || null,
    channel_logo_source: override && override.logo_url ? "dashboard" : "schedule_json",
    epoch: epochDate.getTime(),
    shows,
    totalDuration,
  };
  lastFetchError = null;
  lastFetchAt = new Date();
  console.log(
    `[schedule] Loaded ${shows.length} show(s), total cycle length ${totalDuration}s`
  );
  return cachedConfig;
}

async function applyLogoOverrideOnly() {
  // Called right after the dashboard updates the logo, so it takes effect
  // immediately without waiting for the next full schedule refresh.
  if (!cachedConfig) return;
  const override = await db.getChannelOverride();
  if (override && override.logo_url) {
    cachedConfig.channel_logo = override.logo_url;
    cachedConfig.channel_logo_source = "dashboard";
  }
  if (override && override.channel_name) {
    cachedConfig.channel_name = override.channel_name;
  }
}

function getConfig() {
  return cachedConfig;
}

function getStatus() {
  return {
    lastFetchAt,
    lastFetchError,
    loaded: !!cachedConfig,
  };
}

function startAutoRefresh() {
  const seconds = Number(process.env.SCHEDULE_REFRESH_SECONDS || 60);
  refresh().catch((e) => {
    lastFetchError = e.message;
    console.error("[schedule] Initial load failed:", e.message);
  });
  setInterval(() => {
    refresh().catch((e) => {
      lastFetchError = e.message;
      console.error("[schedule] Refresh failed:", e.message);
    });
  }, seconds * 1000);
}

module.exports = {
  refresh,
  getConfig,
  getStatus,
  applyLogoOverrideOnly,
  startAutoRefresh,
};
