import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createRoutes } from "../src/api.ts";
import { loadConfig } from "../src/config.ts";
import { createDb } from "../src/db.ts";
import { sqliteSql } from "../src/sql.ts";
import { createNodeServer } from "../src/handler.ts";
import { uiRoute } from "../src/ui.ts";
import { createAniList, type AniListClient, type AniMedia } from "../src/anilist.ts";

const media = (id: number, name: string): AniMedia => ({ id, idMal: id + 100, titleRomaji: name, titleEnglish: name + " EN", cover: "https://x/c.jpg", banner: null, episodes: 12, year: 2020, status: "FINISHED", format: "TV" });
const fake: AniListClient = {
  search: async (q) => (q === "boom" ? Promise.reject(new Error("down")) : [media(1, "Alpha"), media(2, "Beta")]),
  byId: async (id) => (id === 999 ? null : media(id, `Anime ${id}`)),
};

let server: Server, base: string, dir: string;
const KEY = "secret-key";
const auth = { "X-Api-Key": KEY };
const post = (path: string, body: unknown, headers: Record<string, string> = auth, method = "POST") =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tagdub-"));
  const config = loadConfig({ DATA_DIR: dir, ADMIN_KEY: KEY, MAX_UPLOAD_MB: "1" });
  const db = createDb(sqliteSql(config.dataDir));
  server = createNodeServer([uiRoute, ...createRoutes(db, fake, config)], KEY);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("tagalog dub api", () => {
  it("serves the admin page and health", async () => {
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Tagalog Dub/);
    assert.deepEqual((await (await fetch(base + "/api/health")).json()).ok, true);
  });

  it("rejects admin calls without the key", async () => {
    assert.equal((await post("/api/admin/anime", { anilistId: 1 }, {})).status, 401);
    assert.equal((await post("/api/admin/anime", { anilistId: 1 }, { "X-Api-Key": "nope" })).status, 401);
    assert.equal((await fetch(base + "/api/admin/check", { headers: { Authorization: `Bearer ${KEY}` } })).status, 200);
  });

  it("searches AniList and reports AniList failures", async () => {
    const ok = await (await fetch(base + "/api/search?q=alpha")).json();
    assert.equal(ok.results.length, 2);
    assert.equal(ok.results[0].tagalog.available, false);
    assert.equal((await fetch(base + "/api/search?q=a")).status, 400);
    assert.equal((await fetch(base + "/api/search?q=boom")).status, 502);
  });

  it("adds an anime by AniList id and refuses unknown ids", async () => {
    const r = await post("/api/admin/anime", { anilistId: 21 });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).title.romaji, "Anime 21");
    assert.equal((await post("/api/admin/anime", { anilistId: 999 })).status, 404);
    assert.equal((await post("/api/admin/anime", { anilistId: "abc" })).status, 400);
  });

  let epId = 0;
  it("creates episodes (auto-adding the anime) and blocks duplicates", async () => {
    const r = await post("/api/admin/episodes", { anilistId: 5, number: 1, title: "Simula", quality: "720p" });
    assert.equal(r.status, 201);
    epId = (await r.json()).episode.id;
    assert.equal((await post("/api/admin/episodes", { anilistId: 5, number: 1 })).status, 409);
    assert.equal((await post("/api/admin/episodes", { anilistId: 5, number: 0 })).status, 400);
    assert.equal((await post("/api/admin/episodes", { anilistId: 5, number: 2, sourceUrl: "ftp://x" })).status, 400);
  });

  it("has no stream until a video exists", async () => {
    assert.equal((await fetch(base + "/api/watch/5/1")).status, 404);
    const info = await (await fetch(base + "/api/anime/5")).json();
    assert.equal(info.episodes[0].ready, false);
  });

  const video = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  it("uploads a video, then serves it with ranges", async () => {
    const up = await fetch(`${base}/api/admin/episodes/${epId}/file?filename=ep1.mp4`, { method: "PUT", headers: { ...auth, "Content-Type": "video/mp4" }, body: video });
    assert.equal(up.status, 200);
    const watch = await (await fetch(base + "/api/watch/5/1")).json();
    assert.equal(watch.audio, "dub");
    assert.equal(watch.language, "tl");
    assert.equal(watch.streams[0].type, "mp4");
    assert.match(watch.streams[0].url, /\/stream\/\d+\/episode-1\.mp4$/);

    const url = watch.streams[0].url as string;
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), video);

    const part = await fetch(url, { headers: { Range: "bytes=100-199" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 100-199/5000");
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), video.subarray(100, 200));

    const tail = await fetch(url, { headers: { Range: "bytes=-50" } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), video.subarray(4950));
    assert.equal((await fetch(url, { headers: { Range: "bytes=9000-" } })).status, 416);
    assert.equal((await fetch(url, { method: "HEAD" })).headers.get("content-length"), "5000");
  });

  it("rejects wrong types, empty and oversized uploads and leaves no partial files", async () => {
    const put = (body: BodyInit, type = "video/mp4", q = "") => fetch(`${base}/api/admin/episodes/${epId}/file${q}`, { method: "PUT", headers: { ...auth, "Content-Type": type }, body });
    assert.equal((await put("x", "text/plain")).status, 415);
    assert.equal((await put("")).status, 400);
    assert.equal((await put(Buffer.alloc(1024 * 1024 + 10))).status, 413);
    assert.equal(readdirSync(join(dir, "videos")).filter((f) => f.endsWith(".part")).length, 0);
    assert.equal(readdirSync(join(dir, "videos")).length, 1);
  });

  it("replaces the video and removes the old file", async () => {
    await fetch(`${base}/api/admin/episodes/${epId}/file?filename=b.webm`, { method: "PUT", headers: auth, body: Buffer.alloc(100, 1) });
    const files = readdirSync(join(dir, "videos"));
    assert.equal(files.length, 1);
    assert.match(files[0], /\.webm$/);
  });

  it("stores mirror links, skip times and subtitles", async () => {
    const r = await post("/api/admin/episodes", { anilistId: 5, number: 2, sourceUrl: "https://cdn.example/ep2.m3u8" });
    const id = (await r.json()).episode.id;
    const p = await post(`/api/admin/episodes/${id}`, {
      intro: { start: 10, end: 95 },
      outro: { start: 1300, end: 1400 },
      subtitles: [{ url: "https://cdn.example/tl.vtt", label: "Tagalog" }],
    }, auth, "PATCH");
    assert.equal(p.status, 200);
    const w = await (await fetch(base + "/api/watch/5/2")).json();
    assert.equal(w.streams[0].type, "hls");
    assert.deepEqual(w.intro, { start: 10, end: 95 });
    assert.equal(w.subtitles[0].language, "tl");
    assert.equal((await post(`/api/admin/episodes/${id}`, { intro: { start: 50, end: 10 } }, auth, "PATCH")).status, 400);
    const cleared = await post(`/api/admin/episodes/${id}`, { sourceUrl: null }, auth, "PATCH");
    assert.equal((await cleared.json()).episode.ready, false);
    assert.equal((await fetch(base + "/api/watch/5/2")).status, 404);
  });

  it("lists library and flags Tagalog availability in search", async () => {
    const lib = await (await fetch(base + "/api/anime")).json();
    assert.equal(lib.anime.find((a: any) => a.anilistId === 5).tagalogEpisodes, 1);
    const s = await (await fetch(base + "/api/search?q=alpha")).json();
    assert.equal(s.results.find((r: any) => r.anilistId === 1).tagalog.available, false);
  });

  it("deletes an episode and an anime with their files", async () => {
    assert.equal((await fetch(`${base}/api/admin/episodes/${epId}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal(readdirSync(join(dir, "videos")).length, 0);
    assert.equal((await fetch(`${base}/api/admin/anime/5`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await fetch(base + "/api/anime/5")).status, 404);
    assert.equal((await fetch(base + "/nothing")).status, 404);
  });

  it("answers CORS preflight", async () => {
    const r = await fetch(base + "/api/watch/1/1", { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });
});

describe("anilist client", () => {
  it("maps the GraphQL answer", async () => {
    const stub = (async () => new Response(JSON.stringify({ data: { Page: { media: [{ id: 7, idMal: 8, title: { romaji: "R", english: null }, coverImage: { large: "c" }, bannerImage: null, episodes: 24, seasonYear: 2019, status: "FINISHED", format: "TV" }] } } }))) as unknown as typeof fetch;
    const r = await createAniList(stub).search("r");
    assert.equal(r[0].id, 7);
    assert.equal(r[0].titleRomaji, "R");
    assert.equal(r[0].year, 2019);
  });
});
