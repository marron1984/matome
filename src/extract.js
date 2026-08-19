import { decodeEntities, attrOf } from './xml.js';
import { resolveUrl } from './url.js';

/**
 * まとめブログの記事ページから本文だけを取り出すリーダーモード用の抽出器。
 * 方針:
 *  - 本文コンテナ（article-body 等）を探し、その中だけを対象にする
 *  - タグはホワイトリスト方式で組み立て直す（属性は a[href] / img[src] のみ）
 *  - script / iframe / 広告クラス / アフィリエイトリンクはここで落ちる
 */

const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'embed', 'area', 'base', 'col', 'wbr']);

// サブツリーごと捨てるタグ（広告・埋め込み・操作要素）
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe', 'ins', 'form', 'button', 'select', 'option',
  'aside', 'nav', 'footer', 'svg', 'video', 'audio', 'object', 'embed', 'template', 'dialog', 'amp-ad',
]);

// 出力を許可するタグ（これ以外は unwrap: タグは消して中身だけ残す）
const KEEP_TAGS = new Set([
  'p', 'br', 'hr', 'blockquote', 'h2', 'h3', 'h4', 'ul', 'ol', 'li',
  'b', 'strong', 'i', 'em', 'u', 's', 'small', 'span', 'div', 'a', 'img',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'dl', 'dt', 'dd', 'pre', 'code', 'figure', 'figcaption',
]);

// class / id にこれが含まれる要素はサブツリーごと捨てる
const AD_PATTERN = /(^|[\s_-])(ads?|adsense|advertise\w*|advert|sponsor\w*|affiliates?|amazon\w*|rakuten\w*|asin|banner\w*|rect\w*|yads|uzou|outbrain|taboola|kauli|nend|imobile|popin|ldblog[-_]?ad|blogroll|relatedad|pr[-_]box)([\s\d_-]|$)/i;

// アフィリエイト・短縮リンクのホスト
const AFF_HOSTS = /(^|\.)(a8\.net|px\.a8\.net|amzn\.to|amzn\.asia|af\.moshimo\.com|hb\.afl\.rakuten\.co\.jp|afl\.rakuten\.co\.jp|valuecommerce\.com|ck\.jp\.ap\.valuecommerce\.com|rentracks\.jp|accesstrade\.net|felmat\.net|linksynergy\.com|h\.accesstrade\.net|tcs-asp\.net)$/i;

/** アフィリエイトリンクかどうか。判定できないURLは安全側で true。 */
export function isAffiliateLink(href) {
  if (!href) return true;
  let url;
  try {
    url = new URL(href);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  if (AFF_HOSTS.test(url.hostname)) return true;
  if (/(^|\.)amazon\.(co\.jp|com)$/i.test(url.hostname) && url.searchParams.has('tag')) return true;
  return false;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function parseTag(token) {
  const m = /^<\s*(\/)?\s*([a-zA-Z][\w:-]*)([\s\S]*?)(\/)?\s*>$/.exec(token);
  if (!m) return null;
  return { closing: Boolean(m[1]), name: m[2].toLowerCase(), attrs: m[3] ?? '', selfClosing: Boolean(m[4]) };
}

function isAdElement(attrs) {
  const cls = `${attrOf(attrs, 'class')} ${attrOf(attrs, 'id')}`;
  return AD_PATTERN.test(cls);
}

/**
 * 本文HTMLをホワイトリスト方式で安全なHTMLに組み立て直す。
 * @param {string} html 抽出済みコンテナの中身
 * @param {string} baseUrl 相対URL解決用
 */
export function sanitizeArticleHtml(html, baseUrl) {
  const source = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const tokenRe = /<[^>]*>|[^<]+/g;
  let out = '';
  const stack = []; // { name, emit }
  let skipName = null;
  let skipDepth = 0;
  let match;

  while ((match = tokenRe.exec(source)) !== null) {
    const token = match[0];

    if (token[0] !== '<') {
      if (!skipName) {
        const text = decodeEntities(token);
        if (text) out += escapeHtml(text);
      }
      continue;
    }

    const tag = parseTag(token);
    if (!tag) continue;

    // 捨てているサブツリーの中: 同名タグの入れ子だけ数えて出口を探す
    if (skipName) {
      if (tag.name === skipName) {
        if (tag.closing) {
          skipDepth -= 1;
          if (skipDepth <= 0) skipName = null;
        } else if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) {
          skipDepth += 1;
        }
      }
      continue;
    }

    if (tag.closing) {
      // 一番近い同名の開始タグまで巻き戻す
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === tag.name) {
          for (let j = stack.length - 1; j >= i; j -= 1) {
            if (stack[j].emit) out += `</${stack[j].name}>`;
          }
          stack.length = i;
          break;
        }
      }
      continue;
    }

    // サブツリーごと捨てる要素
    if (DROP_TAGS.has(tag.name) || isAdElement(tag.attrs)) {
      if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) {
        skipName = tag.name;
        skipDepth = 1;
      }
      continue;
    }

    if (tag.name === 'img') {
      // lazyload対応: data-src 系を優先。1px画像・アフィリエイト画像は捨てる
      const src = attrOf(tag.attrs, 'data-src') || attrOf(tag.attrs, 'data-lazy-src')
        || attrOf(tag.attrs, 'data-original') || attrOf(tag.attrs, 'src');
      const width = attrOf(tag.attrs, 'width');
      const resolved = resolveUrl(decodeEntities(src), baseUrl);
      if (resolved && /^https?:\/\//i.test(resolved) && !isAffiliateLink(resolved) && width !== '1') {
        const alt = escapeHtml(decodeEntities(attrOf(tag.attrs, 'alt')));
        out += `<img src="${escapeHtml(resolved)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`;
      }
      continue;
    }

    if (tag.name === 'a') {
      const href = resolveUrl(decodeEntities(attrOf(tag.attrs, 'href')), baseUrl);
      if (href && /^https?:\/\//i.test(href) && !isAffiliateLink(href)) {
        out += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener nofollow">`;
        stack.push({ name: 'a', emit: true });
      } else {
        // アフィリエイトリンクは unwrap（リンクを外して中身のテキストだけ残す）
        stack.push({ name: 'a', emit: false });
      }
      continue;
    }

    if (VOID_TAGS.has(tag.name)) {
      if (KEEP_TAGS.has(tag.name)) out += `<${tag.name}>`;
      continue;
    }

    if (KEEP_TAGS.has(tag.name)) {
      out += `<${tag.name}>`;
      if (!tag.selfClosing) stack.push({ name: tag.name, emit: true });
    } else if (!tag.selfClosing) {
      stack.push({ name: tag.name, emit: false }); // unwrap
    }
  }

  for (let j = stack.length - 1; j >= 0; j -= 1) {
    if (stack[j].emit) out += `</${stack[j].name}>`;
  }

  // 空のブロックを軽く畳む
  return out
    .replace(/<(p|div|span|li|blockquote)>\s*<\/\1>/g, '')
    .replace(/(\s*<br>\s*){3,}/g, '<br><br>')
    .trim();
}

