const scheduleSource = require("./scheduleSource");

function getNowPlaying() {
  const config = scheduleSource.getConfig();
  if (!config || !config.shows || config.shows.length === 0) return null;

  const { shows, totalDuration } = config;
  if (totalDuration <= 0) return null;

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

  // While remote episode durations are still being probed, do not let the
  // provisional 1-second placeholder duration produce an almost-zero show.
  // Start Episode 1 immediately; the full schedule will take over once loaded.
  if (config.loading) {
    return {
      index: 0,
      show: shows[0],
      offsetSeconds: 0,
      remainingSeconds: 3600,
      channel_name: config.channel_name,
      channel_logo: config.channel_logo,
    };
  }

  // Start the Pokémon playlist at episode 1 at the scheduled time.
  const baseEpochMs = Number.isFinite(scheduledStartMs) && scheduledStartMs > 0
    ? scheduledStartMs
    : config.epoch;
  let posInCycle = ((nowMs - baseEpochMs) / 1000) % totalDuration;
  if (posInCycle < 0) posInCycle += totalDuration;

  let cursor = 0;
  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    if (posInCycle < cursor + show.duration) {
      const offsetSeconds = posInCycle - cursor;
      return {
        index: i,
        show,
        offsetSeconds: Math.max(0, offsetSeconds),
        remainingSeconds: Math.max(0, show.duration - offsetSeconds),
        channel_name: config.channel_name,
        channel_logo: config.channel_logo,
      };
    }
    cursor += show.duration;
  }

  const lastIndex = shows.length - 1;
  const last = shows[lastIndex];
  return {
    index: lastIndex,
    show: last,
    offsetSeconds: 0,
    remainingSeconds: last.duration,
    channel_name: config.channel_name,
    channel_logo: config.channel_logo,
  };
}

module.exports = { getNowPlaying };
