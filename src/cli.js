#!/usr/bin/env node
import { loadSources, paths } from './config.js';
import { Store } from './store.js';
import { crawl } from './crawler.js';
import { createApp } from './server.js';
import { seed } from './seed.js';

const USAGE = `まとめサイトのまとめサイト

使い方:
  node src/cli.js serve [--port 3000] [--interval 10]  サーバを起動（--interval 分ごとに自動クロール、0で無効）
  node src/cli.js crawl [--no-bookmarks]               フィードを1回取得してストアを更新
  node src/cli.js seed                                 サンプル記事を投入（オフライン確認用）
  node src/cli.js sources                              購読中のブログ一覧と最終取得状況を表示

環境変数:
  PORT               serve のポート（既定 3000）
  MATOME_DATA_DIR    データ保存先（既定 ./data）
  MATOME_SOURCES     ブログ定義ファイル（既定 ./config/sources.json）
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=');
      if (inline !== undefined) args[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function formatTime(ms) {
  if (!ms) return '未取得';
  return new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'serve';
  if (command === 'help' || args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const sources = await loadSources();
  const store = await Store.open(paths.storeFile);

  if (command === 'crawl') {
    const summary = await crawl(store, sources, {
      withBookmarks: args['no-bookmarks'] !== true,
      logger: (line) => console.log(line),
    });
    console.log(
      `\n完了: 成功 ${summary.ok} / 失敗 ${summary.failed}、新着 ${summary.added}件、保有 ${summary.total}件`,
    );
    if (summary.failed > 0) process.exitCode = 1;
    return;
  }

  if (command === 'seed') {
    const result = await seed(store, sources);
    console.log(`サンプル投入: ${result.files}フィード / 新規 ${result.added}件 / 保有 ${result.total}件`);
    return;
  }

  if (command === 'sources') {
    for (const source of sources) {
      const stat = store.sources[source.id] ?? {};
      const count = store.articles.filter((a) => a.sourceId === source.id).length;
      console.log(
        `${source.id.padEnd(14)} ${source.name}\n  ${source.feed}\n  記事 ${count}件 / 最終取得 ${formatTime(stat.lastCrawledAt)} ${stat.lastStatus ?? ''} ${stat.lastError ?? ''}`.trimEnd(),
      );
    }
    return;
  }

  if (command !== 'serve') {
    process.stderr.write(`不明なコマンド: ${command}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const port = Number(args.port ?? process.env.PORT ?? 3000);
  const intervalMinutes = Number(args.interval ?? process.env.MATOME_CRAWL_INTERVAL ?? 10);

  const runCrawl = () => crawl(store, sources, { logger: (line) => console.log(`[crawl] ${line}`) });
  const server = createApp({ store, sources, onCrawl: runCrawl });

  server.listen(port, () => {
    console.log(`まとめのまとめ: http://localhost:${port}`);
    console.log(`記事 ${store.articles.length}件 / ブログ ${sources.length}件 / データ ${store.path}`);
    if (store.articles.length === 0) {
      console.log('記事が0件です。`npm run crawl`（要ネットワーク）か `npm run seed`（サンプル）を実行してください。');
    }
  });

  if (intervalMinutes > 0) {
    const timer = setInterval(() => {
      runCrawl().catch((error) => console.error(`[crawl] 失敗: ${error.message}`));
    }, intervalMinutes * 60 * 1000);
    timer.unref?.();
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
