const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const scheduler = require("./scheduler");
const logoCache = require("./logoCache");

const HLS_DIR = path.join(__dirname, "..", "public", "hls");
const FONT_PATH = path.join(__dirname, "..", "assets", "font.ttf");

if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

let currentProcess = null;
let currentShowIndex = null;
let currentShowName = null;
let nextSegmentNumber = 0;
let restarting = false;
let lastError = null;
let tickTimer = null;

function escapeDrawtext(text) {
  // Escape characters that are special inside ffmpeg's drawtext "text" value.
  return String(text)
    .replace(/\\/g, "\\\\\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

function highestSegmentNumberOnDisk() {
  let max = -1;
  try {
    for (const f of fs.readdirSync(HLS_DIR)) {
      const m = f.match(/^seg_(\d+)\.ts$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch (e) {
    // directory might not exist yet on first run
  }
  return max;
}

function clearHlsDir() {
  try {
    for (const f of fs.readdirSync(HLS_DIR)) {
      fs.unlinkSync(path.join(HLS_DIR, f));
    }
  } catch (e) {
    // ignore
  }
}

/**
 * Each ffmpeg process only knows how to delete segments IT wrote (via
 * hls_flags delete_segments). Since we restart ffmpeg on every show switch,
 * segments from earlier processes are otherwise never cleaned up and would
 * accumulate forever over 24/7 operation. This sweep removes any .ts file
 * that is no longer referenced by the current playlist and is old enough
 * that no in-flight client request could still need it.
 */
function cleanupOrphanSegments() {
  const playlistPath = path.join(HLS_DIR, "stream.m3u8");
  let referenced = new Set();
  try {
    const contents = fs.readFileSync(playlistPath, "utf8");
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) referenced.add(trimmed);
    }
  } catch (e) {
    return; // playlist not written yet
  }

  const GRACE_MS = 30 * 1000;
  const now = Date.now();
  let removed = 0;
  try {
    for (const f of fs.readdirSync(HLS_DIR)) {
      if (!f.endsWith(".ts") || referenced.has(f)) continue;
      const full = path.join(HLS_DIR, f);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > GRACE_MS) {
        fs.unlinkSync(full);
        removed++;
      }
    }
  } catch (e) {
    // ignore transient errors (file removed concurrently, etc.)
  }
  if (removed > 0) {
    console.log(`[streamer] Cleaned up ${removed} orphaned segment file(s)`);
  }
}

async function buildFilterGraph({ channelLogoUrl, showLogoUrl, showName, width, height }) {
  const inputs = [];
  const filterParts = [];
  let inputIndex = 1; // 0 is the main video

  let lastVideoLabel = "bg";
  filterParts.push(`[0:v]scale=${width}:${height},setsar=1[${lastVideoLabel}]`);

  const channelLogoPath = await logoCache.getLocalPath(channelLogoUrl);
  if (channelLogoPath) {
    inputs.push("-i", channelLogoPath);
    const logoLabel = `chlogo`;
    const nextLabel = "bg1";
    filterParts.push(`[${inputIndex}:v]scale=${Math.round(width * 0.08)}:-1[${logoLabel}]`);
    filterParts.push(
      `[${lastVideoLabel}][${logoLabel}]overlay=W-w-${Math.round(width * 0.02)}:${Math.round(
        height * 0.03
      )}[${nextLabel}]`
    );
    lastVideoLabel = nextLabel;
    inputIndex++;
  }

  const showLogoPath = await logoCache.getLocalPath(showLogoUrl);
  let showLogoW = 0;
  if (showLogoPath) {
    inputs.push("-i", showLogoPath);
    const logoLabel = `showlogo`;
    const nextLabel = "bg2";
    showLogoW = Math.round(width * 0.07);
    filterParts.push(`[${inputIndex}:v]scale=${showLogoW}:-1[${logoLabel}]`);
    filterParts.push(
      `[${lastVideoLabel}][${logoLabel}]overlay=${Math.round(width * 0.02)}:${Math.round(
        height * 0.03
      )}[${nextLabel}]`
    );
    lastVideoLabel = nextLabel;
    inputIndex++;
  }

  const textX = Math.round(width * 0.02) + showLogoW + (showLogoW ? 15 : 0);
  const textY = Math.round(height * 0.03) + 10;
  const fontSize = Math.round(height * 0.033);
  const label = `Now\\: ${escapeDrawtext(showName)}`;

  filterParts.push(
    `[${lastVideoLabel}]drawtext=fontfile=${FONT_PATH}:text='${label}':` +
      `fontcolor=white:fontsize=${fontSize}:box=1:boxcolor=0x800000@0.85:boxborderw=12:` +
      `x=${textX}:y=${textY}[vout]`
  );

  return { filterComplex: filterParts.join(";"), extraInputs: inputs };
}

async function startShow(nowPlaying) {
  const { show, offsetSeconds, remainingSeconds, channel_logo } = nowPlaying;

  const width = Number(process.env.STREAM_WIDTH || 1280);
  const height = Number(process.env.STREAM_HEIGHT || 720);
  const preset = process.env.STREAM_PRESET || "veryfast";
  const vBitrate = process.env.VIDEO_BITRATE || "1500k";
  const aBitrate = process.env.AUDIO_BITRATE || "128k";

  const { filterComplex, extraInputs } = await buildFilterGraph({
    channelLogoUrl: channel_logo,
    showLogoUrl: show.logo,
    showName: show.name,
    width,
    height,
  });

  const onDisk = highestSegmentNumberOnDisk();
  if (onDisk >= 0) nextSegmentNumber = onDisk + 1;

  const args = [
    "-loglevel",
    "warning",
    "-re",
    "-ss",
    String(Math.max(0, Math.floor(offsetSeconds))),
    "-i",
    show.video_url,
    ...extraInputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[vout]",
    "-map",
    "0:a?",
    "-t",
    String(Math.max(1, Math.floor(remainingSeconds))),
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-tune",
    "zerolatency",
    "-b:v",
    vBitrate,
    "-maxrate",
    vBitrate,
    "-bufsize",
    "3000k",
    "-c:a",
    "aac",
    "-b:a",
    aBitrate,
    "-ac",
    "2",
    "-f",
    "hls",
    "-hls_time",
    "4",
    "-hls_list_size",
    "8",
    "-start_number",
    String(nextSegmentNumber),
    "-hls_flags",
    "append_list+delete_segments+discont_start+omit_endlist",
    "-hls_segment_filename",
    path.join(HLS_DIR, "seg_%d.ts"),
    path.join(HLS_DIR, "stream.m3u8"),
  ];

  console.log(
    `[streamer] Now playing: "${show.name}" (offset ${Math.floor(
      offsetSeconds
    )}s, remaining ${Math.floor(remainingSeconds)}s, segment#${nextSegmentNumber})`
  );

  const proc = spawn("ffmpeg", args);
  currentProcess = proc;
  currentShowIndex = nowPlaying.index;
  currentShowName = show.name;
  lastError = null;

  proc.stderr.on("data", (d) => {
    const line = d.toString().trim();
    if (line) console.log(`[ffmpeg] ${line}`);
  });

  proc.on("error", (err) => {
    lastError = `Failed to start ffmpeg: ${err.message}`;
    console.error(`[streamer] ${lastError}`);
  });

  proc.on("close", (code) => {
    if (currentProcess === proc) currentProcess = null;
    console.log(`[streamer] ffmpeg exited (show "${show.name}", code ${code})`);
    // Immediately re-evaluate so the next show starts with minimal gap.
    setImmediate(() => tick().catch((e) => console.error("[streamer] tick error:", e.message)));
  });
}

function stopCurrentShow() {
  if (currentProcess) {
    currentProcess.kill("SIGTERM");
  }
}

async function tick() {
  if (restarting) return;
  const nowPlaying = scheduler.getNowPlaying();
  if (!nowPlaying) return; // schedule not loaded yet

  const needsSwitch = currentShowIndex === null || currentShowIndex !== nowPlaying.index;
  const isRunning = !!currentProcess;

  if (!isRunning || needsSwitch) {
    restarting = true;
    try {
      if (isRunning && needsSwitch) {
        stopCurrentShow();
        // give ffmpeg a brief moment to release the output files before respawning
        await new Promise((r) => setTimeout(r, 300));
      }
      await startShow(nowPlaying);
    } catch (e) {
      lastError = e.message;
      console.error("[streamer] Failed to start show:", e.message);
    } finally {
      restarting = false;
    }
  }
}

function start({ intervalSeconds = 5 } = {}) {
  clearHlsDir();
  tick().catch((e) => console.error("[streamer] initial tick error:", e.message));
  tickTimer = setInterval(() => {
    tick().catch((e) => console.error("[streamer] tick error:", e.message));
  }, intervalSeconds * 1000);
  setInterval(cleanupOrphanSegments, 20 * 1000);
}

function getStatus() {
  return {
    running: !!currentProcess,
    currentShowIndex,
    currentShowName,
    lastError,
  };
}

module.exports = { start, getStatus };
