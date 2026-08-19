import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { paths } from './config.js';
import { selectArticles } from './rank.js';
import { crawl } from './crawler.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function sendFile(res, filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
  res.writeHead(200, {
    'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

function intParam(params, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function listParam(params, name) {
  const raw = params.get(name);
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * APIと静的ファイルを配信する (req, res) ハンドラを作る。
 * node:http でもサーバレス関数でも、そのまま使える形にしている。
 * @param {{ store: import('./store.js').Store, sources: Array<object>, onCrawl?: () => Promise<object>, serveStatic?: boolean }} deps
 */
export function createRequestHandler({ store, sources, onCrawl, serveStatic = true }) {
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const weights = Object.fromEntries(sources.map((s) => [s.id, s.weight ?? 1]));
  let crawling = null;

  function decorate(article) {
    const source = sourceById.get(article.sourceId);
    return {
      ...article,
      sourceName: article.sourceName || source?.name || article.sourceId,
      sourceSite: source?.site ?? '',
      category: source?.category ?? '',
    };
  }

  async function handleApi(req, res, url) {
    const { pathname, searchParams } = url;

    if (req.method === 'GET' && pathname === '/api/articles') {
      const tab = searchParams.get('tab') === 'popular' ? 'popular' : 'latest';
      const result = selectArticles(store.articles, {
        tab,
        query: searchParams.get('q') ?? '',
        sourceIds: listParam(searchParams, 'sources'),
        ngWords: listParam(searchParams, 'ng'),
        withinHours: intParam(searchParams, 'hours', tab === 'popular' ? 48 : 0, { max: 24 * 30 }) || null,
        limit: intParam(searchParams, 'limit', 60, { min: 1, max: 200 }),
        offset: intParam(searchParams, 'offset', 0, { max: 10000 }),
        weights,
      });
      return sendJson(res, 200, {
        tab,
        total: result.total,
        updatedAt: store.updatedAt,
        items: result.items.map(decorate),
      });
    }

    if (req.method === 'GET' && pathname === '/api/sources') {
      const counts = new Map();
      for (const article of store.articles) {
        counts.set(article.sourceId, (counts.get(article.sourceId) ?? 0) + 1);
      }
      return sendJson(res, 200, {
        sources: sources.map((source) => ({
          ...source,
          articleCount: counts.get(source.id) ?? 0,
          ...(store.sources[source.id] ?? {}),
        })),
      });
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      return sendJson(res, 200, {
        updatedAt: store.updatedAt,
        articleCount: store.articles.length,
        sourceCount: sources.length,
        crawling: Boolean(crawling),
      });
    }

    if (req.method === 'POST' && pathname === '/api/refresh') {
      if (!crawling) {
        crawling = (onCrawl ? onCrawl() : crawl(store, sources))
          .finally(() => {
            crawling = null;
          });
      }
      try {
        const summary = await crawling;
        return sendJson(res, 200, { ok: true, summary });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
      }
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  return async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      if (!serveStatic) {
        // 静的配信はホスティング側（VercelのCDNなど）に任せる構成。
        return sendJson(res, 404, { error: 'not found' });
      }
      const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      const target = join(paths.public, relative === '/' || relative === '\\' ? 'index.html' : relative);
      if (!target.startsWith(paths.public)) {
        return sendJson(res, 403, { error: 'forbidden' });
      }
      try {
        return await sendFile(res, target);
      } catch {
        // SPAなので未知のパスは index.html を返す。
        return await sendFile(res, join(paths.public, 'index.html'));
      }
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: error?.message ?? 'internal error' });
      else res.end();
    }
  };
}

/** ローカル実行用に node:http のサーバとして包む。 */
export function createApp(deps) {
  return createServer(createRequestHandler(deps));
}
