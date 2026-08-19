/**
 * まとめのまとめ フロントエンド。
 * 記事データはサーバ（/api/*）、既読・ブックマーク・設定はローカル保存。
 */

const KEYS = {
  settings: 'matome.settings.v1',
  bookmarks: 'matome.bookmarks.v1',
  read: 'matome.read.v1',
  nav: 'matome.nav.v1',
};

const SETTINGS_SCHEMA = 3;

const DEFAULT_SETTINGS = {
  sort: 'popular',
  ngWords: '',
  hideRead: false,
  showThumbs: false,
  popularHours: 48,
  pageSize: 60,
  theme: 'auto',
  fontScale: 1,
  openInNewTab: false,
  readerMode: true,
  mutedSources: [],
  schema: SETTINGS_SCHEMA,
};

const TAB_TITLES = {
  latest: '今日の記事',
  search: '記事を探す',
  bookmarks: 'ブックマーク',
  blogs: 'ブログ',
  settings: '設定',
};

const MAX_READ_HISTORY = 2000;

/* ---------- ローカル保存 ---------- */

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // プライベートブラウズなどで保存できなくても表示は続ける。
  }
}

/**
 * 保存済みの設定を今のスキーマに合わせる。
 * schema 2: 記事は既定で同じタブに遷移する（以前は新しいタブだった）
 */
function migrateSettings(stored) {
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  if ((stored.schema ?? 1) < 2) {
    settings.openInNewTab = false;
  }
  if ((stored.schema ?? 1) < 3) {
    settings.readerMode = true; // schema 3: 広告を除去したリーダー表示を既定に
  }
  settings.schema = SETTINGS_SCHEMA;
  return settings;
}

const state = {
  tab: 'latest',
  settings: migrateSettings(readJson(KEYS.settings, {})),
  bookmarks: readJson(KEYS.bookmarks, []),
  read: new Set(readJson(KEYS.read, [])),
  sources: [],
  items: [],
  total: 0,
  offset: 0,
  query: '',
  sourceFilter: '',
  loading: false,
  status: null,
};

function saveSettings() {
  writeJson(KEYS.settings, state.settings);
  applyTheme();
}

function saveBookmarks() {
  writeJson(KEYS.bookmarks, state.bookmarks);
}

function saveRead() {
  writeJson(KEYS.read, [...state.read].slice(-MAX_READ_HISTORY));
}

/**
 * 同じタブで記事に遷移すると、戻ったときページは作り直される。
 * どのタブをどこまで読んでいたかを覚えておいて、そこへ戻す。
 */
function saveNav() {
  try {
    sessionStorage.setItem(KEYS.nav, JSON.stringify({
      tab: state.tab,
      query: state.query,
      sourceFilter: state.sourceFilter,
      loaded: state.items.length,
      scrollY: Math.round(window.scrollY),
      savedAt: Date.now(),
    }));
  } catch {
    // 保存できなくても遷移自体は妨げない。
  }
}

function loadNav() {
  let nav;
  try {
    nav = JSON.parse(sessionStorage.getItem(KEYS.nav) ?? 'null');
  } catch {
    return null;
  }
  // 30分以上前の位置まで復元すると、かえって古い一覧を見せてしまう。
  if (!nav || Date.now() - (nav.savedAt ?? 0) > 30 * 60 * 1000) return null;
  return nav;
}

/* ---------- 小物 ---------- */

const el = document.getElementById.bind(document);
const view = el('view');

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const yesterday = new Date(now.getTime() - 86400000);
  if (date.toDateString() === yesterday.toDateString()) return `昨日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatUpdatedAt(ms) {
  if (!ms) return 'まだ取得していません';
  const diffMin = Math.floor((Date.now() - ms) / 60000);
  if (diffMin < 1) return 'たった今更新';
  if (diffMin < 60) return `${diffMin}分前に更新`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}時間前に更新`;
  return `${new Date(ms).toLocaleString('ja-JP')} に更新`;
}

