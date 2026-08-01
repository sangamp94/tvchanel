const scheduleSource = require("./scheduleSource");

/**
 * Given the loaded config (epoch + ordered shows + totalDuration), figure out
 * which show should be playing RIGHT NOW and how many seconds into it we are.
 *
 * This is deliberately stateless / time-based (like real broadcast TV): any
 * viewer joining at any moment, and the server itself even after a restart,
 * will always compute the exact same "now playing" position from wall-clock
 * time alone. Nothing needs to be "remembered" across restarts.
 */
function getNowPlaying() {
  const config = scheduleSource.getConfig();
  if (!config || !config.shows || config.shows.length === 0) {
    return null;
  }

  const { epoch, shows, totalDuration } = config;
  if (totalDuration <= 0) return null;

  const nowSeconds = Date.now() / 1000;
  const elapsedSinceEpoch = nowSeconds - epoch / 1000;

  // mod can be negative in JS if elapsedSinceEpoch is negative; normalize.
  let posInCycle = elapsedSinceEpoch % totalDuration;
  if (posInCycle < 0) posInCycle += totalDuration;

  let cursor = 0;
  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    if (posInCycle < cursor + show.duration) {
      const offsetSeconds = posInCycle - cursor;
      const remainingSeconds = show.duration - offsetSeconds;
      return {
        index: i,
        show,
        offsetSeconds: Math.max(0, offsetSeconds),
        remainingSeconds: Math.max(0, remainingSeconds),
        channel_name: config.channel_name,
        channel_logo: config.channel_logo,
      };
    }
    cursor += show.duration;
  }

  // Floating point edge case: fall back to the last show.
  const last = shows[shows.length - 1];
  return {
    index: shows.length - 1,
    show: last,
    offsetSeconds: 0,
    remainingSeconds: last.duration,
    channel_name: config.channel_name,
    channel_logo: config.channel_logo,
  };
}

module.exports = { getNowPlaying };
