import { sniffCharset } from './xml.js';

export const USER_AGENT = 'matome-aggregator/0.1 (+https://github.com/marron1984/matome)';

/** Node の TextDecoder が知らない別名を吸収する。 */
function normalizeCharset(charset) {
  const key = String(charset || '').toLowerCase().replace(/["']/g, '').trim();
  if (!key) return 'utf-8';
  if (key === 'shift_jis' || key === 'shift-jis' || key === 'x-sjis' || key === 'sjis') return 'shift_jis';
  if (key === 'euc-jp' || key === 'eucjp' || key === 'x-euc-jp') return 'euc-jp';
  if (key === 'iso-2022-jp') return 'iso-2022-jp';
  return key;
}

function decodeBody(buffer, contentType) {
  const fromHeader = /charset\s*=\s*([\w-]+)/i.exec(contentType || '')?.[1];
  const charset = normalizeCharset(fromHeader || sniffCharset(buffer) || 'utf-8');
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * テキストを取得する。文字コードは Content-Type / XML宣言から判定する。
 * 失敗時は指数バックオフでリトライする。
 */
export async function fetchText(url, options = {}) {
  const {
    timeoutMs = 15000,
    retries = 2,
    headers = {},
    signal,
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/rss+xml, application/rdf+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
          ...headers,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        url: res.url || url,
        status: res.status,
        body: decodeBody(buffer, res.headers.get('content-type')),
      };
    } catch (error) {
      lastError = error;
      if (signal?.aborted) break;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError ?? new Error(`fetch failed: ${url}`);
}

/** 同時実行数を絞りつつ非同期処理を回す。 */
export async function mapWithConcurrency(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
