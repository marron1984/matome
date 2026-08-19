import { fetchText, mapWithConcurrency } from './http.js';
import { fetchBookmarkCounts } from './hatena.js';
import { parseFeed } from './feed.js';

/**
 * 全ブログのフィードを取得してストアに取り込む。
 * 1サイトの失敗は他サイトに波及させず、結果に理由を残す。
 */
export async function crawl(store, sources, options = {}) {
  const {
    concurrency = 4,
    now = Date.now(),
    withBookmarks = true,
    perSourceLimit = 30,
    logger = () => {},
    signal,
  } = options;

  const targets = sources.filter((s) => s.enabled !== false);
  const results = await mapWithConcurrency(targets, concurrency, async (source) => {
    try {
      const res = await fetchText(source.feed, { signal });
      const feed = parseFeed(res.body, { feedUrl: res.url });
      const items = feed.items.slice(0, perSourceLimit).map((item) => ({
        ...item,
        sourceId: source.id,
        sourceName: source.name,
      }));
      const added = store.upsertArticles(items, { now });
      store.recordSource(source.id, {
        name: source.name,
        lastCrawledAt: now,
        lastStatus: 'ok',
        lastError: '',
        itemCount: items.length,
      });
      logger(`✓ ${source.name}: ${items.length}件 (新着 ${added}件)`);
      return { source, ok: true, fetched: items.length, added };
    } catch (error) {
      const message = error?.message ?? String(error);
      store.recordSource(source.id, {
        name: source.name,
        lastCrawledAt: now,
        lastStatus: 'error',
        lastError: message,
      });
      logger(`✗ ${source.name}: ${message}`);
      return { source, ok: false, error: message, fetched: 0, added: 0 };
    }
  });

  let bookmarksUpdated = 0;
  if (withBookmarks) {
    // 直近48時間の記事だけブックマーク数を更新する（古い記事はもう伸びない）。
    const fresh = store.articles.filter(
      (a) => now - (a.publishedAt ?? a.firstSeenAt) < 48 * 60 * 60 * 1000,
    );
    const counts = await fetchBookmarkCounts(fresh.map((a) => a.url), { signal });
    bookmarksUpdated = store.applyBookmarkCounts(counts, { now });
    logger(`はてブ数を更新: ${bookmarksUpdated}件 / 対象 ${fresh.length}件`);
  }

  const pruned = store.prune({ now });
  await store.save();

  return {
    startedAt: now,
    finishedAt: Date.now(),
    sources: results.map(({ source, ...rest }) => ({ id: source.id, name: source.name, ...rest })),
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    added: results.reduce((sum, r) => sum + (r.added ?? 0), 0),
    bookmarksUpdated,
    pruned,
    total: store.articles.length,
  };
}
