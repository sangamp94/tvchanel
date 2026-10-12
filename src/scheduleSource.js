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
  let cached = null;
  try {
    cached = await db.getCachedDuration(show.video_url);
  } catch (e) {
    console.warn("[schedule] Duration cache unavailable; probing source:", e.message);
  }
  if (cached && Number.isFinite(Number(cached)) && Number(cached) > 0) return Number(cached);

  console.log(`[schedule] Probing duration for "${show.name}"...`);
  let probed;
  let lastError;
  // Retry transient Archive.org/CDN failures instead of immediately dropping an episode.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      probed = await ffprobeDuration(show.video_url);
      break;
    } catch (e) {
      lastError = e;
      if (attempt < 3) {
        const waitMs = attempt * 2000;
        console.warn(`[schedule] Probe attempt ${attempt}/3 failed for "${show.name}"; retrying in ${waitMs / 1000}s: ${e.message}`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  if (!Number.isFinite(probed) || probed <= 0) throw lastError || new Error("Unable to resolve duration");
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
  // Use the repository schedule by default so a missing Render env var does not leave the channel empty.
  // Set SCHEDULE_SOURCE_URL in Render to override this default when needed.
  const sourceUrl = process.env.SCHEDULE_SOURCE_URL ||
    "https://raw.githubusercontent.com/sangamp94/tvchanel/main/schedule.json";

  const raw = await fetchRawJson(sourceUrl);

  if (!Array.isArray(raw.shows) || raw.shows.length === 0) {
    throw new Error('Schedule JSON must contain a non-empty "shows" array.');
  }

  // Only publish the provisional config on the very first load. Replacing an
  // already-working schedule with this one-show placeholder on every 60s refresh
  // makes the streamer jump to Episode 1, then jump back to the calculated episode.
  // Keep the last good config live while background refresh/probing is in progress.
  if (!cachedConfig && raw.pre_show && raw.pre_show.name && raw.pre_show.video_url) {
    try {
      const preUrl = new URL(raw.pre_show.video_url);
      if (["http:", "https:"].includes(preUrl.protocol)) {
        const startAt = raw.start_at && Number.isFinite(new Date(raw.start_at).getTime())
          ? new Date(raw.start_at).getTime()
          : Date.now() + 60 * 60 * 1000;
        cachedConfig = {
          channel_name: raw.channel_name || "My Channel",
          channel_logo: raw.channel_logo || null,
          channel_logo_source: "schedule_json",
          epoch: Date.now(),
          shows: [{
            name: String(raw.shows[0].name || "Main playlist").slice(0, 200),
            logo: raw.shows[0].logo ? String(raw.shows[0].logo) : null,
            video_url: String(raw.shows[0].video_url),
            duration: 1,
          }],
          totalDuration: 1,
          daily_start_time: null,
          start_at: startAt,
          timezone: "Asia/Kolkata",
          pre_show: {
            name: String(raw.pre_show.name).slice(0, 200),
            logo: raw.pre_show.logo ? String(raw.pre_show.logo) : null,
            video_url: preUrl.href,
            duration: 1,
          },
          loading: true,
        };
        console.log(`[schedule] Pre-show "${cachedConfig.pre_show.name}" is available while episode durations load.`);
      }
    } catch (e) {
      console.warn("[schedule] Could not prepare pre-show config:", e.message);
    }
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
  const dailyStartTime = /^([01]\\d|2[0-3]):([0-5]\\d)$/.test(String(raw.daily_start_time || ""))
    ? String(raw.daily_start_time)
    : null;
  let preShow = null;
  if (raw.pre_show && raw.pre_show.name && raw.pre_show.video_url) {
    try {
      const preShowUrl = new URL(raw.pre_show.video_url);
      if (["http:", "https:"].includes(preShowUrl.protocol)) {
        preShow = {
          name: String(raw.pre_show.name).slice(0, 200),
          logo: raw.pre_show.logo ? String(raw.pre_show.logo) : null,
          video_url: preShowUrl.href,
          duration: 1,
        };
      }
    } catch (e) {
      console.warn("[schedule] Ignoring invalid pre_show URL:", e.message);
    }
  }
  const parsedEpoch = raw.epoch ? new Date(raw.epoch) : new Date(0);
  const epochDate = Number.isFinite(parsedEpoch.getTime()) ? parsedEpoch : new Date(0);

  // Dashboard-set logo overrides the JSON's channel_logo, if present.
  let override = null;
  try {
    override = await db.getChannelOverride();
  } catch (e) {
    console.warn("[schedule] Channel override DB unavailable; using schedule JSON:", e.message);
  }

  cachedConfig = {
    channel_name: (override && override.channel_name) || raw.channel_name || "My Channel",
    channel_logo: (override && override.logo_url) || raw.channel_logo || null,
    channel_logo_source: override && override.logo_url ? "dashboard" : "schedule_json",
    epoch: epochDate.getTime(),
    shows,
    totalDuration,
    daily_start_time: dailyStartTime,
    start_at: raw.start_at && Number.isFinite(new Date(raw.start_at).getTime()) ? new Date(raw.start_at).getTime() : null,
    timezone: "Asia/Kolkata",
    pre_show: preShow,
    loading: false,
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
  let refreshInProgress = false;
  setInterval(() => {
    if (refreshInProgress) return;
    refreshInProgress = true;
    refresh()
      .catch((e) => {
        lastFetchError = e.message;
        console.error("[schedule] Refresh failed:", e.message);
      })
      .finally(() => {
        refreshInProgress = false;
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
