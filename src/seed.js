import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { paths } from './config.js';
import { parseFeed } from './feed.js';

const PLACEHOLDER = /\{\{-(\d+)m\}\}/g;

/**
 * fixtures/ のサンプルフィードをストアに流し込む。
 * ネットワークが使えない環境でもUIを一通り触れるようにするためのもの。
 */
export async function seed(store, sources = [], { now = Date.now(), dir = join(paths.fixtures, 'feeds') } = {}) {
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.rdf') || f.endsWith('.xml'));

  let bookmarks = {};
  try {
    bookmarks = JSON.parse(await readFile(join(paths.fixtures, 'bookmarks.json'), 'utf8'));
  } catch {
    bookmarks = {};
  }

  let added = 0;
  for (const file of files) {
    const sourceId = basename(file).replace(/\.(rdf|xml)$/, '');
    const raw = await readFile(join(dir, file), 'utf8');
    // {{-90m}} を「90分前」の実時刻に置換する。
    const xml = raw.replace(PLACEHOLDER, (_, minutes) => new Date(now - Number(minutes) * 60000).toISOString());
    const feed = parseFeed(xml, { feedUrl: `file://${file}` });
    const source = sourceById.get(sourceId);
    added += store.upsertArticles(
      feed.items.map((item) => ({
        ...item,
        sourceId,
        sourceName: source?.name ?? feed.title ?? sourceId,
      })),
      { now },
    );
    store.recordSource(sourceId, {
      name: source?.name ?? feed.title ?? sourceId,
      lastCrawledAt: now,
      lastStatus: 'seed',
      lastError: '',
      itemCount: feed.items.length,
    });
  }

  const counts = new Map(Object.entries(bookmarks));
  store.applyBookmarkCounts(counts, { now });
  await store.save();
  return { files: files.length, added, total: store.articles.length };
}
