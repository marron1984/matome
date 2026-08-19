import { findElements, textOf, textsOf, attrOf, stripTags, decodeEntities, stripCdata } from './xml.js';
import { canonicalizeUrl, resolveUrl } from './url.js';

const MAX_SUMMARY = 140;

function parseDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const ms = Date.parse(text);
  if (Number.isFinite(ms)) return ms;
  // "2026-08-19 13:40:00 +0900" のようなスペース区切りも救済する。
  const patched = Date.parse(text.replace(' ', 'T'));
  return Number.isFinite(patched) ? patched : null;
}

function summarize(html) {
  const text = stripTags(html).replace(/\s+/g, ' ').trim();
  const decoded = decodeEntities(text);
  return decoded.length > MAX_SUMMARY ? `${decoded.slice(0, MAX_SUMMARY)}…` : decoded;
}

function firstImage(html, base) {
  const m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(stripCdata(String(html ?? '')));
  if (!m) return '';
  return resolveUrl(decodeEntities(m[1]), base);
}

/** Atom の <link rel="alternate" href="..."> を優先して記事URLを決める。 */
function atomLink(entryXml) {
  const links = findElements(entryXml, 'link').map((el) => ({
    href: attrOf(el.attrs, 'href'),
    rel: attrOf(el.attrs, 'rel') || 'alternate',
    type: attrOf(el.attrs, 'type'),
  }));
  const alternate = links.find((l) => l.rel === 'alternate' && l.href)
    || links.find((l) => l.href && l.rel !== 'self' && l.rel !== 'edit');
  return alternate ? alternate.href : '';
}

function rssLink(itemXml, itemAttrs) {
  // RSS2.0 は <link>URL</link>。RDF は <link> か rdf:about 属性。
  const linkText = textOf(itemXml, 'link');
  if (linkText) return linkText;
  const about = attrOf(itemAttrs, 'rdf:about') || attrOf(itemAttrs, 'about');
  if (about) return about;
  const guid = findElements(itemXml, 'guid')[0];
  if (guid && /^https?:\/\//i.test(guid.inner.trim())) return guid.inner.trim();
  return '';
}

/**
 * RSS2.0 / RSS1.0(RDF) / Atom を共通形式にパースする。
 * @param {string} xml
 * @param {{ feedUrl?: string }} [options]
 * @returns {{ title: string, link: string, items: Array<object> }}
 */
export function parseFeed(xml, options = {}) {
  const source = String(xml ?? '');
  const feedUrl = options.feedUrl || '';
  const isAtom = /<feed[\s>]/i.test(source) && !/<rss[\s>]/i.test(source);

  const channelXml = isAtom
    ? source
    : (findElements(source, 'channel')[0]?.inner ?? source);

  const feedTitle = textOf(channelXml, 'title');
  const feedLink = isAtom
    ? resolveUrl(atomLink(channelXml.replace(/<entry[\s\S]*$/i, '')), feedUrl)
    : resolveUrl(textOf(channelXml, 'link'), feedUrl);

  const entries = isAtom ? findElements(source, 'entry') : findElements(source, 'item');

  const items = [];
  for (const entry of entries) {
    const inner = entry.inner;
    const rawLink = isAtom ? atomLink(inner) : rssLink(inner, entry.attrs);
    const url = canonicalizeUrl(resolveUrl(rawLink, feedLink || feedUrl));
    const title = textOf(inner, 'title');
    if (!url || !title) continue;

    const body = textOf(inner, ['content:encoded', 'content', 'description', 'summary']);
    const publishedAt = parseDate(
      textOf(inner, ['pubDate', 'dc:date', 'published', 'updated', 'issued', 'date']),
    );

    items.push({
      title,
      url,
      guid: textOf(inner, ['guid', 'id']) || url,
      publishedAt,
      summary: summarize(body),
      image: firstImage(body, url),
      categories: [...new Set(textsOf(inner, 'category').concat(textsOf(inner, 'dc:subject')))].slice(0, 5),
    });
  }

  return { title: feedTitle, link: feedLink, items };
}
