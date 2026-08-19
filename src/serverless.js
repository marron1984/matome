import { loadSources, paths } from './config.js';
import { Store } from './store.js';
import { crawl } from './crawler.js';
import { createRequestHandler } from './server.js';

const DEFAULT_REFRESH_MS = Number(process.env.MATOME_REFRESH_MINUTES ?? 10) * 60 * 1000;
const DEFAULT_BUDGET_MS = Number(process.env.MATOME_CRAWL_BUDGET_MS ?? 8000);

/**
 * サーバレス（Vercelなど）向けのハンドラ。
 *
 * 常駐プロセスもディスクも当てにできないので、
 * - 記事はモジュールスコープ（同じインスタンスが温かい間だけ生きる）に保持
 * - 保存先は書き込める /tmp。消えていても次のリクエストで取り直すだけ
 * - 記事が空の初回だけクロールを待ち、以降は裏で更新する
 * という方針にしている。
 */
export function createServerlessHandler(options = {}) {
  const {
    sources: fixedSources = null,
    storeFile = paths.storeFile,
    refreshIntervalMs = DEFAULT_REFRESH_MS,
    crawlBudgetMs = DEFAULT_BUDGET_MS,
    serveStatic = false,
    logger = console,
  } = options;

  let boot = null;
  let refreshing = null;

  async function init() {
    const sources = fixedSources ?? await loadSources();
    const store = await Store.open(storeFile, { logger });
    const handle = createRequestHandler({
      store,
      sources,
      serveStatic,
      onCrawl: () => refresh(store, sources),
    });
    return { store, sources, handle };
  }

  function refresh(store, sources) {
    if (refreshing) return refreshing;
    refreshing = crawl(store, sources, {
      signal: AbortSignal.timeout(crawlBudgetMs),
      logger: (line) => logger.log?.(`[crawl] ${line}`),
    })
      .catch((error) => {
        logger.error?.(`[crawl] 失敗: ${error?.message ?? error}`);
        return { ok: 0, failed: sources.length, added: 0, error: String(error?.message ?? error) };
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  return async function handler(req, res) {
    try {
      if (!boot) {
        boot = init().catch((error) => {
          boot = null; // 初期化の失敗を握り続けない
          throw error;
        });
      }
      const { store, sources, handle } = await boot;

      if (store.articles.length === 0) {
        await refresh(store, sources); // 初回は記事が無いので待つ
      } else if (Date.now() - store.updatedAt > refreshIntervalMs) {
        refresh(store, sources); // 2回目以降は待たせない
      }

      return await handle(req, res);
    } catch (error) {
      logger.error?.(error);
      if (res.headersSent) return res.end();
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: error?.message ?? 'internal error' }));
    }
  };
}
