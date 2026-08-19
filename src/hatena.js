import { fetchText, mapWithConcurrency } from './http.js';

const COUNT_ENDPOINT = 'https://bookmark.hatena.ne.jp/entry/jsonlite/';
const BULK_ENDPOINT = 'https://bookmark.hatena.ne.jp/count/entries';
const BULK_CHUNK = 50;

/** レスポンス（オブジェクト or 数値）からURL→ブックマーク数のMapを作る。 */
export function parseCountResponse(text) {
  const counts = new Map();
  if (!text) return counts;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return counts;
  }
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    for (const [url, value] of Object.entries(json)) {
      const count = Number(value);
      if (Number.isFinite(count)) counts.set(url, count);
    }
  }
  return counts;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * はてなブックマーク数をまとめて取得する。
 * ネットワークが使えない環境では単に空のMapを返し、クロール自体は止めない。
 */
export async function fetchBookmarkCounts(urls, options = {}) {
  const { concurrency = 3, signal } = options;
  const unique = [...new Set(urls.filter(Boolean))];
  const counts = new Map();
  if (unique.length === 0) return counts;

  const groups = chunk(unique, BULK_CHUNK);
  await mapWithConcurrency(groups, concurrency, async (group) => {
    const query = group.map((url) => `url=${encodeURIComponent(url)}`).join('&');
    try {
      const res = await fetchText(`${BULK_ENDPOINT}?${query}`, {
        timeoutMs: 10000,
        retries: 1,
        signal,
        headers: { accept: 'application/json' },
      });
      for (const [url, count] of parseCountResponse(res.body)) counts.set(url, count);
    } catch {
      // 取得できなくてもブックマーク数が無いだけなので握りつぶす。
    }
  });
  return counts;
}

/** 単一URLのブックマーク情報（件数・コメント数）を取得する。 */
export async function fetchEntryInfo(url, options = {}) {
  try {
    const res = await fetchText(`${COUNT_ENDPOINT}?url=${encodeURIComponent(url)}`, {
      timeoutMs: 10000,
      retries: 1,
      ...options,
      headers: { accept: 'application/json' },
    });
    const json = JSON.parse(res.body || 'null');
    if (!json) return { count: 0, comments: 0 };
    return {
      count: Number(json.count) || 0,
      comments: Array.isArray(json.bookmarks)
        ? json.bookmarks.filter((b) => b && b.comment).length
        : 0,
    };
  } catch {
    return { count: 0, comments: 0 };
  }
}