const CONTAINER_HINTS = [
  /article-?body-?inner/i,
  /article-?body/i,
  /entry-?content/i,
  /entry-?body/i,
  /post-?content/i,
  /main-?contents?/i,
];

/** 開始タグの位置から、同名タグの対応を数えて中身の範囲を返す。 */
function balancedInner(html, openEnd, name) {
  const re = new RegExp(`<\\s*(/)?\\s*${name}\\b[^>]*>`, 'gi');
  re.lastIndex = openEnd;
  let depth = 1;
  let m;
  while ((m = re.exec(html)) !== null) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(openEnd, m.index);
  }
  return html.slice(openEnd);
}

/** 本文らしいコンテナを探す。見つからなければ body 全体。 */
export function findArticleContainer(html) {
  const candidates = [];
  const openRe = /<(div|section|article|main)\b([^>]*)>/gi;
  let m;
  while ((m = openRe.exec(html)) !== null) {
    const attrs = m[2] ?? '';
    const marker = `${attrOf(attrs, 'class')} ${attrOf(attrs, 'id')}`;
    const rank = CONTAINER_HINTS.findIndex((hint) => hint.test(marker));
    const isArticleTag = m[1].toLowerCase() === 'article';
    if (rank === -1 && !isArticleTag) continue;
    const inner = balancedInner(html, openRe.lastIndex, m[1].toLowerCase());
    candidates.push({ rank: rank === -1 ? CONTAINER_HINTS.length : rank, length: inner.length, inner });
  }
  if (candidates.length === 0) {
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    return body ? body[1] : html;
  }
  candidates.sort((a, b) => a.rank - b.rank || b.length - a.length);
  return candidates[0].inner;
}

/** ページタイトル（og:title 優先、ブログ名サフィックスを除去）。 */
export function extractTitle(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]*>/i.exec(html);
  if (og) {
    const content = attrOf(og[0].replace(/^<meta/i, '').replace(/>$/, ''), 'content');
    if (content) return decodeEntities(content).trim();
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!title) return '';
  return decodeEntities(title[1]).replace(/\s*[:|｜\-–—]\s*[^:|｜\-–—]{1,30}$/, '').trim();
}

/**
 * 記事ページのHTMLからリーダー表示用のデータを作る。
 * @returns {{ title: string, html: string, length: number }}
 */
export function extractArticle(html, { url } = {}) {
  const source = String(html ?? '');
  const container = findArticleContainer(source);
  const clean = sanitizeArticleHtml(container, url);
  return {
    title: extractTitle(source),
    html: clean,
    length: clean.replace(/<[^>]*>/g, '').length,
  };
}
