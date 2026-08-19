import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

const NOW = Date.now();
const HOUR = 3600000;

const SOURCES = [
  { id: 's1', name: 'テスト速報', category: 'ニュース', site: 'http://s1.example/', feed: 'http://s1.example/index.rdf', weight: 1, enabled: true },
  { id: 's2', name: 'ゲーム速報', category: 'ゲーム', site: 'http://s2.example/', feed: 'http://s2.example/index.rdf', weight: 1, enabled: true },
];

async function startApp() {
  const store = new Store('/dev/null');
  store.upsertArticles([
    { url: 'http://s1.example/1', title: '普通の記事', sourceId: 's1', sourceName: 'テスト速報', publishedAt: NOW - HOUR },
    { url: 'http://s1.example/2', title: 'ネタバレを含む記事', sourceId: 's1', sourceName: 'テスト速報', publishedAt: NOW - 2 * HOUR },
    { url: 'http://s2.example/1', title: '新作ゲームの話題', sourceId: 's2', sourceName: 'ゲーム速報', publishedAt: NOW - 3 * HOUR },
    { url: 'http://s2.example/2', title: '一週間前の記事', sourceId: 's2', sourceName: 'ゲーム速報', publishedAt: NOW - 200 * HOUR },
  ], { now: NOW });
  store.applyBookmarkCounts(new Map([['http://s2.example/1', 500]]), { now: NOW });

  const server = createApp({
    store,
    sources: SOURCES,
    onCrawl: async () => ({ ok: 2, failed: 0, added: 0 }),
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, store };
}

test('APIと静的ファイルの配信', async (t) => {
  const { server, base } = await startApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await t.test('GET /api/articles は新着順', async () => {
    const res = await fetch(`${base}/api/articles`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.tab, 'latest');
    assert.equal(json.items[0].title, '普通の記事');
    assert.equal(json.items[0].category, 'ニュース');
  });

  await t.test('GET /api/articles?tab=popular ははてブの多い記事が先頭', async () => {
    const json = await (await fetch(`${base}/api/articles?tab=popular`)).json();
    assert.equal(json.items[0].title, '新作ゲームの話題');
    assert.ok(json.items.every((a) => a.title !== '一週間前の記事'), '48時間より古い記事は出ない');
  });

  await t.test('検索・ブログ絞り込み・NGワードが効く', async () => {
    const q = await (await fetch(`${base}/api/articles?q=${encodeURIComponent('新作')}`)).json();
    assert.deepEqual(q.items.map((a) => a.title), ['新作ゲームの話題']);

    // ブログ名も検索対象なので、ブログ名で引くとそのブログの記事が並ぶ
    const byName = await (await fetch(`${base}/api/articles?q=${encodeURIComponent('ゲーム速報')}`)).json();
    assert.ok(byName.items.every((a) => a.sourceId === 's2'));
    assert.equal(byName.items.length, 2);

    const bySource = await (await fetch(`${base}/api/articles?sources=s1`)).json();
    assert.ok(bySource.items.every((a) => a.sourceId === 's1'));

    const ng = await (await fetch(`${base}/api/articles?ng=${encodeURIComponent('ネタバレ')}`)).json();
    assert.ok(ng.items.every((a) => !a.title.includes('ネタバレ')));
  });

  await t.test('limit と offset でページングできる', async () => {
    const page = await (await fetch(`${base}/api/articles?limit=1&offset=1`)).json();
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].title, 'ネタバレを含む記事');
    assert.equal(page.total, 4);
  });

  await t.test('GET /api/sources は記事数つきの一覧を返す', async () => {
    const json = await (await fetch(`${base}/api/sources`)).json();
    assert.equal(json.sources.length, 2);
    assert.equal(json.sources.find((s) => s.id === 's1').articleCount, 2);
  });

  await t.test('GET /api/status', async () => {
    const json = await (await fetch(`${base}/api/status`)).json();
    assert.equal(json.articleCount, 4);
    assert.equal(json.sourceCount, 2);
  });

  await t.test('POST /api/refresh はクロールを呼ぶ', async () => {
    const json = await (await fetch(`${base}/api/refresh`, { method: 'POST' })).json();
    assert.equal(json.ok, true);
    assert.equal(json.summary.ok, 2);
  });

  await t.test('未知のAPIは404、未知のページは index.html', async () => {
    assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
    const page = await fetch(`${base}/unknown-page`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /まとめのまとめ/);
  });

  await t.test('静的ファイルを配信する', async () => {
    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
  });

  await t.test('公開ディレクトリの外は読めない', async () => {
    const res = await fetch(`${base}/../package.json`);
    const body = await res.text();
    assert.ok(!body.includes('"scripts"'), 'package.json が漏れている');
  });
});
