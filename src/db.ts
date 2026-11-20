import type { AniMedia } from "./anilist.ts";
import type { Row, Sql } from "./sql.ts";

export interface AnimeRow {
  anilist_id: number;
  mal_id: number | null;
  title_romaji: string;
  title_english: string | null;
  cover: string | null;
  banner: string | null;
  episodes_total: number | null;
  year: number | null;
  status: string | null;
  format: string | null;
}

export interface EpisodeRow {
  id: number;
  anilist_id: number;
  number: number;
  title: string | null;
  status: "pending" | "ready";
  file_name: string | null;
  mime: string | null;
  size: number;
  source_url: string | null;
  quality: string | null;
  intro_start: number | null;
  intro_end: number | null;
  outro_start: number | null;
  outro_end: number | null;
  subtitles: string | null;
  created_at: string;
  updated_at: string;
}

export type Db = ReturnType<typeof createDb>;

const schema = (pg: boolean) => [
  `CREATE TABLE IF NOT EXISTS anime (
    anilist_id INTEGER PRIMARY KEY,
    mal_id INTEGER,
    title_romaji TEXT NOT NULL,
    title_english TEXT,
    cover TEXT,
    banner TEXT,
    episodes_total INTEGER,
    year INTEGER,
    status TEXT,
    format TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS episodes (
    id ${pg ? "SERIAL" : "INTEGER"} PRIMARY KEY ${pg ? "" : "AUTOINCREMENT"},
    anilist_id INTEGER NOT NULL REFERENCES anime(anilist_id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    file_name TEXT,
    mime TEXT,
    size BIGINT NOT NULL DEFAULT 0,
    source_url TEXT,
    quality TEXT,
    intro_start ${pg ? "DOUBLE PRECISION" : "REAL"},
    intro_end ${pg ? "DOUBLE PRECISION" : "REAL"},
    outro_start ${pg ? "DOUBLE PRECISION" : "REAL"},
    outro_end ${pg ? "DOUBLE PRECISION" : "REAL"},
    subtitles TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (anilist_id, number)
  )`,
  `CREATE INDEX IF NOT EXISTS episodes_anime ON episodes (anilist_id, number)`,
];

const ep = (r: Row | undefined) => (r ? ({ ...r, size: Number(r.size) } as EpisodeRow) : undefined);
const now = () => new Date().toISOString();

export function createDb(sql: Sql) {
  let ready: Promise<void> | null = null;
  /** Creates the tables once per process, before the first query. */
  const init = () =>
    (ready ??= (async () => {
      for (const stmt of schema(sql.dialect === "postgres")) await sql.query(stmt);
    })().catch((e) => {
      ready = null;
      throw e;
    }));
  const q = async (text: string, params: unknown[] = []) => {
    await init();
    return sql.query(text, params);
  };

  return {
    dialect: sql.dialect,
    close: () => sql.close(),
    init,

    async upsertAnime(m: AniMedia): Promise<AnimeRow> {
      await q(
        `INSERT INTO anime (anilist_id, mal_id, title_romaji, title_english, cover, banner, episodes_total, year, status, format)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (anilist_id) DO UPDATE SET mal_id=EXCLUDED.mal_id, title_romaji=EXCLUDED.title_romaji,
           title_english=EXCLUDED.title_english, cover=EXCLUDED.cover, banner=EXCLUDED.banner,
           episodes_total=EXCLUDED.episodes_total, year=EXCLUDED.year, status=EXCLUDED.status, format=EXCLUDED.format`,
        [m.id, m.idMal, m.titleRomaji, m.titleEnglish, m.cover, m.banner, m.episodes, m.year, m.status, m.format],
      );
      return (await q(`SELECT * FROM anime WHERE anilist_id = $1`, [m.id]))[0] as AnimeRow;
    },
    async anime(id: number): Promise<AnimeRow | undefined> {
      return (await q(`SELECT * FROM anime WHERE anilist_id = $1`, [id]))[0] as AnimeRow | undefined;
    },
    async allAnime(): Promise<(AnimeRow & { ready_count: number })[]> {
      const rows = await q(
        `SELECT a.*, CAST((SELECT COUNT(*) FROM episodes e WHERE e.anilist_id = a.anilist_id AND e.status = 'ready') AS INTEGER) AS ready_count
         FROM anime a ORDER BY LOWER(a.title_romaji)`,
      );
      return rows as (AnimeRow & { ready_count: number })[];
    },
    async deleteAnime(id: number): Promise<boolean> {
      return (await q(`DELETE FROM anime WHERE anilist_id = $1 RETURNING anilist_id`, [id])).length > 0;
    },

    async episodes(animeId: number): Promise<EpisodeRow[]> {
      return (await q(`SELECT * FROM episodes WHERE anilist_id = $1 ORDER BY number`, [animeId])).map((r) => ep(r)!);
    },
    async episodeByNumber(animeId: number, n: number) {
      return ep((await q(`SELECT * FROM episodes WHERE anilist_id = $1 AND number = $2`, [animeId, n]))[0]);
    },
    async episode(id: number) {
      return ep((await q(`SELECT * FROM episodes WHERE id = $1`, [id]))[0]);
    },
    async createEpisode(animeId: number, number: number, title: string | null, quality: string | null): Promise<EpisodeRow> {
      const t = now();
      return ep(
        (
          await q(
            `INSERT INTO episodes (anilist_id, number, title, quality, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
            [animeId, number, title, quality, t],
          )
        )[0],
      )!;
    },
    /** Updates only the given columns (names come from code, never from the request). */
    async updateEpisode(id: number, fields: Partial<Omit<EpisodeRow, "id" | "anilist_id" | "created_at">>) {
      const entries = Object.entries({ ...fields, updated_at: now() });
      const sets = entries.map(([k], i) => `${k} = $${i + 1}`).join(", ");
      const rows = await q(`UPDATE episodes SET ${sets} WHERE id = $${entries.length + 1} RETURNING *`, [...entries.map(([, v]) => v), id]);
      return ep(rows[0]);
    },
    async deleteEpisode(id: number): Promise<boolean> {
      return (await q(`DELETE FROM episodes WHERE id = $1 RETURNING id`, [id])).length > 0;
    },
  };
}
