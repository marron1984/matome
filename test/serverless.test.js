import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerlessHandler } from '../src/serverless.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<title>サーバレステスト速報</title><link>http://feed.example/</link>
<item><title>記事1</title><link>http://feed.example/1</link><pubDate>Tue, 19 Aug 2026 04:00:00 GMT</pubDate></item>
<item><title>記事2</title><link>http://feed.example/2</link><pubDate>Tue, 19 Aug 2026 03:00:00 GMT</pubDate></item>
</channel></rss>`;

async function startOrigin() {
  let hits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/index.rdf') {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(FEED);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, hits: () => hits };
}

/** サーバレス関数を、テストから叩けるようにHTTPサーバで包む。 */
async function startFunction(options) {
  const handler = createServerlessHandler(options);
  const server = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('サーバレス: 初回リクエストでクロールしてから記事を返す', async (t) => {
  const origin = await startOrigin();
  t.after(() => new Promise((resolve) => origin.server.close(resolve)));

  const fn = await startFunction({
    sources: [{ id: 's1', name: 'テスト速報', category: '総合', feed: `${origin.base}/index.rdf`, weight: 1 }],
    storeFile: join(await mkdtemp(join(tmpdir(), 'matome-')), 'articles.json'),
    logger: {},
  });
  t.after(() => new Promise((resolve) => fn.server.close(resolve)));

  const first = await (await fetch(`${fn.base}/api/articles`)).json();
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0].sourceName, 'テスト速報');

  // 2回目は温かいキャッシュから返すので、元サイトを叩き直さない
  const second = await (await fetch(`${fn.base}/api/articles`)).json();
  assert.equal(second.items.length, 2);
  assert.equal(origin.hits(), 1);
});

test('サーバレス: 保存先が書き込めなくても500にならない', async (t) => {
  const origin = await startOrigin();
  t.after(() => new Promise((resolve) => origin.server.close(resolve)));

  // 保存先の親ディレクトリを「ファイル」にして、書き込めない状況を作る
  const dir = await mkdtemp(join(tmpdir(), 'matome-'));
  await writeFile(join(dir, 'blocked'), 'not a directory', 'utf8');

  const fn = await startFunction({
    storeFile: join(dir, 'blocked', 'articles.json'),
    sources: [{ id: 's1', name: 'テスト速報', category: '総合', feed: `${origin.base}/index.rdf`, weight: 1 }],
    logger: {},
  });
  t.after(() => new Promise((resolve) => fn.server.close(resolve)));

  const res = await fetch(`${fn.base}/api/articles`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).items.length, 2);
});

test('サーバレス: 取得元が全滅でも500ではなく空の一覧を返す', async (t) => {
  const fn = await startFunction({
    sources: [{ id: 'dead', name: '落ちてるブログ', category: '総合', feed: 'http://127.0.0.1:1/index.rdf', weight: 1 }],
    storeFile: join(await mkdtemp(join(tmpdir(), 'matome-')), 'articles.json'),
    crawlBudgetMs: 3000,
    logger: {},
  });
  t.after(() => new Promise((resolve) => fn.server.close(resolve)));

  const res = await fetch(`${fn.base}/api/articles`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.items, []);

  const status = await (await fetch(`${fn.base}/api/status`)).json();
  assert.equal(status.articleCount, 0);
});

test('サーバレス: 静的配信はホスティング側に任せる（関数は404を返す）', async (t) => {
  const fn = await startFunction({
    sources: [],
    storeFile: join(await mkdtemp(join(tmpdir(), 'matome-')), 'articles.json'),
    logger: {},
  });
  t.after(() => new Promise((resolve) => fn.server.close(resolve)));

  assert.equal((await fetch(`${fn.base}/index.html`)).status, 404);
  assert.equal((await fetch(`${fn.base}/api/status`)).status, 200);
});

test('サーバレス: 設定の読み込みに失敗しても次のリクエストで再試行する', async (t) => {
  const origin = await startOrigin();
  t.after(() => new Promise((resolve) => origin.server.close(resolve)));

  const dir = await mkdtemp(join(tmpdir(), 'matome-'));
  const sourcesFile = join(dir, 'sources.json');
  const original = process.env.MATOME_SOURCES;
  process.env.MATOME_SOURCES = sourcesFile; // まだ存在しないファイル
  t.after(() => {
    if (original === undefined) delete process.env.MATOME_SOURCES;
    else process.env.MATOME_SOURCES = original;
  });

  const fn = await startFunction({ storeFile: join(dir, 'articles.json'), logger: {} });
  t.after(() => new Promise((resolve) => fn.server.close(resolve)));

  const failed = await fetch(`${fn.base}/api/status`);
  assert.equal(failed.status, 500, '設定が無ければ500を返す');

  // 設定が置かれれば、関数を作り直さなくても次のリクエストで復帰する
  await writeFile(sourcesFile, JSON.stringify({
    sources: [{ id: 's1', name: 'テスト速報', category: '総合', feed: `${origin.base}/index.rdf`, weight: 1 }],
  }), 'utf8');
  const recovered = await fetch(`${fn.base}/api/status`);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).sourceCount, 1);
});
