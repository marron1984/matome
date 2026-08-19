import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl, hostOf, resolveUrl } from '../src/url.js';

test('canonicalizeUrl はトラッキングパラメータと末尾スラッシュを落とす', () => {
  assert.equal(
    canonicalizeUrl('http://WWW.Example.com/archives/1.html?utm_source=rss&id=3#more'),
    'http://example.com/archives/1.html?id=3',
  );
  assert.equal(canonicalizeUrl('https://example.com/path/'), 'https://example.com/path');
  assert.equal(canonicalizeUrl('https://example.com/'), 'https://example.com/');
});

test('canonicalizeUrl は同じ記事の表記ゆれを1つにまとめる', () => {
  const a = canonicalizeUrl('http://www.example.com/a.html?utm_medium=feed');
  const b = canonicalizeUrl('http://example.com/a.html#comments');
  assert.equal(a, b);
});

test('canonicalizeUrl は壊れた入力をそのまま返す', () => {
  assert.equal(canonicalizeUrl('not a url'), 'not a url');
  assert.equal(canonicalizeUrl(''), '');
  assert.equal(canonicalizeUrl(null), '');
});

test('hostOf と resolveUrl', () => {
  assert.equal(hostOf('https://www.example.com/a'), 'example.com');
  assert.equal(hostOf('ぐちゃぐちゃ'), '');
  assert.equal(resolveUrl('/img/a.jpg', 'http://example.com/archives/1.html'), 'http://example.com/img/a.jpg');
  assert.equal(resolveUrl('', 'http://example.com/'), '');
});