let toastTimer = null;
function toast(message) {
  const node = el('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

function setLoading(loading) {
  state.loading = loading;
  el('progress').hidden = !loading;
  el('refresh').classList.toggle('is-busy', loading);
}

function ngWordList() {
  return state.settings.ngWords.split(/[\n,、]/).map((w) => w.trim()).filter(Boolean);
}

function applyTheme() {
  const root = document.documentElement;
  if (state.settings.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.settings.theme);
  root.style.setProperty('--font-scale', String(state.settings.fontScale));
}

/* ---------- API ---------- */

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function loadSources() {
  const data = await api('/api/sources');
  state.sources = data.sources;
}

async function loadArticles({ append = false, limit = state.settings.pageSize } = {}) {
  const params = new URLSearchParams();
  const isSearch = state.tab === 'search';
  params.set('tab', isSearch ? 'latest' : state.settings.sort);
  params.set('limit', String(limit));
  params.set('offset', String(append ? state.offset : 0));
  if (isSearch && state.query) params.set('q', state.query);
  if (!isSearch && state.settings.sort === 'popular') params.set('hours', String(state.settings.popularHours));

  const muted = new Set(state.settings.mutedSources);
  const visible = state.sources.filter((s) => !muted.has(s.id)).map((s) => s.id);
  const selected = state.sourceFilter ? [state.sourceFilter] : visible;
  if (state.sources.length && selected.length !== state.sources.length) {
    params.set('sources', selected.join(','));
  }
  const ng = ngWordList();
  if (ng.length) params.set('ng', ng.join(','));

  setLoading(true);
  try {
    const data = await api(`/api/articles?${params}`);
    state.items = append ? state.items.concat(data.items) : data.items;
    state.total = data.total;
    state.offset = state.items.length;
    state.status = { updatedAt: data.updatedAt };
  } catch (error) {
    toast(`記事を取得できませんでした（${error.message}）`);
  } finally {
    setLoading(false);
  }
}

/* ---------- 記事行 ---------- */

function isBookmarked(url) {
  return state.bookmarks.some((b) => b.url === url);
}

function articleRow(article, { removable = false } = {}) {
  const read = state.read.has(article.url);
  const marked = isBookmarked(article.url);
  const users = article.bookmarks > 0
    ? `<span class="badge">${article.bookmarks} users</span>`
    : '';
  const thumb = state.settings.showThumbs && article.image
    ? `<img class="row-thumb" src="${escapeHtml(article.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '';
  return `
    <li class="row ${read ? 'is-read' : ''}" data-url="${escapeHtml(article.url)}">
      ${thumb}
      <div class="row-main">
        <p class="row-title">${escapeHtml(article.title)}</p>
        <div class="row-meta">
          ${users}
          <span class="spacer"></span>
          <span class="stack">
            <span class="source">${escapeHtml(article.sourceName)}</span>
            <span class="time">${formatTime(article.publishedAt)}</span>
          </span>
        </div>
      </div>
      <div class="row-side">
        <button class="star-btn" type="button" data-action="${removable ? 'unbookmark' : 'bookmark'}"
          aria-pressed="${marked}" aria-label="${marked ? 'ブックマーク解除' : 'ブックマークに追加'}">
          <svg class="icon"><use href="#i-star"></use></svg>
        </button>
        <svg class="chevron"><use href="#i-chevron"></use></svg>
      </div>
    </li>`;
}

function articleList(items, emptyMessage, { removable = false } = {}) {
  const filtered = state.settings.hideRead
    ? items.filter((a) => !state.read.has(a.url) || removable)
    : items;
  if (filtered.length === 0) return `<p class="empty">${emptyMessage}</p>`;
  return `<ul class="list">${filtered.map((a) => articleRow(a, { removable })).join('')}</ul>`;
}

/* ---------- 各タブの描画 ---------- */

function renderLatest() {
  const filterLabel = state.sourceFilter
    ? `<div class="chips"><button class="chip" aria-pressed="true" data-action="clear-filter">${escapeHtml(
        state.sources.find((s) => s.id === state.sourceFilter)?.name ?? state.sourceFilter,
      )} ✕</button></div>`
    : '';
  const more = state.items.length < state.total
    ? '<button class="more" type="button" data-action="more">もっと読む</button>'
    : '';
  view.innerHTML = `
    ${filterLabel}
    ${articleList(state.items, '記事がありません。<br>右上の更新ボタンか、設定タブの「今すぐ更新」をお試しください。')}
    ${more}
    <p class="meta-note">${escapeHtml(formatUpdatedAt(state.status?.updatedAt))} ・ ${state.total}件</p>`;
}

function renderSearch() {
  const chips = state.sources.map((s) => `
    <button class="chip" type="button" data-action="filter" data-id="${escapeHtml(s.id)}"
      aria-pressed="${state.sourceFilter === s.id}">${escapeHtml(s.name)}</button>`).join('');
  const results = state.query || state.sourceFilter
    ? articleList(state.items, 'ヒットする記事がありませんでした。')
    : '<p class="empty">キーワードを入力するか、<br>ブログを選んで絞り込めます。</p>';
  const more = (state.query || state.sourceFilter) && state.items.length < state.total
    ? '<button class="more" type="button" data-action="more">もっと読む</button>'
    : '';
  view.innerHTML = `
    <div class="searchbar">
      <input id="q" type="search" placeholder="キーワードで検索（スペースでAND）" value="${escapeHtml(state.query)}"
        enterkeyhint="search" autocomplete="off">
    </div>
    <div class="chips">
      <button class="chip" type="button" data-action="filter" data-id="" aria-pressed="${!state.sourceFilter}">すべて</button>
      ${chips}
    </div>
    ${results}
    ${more}`;
}

function renderBookmarks() {
  const items = [...state.bookmarks].sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  view.innerHTML = `
    ${articleList(items, 'ブックマークはまだありません。<br>記事の☆をタップすると保存できます。', { removable: true })}
    ${items.length ? '<div class="settings-actions"><button type="button" class="danger" data-action="clear-bookmarks">すべて削除</button></div>' : ''}`;
}

function renderBlogs() {
  const muted = new Set(state.settings.mutedSources);
  const byCategory = new Map();
  for (const source of state.sources) {
    if (!byCategory.has(source.category)) byCategory.set(source.category, []);
    byCategory.get(source.category).push(source);
  }
  const sections = [...byCategory.entries()].map(([category, list]) => `
    <h2 class="section-title">${escapeHtml(category)}</h2>
    ${list.map((source) => `
      <div class="blog-row">
        <span class="blog-name" data-action="open-blog" data-id="${escapeHtml(source.id)}">
          ${escapeHtml(source.name)}
          ${source.lastStatus === 'error' ? `<span class="status-err">取得エラー: ${escapeHtml(String(source.lastError ?? '').slice(0, 60))}</span>` : ''}
        </span>
        <span class="blog-count">${source.articleCount ?? 0}件</span>
        <label class="switch">
          <input type="checkbox" data-action="mute" data-id="${escapeHtml(source.id)}" ${muted.has(source.id) ? '' : 'checked'}>
          <span></span>
        </label>
      </div>`).join('')}`).join('');
  view.innerHTML = `${sections}
    <p class="meta-note">スイッチを切ると、そのブログの記事は一覧に出なくなります。ブログ名をタップするとそのブログだけ表示します。</p>`;
}

function renderSettings() {
  const s = state.settings;
  view.innerHTML = `
    <h2 class="section-title">表示</h2>
    <div class="settings-row">
      <label for="set-reader">広告を隠して読む（リーダーモード）<span class="hint">記事の本文だけを抽出してアプリ内に表示します。広告・アフィリエイトは除去されます</span></label>
      <span class="switch"><input id="set-reader" type="checkbox" data-setting="readerMode" ${s.readerMode ? 'checked' : ''}><span></span></span>
    </div>
    <div class="settings-row">
      <label for="set-hide-read">既読を隠す<span class="hint">開いた記事を一覧から消します</span></label>
      <span class="switch"><input id="set-hide-read" type="checkbox" data-setting="hideRead" ${s.hideRead ? 'checked' : ''}><span></span></span>
    </div>
    <div class="settings-row">
      <label for="set-thumbs">サムネイルを表示<span class="hint">通信量が増えます</span></label>
      <span class="switch"><input id="set-thumbs" type="checkbox" data-setting="showThumbs" ${s.showThumbs ? 'checked' : ''}><span></span></span>
    </div>
    <div class="settings-row">
      <label for="set-newtab">記事を新しいタブで開く<span class="hint">リーダーモードがオフのときの動き。オフなら同じタブで開きます</span></label>
      <span class="switch"><input id="set-newtab" type="checkbox" data-setting="openInNewTab" ${s.openInNewTab ? 'checked' : ''}><span></span></span>
    </div>
    <div class="settings-row">
      <label for="set-theme">テーマ</label>
      <select id="set-theme" data-setting="theme">
        <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>自動</option>
        <option value="light" ${s.theme === 'light' ? 'selected' : ''}>ライト</option>
        <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>ダーク</option>
      </select>
    </div>
    <div class="settings-row">
      <label for="set-font">文字サイズ</label>
      <select id="set-font" data-setting="fontScale">
        <option value="0.9" ${s.fontScale == 0.9 ? 'selected' : ''}>小</option>
        <option value="1" ${s.fontScale == 1 ? 'selected' : ''}>標準</option>
        <option value="1.15" ${s.fontScale == 1.15 ? 'selected' : ''}>大</option>
        <option value="1.3" ${s.fontScale == 1.3 ? 'selected' : ''}>特大</option>
      </select>
    </div>

    <h2 class="section-title">記事の取得</h2>
    <div class="settings-row">
      <label for="set-hours">人気の集計期間<span class="hint">この時間内の記事をはてブ数で並べます</span></label>
      <select id="set-hours" data-setting="popularHours">
        <option value="6" ${s.popularHours == 6 ? 'selected' : ''}>6時間</option>
        <option value="24" ${s.popularHours == 24 ? 'selected' : ''}>24時間</option>
        <option value="48" ${s.popularHours == 48 ? 'selected' : ''}>48時間</option>
        <option value="168" ${s.popularHours == 168 ? 'selected' : ''}>1週間</option>
      </select>
    </div>
    <div class="settings-row">
      <label for="set-page">1回に読み込む件数</label>
      <input id="set-page" type="number" min="10" max="200" step="10" value="${s.pageSize}" data-setting="pageSize">
    </div>
    <div class="settings-row stack">
      <label for="set-ng">NGワード<span class="hint">改行またはカンマ区切り。含む記事を隠します</span></label>
      <textarea id="set-ng" data-setting="ngWords" placeholder="例）ネタバレ, 芸能">${escapeHtml(s.ngWords)}</textarea>
    </div>

    <div class="settings-actions">
      <button type="button" data-action="refresh">今すぐ更新</button>
      <button type="button" data-action="clear-read">既読履歴を消す（${state.read.size}件）</button>
      <button type="button" class="danger" data-action="reset">設定を初期化</button>
    </div>
    <p class="meta-note">
      ${escapeHtml(formatUpdatedAt(state.status?.updatedAt))} ・ 購読ブログ ${state.sources.length}件<br>
      既読・ブックマーク・設定はこの端末のブラウザ内にのみ保存されます。
    </p>`;
}

function render() {
  el('appbar-title').textContent = state.sourceFilter && state.tab === 'latest'
    ? state.sources.find((s) => s.id === state.sourceFilter)?.name ?? TAB_TITLES.latest
    : TAB_TITLES[state.tab];
  el('appbar-right').hidden = state.tab !== 'latest';
  for (const button of document.querySelectorAll('.segmented button')) {
    button.setAttribute('aria-selected', String(button.dataset.sort === state.settings.sort));
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === state.tab);
  }

  if (state.tab === 'latest') renderLatest();
  else if (state.tab === 'search') renderSearch();
  else if (state.tab === 'bookmarks') renderBookmarks();
  else if (state.tab === 'blogs') renderBlogs();
  else renderSettings();
}

/* ---------- 操作 ---------- */

function openArticle(url) {
  const article = state.items.find((a) => a.url === url) ?? state.bookmarks.find((a) => a.url === url);
  state.read.add(url);
  saveRead();
  saveNav();
  if (state.settings.readerMode) {
    openReader(url, article);
    render();
  } else if (state.settings.openInNewTab) {
    window.open(url, '_blank', 'noopener');
    render();
  } else {
    // 同じタブで遷移する。既読の見た目は戻ってきたときに反映される。
    window.location.assign(url);
  }
  return article;
}

/* ---------- リーダーモード（広告を除去したアプリ内表示） ---------- */

function readerEl() {
  return document.getElementById('reader');
}

function closeReader({ fromPopstate = false } = {}) {
  const node = readerEl();
  if (!node) return;
  node.remove();
  document.body.classList.remove('reader-open');
  if (!fromPopstate && history.state?.reader) history.back();
}

async function openReader(url, article) {
  closeReader({ fromPopstate: true });
  history.pushState({ reader: url }, '', location.href); // 端末の「戻る」で閉じられるように

  const overlay = document.createElement('div');
  overlay.id = 'reader';
  overlay.className = 'reader';
  overlay.innerHTML = `
    <header class="reader-header">
      <button type="button" class="reader-back" data-reader="close" aria-label="一覧に戻る">←</button>
      <span class="reader-source">${escapeHtml(article?.sourceName ?? '')}</span>
      <a class="reader-origin" href="${escapeHtml(url)}" target="_blank" rel="noopener">元記事</a>
    </header>
    <div class="reader-body"><p class="reader-loading">広告を除去して読み込み中…</p></div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('reader-open');
  overlay.scrollTop = 0;

  const body = overlay.querySelector('.reader-body');
  try {
    const res = await fetch(`/api/extract?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (!readerEl()) return; // 読み込み中に閉じられた
    body.innerHTML = `
      <h1 class="reader-title">${escapeHtml(data.title)}</h1>
      <p class="reader-meta">
        ${escapeHtml(data.sourceName ?? '')} ・ ${escapeHtml(formatTime(data.publishedAt))}
        ${data.bookmarks > 0 ? ` ・ <span class="badge">${data.bookmarks} users</span>` : ''}
      </p>
      <div class="reader-content">${data.html}</div>
      <p class="reader-foot"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">元のページで続きを読む →</a></p>`;
  } catch (error) {
    if (!readerEl()) return;
    body.innerHTML = `
      <p class="empty">本文を取り出せませんでした。<br>（${escapeHtml(error.message)}）</p>
      <div class="settings-actions">
        <button type="button" data-reader="open-origin">元のページを開く</button>
        <button type="button" data-reader="close">一覧に戻る</button>
      </div>`;
    overlay.dataset.url = url;
  }
}

document.addEventListener('click', (event) => {
  const control = event.target.closest('[data-reader]');
  if (!control) return;
  if (control.dataset.reader === 'close') closeReader();
  if (control.dataset.reader === 'open-origin') {
    const url = control.closest('.reader')?.dataset.url;
    if (url) window.open(url, '_blank', 'noopener');
  }
});

window.addEventListener('popstate', () => {
  if (readerEl()) closeReader({ fromPopstate: true });
});

function toggleBookmark(url) {
  const index = state.bookmarks.findIndex((b) => b.url === url);
  if (index >= 0) {
    state.bookmarks.splice(index, 1);
    toast('ブックマークを解除しました');
  } else {
    const article = state.items.find((a) => a.url === url);
    if (!article) return;
    state.bookmarks.push({ ...article, savedAt: Date.now() });
    toast('ブックマークに追加しました');
  }
  saveBookmarks();
  render();
}

async function switchTab(tab) {
  state.tab = tab;
  if (tab === 'latest') {
    state.sourceFilter = state.sourceFilter && state.tab === 'latest' ? state.sourceFilter : '';
    await loadArticles();
  } else if (tab === 'search') {
    if (state.query || state.sourceFilter) await loadArticles();
  } else if (tab === 'blogs' || tab === 'settings') {
    await loadSources().catch(() => {});
  }
  render();
  window.scrollTo({ top: 0 });
}

async function refresh() {
  if (state.loading) return;
  setLoading(true);
  try {
    const result = await api('/api/refresh', { method: 'POST' });
    const summary = result.summary;
    if (summary) {
      toast(`更新: 新着${summary.added}件 / 失敗${summary.failed}ブログ`);
    }
  } catch {
    toast('更新できませんでした（オフラインかもしれません）');
  } finally {
    setLoading(false);
  }
  await loadSources().catch(() => {});
  await loadArticles();
  render();
}

/* ---------- イベント ---------- */

document.querySelector('.tabbar').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) switchTab(tab.dataset.tab);
});

