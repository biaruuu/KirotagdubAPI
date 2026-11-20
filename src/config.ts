import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Config {
  /** "local": SQLite file and videos on disk. "cloud": Postgres (DATABASE_URL) and Vercel Blob. */
  mode: "local" | "cloud";
  databaseUrl: string;
  port: number;
  dataDir: string;
  videoDir: string;
  adminKey: string;
  publicUrl: string;
  maxUploadBytes: number;
}

/** Reads settings from the environment. Folders are created; the admin key is generated once if missing. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const databaseUrl = (env.DATABASE_URL || "").trim();
  const mode = databaseUrl ? "cloud" : "local";
  const dataDir = resolve(env.DATA_DIR || "./data");
  const videoDir = join(dataDir, "videos");
  let adminKey = (env.ADMIN_KEY || "").trim();
  if (mode === "cloud") {
    // Serverless hosts have no writable disk: the key must come from the environment.
    if (!adminKey) throw new Error("Set ADMIN_KEY in the environment");
  } else {
    mkdirSync(videoDir, { recursive: true });
  }
  if (!adminKey) {
    const file = join(dataDir, "admin.key");
    if (existsSync(file)) adminKey = readFileSync(file, "utf8").trim();
    else {
      adminKey = randomBytes(18).toString("base64url");
      writeFileSync(file, adminKey, { mode: 0o600 });
      console.log(`Admin key (saved in ${file}): ${adminKey}`);
    }
  }
  return {
    mode,
    databaseUrl,
    port: Number(env.PORT) || 8787,
    dataDir,
    videoDir,
    adminKey,
    publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, ""),
    maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 4096) * 1024 * 1024,
  };
}
