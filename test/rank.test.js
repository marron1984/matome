import test from 'node:test';
import assert from 'node:assert/strict';
import { popularityScore, matchesQuery, isBlocked, selectArticles } from '../src/rank.js';

const NOW = Date.parse('2026-08-19T15:00:00+09:00');
const HOUR = 3600000;

function article(overrides = {}) {
  return {
    url: `http://a/${overrides.title ?? 'x'}`,
    title: 'タイトル',
    summary: '',
    sourceId: 's1',
    sourceName: 'テストブログ',
    publishedAt: NOW - HOUR,
    bookmarks: 0,
    categories: [],
    ...overrides,
  };
}

test('はてブが多いほどスコアが高い', () => {
  const many = popularityScore(article({ bookmarks: 300 }), { now: NOW });
  const few = popularityScore(article({ bookmarks: 3 }), { now: NOW });
  assert.ok(many > few);
});

test('同じはてブ数なら新しいほうがスコアが高い', () => {
  const fresh = popularityScore(article({ bookmarks: 50, publishedAt: NOW - HOUR }), { now: NOW });
  const old = popularityScore(article({ bookmarks: 50, publishedAt: NOW - 24 * HOUR }), { now: NOW });
  assert.ok(fresh > old);
});

test('matchesQuery はスペース区切りのAND検索・全半角ゆれを吸収する', () => {
  const a = article({ title: '【朗報】ＲＰＧの新作が発表される', summary: '発売日は未定' });
  assert.ok(matchesQuery(a, 'rpg 新作'));
  assert.ok(matchesQuery(a, ''));
  assert.ok(!matchesQuery(a, 'rpg 完全版'));
});

test('isBlocked は NGワードを部分一致で判定する', () => {
  const a = article({ title: 'ネタバレ注意の記事' });
  assert.ok(isBlocked(a, ['ネタバレ']));
  assert.ok(!isBlocked(a, ['野球', '']));
});

test('selectArticles: 新着タブは時刻順', () => {
  const items = [
    article({ title: '古い', publishedAt: NOW - 5 * HOUR, bookmarks: 500 }),
    article({ title: '新しい', publishedAt: NOW - 1 * HOUR, bookmarks: 0 }),
  ];
  const result = selectArticles(items, { tab: 'latest', now: NOW });
  assert.deepEqual(result.items.map((a) => a.title), ['新しい', '古い']);
});

test('selectArticles: 人気タブははてブ数を優先する', () => {
  const items = [
    article({ title: '無風', publishedAt: NOW - 1 * HOUR, bookmarks: 0 }),
    article({ title: 'バズ', publishedAt: NOW - 3 * HOUR, bookmarks: 800 }),
  ];
  const result = selectArticles(items, { tab: 'popular', now: NOW });
  assert.equal(result.items[0].title, 'バズ');
});

test('selectArticles: 期間・ブログ・NGワード・検索で絞り込む', () => {
  const items = [
    article({ title: '対象', sourceId: 's1', publishedAt: NOW - 2 * HOUR }),
    article({ title: '期間外', sourceId: 's1', publishedAt: NOW - 80 * HOUR }),
    article({ title: '別ブログ', sourceId: 's2', publishedAt: NOW - 2 * HOUR }),
    article({ title: 'ネタバレあり', sourceId: 's1', publishedAt: NOW - 2 * HOUR }),
  ];
  const result = selectArticles(items, {
    now: NOW,
    withinHours: 48,
    sourceIds: ['s1'],
    ngWords: ['ネタバレ'],
  });
  assert.deepEqual(result.items.map((a) => a.title), ['対象']);
  assert.equal(result.total, 1);
});

test('selectArticles: limit と offset でページングできる', () => {
  const items = Array.from({ length: 5 }, (_, i) => article({
    title: `記事${i}`, publishedAt: NOW - (i + 1) * HOUR,
  }));
  const page1 = selectArticles(items, { now: NOW, limit: 2 });
  const page2 = selectArticles(items, { now: NOW, limit: 2, offset: 2 });
  assert.equal(page1.total, 5);
  assert.deepEqual(page1.items.map((a) => a.title), ['記事0', '記事1']);
  assert.deepEqual(page2.items.map((a) => a.title), ['記事2', '記事3']);
});

test('selectArticles: ブログごとの weight がスコアに効く', () => {
  const items = [
    article({ title: '通常', sourceId: 's1', bookmarks: 100 }),
    article({ title: '優遇', sourceId: 's2', bookmarks: 100 }),
  ];
  const result = selectArticles(items, { tab: 'popular', now: NOW, weights: { s1: 0.5, s2: 1.5 } });
  assert.equal(result.items[0].title, '優遇');
});
