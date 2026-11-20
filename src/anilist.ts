export interface AniMedia {
  id: number;
  idMal: number | null;
  titleRomaji: string;
  titleEnglish: string | null;
  cover: string | null;
  banner: string | null;
  episodes: number | null;
  year: number | null;
  status: string | null;
  format: string | null;
}

export interface AniListClient {
  search(query: string): Promise<AniMedia[]>;
  byId(id: number): Promise<AniMedia | null>;
}

const FIELDS = `id idMal title { romaji english } coverImage { large } bannerImage episodes seasonYear status format`;

function toMedia(m: any): AniMedia {
  return {
    id: m.id,
    idMal: m.idMal ?? null,
    titleRomaji: m.title?.romaji ?? m.title?.english ?? `Anime ${m.id}`,
    titleEnglish: m.title?.english ?? null,
    cover: m.coverImage?.large ?? null,
    banner: m.bannerImage ?? null,
    episodes: m.episodes ?? null,
    year: m.seasonYear ?? null,
    status: m.status ?? null,
    format: m.format ?? null,
  };
}

/** AniList's public GraphQL API. `fetchImpl` can be swapped in tests. */
export function createAniList(fetchImpl: typeof fetch = fetch): AniListClient {
  async function gql(query: string, variables: Record<string, unknown>): Promise<any> {
    const res = await fetchImpl("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || json?.errors) {
      if (res.status === 404) return null;
      throw new Error(json?.errors?.[0]?.message || `AniList ${res.status}`);
    }
    return json?.data;
  }
  return {
    async search(q) {
      const data = await gql(
        `query($s:String){Page(perPage:12){media(search:$s,type:ANIME,sort:SEARCH_MATCH){${FIELDS}}}}`,
        { s: q },
      );
      return (data?.Page?.media ?? []).map(toMedia);
    },
    async byId(id) {
      const data = await gql(`query($id:Int){Media(id:$id,type:ANIME){${FIELDS}}}`, { id });
      return data?.Media ? toMedia(data.Media) : null;
    },
  };
}
