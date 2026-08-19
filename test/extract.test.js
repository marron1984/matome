import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeArticleHtml, findArticleContainer, extractArticle, extractTitle, isAffiliateLink } from '../src/extract.js';

const BASE = 'http://blog.example.jp/x/archives/1.html';

test('script・style・iframe・ins は中身ごと消える', () => {
  const html = `<p>本文</p><script>evil()</script><style>.x{}</style>
    <iframe src="http://ad.example/f"></iframe><ins class="adsbygoogle">AD</ins><p>続き</p>`;
  const out = sanitizeArticleHtml(html, BASE);
  assert.match(out, /本文/);
  assert.match(out, /続き/);
  assert.doesNotMatch(out, /evil|iframe|adsbygoogle|AD/);
});

test('広告らしい class / id のブロックはサブツリーごと消える', () => {
  const html = `<div class="article"><p>レス1</p>
    <div class="ad-rect"><a href="http://x/"><img src="http://x/banner.png"></a>広告テキスト</div>
    <div id="rakuten_widget"><p>楽天のおすすめ</p></div>
    <p>レス2</p></div>`;
  const out = sanitizeArticleHtml(html, BASE);
  assert.match(out, /レス1/);
  assert.match(out, /レス2/);
  assert.doesNotMatch(out, /広告テキスト|楽天のおすすめ|banner/);
});

test('アフィリエイトリンクはリンクだけ外れてテキストは残る', () => {
  const html = `<p><a href="https://amzn.to/abc">この商品はこちら</a>を見てくれ</p>
    <p><a href="https://www.amazon.co.jp/dp/B000?tag=aff-22">タグ付きAmazon</a></p>
    <p><a href="https://hb.afl.rakuten.co.jp/hgc/xyz">楽天アフィ</a></p>
    <p><a href="http://blog.example.jp/x/archives/2.html">普通の記事リンク</a></p>`;
  const out = sanitizeArticleHtml(html, BASE);
  assert.doesNotMatch(out, /amzn\.to|tag=aff-22|afl\.rakuten/);
  assert.match(out, /この商品はこちら/);
  assert.match(out, /<a href="http:\/\/blog\.example\.jp\/x\/archives\/2\.html"[^>]*>普通の記事リンク<\/a>/);
});

test('isAffiliateLink の判定', () => {
  assert.equal(isAffiliateLink('https://amzn.to/x'), true);
  assert.equal(isAffiliateLink('https://px.a8.net/svt/ejp'), true);
  assert.equal(isAffiliateLink('https://www.amazon.co.jp/dp/B000?tag=x-22'), true);
  assert.equal(isAffiliateLink('https://www.amazon.co.jp/dp/B000'), false);
  assert.equal(isAffiliateLink('http://blog.example.jp/a.html'), false);
  assert.equal(isAffiliateLink('javascript:alert(1)'), true);
  assert.equal(isAffiliateLink(''), true);
});

test('属性は落ち、XSSの持ち込みができない', () => {
  const html = `<p onclick="evil()">クリック</p>
    <img src="x" onerror="evil()">
    <a href="javascript:alert(1)">リンク</a>
    <p>&lt;script&gt;taint&lt;/script&gt;</p>`;
  const out = sanitizeArticleHtml(html, BASE);
  assert.doesNotMatch(out, /onclick|onerror|javascript:/);
  assert.match(out, /&lt;script&gt;taint&lt;\/script&gt;/, 'エスケープ済みテキストはそのまま安全に表示');
});

test('lazyload画像は data-src から復元し、相対URLは絶対化する', () => {
  const html = `<img data-src="/img/photo.jpg" src="data:image/gif;base64,R0lGOD">
    <img src="//cdn.example.jp/a.png"><img src="http://x/spacer.gif" width="1" height="1">`;
  const out = sanitizeArticleHtml(html, BASE);
  assert.match(out, /src="http:\/\/blog\.example\.jp\/img\/photo\.jpg"/);
  assert.match(out, /src="http:\/\/cdn\.example\.jp\/a\.png"/);
  assert.doesNotMatch(out, /spacer\.gif|data:image/);
});

test('本文コンテナ（article-body）を優先して選ぶ', () => {
  const html = `<html><body>
    <div class="header"><p>ヘッダーメニュー</p></div>
    <div class="article-body-inner"><p>1: 名無しさん 本文のレスです</p><p>2: 名無しさん 2番目のレス</p></div>
    <div class="sidebar"><p>サイドバー</p></div>
  </body></html>`;
  const inner = findArticleContainer(html);
  assert.match(inner, /本文のレス/);
  assert.doesNotMatch(inner, /ヘッダーメニュー|サイドバー/);
});

test('extractTitle は og:title を優先し、ブログ名サフィックスを落とす', () => {
  assert.equal(extractTitle(`<meta property="og:title" content="【朗報】記事タイトル"><title>別題</title>`), '【朗報】記事タイトル');
  assert.equal(extractTitle(`<title>記事タイトル : 痛いニュース</title>`), '記事タイトル');
});

test('extractArticle: まとめ記事らしいページの一括処理', () => {
  const html = `<html><head><title>【悲報】テスト : テスト速報</title></head><body>
    <nav><a href="/">ホーム</a></nav>
    <div class="article-body">
      <p>1: 名無しさん これは本文</p>
      <script>ad()</script>
      <div class="amazon-box"><a href="https://amzn.to/x"><img src="http://img/x.jpg"></a></div>
      <blockquote><p>引用されたレス</p></blockquote>
      <img data-src="/upload/photo.jpg">
    </div>
    <footer>フッター</footer>
  </body></html>`;
  const result = extractArticle(html, { url: 'http://blog.example.jp/x/archives/1.html' });
  assert.equal(result.title, '【悲報】テスト');
  assert.match(result.html, /これは本文/);
  assert.match(result.html, /引用されたレス/);
  assert.match(result.html, /upload\/photo\.jpg/);
  assert.doesNotMatch(result.html, /amzn|ad\(\)|フッター|ホーム/);
  assert.ok(result.length > 10);
});
