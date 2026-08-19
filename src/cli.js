#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { loadSources, saveSources, paths } from './config.js';
import { Store } from './store.js';
import { crawl } from './crawler.js';
import { createApp } from './server.js';
import { seed } from './seed.js';
import { discoverFeed, verifySources, resolveCandidates, defaultId } from './discover.js';

const USAGE = `まとめサイトのまとめサイト

使い方:
  node src/cli.js serve [--port 3000] [--interval 10]  サーバを起動（--interval 分ごとに自動クロール、0で無効）
  node src/cli.js crawl [--no-bookmarks]               フィードを1回取得してストアを更新
  node src/cli.js seed                                 サンプル記事を投入（オフライン確認用）
  node src/cli.js sources                              購読中のブログ一覧と最終取得状況を表示
  node src/cli.js verify [--prune]                     全フィードが実在するか確認（--prune で読めないブログを設定から削除）
  node src/cli.js add <サイトURL> [--id x] [--name y] [--category z]
                                                       サイトURLからフィードを自動発見して購読に追加
  node src/cli.js add --list <候補ファイル> [--category z] [--dry-run]
                                                       候補リストをまとめて試し、読めたものだけ追加

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

  if (command === 'verify') {
    const results = await verifySources(sources, {
      logger: (source, result) => {
        if (result.ok) {
          const latest = result.latest ? `最新 ${formatTime(result.latest)}` : '日時なし';
          console.log(`✓ ${source.name} — ${result.count}件 / ${latest}`);
        } else {
          console.log(`✗ ${source.name} — ${result.error}\n    ${source.feed}`);
        }
      },
    });
    const alive = results.filter((r) => r.ok);
    const dead = results.filter((r) => !r.ok);
    console.log(`\n実在 ${alive.length} / 到達できず ${dead.length}`);

    if (args.prune && dead.length > 0) {
      const deadIds = new Set(dead.map((r) => r.source.id));
      const kept = sources.filter((s) => !deadIds.has(s.id));
      await saveSources(kept);
      console.log(`設定から削除: ${dead.map((r) => r.source.name).join('、')}`);
      console.log(`残り ${kept.length}ブログ（${paths.sourcesFile}）`);
    } else if (dead.length > 0) {
      console.log('削除するには --prune を付けて再実行してください。');
    }
    if (dead.length > 0 && !args.prune) process.exitCode = 1;
    return;
  }

  if (command === 'add') {
    if (args.list) {
      const raw = JSON.parse(await readFile(args.list, 'utf8'));
      const candidates = Array.isArray(raw) ? raw : raw.candidates ?? raw.sites ?? [];
      if (candidates.length === 0) {
        process.stderr.write(`候補が空です: ${args.list}\n`);
        process.exitCode = 2;
        return;
      }
      console.log(`${candidates.length}件の候補を順に確認します…\n`);
      const result = await resolveCandidates(candidates, {
        existing: sources,
        category: args.category ?? raw.category ?? 'その他',
        logger: (event) => {
          if (event.type === 'add') console.log(`✓ ${event.label} — ${event.entry.feed}（${event.count}件）`);
          if (event.type === 'skip') console.log(`- ${event.label} — ${event.reason}`);
          if (event.type === 'fail') console.log(`✗ ${event.label} — ${event.error}`);
        },
      });

      console.log(`\n追加 ${result.added.length} / 登録済み ${result.skipped.length} / 見つからず ${result.failed.length}`);
      if (result.added.length === 0) return;
      if (args['dry-run']) {
        console.log('--dry-run のため設定は変更していません。');
        return;
      }
      await saveSources([...sources, ...result.added]);
      console.log(`${paths.sourcesFile} を更新しました（計 ${sources.length + result.added.length}ブログ）`);
      return;
    }

    const target = args._[1];
    if (!target) {
      process.stderr.write('サイトURL（またはフィードURL）、あるいは --list <候補ファイル> を指定してください\n');
      process.exitCode = 2;
      return;
    }
    console.log(`フィードを探しています: ${target}`);
    const found = await discoverFeed(target);
    if (!found.ok) {
      console.error(`見つかりませんでした: ${found.error}`);
      for (const attempt of found.tried ?? []) {
        if (!attempt.ok) console.error(`  試行: ${attempt.url} — ${attempt.error}`);
      }
      process.exitCode = 1;
      return;
    }

    const id = args.id ?? defaultId(found.site || found.url);
    if (sources.some((s) => s.id === id)) {
      console.error(`id が既にあります: ${id}（--id で別名を指定してください）`);
      process.exitCode = 1;
      return;
    }
    const entry = {
      id,
      name: args.name ?? found.title ?? id,
      category: args.category ?? 'その他',
      site: found.site || target,
      feed: found.url,
      weight: 1,
    };
    await saveSources([...sources, entry]);
    console.log(`追加しました（${found.via === 'direct' ? '指定URLがフィード' : found.via === 'link' ? 'ページ内のリンクから発見' : 'よくあるパスから発見'}）`);
    console.log(`  ${entry.name} [${entry.id}] — ${entry.feed}（${found.count}件）`);
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
