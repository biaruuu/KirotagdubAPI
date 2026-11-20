import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ApiError, type Route } from "./api.ts";
import { run, send, sendError } from "./respond.ts";

function matcher(path: string): RegExp {
  return new RegExp("^" + path.replace(/:([A-Za-z]+)/g, "(?<$1>[^/]+)") + "/?$");
}

/** One (req, res) function for all routes. Works on Node's http server and as a Vercel function. */
export function createHandler(routes: Route[], adminKey: string) {
  const table = routes.map((r) => ({ r, re: matcher(r.path) }));
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url || "/", "http://x").pathname;
    const method = req.method === "HEAD" ? "GET" : req.method;
    if (req.method === "OPTIONS") return void (await send(req, res, { status: 204 }));
    for (const { r, re } of table) {
      const m = r.method === method ? re.exec(path) : null;
      if (m) {
        const params = Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        return void (await run(r, req, res, params, adminKey));
      }
    }
    await sendError(req, res, new ApiError(404, "Not found"));
  };
}

export function createNodeServer(routes: Route[], adminKey: string): Server {
  return createServer(createHandler(routes, adminKey));
}
