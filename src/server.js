require("dotenv").config();
const express = require("express");
const path = require("path");
const basicAuth = require("express-basic-auth");

const db = require("./db");
const scheduleSource = require("./scheduleSource");
const streamer = require("./streamer");
const apiRoutes = require("./routes/api");
const adminRoutes = require("./routes/admin");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// ---- Public: health check for Render ----
app.get("/healthz", (req, res) => res.send("ok"));

// ---- Public: HLS output (this is what VLC / players connect to) ----
app.use(
  "/live",
  express.static(path.join(__dirname, "..", "public", "hls"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".m3u8")) {
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      } else if (filePath.endsWith(".ts")) {
        res.setHeader("Cache-Control", "no-cache");
      }
      // Allow players/browsers on other origins to fetch the stream.
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  })
);

// ---- Public: read-only JSON API (now playing, config, status) ----
app.use("/api", apiRoutes);

// ---- Protected: admin API + dashboard UI ----
const adminAuth = basicAuth({
  users: { [process.env.ADMIN_USER || "admin"]: process.env.ADMIN_PASSWORD || "admin" },
  challenge: true,
  realm: "tv-channel-admin",
});

app.use("/api/admin", adminAuth, adminRoutes);
app.use("/dashboard", adminAuth, express.static(path.join(__dirname, "..", "public", "dashboard")));

app.get("/", (req, res) => {
  res.type("text").send(
    "TV Channel Server is running.\n" +
      "- Live stream (open in VLC): /live/stream.m3u8\n" +
      "- Dashboard: /dashboard\n" +
      "- Now playing (JSON): /api/nowplaying\n"
  );
});

async function main() {
  await db.initSchema().catch((e) =>
    console.error("[server] DB schema init failed (check DATABASE_URL):", e.message)
  );

  await scheduleSource.refresh().catch((e) =>
    console.error("[server] Initial schedule load failed:", e.message)
  );
  scheduleSource.startAutoRefresh();

  streamer.start({ intervalSeconds: 5 });

  app.listen(PORT, () => {
    console.log(`[server] Listening on port ${PORT}`);
    console.log(`[server] Live stream will be at http://localhost:${PORT}/live/stream.m3u8`);
  });
}

main().catch((e) => {
  console.error("[server] Fatal startup error:", e);
  process.exit(1);
});