document.querySelector('.segmented').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-sort]');
  if (!button) return;
  state.settings.sort = button.dataset.sort;
  saveSettings();
  await loadArticles();
  render();
});

el('refresh').addEventListener('click', refresh);

view.addEventListener('click', async (event) => {
  const actionEl = event.target.closest('[data-action]');
  const action = actionEl?.dataset.action;

  if (action === 'bookmark' || action === 'unbookmark') {
    event.stopPropagation();
    const url = actionEl.closest('.row').dataset.url;
    toggleBookmark(url);
    return;
  }
  if (action === 'more') {
    await loadArticles({ append: true });
    render();
    return;
  }
  if (action === 'filter') {
    state.sourceFilter = actionEl.dataset.id;
    await loadArticles();
    render();
    return;
  }
  if (action === 'clear-filter') {
    state.sourceFilter = '';
    await loadArticles();
    render();
    return;
  }
  if (action === 'open-blog') {
    state.sourceFilter = actionEl.dataset.id;
    state.tab = 'latest';
    await loadArticles();
    render();
    window.scrollTo({ top: 0 });
    return;
  }
  if (action === 'clear-bookmarks') {
    if (!confirm('ブックマークをすべて削除しますか？')) return;
    state.bookmarks = [];
    saveBookmarks();
    render();
    return;
  }
  if (action === 'clear-read') {
    state.read.clear();
    saveRead();
    render();
    toast('既読履歴を消しました');
    return;
  }
  if (action === 'reset') {
    if (!confirm('設定を初期状態に戻しますか？')) return;
    state.settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    render();
    return;
  }
  if (action === 'refresh') {
    refresh();
    return;
  }

  const row = event.target.closest('.row');
  if (row) openArticle(row.dataset.url);
});

