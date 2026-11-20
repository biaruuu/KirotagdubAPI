import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { handleBlobUpload, removeBlob, isBlobUrl } from "./blob.ts";
import { extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AniListClient } from "./anilist.ts";
import type { Config } from "./config.ts";
import type { AnimeRow, Db, EpisodeRow } from "./db.ts";

export interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  req: IncomingMessage;
  json(): Promise<any>;
}

export interface Res {
  status?: number;
  json?: unknown;
  html?: string;
  file?: { path: string; mime: string };
  headers?: Record<string, string>;
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  admin?: boolean;
  handle(ctx: Ctx): Promise<Res> | Res;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
};
const BY_TYPE: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/quicktime": ".mov",
};

const isHttp = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/\S+$/i.test(v);

function int(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new ApiError(400, `${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function optText(v: unknown, name: string, max = 200): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max) throw new ApiError(400, `${name} must be text up to ${max} characters`);
  return v.trim();
}

function span(v: unknown, name: string): [number | null, number | null] {
  if (v === null) return [null, null];
  const s = (v as any)?.start, e = (v as any)?.end;
  if (typeof s !== "number" || typeof e !== "number" || s < 0 || e <= s) throw new ApiError(400, `${name} needs start and end in seconds, end after start`);
  return [s, e];
}

export function createRoutes(db: Db, anilist: AniListClient, config: Config): Route[] {
  const baseUrl = (ctx: Ctx) => {
    if (config.publicUrl) return config.publicUrl;
    const proto = String(ctx.headers["x-forwarded-proto"] || "http").split(",")[0];
    return `${proto}://${ctx.headers.host || "localhost"}`;
  };

  const animeJson = (a: AnimeRow) => ({
    anilistId: a.anilist_id,
    malId: a.mal_id,
    title: { romaji: a.title_romaji, english: a.title_english },
    cover: a.cover,
    banner: a.banner,
    totalEpisodes: a.episodes_total,
    year: a.year,
    status: a.status,
    format: a.format,
  });

  const episodeJson = (e: EpisodeRow) => ({
    id: e.id,
    number: e.number,
    title: e.title || `Episode ${e.number}`,
    ready: e.status === "ready",
    quality: e.quality,
    size: e.size,
    hasFile: !!e.file_name,
    sourceUrl: e.source_url,
    intro: e.intro_end ? { start: e.intro_start, end: e.intro_end } : null,
    outro: e.outro_end ? { start: e.outro_start, end: e.outro_end } : null,
    subtitles: e.subtitles ? JSON.parse(e.subtitles) : [],
    audio: "dub",
    language: "tl",
    watch: `/api/watch/${e.anilist_id}/${e.number}`,
  });

  async function ensureAnime(id: number): Promise<AnimeRow> {
    const have = await db.anime(id);
    if (have) return have;
    let media;
    try {
      media = await anilist.byId(id);
    } catch (e) {
      throw new ApiError(502, `AniList did not answer: ${(e as Error).message}`);
    }
    if (!media) throw new ApiError(404, `AniList has no anime with id ${id}`);
    return await db.upsertAnime(media);
  }

  const episodeOr404 = async (id: string): Promise<EpisodeRow> => {
    const e = await db.episode(int(id, "id", 1, Number.MAX_SAFE_INTEGER));
    if (!e) throw new ApiError(404, "Episode not found");
    return e;
  };

  /** Deletes what an episode stored: its disk file, or its Vercel Blob. */
  const removeStored = async (e: Pick<EpisodeRow, "file_name" | "source_url">) => {
    if (e.file_name) await rm(join(config.videoDir, e.file_name), { force: true });
    if (isBlobUrl(e.source_url)) await removeBlob(e.source_url!);
  };

  const ready = (e: EpisodeRow) => e.status === "ready" && (e.file_name || e.source_url);

  return [
    { method: "GET", path: "/api/health", handle: async () => ({ json: { ok: true, anime: (await db.allAnime()).length } }) },

    {
      method: "GET",
      path: "/api/search",
      async handle(ctx) {
        const q = (ctx.query.get("q") || "").trim();
        if (q.length < 2) throw new ApiError(400, "q needs at least 2 characters");
        let found;
        try {
          found = await anilist.search(q);
        } catch (e) {
          throw new ApiError(502, `AniList did not answer: ${(e as Error).message}`);
        }
        const results = await Promise.all(found.map(async (m) => {
          const eps = (await db.episodes(m.id)).filter(ready);
          return {
            anilistId: m.id,
            malId: m.idMal,
            title: { romaji: m.titleRomaji, english: m.titleEnglish },
            cover: m.cover,
            totalEpisodes: m.episodes,
            year: m.year,
            format: m.format,
            tagalog: { available: eps.length > 0, episodes: eps.length },
          };
        }));
        return { json: { success: true, results } };
      },
    },

    {
      method: "GET",
      path: "/api/anime",
      handle: async () => ({
        json: {
          success: true,
          anime: (await db.allAnime()).map((a) => ({ ...animeJson(a), tagalogEpisodes: a.ready_count })),
        },
      }),
    },

    {
      method: "GET",
      path: "/api/anime/:id",
      async handle(ctx) {
        const id = int(ctx.params.id, "id", 1, 2_000_000_000);
        const a = await db.anime(id);
        if (!a) throw new ApiError(404, "No Tagalog dub for this anime");
        const eps = await db.episodes(id);
        return {
          json: {
            success: true,
            ...animeJson(a),
            audio: "dub",
            language: "tl",
            episodes: eps.map(episodeJson),
          },
        };
      },
    },

    {
      method: "GET",
      path: "/api/watch/:id/:episode",
      async handle(ctx) {
        const id = int(ctx.params.id, "id", 1, 2_000_000_000);
        const n = int(ctx.params.episode, "episode", 1, 9999);
        const e = await db.episodeByNumber(id, n);
        if (!e || !ready(e)) throw new ApiError(404, `No Tagalog dub for episode ${n}`);
        const streams = [];
        if (e.file_name) {
          streams.push({
            server: "Kiro Tagalog",
            url: `${baseUrl(ctx)}/stream/${e.id}/${encodeURIComponent(`episode-${e.number}${extname(e.file_name)}`)}`,
            type: "mp4",
            quality: e.quality,
            headers: {} as Record<string, string>,
          });
        }
        if (e.source_url) {
          streams.push({
            server: e.file_name ? "Kiro Tagalog (mirror)" : "Kiro Tagalog",
            url: e.source_url,
            type: /\.m3u8(\?|$)/i.test(e.source_url) ? "hls" : "mp4",
            quality: e.quality,
            headers: {} as Record<string, string>,
          });
        }
        const a = await db.anime(id);
        return {
          json: {
            success: true,
            anilistId: id,
            malId: a?.mal_id ?? null,
            episode: n,
            title: e.title || `Episode ${n}`,
            audio: "dub",
            language: "tl",
            streams,
            subtitles: e.subtitles ? JSON.parse(e.subtitles) : [],
            intro: e.intro_end ? { start: e.intro_start, end: e.intro_end } : null,
            outro: e.outro_end ? { start: e.outro_start, end: e.outro_end } : null,
          },
          headers: { "Cache-Control": "public, max-age=60" },
        };
      },
    },

    {
      method: "GET",
      path: "/stream/:id/:name",
      async handle(ctx) {
        const e = await episodeOr404(ctx.params.id);
        if (!e.file_name) throw new ApiError(404, "This episode has no uploaded file");
        return { file: { path: join(config.videoDir, e.file_name), mime: e.mime || "application/octet-stream" } };
      },
    },

    // ------------------------------------------------------------------ admin
    { method: "GET", path: "/api/admin/check", admin: true, handle: () => ({ json: { success: true, storage: config.mode === "cloud" ? "blob" : "disk" } }) },

    {
      method: "POST",
      path: "/api/admin/anime",
      admin: true,
      async handle(ctx) {
        const body = await ctx.json();
        const a = await ensureAnime(int(body?.anilistId, "anilistId", 1, 2_000_000_000));
        return { status: 201, json: { success: true, ...animeJson(a) } };
      },
    },

    {
      method: "DELETE",
      path: "/api/admin/anime/:id",
      admin: true,
      async handle(ctx) {
        const id = int(ctx.params.id, "id", 1, 2_000_000_000);
        const eps = await db.episodes(id);
        if (!(await db.deleteAnime(id))) throw new ApiError(404, "Anime not found");
        await Promise.all(eps.map((e) => removeStored(e).catch(() => {})));
        return { json: { success: true } };
      },
    },

    {
      method: "POST",
      path: "/api/admin/episodes",
      admin: true,
      async handle(ctx) {
        const b = await ctx.json();
        const id = int(b?.anilistId, "anilistId", 1, 2_000_000_000);
        const n = int(b?.number, "number", 1, 9999);
        const source = b?.sourceUrl ?? null;
        if (source !== null && !isHttp(source)) throw new ApiError(400, "sourceUrl must be an http(s) address");
        await ensureAnime(id);
        if (await db.episodeByNumber(id, n)) throw new ApiError(409, `Episode ${n} already exists`);
        let e = await db.createEpisode(id, n, optText(b?.title, "title"), optText(b?.quality, "quality", 12));
        if (source) e = (await db.updateEpisode(e.id, { source_url: source, status: "ready" }))!;
        return { status: 201, json: { success: true, episode: episodeJson(e) } };
      },
    },

    {
      method: "PATCH",
      path: "/api/admin/episodes/:id",
      admin: true,
      async handle(ctx) {
        const e = await episodeOr404(ctx.params.id);
        const b = await ctx.json();
        const f: Parameters<Db["updateEpisode"]>[1] = {};
        if ("title" in (b ?? {})) f.title = optText(b.title, "title");
        if ("quality" in b) f.quality = optText(b.quality, "quality", 12);
        if ("sourceUrl" in b) {
          if (b.sourceUrl !== null && !isHttp(b.sourceUrl)) throw new ApiError(400, "sourceUrl must be an http(s) address or null");
          f.source_url = b.sourceUrl;
          f.status = b.sourceUrl || e.file_name ? "ready" : "pending";
        }
        if ("intro" in b) [f.intro_start, f.intro_end] = span(b.intro, "intro");
        if ("outro" in b) [f.outro_start, f.outro_end] = span(b.outro, "outro");
        if ("subtitles" in b) {
          if (!Array.isArray(b.subtitles) || b.subtitles.length > 12) throw new ApiError(400, "subtitles must be a list of up to 12");
          const list = b.subtitles.map((s: any) => {
            if (!isHttp(s?.url)) throw new ApiError(400, "each subtitle needs an http(s) url");
            return { url: s.url, label: optText(s.label, "label", 40) || "Tagalog", language: optText(s.language, "language", 8) || "tl" };
          });
          f.subtitles = list.length ? JSON.stringify(list) : null;
        }
        const saved = (await db.updateEpisode(e.id, f))!;
        // A replaced or cleared Vercel Blob is no longer needed.
        if ("sourceUrl" in b && e.source_url !== saved.source_url && isBlobUrl(e.source_url)) await removeBlob(e.source_url!).catch(() => {});
        return { json: { success: true, episode: episodeJson(saved) } };
      },
    },

    {
      // Browser uploads go straight to Vercel Blob, so the 4.5 MB request limit never applies.
      // This route only hands out upload tokens (and receives Vercel's "upload finished" call).
      method: "POST",
      path: "/api/admin/blob",
      async handle(ctx) {
        if (config.mode !== "cloud") throw new ApiError(404, "Blob uploads are only used on the hosted version");
        const body = await ctx.json();
        const json = await handleBlobUpload(body, ctx.req, (clientPayload) => {
          if (!isAdmin({ "x-api-key": clientPayload ?? "" }, config.adminKey)) throw new ApiError(401, "Missing or wrong admin key");
        });
        return { json };
      },
    },

    {
      method: "PUT",
      path: "/api/admin/episodes/:id/file",
      admin: true,
      async handle(ctx) {
        if (config.mode === "cloud") throw new ApiError(501, "This server stores videos in Vercel Blob; upload from the admin page");
        const e = await episodeOr404(ctx.params.id);
        const type = String(ctx.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        const nameExt = extname(ctx.query.get("filename") || "").toLowerCase();
        const ext = MIME[nameExt] ? nameExt : BY_TYPE[type];
        if (!ext) throw new ApiError(415, "Send an .mp4, .webm, .mkv or .mov video (Content-Type video/* or ?filename=)");
        const length = Number(ctx.headers["content-length"] || 0);
        if (length > config.maxUploadBytes) throw new ApiError(413, "File is larger than MAX_UPLOAD_MB");

        const name = `${e.anilist_id}-${e.number}-${Date.now()}${ext}`;
        const target = join(config.videoDir, name);
        const part = `${target}.part`;
        let size = 0;
        const limit = new Transform({
          transform(chunk, _enc, cb) {
            size += chunk.length;
            if (size > config.maxUploadBytes) cb(new ApiError(413, "File is larger than MAX_UPLOAD_MB"));
            else cb(null, chunk);
          },
        });
        try {
          await pipeline(ctx.req, limit, createWriteStream(part));
          if (size === 0) throw new ApiError(400, "The upload was empty");
          await rename(part, target);
        } catch (err) {
          await rm(part, { force: true });
          throw err;
        }
        if (e.file_name) await rm(join(config.videoDir, e.file_name), { force: true });
        const updated = (await db.updateEpisode(e.id, { file_name: name, mime: MIME[ext], size, status: "ready" }))!;
        return { json: { success: true, episode: episodeJson(updated) } };
      },
    },

    {
      method: "DELETE",
      path: "/api/admin/episodes/:id",
      admin: true,
      async handle(ctx) {
        const e = await episodeOr404(ctx.params.id);
        await db.deleteEpisode(e.id);
        await removeStored(e).catch(() => {});
        return { json: { success: true } };
      },
    },
  ];
}

/** Constant-time check of the admin key from `x-api-key` or `Authorization: Bearer`. */
export function isAdmin(headers: IncomingHttpHeaders, key: string): boolean {
  const auth = String(headers.authorization || "");
  const given = String(headers["x-api-key"] || (auth.startsWith("Bearer ") ? auth.slice(7) : ""));
  const a = Buffer.from(given), b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}
