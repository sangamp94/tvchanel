# TV Channel Server

A self-hosted, 24/7 "linear TV" channel. It plays a looping schedule of
pre-recorded videos (MP4 / MKV / M3U8 URLs), burns a TV-style overlay onto
the picture (channel logo top-right, show logo + maroon **"Now: Show Name"**
banner top-left), and outputs a standard HLS stream (`stream.m3u8`) that
VLC, browsers, or any IPTV player can open directly.

```
Schedule JSON (yours, hosted anywhere)  ──┐
                                           ├─▶  Node.js scheduler  ──▶  ffmpeg (overlay + encode)  ──▶  HLS (/live/stream.m3u8)
Neon Postgres (logo override + cache)  ──┘
```

---

## 1. Before you start — please read this

This is genuinely free to run, but **"free + zero lag/frame drops, guaranteed" is not something anyone can promise** on shared free hosting. Here's the honest picture:

- **Render's free web service sleeps after 15 minutes with no traffic.** If nobody is watching, the channel goes offline, and the next viewer triggers a ~30-60s cold start. For a channel that must always be live, you'll eventually want a paid Render plan (Starter, ~$7/mo) which doesn't sleep.
- **Free tier CPU/RAM is limited.** Continuous video transcoding with overlays is CPU-heavy. Defaults are tuned more conservatively for testing (854×480, 25 FPS, `ultrafast`, 800kbps, two encoder threads). This reduces CPU use and bandwidth but also lowers picture quality. Multiple viewers, slow source URLs, or constrained shared CPU can still cause stutter.
- **There's a brief (1-3 second) hiccup when one show ends and the next begins.** This is because switching sources restarts the encoder cleanly (simplest, most reliable approach). A perfectly seamless transition is possible but requires a much more complex pipeline — not something achievable reliably for free infrastructure.
- **Neon's free tier is more than enough** — this app only stores your logo setting and cached video durations, which is a tiny amount of data.

None of this means it won't work — it will, and it'll look and feel like real TV. Just don't expect broadcast-grade guarantees from free infrastructure.

---

## 2. What you need

