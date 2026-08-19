/**
 * 依存ゼロの軽量XMLヘルパー。
 * RSS/RDF/Atom を読むのに必要な範囲だけを扱う（汎用XMLパーサではない）。
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** &amp; &#38; &#x26; などを実文字に戻す。 */
export function decodeEntities(text) {
  if (!text) return '';
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** CDATAセクションを外して中身だけにする。 */
export function stripCdata(text) {
  return String(text ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** タグを落として素のテキストにする（要約文の生成用）。 */
export function stripTags(html) {
  return stripCdata(String(html ?? ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

function escapeName(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 指定タグの出現をすべて返す。各要素は { attrs, inner }。
 * 自己終了タグ（<link ... />）は inner が空文字になる。
 */
export function findElements(xml, name) {
  const source = String(xml ?? '');
  const openRe = new RegExp(`<${escapeName(name)}(\\s[^>]*?)?(/)?>`, 'gi');
  const closeRe = new RegExp(`</${escapeName(name)}\\s*>`, 'gi');
  const out = [];
  let m;
  while ((m = openRe.exec(source)) !== null) {
    const attrs = (m[1] ?? '').trim();
    if (m[2] === '/') {
      out.push({ attrs, inner: '' });
      continue;
    }
    closeRe.lastIndex = openRe.lastIndex;
    const close = closeRe.exec(source);
    if (!close) {
      out.push({ attrs, inner: source.slice(openRe.lastIndex) });
      break;
    }
    out.push({ attrs, inner: source.slice(openRe.lastIndex, close.index) });
    openRe.lastIndex = closeRe.lastIndex;
  }
  return out;
}

/** 最初に見つかったタグの中身をテキストとして返す。候補名は先勝ち。 */
export function textOf(xml, names) {
  for (const name of [].concat(names)) {
    const el = findElements(xml, name)[0];
    if (!el) continue;
    const value = decodeEntities(stripCdata(el.inner)).trim();
    if (value) return value;
  }
  return '';
}

/** 属性値を取り出す。attrs 文字列（`href="..." rel="alternate"`）が対象。 */
export function attrOf(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(attrs ?? '');
  if (!m) return '';
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim();
}

/** 指定タグをすべて集めてテキスト配列にする（category など）。 */
export function textsOf(xml, name) {
  return findElements(xml, name)
    .map((el) => decodeEntities(stripCdata(el.inner)).trim())
    .filter(Boolean);
}

/** XML宣言やmetaタグから文字コードを推定する。 */
export function sniffCharset(buffer) {
  const head = Buffer.from(buffer).subarray(0, 1024).toString('latin1');
  const m = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head) || /charset\s*=\s*["']?([\w-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : '';
}
