const { spawn } = require("child_process");
const db = require("./db");

let cachedConfig = null; // { channel_name, channel_logo, epoch, shows: [...], totalDuration }
let lastFetchError = null;
let lastFetchAt = null;
let lastDurationProbeError = null;
const durationRequests = new Map();

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
  const sourceUrl = process.env.SCHEDULE_SOURCE_URL ||
    "https://raw.githubusercontent.com/sangamp94/tvchanel/main/schedule.json";
  const sourceMode = String(process.env.SCHEDULE_SOURCE_MODE || "url").toLowerCase();
  let raw;

  if (sourceMode === "database") {
    raw = await db.getScheduleConfig();
    if (!raw) {
      // Bootstrap Neon from the configured JSON source on first run.
      raw = await fetchRawJson(sourceUrl);
      await db.setScheduleConfig(raw);
      console.log("[schedule] Seeded Neon channel_schedule from SCHEDULE_SOURCE_URL");
    }
  } else {
    raw = await fetchRawJson(sourceUrl);
  }
  if (!Array.isArray(raw.shows) || raw.shows.length === 0) {
    throw new Error('Schedule JSON must contain a non-empty "shows" array.');
  }

  // Load metadata only. Do NOT probe all episode URLs here. Duration probing
  // is lazy and limited to the active episode plus one next-episode prefetch.
  const shows = [];
  for (const item of raw.shows) {
    if (!item.name || !item.video_url) {
      throw new Error("Invalid schedule entry: every show needs both name and video_url. Keeping the last good schedule.");
    }
    let source;
    try { source = new URL(item.video_url); } catch {
      throw new Error(`Invalid video URL for "${String(item.name).slice(0, 80)}". Keeping the last good schedule.`);
    }
    if (!["http:", "https:"].includes(source.protocol)) {
      throw new Error(`Non-HTTP(S) video URL for "${String(item.name).slice(0, 80)}". Keeping the last good schedule.`);
    }
    const suppliedDuration = Number(item.duration);
    shows.push({
      name: String(item.name).slice(0, 200),
      logo: item.logo ? String(item.logo) : null,
      video_url: source.href,
      duration: Number.isFinite(suppliedDuration) && suppliedDuration > 0 ? Math.round(suppliedDuration) : null,
    });
  }
  if (shows.length === 0) throw new Error("No valid shows found after validation.");

  let preShow = null;
  if (raw.pre_show && raw.pre_show.name && raw.pre_show.video_url) {
    try {
      const u = new URL(raw.pre_show.video_url);
      if (["http:", "https:"].includes(u.protocol)) {
        preShow = {
          name: String(raw.pre_show.name).slice(0, 200),
          logo: raw.pre_show.logo ? String(raw.pre_show.logo) : null,
          video_url: u.href,
          duration: null,
        };
      }
    } catch (e) {
      console.warn("[schedule] Ignoring invalid pre_show URL:", e.message);
    }
  }

  const parsedEpoch = raw.epoch ? new Date(raw.epoch) : new Date(0);
  const epochDate = Number.isFinite(parsedEpoch.getTime()) ? parsedEpoch : new Date(0);
  let override = null;
  try {
    override = await db.getChannelOverride();
  } catch (e) {
    console.warn("[schedule] Channel override DB unavailable; using schedule JSON:", e.message);
  }

  // Preserve the previous playlist's order/progress where possible. A routine
  // refresh must not reset playback to Episode 1.
  const previous = cachedConfig;
  cachedConfig = {
    channel_name: (override && override.channel_name) || raw.channel_name || "My Channel",
    channel_logo: (override && override.logo_url) || raw.channel_logo || null,
    channel_logo_source: override && override.logo_url ? "dashboard" : "schedule_json",
    epoch: epochDate.getTime(),
    shows,
    totalDuration: null,
    daily_start_time: null,
    start_at: raw.start_at && Number.isFinite(new Date(raw.start_at).getTime()) ? new Date(raw.start_at).getTime() : null,
    timezone: "Asia/Kolkata",
    pre_show: preShow,
    loading: false,
  };

  // If the schedule URLs/order are unchanged, carry forward durations already
  // resolved in memory to avoid repeating probes on each 60-second refresh.
  if (previous && Array.isArray(previous.shows)) {
    const oldByUrl = new Map(previous.shows.map((s) => [s.video_url, s.duration]));
    for (const show of cachedConfig.shows) {
      if (!show.duration && oldByUrl.has(show.video_url)) show.duration = oldByUrl.get(show.video_url);
    }
  }

  lastFetchError = null;
  lastFetchAt = new Date();
  console.log(`[schedule] Loaded ${shows.length} episode entries (durations will be fetched lazily: current + next only).`);
  return cachedConfig;
}

async function ensureDuration(index) {
  const config = cachedConfig;
  if (!config || !config.shows[index]) throw new Error(`Episode index ${index} is not in the schedule`);
  const show = config.shows[index];
  if (Number.isFinite(show.duration) && show.duration > 0) return show.duration;

  const now = Date.now();
  const existing = durationRequests.get(show.video_url);
  if (existing && Number.isFinite(existing.duration) && existing.duration > 0) {
    show.duration = existing.duration;
    return existing.duration;
  }
  if (existing && existing.promise) return existing.promise;
  if (existing && existing.retryAfter > now) throw new Error(existing.error || "Duration probe is cooling down");

  const promise = resolveDuration(show).then((duration) => {
    // Only update the currently loaded matching URL; refresh may have changed the schedule.
    const current = cachedConfig && cachedConfig.shows.find((s) => s.video_url === show.video_url);
    if (current) current.duration = duration;
    durationRequests.set(show.video_url, { duration, retryAfter: 0 });
    lastDurationProbeError = null;
    return duration;
  }).catch((e) => {
    lastDurationProbeError = `${show.name}: ${e.message}`;
    durationRequests.set(show.video_url, { error: e.message, retryAfter: Date.now() + 30000 });
    throw e;
  }).finally(() => {
    const entry = durationRequests.get(show.video_url);
    if (entry) delete entry.promise;
  });
  durationRequests.set(show.video_url, { promise, retryAfter: 0 });
  return promise;
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
    episodeCount: cachedConfig ? cachedConfig.shows.length : 0,
    durationProbesInFlight: [...durationRequests.values()].filter((x) => x.promise).length,
    lastDurationProbeError,
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
  ensureDuration,
  applyLogoOverrideOnly,
  startAutoRefresh,
};
