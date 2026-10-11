const scheduleSource = require("./scheduleSource");

function getLocalClock(timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZone || "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

/**
 * Calculate the current programme. If daily_start_time and pre_show are set,
 * play the pre-show until that local time, then restart the main playlist from
 * its first episode at the configured time each day.
 */
function getNowPlaying() {
  const config = scheduleSource.getConfig();
  if (!config || !config.shows || config.shows.length === 0) return null;

  const { shows, totalDuration } = config;
  if (totalDuration <= 0) return null;

  let posInCycle;
  if (config.daily_start_time && config.pre_show) {
    const [startHour, startMinute] = config.daily_start_time.split(":").map(Number);
    const clock = getLocalClock(config.timezone);
    const nowMinutes = clock.hour * 60 + clock.minute;
    const startMinutes = startHour * 60 + startMinute;
    if (nowMinutes < startMinutes) {
      const remainingSeconds = (startMinutes - nowMinutes) * 60 - clock.second;
      return {
        index: -1,
        show: config.pre_show,
        offsetSeconds: 0,
        remainingSeconds: Math.max(1, remainingSeconds),
        channel_name: config.channel_name,
        channel_logo: config.channel_logo,
      };
    }
    const elapsedSeconds = (nowMinutes - startMinutes) * 60 + clock.second;
    posInCycle = elapsedSeconds % totalDuration;
  } else {
    const nowSeconds = Date.now() / 1000;
    const elapsedSinceEpoch = nowSeconds - config.epoch / 1000;
    posInCycle = elapsedSinceEpoch % totalDuration;
    if (posInCycle < 0) posInCycle += totalDuration;
  }

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
