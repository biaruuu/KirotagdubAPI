import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { ApiError, isAdmin, type Ctx, type Res, type Route } from "./api.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, Range",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
};

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new ApiError(413, "JSON body too large");
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "Body is not valid JSON");
  }
}

export function buildCtx(req: IncomingMessage, params: Record<string, string>): Ctx {
  const url = new URL(req.url || "/", "http://x");
  return { params, query: url.searchParams, headers: req.headers, req, json: () => readJson(req) };
}

/** Writes a handler result. Files are served with Range support so players can seek. */
export async function send(req: IncomingMessage, res: ServerResponse, r: Res): Promise<void> {
  const base = { ...CORS, ...r.headers };
  if (r.file) {
    let info;
    try {
      info = await stat(r.file.path);
    } catch {
      throw new ApiError(404, "The video file is missing on the server");
    }
    const size = info.size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    let start = 0, end = size - 1, status = 200;
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), size - 1);
      } else {
        start = Math.max(size - Number(range[2]), 0);
      }
      if (start >= size || start > end) {
        res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` }).end();
        return;
      }
      status = 206;
    }
    const headers: Record<string, string | number> = {
      ...base,
      "Content-Type": r.file.mime,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    };
    if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === "HEAD") return void res.end();
    createReadStream(r.file.path, { start, end }).on("error", () => res.destroy()).pipe(res);
    return;
  }
  const status = r.status ?? 200;
  if (status === 204) {
    res.writeHead(204, base).end();
    return;
  }
  if (r.html !== undefined) {
    res.writeHead(status, { ...base, "Content-Type": "text/html; charset=utf-8" }).end(r.html);
    return;
  }
  res.writeHead(status, { ...base, "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(r.json ?? {}));
}

export function sendError(req: IncomingMessage, res: ServerResponse, err: unknown): Promise<void> {
  const e = err instanceof ApiError ? err : new ApiError(500, "Something went wrong on the server");
  if (!(err instanceof ApiError)) console.error(err);
  if (res.headersSent) {
    res.destroy();
    return Promise.resolve();
  }
  return send(req, res, { status: e.status, json: { success: false, error: e.message } });
}

/** Runs a route: admin check, then the handler. Shared by the Express app and the test server. */
export async function run(route: Route, req: IncomingMessage, res: ServerResponse, params: Record<string, string>, adminKey: string): Promise<void> {
  try {
    if (route.admin && !isAdmin(req.headers, adminKey)) throw new ApiError(401, "Missing or wrong admin key");
    await send(req, res, await route.handle(buildCtx(req, params)));
  } catch (err) {
    await sendError(req, res, err);
  }
}
