import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { parseFeed } from '../src/feed.js';

const RDF = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="http://blog.example.jp/x/"><title>テスト速報</title><link>http://blog.example.jp/x/</link></channel>
  <item rdf:about="http://blog.example.jp/x/archives/1.html">
    <title><![CDATA[【悲報】テスト記事www]]></title>
    <link>http://blog.example.jp/x/archives/1.html?utm_source=rss</link>
    <description><![CDATA[<img src="/img/a.jpg">本文テキスト]]></description>
    <dc:date>2026-08-19T13:40:00+09:00</dc:date>
    <dc:subject>ニュース</dc:subject>
  </item>
</rdf:RDF>`;

const RSS2 = `<rss version="2.0"><channel><title>RSS2ブログ</title><link>https://rss2.example/</link>
  <item><title>記事A</title><link>https://rss2.example/a</link><pubDate>Tue, 19 Aug 2026 04:00:00 GMT</pubDate>
    <description>説明A</description><category>雑談</category></item>
  <item><title>タイトルだけでリンクなし</title></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atomブログ</title>
  <link rel="self" href="https://atom.example/feed"/><link rel="alternate" href="https://atom.example/"/>
  <entry><title>Atom記事</title><link rel="alternate" href="/p/1"/><id>tag:atom,1</id>
    <published>2026-08-19T04:00:00Z</published><content type="html">&lt;p&gt;中身&lt;/p&gt;</content></entry>
</feed>`;

test('RSS1.0(RDF) を解析し、URLを正規化する', () => {
  const feed = parseFeed(RDF, { feedUrl: 'http://blog.example.jp/x/index.rdf' });
  assert.equal(feed.title, 'テスト速報');
  assert.equal(feed.items.length, 1);
  const item = feed.items[0];
  assert.equal(item.title, '【悲報】テスト記事www');
  assert.equal(item.url, 'http://blog.example.jp/x/archives/1.html');
  assert.equal(item.publishedAt, Date.parse('2026-08-19T13:40:00+09:00'));
  assert.equal(item.summary, '本文テキスト');
  assert.equal(item.image, 'http://blog.example.jp/img/a.jpg');
  assert.deepEqual(item.categories, ['ニュース']);
});

test('RSS2.0 を解析し、リンクの無い項目は捨てる', () => {
  const feed = parseFeed(RSS2, { feedUrl: 'https://rss2.example/rss' });
  assert.equal(feed.title, 'RSS2ブログ');
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].url, 'https://rss2.example/a');
  assert.equal(feed.items[0].publishedAt, Date.parse('Tue, 19 Aug 2026 04:00:00 GMT'));
});

test('Atom は rel=alternate のリンクを記事URLにする', () => {
  const feed = parseFeed(ATOM, { feedUrl: 'https://atom.example/feed' });
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].url, 'https://atom.example/p/1');
  assert.equal(feed.items[0].summary, '中身');
});

test('空文字や壊れたXMLでも例外を投げない', () => {
  assert.deepEqual(parseFeed('').items, []);
  assert.deepEqual(parseFeed('<rss><channel><item><title>途中').items, []);
});

test('同梱のサンプルフィードをすべて解析できる', async () => {
  const dir = new URL('../fixtures/feeds/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.rdf'));
  assert.ok(files.length > 0, 'サンプルフィードが1件も無い');
  for (const file of files) {
    const xml = await readFile(new URL(file, dir), 'utf8');
    const feed = parseFeed(xml.replace(/\{\{-(\d+)m\}\}/g, '2026-08-19T04:00:00Z'), { feedUrl: 'http://x/' });
    assert.ok(feed.items.length > 0, `${file} の記事が0件`);
    assert.ok(feed.items.every((i) => i.url && i.title));
  }
});
