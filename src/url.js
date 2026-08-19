const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|yclid$|ref$|ref_src$|from$|_ga$|mc_cid$|mc_eid$|rss$|feed$)/i;

/**
 * 同じ記事が違うURLで届いても1件として扱えるように正規化する。
 * - トラッキングパラメータを除去
 * - フラグメントを除去
 * - ホスト名を小文字化し、www. を落とす
 * - 末尾スラッシュを（パスがルートでなければ）落とす
 */
export function canonicalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.search = url.searchParams.toString() ? `?${url.searchParams.toString()}` : '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

/** 記事URLからホスト名だけを取り出す（表示・グルーピング用）。 */
export function hostOf(input) {
  try {
    return new URL(String(input)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 相対URLを絶対URLに直す。base が無ければそのまま返す。 */
export function resolveUrl(href, base) {
  if (!href) return '';
  try {
    return new URL(href, base || undefined).toString();
  } catch {
    return href;
  }
}
