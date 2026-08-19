const HOUR = 60 * 60 * 1000;

/**
 * 人気スコア。ブックマーク数を主軸に、時間経過で減衰させる。
 * 新着でまだブックマークが付いていない記事も少しだけ拾えるようにしている。
 */
export function popularityScore(article, { now = Date.now(), weight = 1, halfLifeHours = 8 } = {}) {
  const published = article.publishedAt ?? article.firstSeenAt ?? now;
  const ageHours = Math.max(0, (now - published) / HOUR);
  const decay = 1 / (1 + ageHours / halfLifeHours) ** 1.4;
  const base = Math.log1p(Math.max(0, article.bookmarks ?? 0)) * 10 + 1;
  return base * decay * (weight ?? 1);
}

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKC');
}

/** タイトル・要約・ブログ名を対象にした素朴なAND検索。 */
export function matchesQuery(article, query) {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = normalize(`${article.title} ${article.summary} ${article.sourceName} ${(article.categories ?? []).join(' ')}`);
  return terms.every((term) => haystack.includes(term));
}

/** NGワード（部分一致）に引っかかる記事を弾く。 */
export function isBlocked(article, ngWords = []) {
  const haystack = normalize(`${article.title} ${article.summary}`);
  return ngWords
    .map((w) => normalize(w))
    .filter(Boolean)
    .some((word) => haystack.includes(word));
}

/**
 * 一覧の並べ替えと絞り込み。
 * @param {Array<object>} articles
 * @param {object} options
 */
export function selectArticles(articles, options = {}) {
  const {
    tab = 'latest',
    query = '',
    sourceIds = null,
    ngWords = [],
    withinHours = null,
    limit = 50,
    offset = 0,
    now = Date.now(),
    weights = {},
  } = options;

  const cutoff = withinHours ? now - withinHours * HOUR : null;
  const filtered = articles.filter((article) => {
    if (sourceIds && sourceIds.length && !sourceIds.includes(article.sourceId)) return false;
    if (cutoff !== null && (article.publishedAt ?? article.firstSeenAt) < cutoff) return false;
    if (!matchesQuery(article, query)) return false;
    if (isBlocked(article, ngWords)) return false;
    return true;
  });

  const sorted = filtered
    .map((article) => ({
      article,
      score: popularityScore(article, { now, weight: weights[article.sourceId] ?? 1 }),
      time: article.publishedAt ?? article.firstSeenAt ?? 0,
    }))
    .sort((a, b) => {
      if (tab === 'popular') {
        if (b.score !== a.score) return b.score - a.score;
        return b.time - a.time;
      }
      if (b.time !== a.time) return b.time - a.time;
      return b.score - a.score;
    });

  return {
    total: sorted.length,
    items: sorted.slice(offset, offset + limit).map((entry) => entry.article),
  };
}
