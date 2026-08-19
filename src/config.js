import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const paths = {
  root: ROOT_DIR,
  public: join(ROOT_DIR, 'public'),
  fixtures: join(ROOT_DIR, 'fixtures'),
  sourcesFile: process.env.MATOME_SOURCES ?? join(ROOT_DIR, 'config', 'sources.json'),
  // サーバレス環境（Vercelなど）はプロジェクト配下が読み取り専用なので /tmp を使う。
  dataDir: process.env.MATOME_DATA_DIR
    ?? (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
      ? join(tmpdir(), 'matome')
      : join(ROOT_DIR, 'data')),
};

paths.storeFile = join(paths.dataDir, 'articles.json');

/** config/sources.json を読み、最低限の検証をして返す。 */
export async function loadSources(file = process.env.MATOME_SOURCES ?? paths.sourcesFile) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    // サーバレスにデプロイするとJSONが同梱されないことがあるので、
    // 既定パスに限り、バンドルされたコピーへフォールバックする。
    if (error.code === 'ENOENT' && file === paths.sourcesFile) {
      parsed = (await import('../config/sources.json', { with: { type: 'json' } })).default;
    } else {
      throw error;
    }
  }
  const list = Array.isArray(parsed) ? parsed : parsed.sources;
  if (!Array.isArray(list)) throw new Error(`sources.json の形式が不正です: ${file}`);

  const seen = new Set();
  return list.map((source, index) => {
    if (!source.id) throw new Error(`sources[${index}] に id がありません`);
    if (!source.feed) throw new Error(`sources[${index}] (${source.id}) に feed がありません`);
    if (seen.has(source.id)) throw new Error(`id が重複しています: ${source.id}`);
    seen.add(source.id);
    return {
      id: source.id,
      name: source.name ?? source.id,
      category: source.category ?? 'その他',
      site: source.site ?? '',
      feed: source.feed,
      weight: Number.isFinite(source.weight) ? source.weight : 1,
      enabled: source.enabled !== false,
    };
  });
}

/** config/sources.json を書き戻す（$comment などの付随キーは維持する）。 */
export async function saveSources(sources, file = process.env.MATOME_SOURCES ?? paths.sourcesFile) {
  let extras = {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed && !Array.isArray(parsed)) {
      const { sources: _ignored, ...rest } = parsed;
      extras = rest;
    }
  } catch {
    extras = {};
  }
  const body = JSON.stringify({ ...extras, sources }, null, 2);
  await writeFile(file, `${body}\n`, 'utf8');
  return sources.length;
}
