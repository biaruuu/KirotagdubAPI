import { buildApp } from "./app.ts";
import { createNodeServer } from "./handler.ts";
import { uiRoute } from "./ui.ts";

const { config, routes } = await buildApp();

createNodeServer([uiRoute, ...routes], config.adminKey).listen(config.port, () => {
  console.log(`Tagalog dub API on http://localhost:${config.port}  (${config.mode}, data: ${config.dataDir})`);
});
