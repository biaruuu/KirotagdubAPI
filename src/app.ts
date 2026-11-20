import { createRoutes } from "./api.ts";
import { createAniList } from "./anilist.ts";
import { loadConfig, type Config } from "./config.ts";
import { createDb } from "./db.ts";
import { postgresSql, sqliteSql } from "./sql.ts";

/** Opens the database for the current mode and builds the routes. */
export async function buildApp(config: Config = loadConfig()) {
  const sql = config.mode === "cloud" ? await postgresSql(config.databaseUrl) : sqliteSql(config.dataDir);
  const db = createDb(sql);
  return { config, db, routes: createRoutes(db, createAniList(), config) };
}
