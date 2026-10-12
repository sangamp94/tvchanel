const scheduleSource = require("./scheduleSource");

let activeIndex = null;
let activeStartedAt = null;
let activeScheduleKey = null;

async function getNowPlaying() {
  const config = scheduleSource.getConfig();
  if (!config || !config.shows || config.shows.length === 0) return null;

  const nowMs = Date.now();
  const scheduledStartMs = Number(config.start_at);
  if (config.pre_show && Number.isFinite(scheduledStartMs) && scheduledStartMs > 0 && nowMs < scheduledStartMs) {
    return {
      index: -1,
      show: config.pre_show,
      offsetSeconds: 0,
      remainingSeconds: Math.max(1, Math.ceil((scheduledStartMs - nowMs) / 1000)),
      channel_name: config.channel_name,
      channel_logo: config.channel_logo,
    };
  }

  const scheduleKey = config.shows.map((s) => s.video_url).join("|");
  if (activeIndex === null || activeScheduleKey !== scheduleKey) {
    activeIndex = 0;
    activeScheduleKey = scheduleKey;
    // If the service comes up after the scheduled start, start the first
    // episode now instead of skipping ahead based on guessed durations.
    activeStartedAt = Math.max(nowMs, Number.isFinite(scheduledStartMs) && scheduledStartMs > 0 ? scheduledStartMs : nowMs);
  }

  // Resolve only the active episode. Prefetch exactly one next episode in the
  // background; a next-episode 5XX must not interrupt the currently playing one.
  let currentDuration;
  try {
    currentDuration = await scheduleSource.ensureDuration(activeIndex);
  } catch (e) {
    console.warn(`[scheduler] Waiting for duration of "${config.shows[activeIndex].name}": ${e.message}`);
    return null;
  }

  let offsetSeconds = Math.max(0, (nowMs - activeStartedAt) / 1000);
  while (offsetSeconds >= currentDuration) {
    activeStartedAt += currentDuration * 1000;
    activeIndex = (activeIndex + 1) % config.shows.length;
    offsetSeconds = Math.max(0, (nowMs - activeStartedAt) / 1000);
    try {
      currentDuration = await scheduleSource.ensureDuration(activeIndex);
    } catch (e) {
      console.warn(`[scheduler] Waiting for duration of "${config.shows[activeIndex].name}": ${e.message}`);
      return null;
    }
  }

  const nextIndex = (activeIndex + 1) % config.shows.length;
  if (config.shows.length > 1) {
    scheduleSource.ensureDuration(nextIndex).catch((e) => {
      console.warn(`[scheduler] Next episode duration not ready for "${config.shows[nextIndex].name}": ${e.message}`);
    });
  }

  const show = config.shows[activeIndex];
  return {
    index: activeIndex,
    show,
    offsetSeconds: Math.min(offsetSeconds, Math.max(0, currentDuration - 1)),
    remainingSeconds: Math.max(1, currentDuration - offsetSeconds),
    channel_name: config.channel_name,
    channel_logo: config.channel_logo,
  };
}

module.exports = { getNowPlaying };
