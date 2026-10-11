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

if (
  process.env.NODE_ENV === "production" &&
  (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "admin")
) {
  throw new Error("Set a strong ADMIN_PASSWORD environment variable before production deployment.");
}

app.use(express.json());

app.get("/healthz", (req, res) => res.send("ok"));

app.use("/brand", express.static(path.join(__dirname, "..", "public", "brand"), {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
  },
}));

app.use("/live", express.static(path.join(__dirname, "..", "public", "hls"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".m3u8")) {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    } else if (filePath.endsWith(".ts")) {
      res.setHeader("Cache-Control", "no-cache");
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
  },
}));

app.use("/api", apiRoutes);

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
  // Open the HTTP server and start the streamer first so the pre-show can go live
  // while the schedule loader probes remote episode durations in the background.
  app.listen(PORT, () => {
    console.log(`[server] Listening on port ${PORT}`);
    console.log(`[server] Live stream will be at http://localhost:${PORT}/live/stream.m3u8`);
  });
  streamer.start({ intervalSeconds: 5 });

  await db.initSchema().catch((e) =>
    console.error("[server] DB schema init failed (check DATABASE_URL):", e.message)
  );

  scheduleSource.startAutoRefresh().catch((e) =>
    console.error("[server] Schedule startup failed:", e.message)
  );
}

main().catch((e) => {
  console.error("[server] Fatal startup error:", e);
  process.exit(1);
});
