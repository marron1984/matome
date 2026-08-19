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

/** サイトURLから、それらしいidを作る（example.com/blog → example-blog）。 */
export function defaultId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').replace(/\.(com|net|jp|org|blog|info)$/g, '');
    const path = parsed.pathname.replace(/^\/|\/$/g, '').split('/')[0];
    return [host, path].filter(Boolean).join('-').replace(/[^\w-]/g, '-').toLowerCase() || 'blog';
  } catch {
    return 'blog';
  }
}

function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 候補リスト（サイトURLの一覧）から、実際に読めたものだけを購読エントリにする。
 * 1件に複数のURL候補（移転前/後など）を書ける。先に読めたものを採用する。
 *
 * @param {Array<{name?: string, url?: string, urls?: string[], category?: string, weight?: number}>} candidates
 * @param {{ existing?: Array<object>, category?: string, discover?: Function, logger?: Function }} options
 * @returns {Promise<{ added: Array<object>, skipped: Array<object>, failed: Array<object> }>}
 */
export async function resolveCandidates(candidates, options = {}) {
  const {
    existing = [],
    category = 'その他',
    discover = discoverFeed,
    logger = () => {},
  } = options;

  const takenIds = new Set(existing.map((s) => s.id));
  const takenFeeds = new Set(existing.map((s) => s.feed));
  const takenSites = new Set(existing.map((s) => s.site).filter(Boolean));
  const added = [];
  const skipped = [];
  const failed = [];

  for (const candidate of candidates) {
    const urls = candidate.urls ?? [candidate.url].filter(Boolean);
    const label = candidate.name ?? urls[0] ?? '(URLなし)';
    if (urls.length === 0) {
      failed.push({ candidate, error: 'URLがありません' });
      continue;
    }
    if (urls.some((u) => takenFeeds.has(u) || takenSites.has(u))) {
      skipped.push({ candidate, reason: '登録済み' });
      logger({ type: 'skip', label, reason: '登録済み' });
      continue;
    }

    let found = null;
    const attempts = [];
    for (const url of urls) {
      const result = await discover(url);
      attempts.push(result);
      if (result.ok) {
        found = result;
        break;
      }
    }

    if (!found) {
      failed.push({ candidate, error: attempts.at(-1)?.error ?? '見つかりませんでした' });
      logger({ type: 'fail', label, error: attempts.at(-1)?.error ?? '見つかりませんでした' });
      continue;
    }
    if (takenFeeds.has(found.url)) {
      skipped.push({ candidate, reason: '同じフィードが登録済み' });
      logger({ type: 'skip', label, reason: '同じフィードが登録済み' });
      continue;
    }

    const entry = {
      id: uniqueId(candidate.id ?? defaultId(found.site || found.url), takenIds),
      // 候補名はあくまで探すためのラベル。移転・改名していることがあるので、
      // 登録名はフィード自身が名乗るタイトルを正とする。
      name: found.title || candidate.name || found.url,
      category: candidate.category ?? category,
      site: found.site || urls[0],
      feed: found.url,
      weight: candidate.weight ?? 1,
    };
    takenIds.add(entry.id);
    takenFeeds.add(entry.feed);
    added.push(entry);
    logger({ type: 'add', label, entry, count: found.count, via: found.via });
  }

  return { added, skipped, failed };
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
