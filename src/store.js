import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalizeUrl } from './url.js';

const VERSION = 1;

function emptyState() {
  return { version: VERSION, updatedAt: 0, articles: [], sources: {} };
}

/**
 * JSONファイル1枚で完結する記事ストア。
 * 記事は正規化URLを主キーとして重複排除する。
 */
export class Store {
  #path;
  #state;
  #writing = Promise.resolve();

  constructor(path, state = emptyState()) {
    this.#path = path;
    this.#state = state;
  }

  static async open(path) {
    let state = emptyState();
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.articles)) {
        state = { ...emptyState(), ...parsed };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`ストアの読み込みに失敗しました (${path}): ${error.message}`);
      }
    }
    return new Store(path, state);
  }

  get path() {
    return this.#path;
  }

  get updatedAt() {
    return this.#state.updatedAt;
  }

  get articles() {
    return this.#state.articles;
  }

  get sources() {
    return this.#state.sources;
  }

  /** 記事を追加/更新する。戻り値は新規に追加された件数。 */
  upsertArticles(items, { now = Date.now() } = {}) {
    const byUrl = new Map(this.#state.articles.map((a) => [a.url, a]));
    let added = 0;
    for (const item of items) {
      const url = canonicalizeUrl(item.url);
      if (!url || !item.title) continue;
      const existing = byUrl.get(url);
      if (existing) {
        // タイトル修正や日時の後付けは取り込むが、初出時刻は保持する。
        existing.title = item.title || existing.title;
        existing.summary = item.summary || existing.summary;
        existing.image = item.image || existing.image;
        existing.publishedAt = item.publishedAt ?? existing.publishedAt;
        existing.categories = item.categories?.length ? item.categories : existing.categories;
        continue;
      }
      const article = {
        url,
        title: item.title,
        sourceId: item.sourceId ?? '',
        sourceName: item.sourceName ?? '',
        publishedAt: item.publishedAt ?? now,
        firstSeenAt: now,
        summary: item.summary ?? '',
        image: item.image ?? '',
        categories: item.categories ?? [],
        bookmarks: 0,
        bookmarksCheckedAt: 0,
      };
      byUrl.set(url, article);
      this.#state.articles.push(article);
      added += 1;
    }
    this.#state.updatedAt = now;
    return added;
  }

  /** はてなブックマーク数を反映する。 */
  applyBookmarkCounts(counts, { now = Date.now() } = {}) {
    let updated = 0;
    for (const article of this.#state.articles) {
      if (!counts.has(article.url)) continue;
      const count = counts.get(article.url);
      if (article.bookmarks !== count) updated += 1;
      article.bookmarks = count;
      article.bookmarksCheckedAt = now;
    }
    return updated;
  }

  /** クロール結果のメタ情報を記録する。 */
  recordSource(sourceId, info) {
    this.#state.sources[sourceId] = { ...(this.#state.sources[sourceId] ?? {}), ...info };
  }

  /** 古い記事・件数超過分を捨てる。戻り値は削除件数。 */
  prune({ maxAgeDays = 14, maxArticles = 5000, now = Date.now() } = {}) {
    const before = this.#state.articles.length;
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    let kept = this.#state.articles.filter((a) => (a.publishedAt ?? a.firstSeenAt) >= cutoff);
    kept.sort((a, b) => (b.publishedAt ?? b.firstSeenAt) - (a.publishedAt ?? a.firstSeenAt));
    if (kept.length > maxArticles) kept = kept.slice(0, maxArticles);
    this.#state.articles = kept;
    return before - kept.length;
  }

  toJSON() {
    return this.#state;
  }

  /** 一時ファイル経由で書き込み、途中終了でファイルを壊さない。 */
  async save() {
    this.#writing = this.#writing.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#state), 'utf8');
      await rename(tmp, this.#path);
    });
    return this.#writing;
  }
}
