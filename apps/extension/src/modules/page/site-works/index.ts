/** Reads JSON from a path on the page's own site, with the reader's cookies. */
export type FetchJson = (path: string) => Promise<unknown>;

const sameSite: FetchJson = async (path) => {
  const response = await fetch(new URL(path, location.origin), { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const PIXIV = "www.pixiv.net";
// pixiv serves its pages with or without a language prefix (`/en/...`).
const PIXIV_NOVEL = /^(?:\/[a-z]{2})?\/novel\/show\.php$/;
const PIXIV_SERIES = /^(?:\/[a-z]{2})?\/novel\/series\/(\d+)\/?$/;

/**
 * The work a page belongs to, on sites that publish many unrelated works under one origin: a
 * pixiv novel's series (`novel/series/<id>`), or the novel itself when it's a one-shot. Site
 * context is kept per work, so one story's names and voice don't leak into another's, while the
 * chapters of a series share theirs. Other pages have no work and share their site's context.
 *
 * Which series a novel is in comes from pixiv's own API on the same site, the one its pages read;
 * when that fails, the novel stands alone.
 */
export async function workOf(url: string, fetchJson: FetchJson = sameSite): Promise<string | undefined> {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return undefined;
  }
  if (page.hostname !== PIXIV) return undefined;
  const series = PIXIV_SERIES.exec(page.pathname);
  if (series) return `novel/series/${series[1]}`;
  const id = page.searchParams.get("id");
  if (!PIXIV_NOVEL.test(page.pathname) || !id || !/^\d+$/.test(id)) return undefined;
  const seriesId = await fetchJson(`/ajax/novel/${id}`).then(pixivSeriesOf, () => undefined);
  return seriesId ? `novel/series/${seriesId}` : `novel/${id}`;
}

function pixivSeriesOf(reply: unknown): string | undefined {
  const seriesId = (reply as { body?: { seriesNavData?: { seriesId?: unknown } | null } } | null)?.body?.seriesNavData?.seriesId;
  return (typeof seriesId === "number" || typeof seriesId === "string") && /^\d+$/.test(String(seriesId)) ? String(seriesId) : undefined;
}
