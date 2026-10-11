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
  const fps = Math.max(15, Math.min(30, Number(process.env.STREAM_FPS || 25)));
  filterParts.push(
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},setsar=1[${lastVideoLabel}]`
  );

  const channelLogoIsStreamify = channelLogoUrl && /\/brand\/streamify\.svg(?:\?|$)/i.test(channelLogoUrl);
  const channelLogoPath = channelLogoIsStreamify ? null : await logoCache.getLocalPath(channelLogoUrl);
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

  // Draw a compact premium Streamify TV badge directly in FFmpeg.
  // This remains vector/text based: no raster logo asset is loaded into the stream.
  if (channelLogoIsStreamify) {
    const badgeW = Math.round(width * 0.245);
    const badgeH = Math.round(height * 0.105);
    const badgeX = width - badgeW - Math.round(width * 0.025);
    const badgeY = Math.round(height * 0.035);
    const pad = Math.round(height * 0.012);
    const iconSize = Math.round(badgeH * 0.62);
    const iconX = badgeX + pad;
    const iconY = badgeY + Math.round((badgeH - iconSize) / 2);
    const base = "brandbase";
    const border = "brandborder";
    const iconBox = "brandiconbox";
    const playText = "brandplay";
    const word = "brandword";
    const tv = "brandtv";

    // Dark translucent plate with a magenta edge and a second crimson accent.
    filterParts.push(
      `[${lastVideoLabel}]drawbox=x=${badgeX}:y=${badgeY}:w=${badgeW}:h=${badgeH}:color=0x08030B@0.82:t=fill[${base}]`
    );
    filterParts.push(
      `[${base}]drawbox=x=${badgeX}:y=${badgeY}:w=${badgeW}:h=${badgeH}:color=0xFF2ABF@0.95:t=2[${border}]`
    );
    filterParts.push(
      `[${border}]drawbox=x=${iconX}:y=${iconY}:w=${iconSize}:h=${iconSize}:color=0xFF244D@0.95:t=2[${iconBox}]`
    );
    filterParts.push(
      `[${iconBox}]drawtext=fontfile=${FONT_PATH}:text='▶':fontcolor=0xFF4ACF:fontsize=${Math.round(iconSize * 0.72)}:x=${iconX + Math.round(iconSize * 0.12)}:y=${iconY + Math.round(iconSize * 0.08)}[${playText}]`
    );
    const wordX = iconX + iconSize + pad;
    filterParts.push(
      `[${playText}]drawtext=fontfile=${FONT_PATH}:text='MAHHA':fontcolor=white:fontsize=${Math.round(badgeH * 0.40)}:borderw=1:bordercolor=0x5B123D:x=${wordX}:y=${badgeY + Math.round(badgeH * 0.12)}[${word}]`
    );
    filterParts.push(
      `[${word}]drawtext=fontfile=${FONT_PATH}:text='TV':fontcolor=0xFF334F:fontsize=${Math.round(badgeH * 0.30)}:borderw=1:bordercolor=0x5B123D:x=${wordX}:y=${badgeY + Math.round(badgeH * 0.56)}[${tv}]`
    );
    lastVideoLabel = tv;
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

  // Premium glossy-metal NOW badge: dark chrome plate, crimson outer rim,
  // silver bevel and a narrow specular highlight. Built from FFmpeg primitives
  // so it stays lightweight and does not need extra image assets.
  const marginX = Math.round(width * 0.025);
  const marginY = Math.round(height * 0.045);
  const plateW = Math.round(width * 0.285);
  const plateH = Math.round(height * 0.082);
  const radius = Math.max(4, Math.round(plateH * 0.24));
  const plateX = marginX;
  const nowFont = Math.max(13, Math.round(height * 0.030));
  let plateInput = lastVideoLabel;

  // Approximate rounded corners with stepped horizontal slices.
  const bandCount = 9;
  for (let i = 0; i < bandCount; i++) {
    const center = (bandCount - 1) / 2;
    const inset = Math.round(radius * (1 - Math.abs((i - center) / center)));
    const y = marginY + Math.round(i * plateH / bandCount);
    const h = Math.max(1, Math.ceil(plateH / bandCount));
    const out = `nowmetal${i}`;
    filterParts.push(
      `[${plateInput}]drawbox=x=${plateX + inset}:y=${y}:w=${plateW - inset * 2}:h=${h}:color=0x101722@0.94:t=fill[${out}]`
    );
    plateInput = out;
  }

  const rim = "nowrim";
  const bevel = "nowbevel";
  const gloss = "nowgloss";
  const accent = "nowaccent";
  const textShadow = "nowshadow";
  const nowText = "nowtext";
  filterParts.push(
    `[${plateInput}]drawbox=x=${plateX + 1}:y=${marginY + radius}:w=${plateW - 2}:h=${plateH - radius * 2}:color=0xFF3158@0.95:t=2[${rim}]`
  );
  filterParts.push(
    `[${rim}]drawbox=x=${plateX + 4}:y=${marginY + radius + 2}:w=${plateW - 8}:h=2:color=0xF5F8FF@0.92:t=fill[${bevel}]`
  );
  filterParts.push(
    `[${bevel}]drawbox=x=${plateX + 5}:y=${marginY + radius + 4}:w=${plateW - 10}:h=${Math.max(2, Math.round(plateH * 0.20))}:color=0xFFFFFF@0.12:t=fill[${gloss}]`
  );
  filterParts.push(
    `[${gloss}]drawbox=x=${plateX + 5}:y=${marginY + radius + 7}:w=4:h=${plateH - radius * 2 - 10}:color=0xFF3158@1:t=fill[${accent}]`
  );
  const textX = plateX + Math.round(width * 0.020);
  const textY = marginY + Math.round(plateH * 0.27);
  filterParts.push(
    `[${accent}]drawtext=fontfile=${FONT_PATH}:text='NOW ➤ ${escapeDrawtext(showName)}':fontcolor=0xFFFFFF:fontsize=${nowFont}:borderw=2:bordercolor=0x05070B@0.95:shadowcolor=0x000000@0.9:shadowx=1:shadowy=2:x=${textX}:y=${textY}[vout]`
  );

  // Bottom promo strip is genuinely intermittent: the background and both text
  // lines share the same enable window, so it cannot cover the show between promos.
  const adH = Math.round(height * 0.105);
  const adY = height - adH - Math.round(height * 0.025);
  const adPad = Math.round(width * 0.025);
  const adAccentW = Math.max(4, Math.round(width * 0.008));
  const adBase = "adbase";
  const adEdge = "adedge";
  const adAccent = "adaccent";
  const adTitle = "adtitle";
  const adSubtitle = "adsubtitle";
  const adEnable = "between(mod(t,180),0,12)";
  filterParts.push(
    `[vout]drawbox=x=0:y=${adY}:w=${width}:h=${adH}:color=0x090B14@0.92:t=fill:enable='${adEnable}'[${adBase}]`
  );
  filterParts.push(
    `[${adBase}]drawbox=x=0:y=${adY}:w=${width}:h=2:color=0xFF3158@1:t=fill:enable='${adEnable}'[${adEdge}]`
  );
  filterParts.push(
    `[${adEdge}]drawbox=x=0:y=${adY}:w=${adAccentW}:h=${adH}:color=0xFF3158@1:t=fill:enable='${adEnable}'[${adAccent}]`
  );
  filterParts.push(
    `[${adAccent}]drawtext=fontfile=${FONT_PATH}:text='BANDBUDH AUR BUDBAK 2.0':fontcolor=white:fontsize=${Math.max(13, Math.round(height * 0.031))}:x=${adPad}:y=${adY + Math.round(adH * 0.14)}:borderw=0:enable='${adEnable}'[${adTitle}]`
  );
  filterParts.push(
    `[${adTitle}]drawtext=fontfile=${FONT_PATH}:text='COMING SOON ON MAHA CARTOON TV':fontcolor=0xFF6B8B:fontsize=${Math.max(10, Math.round(height * 0.023))}:x=${adPad}:y=${adY + Math.round(adH * 0.57)}:borderw=0:enable='${adEnable}'[vout]`
  );

  return { filterComplex: filterParts.join(";"), extraInputs: inputs };
}

async function startShow(nowPlaying) {
  const { show, offsetSeconds, remainingSeconds, channel_logo } = nowPlaying;

  const width = Number(process.env.STREAM_WIDTH || 854);
  const height = Number(process.env.STREAM_HEIGHT || 480);
  const preset = process.env.STREAM_PRESET || "ultrafast";
  const vBitrate = process.env.VIDEO_BITRATE || "800k";
  const aBitrate = process.env.AUDIO_BITRATE || "96k";
  const fps = Math.max(15, Math.min(30, Number(process.env.STREAM_FPS || 25)));

  const { filterComplex, extraInputs } = await buildFilterGraph({
    channelLogoUrl: channel_logo,
    showLogoUrl: show.logo,
    showName: show.name,
    width,
    height,
  });

  // Logo fetching/filter preparation can take long enough to cross a show boundary.
  // Do not launch FFmpeg at the very end of a show, where -ss/-t can yield no packets.
  const latest = scheduler.getNowPlaying();
  if (!latest || latest.index !== nowPlaying.index || latest.remainingSeconds < 2) {
    setImmediate(() => tick().catch((e) => console.error("[streamer] tick error:", e.message)));
    return;
  }

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
    process.env.VIDEO_BUFSIZE || "1600k",
    "-threads",
    String(Math.max(1, Math.min(4, Number(process.env.STREAM_THREADS || 2)))),
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(fps * 2),
    "-sc_threshold",
    "0",
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
    // Keep deletion under cleanupOrphanSegments() rather than letting FFmpeg
    // race the cleanup sweep or remove segments still requested by HLS clients.
    "-hls_flags",
    "append_list+discont_start+omit_endlist",
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
  const proc = currentProcess;
  if (!proc) return Promise.resolve();

  // Wait for FFmpeg to release the playlist/segment files before starting
  // another process. A fixed short sleep allowed overlapping writers on Render.
  return new Promise((resolve) => {
    let settled = false;
    let killTimer;
    let fallbackTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(fallbackTimer);
      resolve();
    };

    proc.once("close", finish);
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, 1500);
    fallbackTimer = setTimeout(finish, 3000);
  });
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
        await stopCurrentShow();
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
