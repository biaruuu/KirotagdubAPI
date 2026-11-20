import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export type Row = Record<string, any>;

/** One tiny interface over both databases. SQL is written once with $1, $2 placeholders. */
export interface Sql {
  dialect: "sqlite" | "postgres";
  query(text: string, params?: unknown[]): Promise<Row[]>;
  close(): void;
}

/** SQLite file (or memory) through Node's built-in driver: local use and tests. */
export function sqliteSql(dataDir: string): Sql {
  const db = new DatabaseSync(dataDir === ":memory:" ? ":memory:" : join(dataDir, "tagdub.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return {
    dialect: "sqlite",
    async query(text, params = []) {
      const stmt = db.prepare(text.replace(/\$(\d+)/g, "?$1"));
      return stmt.all(...(params as (string | number | null)[])).map((r) => ({ ...r }));
    },
    close: () => db.close(),
  };
}

/** Postgres over HTTP (Neon), which works from serverless functions such as Vercel's. */
export async function postgresSql(url: string): Promise<Sql> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  return {
    dialect: "postgres",
    async query(text, params = []) {
      return (await sql.query(text, params as any[])) as Row[];
    },
    close() {},
  };
}
