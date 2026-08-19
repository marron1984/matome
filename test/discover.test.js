import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feedLinksFromHtml, probeFeed, discoverFeed, verifySources, resolveCandidates } from '../src/discover.js';
import { loadSources, saveSources } from '../src/config.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>実在するまとめ</title><link>http://example.jp/</link>
<item><title>記事1</title><link>http://example.jp/1</link><pubDate>Tue, 19 Aug 2026 04:00:00 GMT</pubDate></item>
</channel></rss>`;

/** いろいろな「フィードの置き場所」を再現するサイトを立てる。 */
async function startSite(routes) {
  const server = createServer((req, res) => {
    const handler = routes[req.url.split('?')[0]];
    if (!handler) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': handler.type });
    res.end(handler.body);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('feedLinksFromHtml は rel=alternate のフィードだけを拾い、RSS/AtomをRDFより優先する', () => {
  const html = `<html><head>
    <link rel="stylesheet" href="/a.css">
    <link rel="alternate" type="application/rdf+xml" href="/index.rdf">
    <link rel="alternate" type="application/atom+xml" href="/atom.xml">
    <link rel="alternate" type="text/html" href="/mobile">
  </head></html>`;
  const links = feedLinksFromHtml(html, 'http://example.jp/blog/');
  assert.deepEqual(links.map((l) => l.url), ['http://example.jp/atom.xml', 'http://example.jp/index.rdf']);
});

test('probeFeed は読めるフィードだけ ok=true にする', async (t) => {
  const { server, base } = await startSite({
    '/feed': { type: 'application/xml', body: FEED },
    '/empty': { type: 'application/xml', body: '<rss><channel><title>空</title></channel></rss>' },
    '/html': { type: 'text/html', body: '<html><body>ただのページ</body></html>' },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const ok = await probeFeed(`${base}/feed`);
  assert.equal(ok.ok, true);
  assert.equal(ok.title, '実在するまとめ');
  assert.equal(ok.count, 1);
  assert.equal(ok.latest, Date.parse('Tue, 19 Aug 2026 04:00:00 GMT'));

  assert.equal((await probeFeed(`${base}/empty`)).ok, false);
  assert.equal((await probeFeed(`${base}/html`)).ok, false);
  assert.equal((await probeFeed(`${base}/missing`)).ok, false);
});

test('discoverFeed: フィードURLを直接渡した場合', async (t) => {
  const { server, base } = await startSite({ '/index.rdf': { type: 'application/xml', body: FEED } });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const found = await discoverFeed(`${base}/index.rdf`);
  assert.equal(found.ok, true);
  assert.equal(found.via, 'direct');
});

test('discoverFeed: サイトURLからHTML内のリンクをたどる', async (t) => {
  const { server, base } = await startSite({
    '/': { type: 'text/html', body: '<html><head><link rel="alternate" type="application/rss+xml" href="/my/feed.xml"></head></html>' },
    '/my/feed.xml': { type: 'application/xml', body: FEED },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const found = await discoverFeed(`${base}/`);
  assert.equal(found.ok, true);
  assert.equal(found.via, 'link');
  assert.equal(found.url, `${base}/my/feed.xml`);
});

test('discoverFeed: リンクが無くても、よくあるパスを試して見つける', async (t) => {
  const { server, base } = await startSite({
    '/': { type: 'text/html', body: '<html><body>フィードの記載なし</body></html>' },
    '/index.rdf': { type: 'application/xml', body: FEED },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const found = await discoverFeed(`${base}/`);
  assert.equal(found.ok, true);
  assert.equal(found.via, 'guess');
});

test('discoverFeed: どこにも無ければ失敗として試行結果を返す', async (t) => {
  const { server, base } = await startSite({ '/': { type: 'text/html', body: '<html></html>' } });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const found = await discoverFeed(`${base}/`);
  assert.equal(found.ok, false);
  assert.ok(found.tried.length > 1);
});

test('verifySources は実在するブログと到達できないブログを仕分ける', async (t) => {
  const { server, base } = await startSite({ '/index.rdf': { type: 'application/xml', body: FEED } });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const results = await verifySources([
    { id: 'alive', name: '実在', feed: `${base}/index.rdf` },
    { id: 'dead', name: '消滅', feed: `${base}/gone.rdf` },
  ]);
  assert.deepEqual(results.filter((r) => r.ok).map((r) => r.source.id), ['alive']);
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.source.id), ['dead']);
});

test('saveSources は $comment を残したまま書き戻せる', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'matome-')), 'sources.json');
  await writeFile(file, JSON.stringify({ $comment: 'メモ', sources: [{ id: 'a', name: 'A', feed: 'http://a/f' }] }), 'utf8');

  const loaded = await loadSources(file);
  await saveSources(loaded.filter((s) => s.id !== 'a').concat({ id: 'b', name: 'B', feed: 'http://b/f' }), file);

  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.$comment, 'メモ');
  assert.deepEqual(written.sources.map((s) => s.id), ['b']);
});

test('同梱の config/sources.json は全件そのまま読み込める', async () => {
  const sources = await loadSources();
  assert.ok(sources.length >= 5);
  assert.ok(sources.every((s) => /^https?:\/\//.test(s.feed)));
  assert.equal(new Set(sources.map((s) => s.id)).size, sources.length);
});

test('設定ファイルが見つからない環境では、同梱コピーへフォールバックする', async (t) => {
  const { paths } = await import('../src/config.js');
  const original = paths.sourcesFile;
  paths.sourcesFile = join(tmpdir(), 'matome-does-not-exist', 'sources.json');
  t.after(() => { paths.sourcesFile = original; });

  const sources = await loadSources();
  assert.ok(sources.length >= 5, 'フォールバックでブログ一覧が取れる');
  assert.ok(sources.every((s) => s.id && s.feed));
});

test('resolveCandidates は読めた候補だけを購読エントリにする', async (t) => {
  const { server, base } = await startSite({
    '/alive/index.rdf': { type: 'application/xml', body: FEED },
    '/moved/index.rdf': { type: 'application/xml', body: FEED },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await resolveCandidates([
    { name: '生きているまとめ', urls: [`${base}/alive/index.rdf`] },
    // 1つ目は死んでいて、2つ目（移転先）が生きているケース
    { name: '移転したまとめ', urls: [`${base}/gone/index.rdf`, `${base}/moved/index.rdf`] },
    { name: '消滅したまとめ', urls: [`${base}/nowhere/index.rdf`] },
    { name: 'URLなし' },
  ], { existing: [], category: '坂道' });

  assert.deepEqual(result.added.map((e) => e.name), ['生きているまとめ', '移転したまとめ']);
  assert.equal(result.added[1].feed, `${base}/moved/index.rdf`);
  assert.ok(result.added.every((e) => e.category === '坂道'));
  assert.equal(new Set(result.added.map((e) => e.id)).size, 2, 'idが重複しない');
  assert.equal(result.failed.length, 2);
});

test('resolveCandidates は登録済みのブログを二重に追加しない', async (t) => {
  const { server, base } = await startSite({ '/index.rdf': { type: 'application/xml', body: FEED } });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const existing = [{ id: 'exists', name: '登録済み', feed: `${base}/index.rdf`, site: `${base}/` }];
  const result = await resolveCandidates([{ name: '同じもの', urls: [`${base}/index.rdf`] }], { existing });

  assert.equal(result.added.length, 0);
  assert.equal(result.skipped.length, 1);
});

test('同梱の坂道候補リストは形式が正しい', async () => {
  const raw = JSON.parse(await readFile(new URL('../config/candidates/sakamichi.json', import.meta.url), 'utf8'));
  assert.ok(raw.candidates.length >= 5);
  for (const candidate of raw.candidates) {
    assert.ok(candidate.name, '名前がある');
    assert.ok((candidate.urls ?? []).length > 0, `${candidate.name} にURLがある`);
    assert.ok((candidate.urls ?? []).every((u) => /^https?:\/\//.test(u)), `${candidate.name} のURLが絶対URL`);
  }
});
