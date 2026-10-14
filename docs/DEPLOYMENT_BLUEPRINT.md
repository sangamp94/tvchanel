# TV Channel: Neon + Drive + Vercel + FFmpeg Worker Blueprint

This deployment keeps the existing FFmpeg/HLS worker separate from Vercel. It is designed for a single linear channel and does not require Cloudflare.

## Target architecture

- **GitHub**: source code and deployment history.
- **Vercel**: public website/player and optional control-plane UI. Do not run the long-lived FFmpeg worker in a Vercel Function.
- **Neon PostgreSQL**: schedule, channel metadata, logo overrides, duration cache and worker health metadata.
- **Google Drive**: optional archive/library for source files. Prefer stable, direct HTTPS MP4 URLs (for example, authorized Internet Archive files) in the schedule. Drive share pages are not guaranteed direct media URLs.
- **Linux worker**: runs this repository's Node.js process and FFmpeg. It generates and serves the live HLS playlist at `/live/stream.m3u8`.
- **HLS origin**: for the initial version, the worker serves its own HLS directory. This avoids adding a separate object-storage vendor. Keep the worker disk persistent or accept that a restart will regenerate the live playlist.

## Important free-tier constraint

No configuration can make a serverless function run forever. Vercel can host the website/API, but a continuous FFmpeg process needs a separate long-running worker. Free/no-card providers may suspend, sleep, limit CPU, or disallow continuous transcoding. Treat a candidate host as unapproved until it passes the validation checklist below.

## Neon setup

1. Create a Neon PostgreSQL project.
2. Copy the connection string and store it as `DATABASE_URL` in the worker's secret environment. Include `sslmode=require`.
3. Set `SCHEDULE_SOURCE_MODE=database`.
4. Keep `SCHEDULE_SOURCE_URL` configured for the first boot. If the Neon `channel_schedule` table has no row yet, the worker imports the JSON from this URL once. Subsequent refreshes read the stored Neon schedule.
5. To import or replace a schedule manually, run:
   ```bash
   npm install
   node scripts/import-schedule-to-neon.js data/schedule.json
   ```
   Run this command in an environment that has `DATABASE_URL` set. Never commit the real connection string.

The schema is created by `src/db.js` at worker startup. The authenticated admin API supports `PUT /api/admin/schedule` when database mode is enabled.

Example request body:
```json
{
  "schedule": {
    "channel_name": "Maha Cartoon TV",
    "channel_logo": "https://example.org/channel-logo.png",
    "epoch": "2026-10-14T00:00:00Z",
    "shows": [
      {
        "name": "Authorized Programme 1",
        "video_url": "https://archive.org/download/EXAMPLE/episode.mp4",
        "duration": 1800
      }
    ]
  }
}
```
Replace the example URL with a video you are authorized to rebroadcast.

## Worker deployment

The repository already contains a Dockerfile with Node.js and FFmpeg. On a Linux host with Docker Compose:

1. Clone the repository.
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_URL`, a strong `ADMIN_PASSWORD`, `SCHEDULE_SOURCE_MODE=database`, and a valid `SCHEDULE_SOURCE_URL` for first-time seeding.
4. Ensure the schedule only contains working, authorized HTTPS video URLs.
5. Run `docker compose up -d --build`.
6. Check `https://YOUR-WORKER-HOST/healthz`, `/api/status`, and `/live/stream.m3u8`.

The host must permit persistent processes, outbound source downloads, inbound HTTPS, and continuous FFmpeg. The included `docker-compose.yml` restarts the worker after a crash, but it cannot keep a suspended free host awake.

## Vercel setup

Use Vercel for the web player/front-end and lightweight APIs only:

- Set a public `WORKER_PUBLIC_URL` in the frontend deployment, pointing to the worker's HTTPS origin.
- The player should load `${WORKER_PUBLIC_URL}/live/stream.m3u8`.
- Do not expose `DATABASE_URL` or `ADMIN_PASSWORD) to browser code.
- If the Vercel UI calls worker APIs cross-origin, configure a strict allowlist for the deployed Vercel domain on the worker; do not enable unrestricted authenticated admin CORS.
- Do not deploy this worker's `src/server.js` as a Vercel Function expecting it to maintain FFmpeg or local HLS files.

The existing dashboard is served by the worker at `/dashboard`; the simplest first deployment is to use it there. A separate Vercel-hosted dashboard is a later frontend integration, not a prerequisite for the worker.

## HLS and playback

- The worker writes segments to `public/hls` and serves them from `/live`.
- Keep the HLS playlist's segment duration and cleanup settings consistent.
- A worker restart can cause a short playback interruption while FFmpeg recreates the playlist.
- Avoid downloading an entire source video every three minutes. Use direct source seeking or pre-generated authorized media where supported.
- If the worker host's disk is ephemeral, HLS files may disappear on restart; this design expects local temporary HLS output and a persistent process, not permanent VOD storage.

## Acceptance checklist before calling it live

- [ ] Worker stays running for at least 2–4 hours on the chosen host.
- [ ] `/healthz` responds over public HTTPS.
- [ ] `/live/stream.m3u8` and every referenced segment load in VLC.
- [ ] Source URL supports the needed HTTP range/seek behaviour, or full download is viable.
- [ ] Switching shows does not leave the playlist pointing to deleted segments.
- [ ] Restart recovery works and the schedule survives restart in Neon.
- [ ] Storage and bandwidth limits are understood for the expected number of viewers.
- [ ] All source videos are authorized for rebroadcast.

## What this blueprint does not promise

It does not guarantee a permanent free/no-card FFmpeg host or unlimited public bandwidth. Those are provider constraints, not code settings. Verify the actual worker host before announcing a 24/7 public channel.
