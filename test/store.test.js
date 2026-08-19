import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const NOW = Date.parse('2026-08-19T12:00:00+09:00');

function article(overrides = {}) {
  return {
    url: 'http://blog.example.jp/x/archives/1.html',
    title: '記事タイトル',
    sourceId: 'x',
    sourceName: 'テストブログ',
    publishedAt: NOW - 60000,
    summary: '要約',
    ...overrides,
  };
}

test('upsertArticles は正規化URLで重複排除する', () => {
  const store = new Store('/dev/null');
  const added = store.upsertArticles([
    article(),
    article({ url: 'http://www.blog.example.jp/x/archives/1.html?utm_source=rss' }),
    article({ url: 'http://blog.example.jp/x/archives/2.html', title: '別記事' }),
  ], { now: NOW });
  assert.equal(added, 2);
  assert.equal(store.articles.length, 2);
});

test('既存記事の初出時刻は上書きされない', () => {
  const store = new Store('/dev/null');
  store.upsertArticles([article()], { now: NOW });
  store.upsertArticles([article({ title: '修正後タイトル' })], { now: NOW + 3600000 });
  assert.equal(store.articles.length, 1);
  assert.equal(store.articles[0].firstSeenAt, NOW);
  assert.equal(store.articles[0].title, '修正後タイトル');
});

test('タイトルやURLが欠けた項目は取り込まない', () => {
  const store = new Store('/dev/null');
  const added = store.upsertArticles([{ url: '', title: 'なし' }, { url: 'http://a/b', title: '' }], { now: NOW });
  assert.equal(added, 0);
});

test('applyBookmarkCounts ははてブ数を反映する', () => {
  const store = new Store('/dev/null');
  store.upsertArticles([article()], { now: NOW });
  const updated = store.applyBookmarkCounts(new Map([[article().url, 42]]), { now: NOW });
  assert.equal(updated, 1);
  assert.equal(store.articles[0].bookmarks, 42);
  assert.equal(store.articles[0].bookmarksCheckedAt, NOW);
});

test('prune は古い記事と上限超過分を捨てる', () => {
  const store = new Store('/dev/null');
  store.upsertArticles([
    article({ url: 'http://a/1', publishedAt: NOW - 20 * 24 * 3600 * 1000 }),
    article({ url: 'http://a/2', publishedAt: NOW - 3600 * 1000 }),
    article({ url: 'http://a/3', publishedAt: NOW - 7200 * 1000 }),
  ], { now: NOW });
  assert.equal(store.prune({ maxAgeDays: 14, now: NOW }), 1);
  assert.equal(store.prune({ maxArticles: 1, now: NOW }), 1);
  assert.equal(store.articles.length, 1);
  assert.equal(store.articles[0].url, 'http://a/2');
});

test('save と open でデータが往復する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matome-'));
  const file = join(dir, 'articles.json');
  const store = new Store(file);
  store.upsertArticles([article()], { now: NOW });
  store.recordSource('x', { lastStatus: 'ok' });
  await store.save();

  const reopened = await Store.open(file);
  assert.equal(reopened.articles.length, 1);
  assert.equal(reopened.sources.x.lastStatus, 'ok');
  assert.match(await readFile(file, 'utf8'), /記事タイトル/);
});

test('存在しないファイルを開くと空のストアになる', async () => {
  const store = await Store.open(join(tmpdir(), 'matome-missing', 'none.json'));
  assert.deepEqual(store.articles, []);
});
