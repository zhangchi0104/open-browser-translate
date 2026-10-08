import { strict as assert } from "node:assert";
import { test } from "node:test";
import { workOf, type FetchJson } from "../src/modules/page/site-works";

/** pixiv's novel API as it answers for novel 28553671, the first chapter of series 16174972. */
const pixiv = (series: Record<string, number>): FetchJson & { asked: string[] } => {
  const asked: string[] = [];
  return Object.assign(async (path: string) => {
    asked.push(path);
    const id = /^\/ajax\/novel\/(\d+)$/.exec(path)?.[1];
    if (!id) throw new Error(`unexpected ${path}`);
    return { error: false, body: { id, seriesNavData: series[id] ? { seriesId: series[id], order: 1 } : null } };
  }, { asked });
};

test("a pixiv novel belongs to its series, or stands alone when it has none", async () => {
  const fetchJson = pixiv({ 28553671: 16174972 });
  assert.equal(await workOf("https://www.pixiv.net/novel/show.php?id=28553671", fetchJson), "novel/series/16174972");
  assert.equal(await workOf("https://www.pixiv.net/en/novel/show.php?id=28553671#2", fetchJson), "novel/series/16174972");
  assert.equal(await workOf("https://www.pixiv.net/novel/show.php?id=42", fetchJson), "novel/42");
  assert.deepEqual(fetchJson.asked, ["/ajax/novel/28553671", "/ajax/novel/28553671", "/ajax/novel/42"]);
});

test("a series page is its series without asking; a failed lookup leaves the novel on its own", async () => {
  const failing: FetchJson = async () => { throw new Error("offline"); };
  assert.equal(await workOf("https://www.pixiv.net/novel/series/16174972", failing), "novel/series/16174972");
  assert.equal(await workOf("https://www.pixiv.net/novel/show.php?id=7", failing), "novel/7");
  assert.equal(await workOf("https://www.pixiv.net/novel/show.php?id=7", async () => ({ body: { seriesNavData: { seriesId: "../x" } } })), "novel/7");
});

test("other pages and sites have no work", async () => {
  const fetchJson = pixiv({});
  for (const url of [
    "https://www.pixiv.net/artworks/5",
    "https://www.pixiv.net/novel/show.php",
    "https://www.pixiv.net/novel/show.php?id=abc",
    "https://example.com/novel/show.php?id=1",
    "not a url",
  ]) assert.equal(await workOf(url, fetchJson), undefined, url);
  assert.deepEqual(fetchJson.asked, []);
});
