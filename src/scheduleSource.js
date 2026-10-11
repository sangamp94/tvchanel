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
    const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        proc.kill("SIGKILL");
        settled = true;
        reject(new Error("ffprobe timed out after 20 seconds"));
      }
    }, 20000);
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const val = parseFloat(out.trim());
      if (code === 0 && Number.isFinite(val) && val > 0) {
        resolve(val);
      } else {
        reject(new Error(`ffprobe failed for ${videoUrl}: ${err || "unknown error"}`));
      }
    });
    proc.on("error", (e) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
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
  // Duration probing should still work when the optional cache DB is unavailable.
  await db.cacheDuration(show.video_url, rounded).catch((e) => console.warn("[schedule] Duration cache unavailable:", e.message));
  return rounded;
}

async function fetchRawJson(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("SCHEDULE_SOURCE_URL must be a valid HTTPS URL"); }
  if (parsed.protocol !== "https:") {
    throw new Error("SCHEDULE_SOURCE_URL must use HTTPS");
  }
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
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
      console.warn("[schedule] Skipping invalid show entry (missing name/video_url).");
      continue;
    }
    let source;
    try { source = new URL(show.video_url); } catch { 
      console.warn("[schedule] Skipping show with invalid video URL:", show.name);
      continue;
    }
    if (!["http:", "https:"].includes(source.protocol)) {
      console.warn("[schedule] Skipping non-HTTP(S) video URL:", show.name);
      continue;
    }
    try {
      const duration = await resolveDuration(show);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid duration");
      shows.push({
        name: String(show.name).slice(0, 200),
        logo: show.logo ? String(show.logo) : null,
        video_url: source.href,
        duration,
      });
    } catch (e) {
      console.warn(`[schedule] Skipping "${String(show.name).slice(0, 80)}": ${e.message}`);
    }
  }

  if (shows.length === 0) {
    throw new Error("No valid shows found after validation.");
  }

  const totalDuration = shows.reduce((sum, s) => sum + s.duration, 0);
  const parsedEpoch = raw.epoch ? new Date(raw.epoch) : new Date(0);
  const epochDate = Number.isFinite(parsedEpoch.getTime()) ? parsedEpoch : new Date(0);

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

async function startAutoRefresh() {
  const seconds = Math.max(30, Number(process.env.SCHEDULE_REFRESH_SECONDS || 60));
  try {
    await refresh();
  } catch (e) {
    lastFetchError = e.message;
    console.error("[schedule] Initial load failed:", e.message);
  }
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
