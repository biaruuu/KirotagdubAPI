# Tagalog Dub API

Your own Tagalog-dub streaming source for Kiro. Upload an episode (or point to a video link), tie it to an anime by its **AniList id**, and the app can stream it like any other provider.

TypeScript on Node 22 (runs directly, no build step), Express for routing, SQLite for data (built into Node, nothing to install), AniList for titles and covers.

## Deploy on Vercel

Vercel has no permanent disk and limits requests to 4.5 MB, so the hosted version keeps data in **Postgres** and videos in **Vercel Blob**. The browser uploads each video straight to Blob.

1. Import this repo in Vercel (framework preset: Other). `vercel.json` already sets the build.
2. In the project's **Storage** tab add **Neon Postgres** (this creates `DATABASE_URL`) and **Blob** (creates `BLOB_READ_WRITE_TOKEN`).
3. Under **Settings → Environment Variables** add `ADMIN_KEY` (any long secret you choose).
4. Deploy, open your site, paste the admin key, search an anime, add episodes, upload videos.

Tables are created automatically on the first request.

## Run locally

```bash
npm install
npm start                 # http://localhost:8787
```

Without `DATABASE_URL` it uses a SQLite file and saves videos to `./data`. On first start an admin key is generated and printed (also in `data/admin.key`). Docker works too: `docker build -t tagdub-api . && docker run -p 8787:8787 -v tagdub:/data -e ADMIN_KEY=choose-one tagdub-api`.

## Public API (no key)

| Request | Returns |
|---|---|
| `GET /api/search?q=name` | AniList matches, each with `tagalog.available` and episode count |
| `GET /api/anime` | Every anime you added, with `tagalogEpisodes` |
| `GET /api/anime/:anilistId` | Info plus the episode list |
| `GET /api/watch/:anilistId/:episode` | The stream (below) |
| `GET /stream/:id/:name` | The video file, with Range support for seeking |

`/api/watch` answers:

```json
{
  "success": true, "anilistId": 154587, "malId": 52991, "episode": 1,
  "title": "Episode 1", "audio": "dub", "language": "tl",
  "streams": [{ "server": "Kiro Tagalog", "url": "https://…/stream/3/episode-1.mp4", "type": "mp4", "quality": "720p", "headers": {} }],
  "subtitles": [], "intro": { "start": 10, "end": 95 }, "outro": null
}
```

404 means there is no Tagalog dub for that episode.

## Admin API (header `X-Api-Key: <key>` or `Authorization: Bearer <key>`)

| Request | Body |
|---|---|
| `POST /api/admin/anime` | `{ "anilistId": 154587 }` |
| `DELETE /api/admin/anime/:anilistId` | removes the anime and its videos |
| `POST /api/admin/episodes` | `{ "anilistId", "number", "title?", "quality?", "sourceUrl?" }` (adds the anime if needed) |
| `PUT /api/admin/episodes/:id/file?filename=ep1.mp4` | local mode only: the raw video as the request body. On Vercel upload from the admin page, or host the file yourself and set `sourceUrl` |
| `PATCH /api/admin/episodes/:id` | any of `title`, `quality`, `sourceUrl` (http/https, `null` to clear), `intro`/`outro` `{start,end}`, `subtitles` `[{url,label,language}]` |
| `DELETE /api/admin/episodes/:id` | removes the episode and its video |

Upload from a script: `curl -X PUT -H "X-Api-Key: $KEY" -H "Content-Type: video/mp4" --data-binary @ep1.mp4 "$URL/api/admin/episodes/3/file?filename=ep1.mp4"`

## Tips

- Use **MP4 (H.264 + AAC)** so every phone plays it. MKV often fails on some devices.
- Local uploads are capped by `MAX_UPLOAD_MB` (default 4096). On Vercel, Blob accepts files up to 5 GB (storage and bandwidth follow your Vercel plan).

## Tests

`npm test` runs 14 tests against the real routes (auth, AniList lookup, upload, Range seeking, replace/delete, CORS). `npm run typecheck` checks types after `npm install`.
