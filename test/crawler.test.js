import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { crawl } from '../src/crawler.js';
import { parseCountResponse } from '../src/hatena.js';

/** fixtures のフィードを配るローカルサーバを立てる。 */
async function startFeedServer() {
  const dqnplus = (await readFile(new URL('../fixtures/feeds/dqnplus.rdf', import.meta.url), 'utf8'))
    .replace(/\{\{-(\d+)m\}\}/g, () => new Date().toISOString());
  const server = createServer((req, res) => {
    if (req.url === '/ok.rdf') {
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
      res.end(dqnplus);
      return;
    }
    if (req.url === '/broken.rdf') {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('crawl はフィードを取り込み、失敗したブログだけを error として記録する', async (t) => {
  const { server, base } = await startFeedServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const store = new Store(join(await mkdtemp(join(tmpdir(), 'matome-')), 'articles.json'));
  const sources = [
    { id: 'ok', name: '動くブログ', feed: `${base}/ok.rdf`, weight: 1 },
    { id: 'ng', name: '落ちてるブログ', feed: `${base}/broken.rdf`, weight: 1 },
    { id: 'off', name: '購読停止中', feed: `${base}/ok.rdf`, weight: 1, enabled: false },
  ];

  const summary = await crawl(store, sources, { withBookmarks: false, concurrency: 2 });

  assert.equal(summary.ok, 1);
  assert.equal(summary.failed, 1);
  assert.ok(summary.added > 0);
  assert.ok(store.articles.every((a) => a.sourceId === 'ok'));
  assert.equal(store.sources.ok.lastStatus, 'ok');
  assert.equal(store.sources.ng.lastStatus, 'error');
  assert.match(store.sources.ng.lastError, /HTTP 500/);
  assert.equal(store.sources.off, undefined);
});

test('crawl を2回流しても記事は重複しない', async (t) => {
  const { server, base } = await startFeedServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const store = new Store(join(await mkdtemp(join(tmpdir(), 'matome-')), 'articles.json'));
  const sources = [{ id: 'ok', name: '動くブログ', feed: `${base}/ok.rdf`, weight: 1 }];
  const first = await crawl(store, sources, { withBookmarks: false });
  const second = await crawl(store, sources, { withBookmarks: false });
  assert.ok(first.added > 0);
  assert.equal(second.added, 0);
  assert.equal(store.articles.length, first.added);
});

test('parseCountResponse は URL→件数 のMapを返す', () => {
  const counts = parseCountResponse('{"http://a/1":12,"http://a/2":0}');
  assert.equal(counts.get('http://a/1'), 12);
  assert.equal(counts.get('http://a/2'), 0);
  assert.equal(parseCountResponse('壊れたJSON').size, 0);
  assert.equal(parseCountResponse('').size, 0);
});
