import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, findElements, textOf, textsOf, attrOf, stripTags, sniffCharset } from '../src/xml.js';

test('decodeEntities は名前付き・10進・16進の実体参照を戻す', () => {
  assert.equal(decodeEntities('A&amp;B'), 'A&B');
  assert.equal(decodeEntities('&#12354;&#x3044;'), 'あい');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

test('findElements は自己終了タグを空要素として扱う', () => {
  const elements = findElements('<item>a</item><item/><item x="1">b</item>', 'item');
  assert.deepEqual(elements.map((e) => e.inner), ['a', '', 'b']);
  assert.equal(elements[2].attrs, 'x="1"');
});

test('findElements は閉じタグが無くても落ちない', () => {
  const elements = findElements('<item>途中で切れた', 'item');
  assert.equal(elements.length, 1);
  assert.equal(elements[0].inner, '途中で切れた');
});

test('textOf は CDATA を外し、候補名を先勝ちで探す', () => {
  const xml = '<entry><summary><![CDATA[要約 &amp; 続き]]></summary></entry>';
  assert.equal(textOf(xml, ['description', 'summary']), '要約 & 続き');
  assert.equal(textOf(xml, 'missing'), '');
});

test('textsOf は同名タグをすべて集める', () => {
  assert.deepEqual(textsOf('<i><category>A</category><category>B</category></i>', 'category'), ['A', 'B']);
});

test('attrOf はクォート有無に関わらず属性を取れる', () => {
  assert.equal(attrOf('href="http://x/" rel=alternate', 'href'), 'http://x/');
  assert.equal(attrOf("href='y'", 'href'), 'y');
  assert.equal(attrOf('rel="self"', 'href'), '');
});

test('stripTags は script も含めてタグを落とす', () => {
  assert.match(stripTags('<div>本文<script>evil()</script></div>'), /本文/);
  assert.doesNotMatch(stripTags('<div>本文<script>evil()</script></div>'), /evil/);
});

test('sniffCharset は XML 宣言から文字コードを拾う', () => {
  assert.equal(sniffCharset(Buffer.from('<?xml version="1.0" encoding="EUC-JP"?>')), 'euc-jp');
  assert.equal(sniffCharset(Buffer.from('<rss>')), '');
});