- A [GitHub](https://github.com) account (to hold this code + optionally your schedule JSON and logo images)
- A [Neon](https://neon.tech) account (free Postgres database)
- A [Render](https://render.com) account (free web hosting)
- Direct URLs to video files (MP4/MKV/M3U8) and logo images (PNG), hosted anywhere public; use only content you own or are explicitly licensed to rebroadcast

---

## 3. Set up Neon (database)

1. Create a free project at neon.tech.
2. Open **Connection Details** and copy the connection string. It looks like:
   `postgresql://user:password@ep-xxxx.neon.tech/neondb?sslmode=require`
3. Keep this — you'll paste it into Render as `DATABASE_URL`.

The app creates its own tables automatically on first boot. You don't need to run any SQL yourself.

---

## 4. Prepare your schedule JSON

This JSON is the source of truth for your show lineup (and, unless you override it from
the dashboard, your channel logo too). Host it anywhere public — the easiest option is
to put it right in this same GitHub repo and use its **raw** URL.

See `data/schedule.example.json` for the exact format:

```json
{
  "channel_name": "MyTV",
  "channel_logo": "https://your-host/channel-logo.png",
  "epoch": "2026-01-01T00:00:00Z",
  "shows": [
    {
      "name": "Pokemon Episode 1",
      "logo": "https://your-host/show-logo.png",
      "video_url": "https://your-host/authorized-video-1.mp4",
      "duration": 1800
    },
    {
      "name": "Authorized Programme 2",
      "logo": "https://your-host/show-logo-2.png",
      "video_url": "https://your-host/authorized-video-2.m3u8",
      "duration": 1800
    }
  ]
}
```

- `shows` plays in the order listed, then **loops forever** — like a real broadcast day repeating.
- `duration` (seconds) is optional. If you leave it out, the server probes the video
  once with `ffprobe` and caches the result in Neon, so it only happens once.
- `logo` per show is optional — if omitted, no show-logo/top-left icon is drawn (only the "Now:" text banner still shows).
- `epoch` is optional — it just lets you align "the start of the loop" to a specific
  real-world moment. Leave it out if you don't care.
- `video_url` can be an MP4, MKV, or M3U8 URL — ffmpeg reads all three natively.

You can update this JSON any time; the server re-fetches it every
`SCHEDULE_REFRESH_SECONDS` (default 60s).

**Why both "logo from JSON" and "logo from dashboard" work together:** the dashboard
writes your override into Neon. On every refresh, the server uses the dashboard value
if one is set, otherwise falls back to whatever `channel_logo` says in the JSON. So you
can set a default in the JSON, then freely override it live from the dashboard without
editing/redeploying anything.

---

## 5. Push this project to GitHub

```bash
cd tv-channel-server
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

---

## 6. Deploy to Render

**Option A — Blueprint (recommended, one click):**
1. In Render, click **New > Blueprint**, and point it at your GitHub repo. It will read `render.yaml` automatically.
2. Render will ask you to fill in the secret env vars it left blank (`DATABASE_URL`, `ADMIN_PASSWORD`, `SCHEDULE_SOURCE_URL`). Fill them in.
3. Click **Apply** — Render builds the Docker image (installs ffmpeg) and deploys.

**Option B — Manual Web Service:**
1. **New > Web Service**, connect your repo, choose **Docker** as the runtime.
2. Add the environment variables listed in `.env.example` under Settings > Environment.
3. Deploy.

Either way, first build takes a few minutes (installing ffmpeg + node modules).

---

## 7. Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Neon Postgres connection string |
| `ADMIN_USER` | No (default `admin`) | Dashboard login username |
| `ADMIN_PASSWORD` | Yes | Dashboard login password |
| `SCHEDULE_SOURCE_URL` | Yes for URL mode / first database bootstrap | Public URL to your schedule JSON |
| `SCHEDULE_SOURCE_MODE` | No (default `url`) | `url` or `database`; database mode reads Neon `channel_schedule` |
| `SCHEDULE_REFRESH_SECONDS` | No (default 60) | How often to re-fetch the schedule JSON |
| `STREAM_WIDTH` / `STREAM_HEIGHT` | No (default 854x480) | Output resolution — lower if you see lag |
| `STREAM_FPS` | No (default 25) | Output frame rate, clamped to 15–30 |
| `STREAM_THREADS` | No (default 2) | FFmpeg encoder thread limit |
| `VIDEO_BUFSIZE` | No (default 1600k) | Encoder rate-control buffer |
| `STREAM_PRESET` | No (default `ultrafast`) | FFmpeg x264 preset; `ultrafast` uses less CPU |
| `VIDEO_BITRATE` | No (default `800k`) | Increase for quality only if CPU and bandwidth allow |
| `AUDIO_BITRATE` | No (default `96k`) | Audio bitrate |

---

## 7A. Use Neon as the schedule database (optional)

The default schedule source remains a public JSON URL so existing deployments keep working.
To store the schedule in Neon instead:

1. Set `DATABASE_URL` to your Neon pooled or direct PostgreSQL connection string.
2. Set `SCHEDULE_SOURCE_MODE=database`.
3. Keep `SCHEDULE_SOURCE_URL` configured during the first boot. If Neon has no schedule row yet, the worker imports that JSON into the `channel_schedule` table.
4. Restart the worker. After bootstrapping, Neon is the schedule source of truth.
5. To import a different JSON schedule manually, run:
   `node scripts/import-schedule-to-neon.js path/to/schedule.json`
   with `DATABASE_URL` available in the shell. The script requires `npm install` first.
6. The authenticated admin API also supports `PUT /api/admin/schedule` with a schedule JSON body while database mode is enabled.

This does **not** make Vercel a persistent FFmpeg worker. Keep the Node.js/FFmpeg process on a host that explicitly permits long-running processes. The worker itself serves `/live/stream.m3u8` and its local HLS segments; no separate object storage is required for the initial version.

## 7B. Static Vercel player

A lightweight HLS player is included at `public/player.html`. After deploying the `public` directory as static output on Vercel, open `/player` and enter the public HTTPS URL of the separate FFmpeg worker. The player remembers the URL in that browser only. It does not run FFmpeg and it does not replace the worker.

See `docs/DEPLOYMENT_BLUEPRINT.md` for the Neon schedule mode, Docker Compose worker setup, and deployment validation checklist.

## 8. Using it

- **Watch in VLC (or any player):** Media > Open Network Stream >
  `https://your-app.onrender.com/live/stream.m3u8`
- **Dashboard:** `https://your-app.onrender.com/dashboard` (login with `ADMIN_USER` / `ADMIN_PASSWORD`).
  Change the channel logo, see what's live right now, and force an immediate schedule refresh.
- **Raw JSON status endpoints**, useful for debugging or building your own player page:
  - `/api/nowplaying` — current show, offset, remaining time
  - `/api/config` — full merged schedule + channel branding
  - `/api/status` — encoder + schedule health

---

## 9. Troubleshooting

- **Stream won't load / 503 on `/api/nowplaying`**: schedule hasn't loaded yet. Check
  `SCHEDULE_SOURCE_URL` is publicly reachable (paste it in a browser) and check Render's logs.
- **ffprobe/duration errors in logs**: one of your `video_url`s isn't reachable from
  Render's servers, or needs a `duration` specified manually in the JSON.
- **Choppy video**: lower `STREAM_WIDTH`/`STREAM_HEIGHT`/`VIDEO_BITRATE`, or set
  `STREAM_PRESET=ultrafast`, or upgrade off the free Render plan.
- **Dashboard asks for login repeatedly / won't save**: double-check `ADMIN_USER` /
  `ADMIN_PASSWORD` are set in Render's environment variables (not just locally).

---

## 10. Running locally (optional, for testing before deploying)

```bash
npm install
cp .env.example .env   # then fill in your real values
npm start
```
Then open `http://localhost:10000/dashboard` and
`http://localhost:10000/live/stream.m3u8` in VLC.
