import express from "express";
import { ApiError } from "./api.ts";
import { buildApp } from "./app.ts";
import { run, send, sendError } from "./respond.ts";
import { uiRoute } from "./ui.ts";

const { config, routes: apiRoutes } = await buildApp();
const routes = [uiRoute, ...apiRoutes];

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// CORS preflight for browsers and web players.
app.options("/{*path}", (req, res) => {
  void send(req, res, { status: 204 });
});

// Express only matches the routes; the handlers read the request body themselves.
for (const r of routes) {
  const register = { GET: app.get, POST: app.post, PUT: app.put, PATCH: app.patch, DELETE: app.delete }[r.method].bind(app);
  register(r.path, (req, res) => {
    void run(r, req, res, { ...(req.params as Record<string, string>) }, config.adminKey);
  });
}

app.use((req, res) => {
  void sendError(req, res, new ApiError(404, "Not found"));
});

app.listen(config.port, () => {
  console.log(`Tagalog dub API on http://localhost:${config.port}  (${config.mode}, data: ${config.dataDir})`);
});
