require("dotenv").config();
const fs = require("fs");
const path = require("path");
const db = require("../src/db");

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Add it to .env or the shell environment.");
  }

  const filePath = path.resolve(process.argv[2] || "data/schedule.example.json");
  const schedule = JSON.parse(fs.readFileSync(filePath, "utf8"));

  if (!Array.isArray(schedule.shows) || schedule.shows.length === 0) {
    throw new Error('Schedule JSON must contain a non-empty "shows" array.');
  }

  await db.initSchema();
  const saved = await db.setScheduleConfig(schedule);
  console.log(
    `Imported ${saved.shows.length} shows into Neon channel_schedule from ${filePath}`
  );
}

main()
  .catch((error) => {
    console.error("[import-schedule-to-neon] Failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (db.pool) await db.pool.end().catch(() => {});
  });
