import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "./app.ts";
import { createHandler } from "./handler.ts";
import { sendError } from "./respond.ts";
import { ApiError } from "./api.ts";

// Built once per warm function instance. The admin page itself is static (public/index.html).
let handler: Promise<ReturnType<typeof createHandler>> | null = null;

export default async function vercel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    handler ??= buildApp().then(({ routes, config }) => createHandler(routes, config.adminKey));
    await (await handler)(req, res);
  } catch (err) {
    handler = null;
    console.error(err);
    await sendError(req, res, new ApiError(500, "The server is not set up yet: check DATABASE_URL and ADMIN_KEY"));
  }
}