view.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.dataset.setting) {
    const key = target.dataset.setting;
    let value = target.type === 'checkbox' ? target.checked : target.value;
    if (key === 'pageSize') value = Math.min(200, Math.max(10, Number(value) || DEFAULT_SETTINGS.pageSize));
    if (key === 'popularHours' || key === 'fontScale') value = Number(value);
    state.settings[key] = value;
    saveSettings();
    if (['hideRead', 'showThumbs', 'ngWords', 'popularHours', 'pageSize'].includes(key)) {
      await loadArticles();
    }
    render();
    return;
  }
  if (target.dataset.action === 'mute') {
    const id = target.dataset.id;
    const muted = new Set(state.settings.mutedSources);
    if (target.checked) muted.delete(id);
    else muted.add(id);
    state.settings.mutedSources = [...muted];
    saveSettings();
    await loadArticles();
    render();
  }
});

let searchTimer = null;
view.addEventListener('input', (event) => {
  if (event.target.id !== 'q') return;
  const value = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    state.query = value.trim();
    await loadArticles();
    const focused = document.activeElement?.id === 'q';
    render();
    if (focused) {
      const input = el('q');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, 250);
});

/* ---------- 起動 ---------- */

(async function start() {
  applyTheme();
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  const nav = loadNav();
  if (nav) {
    state.tab = nav.tab ?? 'latest';
    state.query = nav.query ?? '';
    state.sourceFilter = nav.sourceFilter ?? '';
  }
  render();

  await loadSources().catch(() => {});
  if (state.tab !== 'bookmarks' && state.tab !== 'settings' && state.tab !== 'blogs') {
    // 「もっと読む」で伸ばしていた分も含めて読み直す。
    const wanted = Math.max(state.settings.pageSize, nav?.loaded ?? 0);
    await loadArticles({ limit: Math.min(wanted, 200) });
  }
  render();

  if (nav?.scrollY) {
    requestAnimationFrame(() => window.scrollTo(0, nav.scrollY));
  }
}());

// 記事以外の離脱（ブックマークからの遷移、リロード）でも位置を残す。
window.addEventListener('pagehide', saveNav);
