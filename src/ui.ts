import { readFileSync } from "node:fs";
import type { Route } from "./api.ts";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

/** The admin page: one static HTML file that talks to the API. */
export const uiRoute: Route = { method: "GET", path: "/", handle: () => ({ html: page }) };
