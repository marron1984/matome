import { fetchText } from './http.js';
import { parseFeed } from './feed.js';
import { findOpenTags, attrOf, decodeEntities } from './xml.js';
import { resolveUrl } from './url.js';

const FEED_TYPES = /(rss|rdf|atom)\+xml/i;

// フィードURLが書かれていないサイト向けの、まとめブログでよくある置き場所。
const COMMON_PATHS = ['/index.rdf', '/feed', '/rss', '/atom.xml', '/feed/rss2', '/?feed=rss2'];

/** HTMLの <link rel="alternate" type="application/rss+xml"> を拾う。 */
export function feedLinksFromHtml(html, baseUrl) {
  const links = [];
  for (const el of findOpenTags(html, 'link')) {
    const rel = attrOf(el.attrs, 'rel').toLowerCase();
    const type = attrOf(el.attrs, 'type');
    const href = attrOf(el.attrs, 'href');
    if (!href || !FEED_TYPES.test(type)) continue;
    if (rel && !rel.split(/\s+/).includes('alternate')) continue;
    links.push({
      url: resolveUrl(decodeEntities(href), baseUrl),
      title: attrOf(el.attrs, 'title'),
      type,
    });
  }
  // RDF(RSS1.0) より RSS2.0/Atom を優先すると、全文が入っていることが多い。
  return links.sort((a, b) => Number(/rdf/i.test(a.type)) - Number(/rdf/i.test(b.type)));
}

/** URLを1本取得して、フィードとして読めるか（記事が1件以上あるか）を確かめる。 */
export async function probeFeed(url, options = {}) {
  try {
    const res = await fetchText(url, { retries: 1, timeoutMs: 12000, ...options });
    const feed = parseFeed(res.body, { feedUrl: res.url });
    if (feed.items.length === 0) {
      return { ok: false, url, error: 'フィードとして読めるが記事が0件' };
    }
    const latest = feed.items
      .map((item) => item.publishedAt)
      .filter(Boolean)
      .sort((a, b) => b - a)[0] ?? null;
    return { ok: true, url: res.url, title: feed.title, site: feed.link, count: feed.items.length, latest };
  } catch (error) {
    return { ok: false, url, error: error?.message ?? String(error) };
  }
}

/**
 * サイトURL（またはフィードURL）から、実際に読めるフィードを探し当てる。
 * 1. 与えられたURLがそのままフィードなら、それを使う
 * 2. HTMLなら <link rel="alternate"> をたどる
 * 3. それも無ければ、よくあるパスを順に試す
 */
export async function discoverFeed(input, options = {}) {
  const tried = [];
  const direct = await probeFeed(input, options);
  tried.push(direct);
  if (direct.ok) return { ...direct, via: 'direct', tried };

  let html = '';
  try {
    const res = await fetchText(input, { retries: 1, timeoutMs: 12000, ...options });
    html = res.body;
    for (const link of feedLinksFromHtml(html, res.url)) {
      const probed = await probeFeed(link.url, options);
      tried.push(probed);
      if (probed.ok) return { ...probed, via: 'link', tried };
    }
  } catch (error) {
    tried.push({ ok: false, url: input, error: error?.message ?? String(error) });
  }

  for (const path of COMMON_PATHS) {
    const candidate = resolveUrl(path, input);
    if (tried.some((t) => t.url === candidate)) continue;
    const probed = await probeFeed(candidate, options);
    tried.push(probed);
    if (probed.ok) return { ...probed, via: 'guess', tried };
  }

  return { ok: false, url: input, error: 'フィードが見つかりませんでした', tried };
}

/** 設定済みの全ブログについて、フィードが今も生きているかを確かめる。 */
export async function verifySources(sources, options = {}) {
  const { concurrency = 4, logger = () => {}, ...rest } = options;
  const { mapWithConcurrency } = await import('./http.js');
  return mapWithConcurrency(sources, concurrency, async (source) => {
    const result = await probeFeed(source.feed, rest);
    logger(source, result);
    return { source, ...result };
  });
}
