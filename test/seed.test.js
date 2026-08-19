import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { seed } from '../src/seed.js';

test('seed はサンプル記事を「今」に近い時刻で投入する', async () => {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'matome-')), 'articles.json'));
  const now = Date.now();
  const result = await seed(store, [{ id: 'dqnplus', name: '痛いニュース(ﾉ∀`)' }], { now });

  assert.ok(result.files >= 5);
  assert.equal(result.added, store.articles.length);
  assert.ok(store.articles.length > 20);
  assert.ok(store.articles.every((a) => a.publishedAt <= now && a.publishedAt > now - 24 * 3600 * 1000));
  assert.ok(store.articles.some((a) => a.bookmarks > 0), 'はてブ数のサンプルが入っていない');
  assert.equal(store.articles.find((a) => a.sourceId === 'dqnplus').sourceName, '痛いニュース(ﾉ∀`)');
});

test('seed を二度実行しても重複しない', async () => {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'matome-')), 'articles.json'));
  const first = await seed(store, []);
  const second = await seed(store, []);
  assert.ok(first.added > 0);
  assert.equal(second.added, 0);
});
