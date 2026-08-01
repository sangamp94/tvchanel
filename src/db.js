const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    "[db] WARNING: DATABASE_URL is not set. Channel logo overrides and duration " +
      "caching will not persist across restarts."
  );
}

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
    })
  : null;

async function initSchema() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channel_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      logo_url TEXT,
      channel_name TEXT,
      updated_at TIMESTAMPTZ DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_durations (
      video_url TEXT PRIMARY KEY,
      duration_seconds NUMERIC NOT NULL,
      probed_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  console.log("[db] Schema ready");
}

// ---- Channel settings (dashboard-editable logo override) ----

async function getChannelOverride() {
  if (!pool) return null;
  const res = await pool.query(
    "SELECT logo_url, channel_name FROM channel_settings WHERE id = 1"
  );
  return res.rows[0] || null;
}

async function setChannelOverride({ logo_url, channel_name }) {
  if (!pool) {
    throw new Error(
      "DATABASE_URL is not configured, cannot persist dashboard changes."
    );
  }
  await pool.query(
    `INSERT INTO channel_settings (id, logo_url, channel_name, updated_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET
       logo_url = COALESCE(EXCLUDED.logo_url, channel_settings.logo_url),
       channel_name = COALESCE(EXCLUDED.channel_name, channel_settings.channel_name),
       updated_at = now()`,
    [logo_url || null, channel_name || null]
  );
  return getChannelOverride();
}

// ---- Cached video durations (avoids re-probing the same URL every restart) ----

async function getCachedDuration(videoUrl) {
  if (!pool) return null;
  const res = await pool.query(
    "SELECT duration_seconds FROM video_durations WHERE video_url = $1",
    [videoUrl]
  );
  return res.rows[0] ? Number(res.rows[0].duration_seconds) : null;
}

async function cacheDuration(videoUrl, durationSeconds) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO video_durations (video_url, duration_seconds, probed_at)
     VALUES ($1, $2, now())
     ON CONFLICT (video_url) DO UPDATE SET
       duration_seconds = EXCLUDED.duration_seconds,
       probed_at = now()`,
    [videoUrl, durationSeconds]
  );
}

module.exports = {
  pool,
  initSchema,
  getChannelOverride,
  setChannelOverride,
  getCachedDuration,
  cacheDuration,
};
