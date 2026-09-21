// ==UserScript==
// @name         Onward
// @namespace    https://github.com/SysAdminDoc/Onward_Userscript
// @version      0.1.0
// @description  Lean auto-pager. Finds the next page on paginated sites and appends it below the current one as you scroll. No rule database needed.
// @author       SysAdminDoc
// @license      MIT
// @homepageURL  https://github.com/SysAdminDoc/Onward_Userscript
// @supportURL   https://github.com/SysAdminDoc/Onward_Userscript/issues
// @updateURL    https://raw.githubusercontent.com/SysAdminDoc/Onward_Userscript/main/src/onward.user.js
// @downloadURL  https://raw.githubusercontent.com/SysAdminDoc/Onward_Userscript/main/src/onward.user.js
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* Onward is laid out as a factory so the detection code can be unit tested in
 * Node (module.exports) while the userscript manager simply boots it. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.boot();
})(typeof window !== 'undefined' ? window : globalThis, function (win) {
  'use strict';

  const VERSION = '0.1.0';
  const TAG = '[Onward]';

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  const DEFAULTS = {
    threshold: 1.5,        // start loading when less than N viewport heights remain
    maxPages: 40,          // hard cap per visit
    spacing: 1000,         // ms between page requests to a site, so paging never hammers it
    separators: true,      // show a page bar between pages
    updateUrl: true,       // replaceState to the page currently in view
    mode: 'auto',          // auto | fetch | iframe
    disabledHosts: [],
    exclude: [
      'mail.google.com', 'docs.google.com', 'drive.google.com', 'calendar.google.com',
      'www.youtube.com', 'x.com', 'twitter.com', 'www.facebook.com', 'www.instagram.com',
      'outlook.live.com', 'outlook.office.com', 'web.whatsapp.com', 'discord.com',
    ],
    rules: [],             // user rules (Onward format)
    sources: [],           // URLs of rule lists (Onward or AutoPagerize/wedata JSON)
    sourceRules: [],       // cached rules from sources, flattened for matching
    sourceCache: {},       // last good copy of each source: { url: { rules, at } }
    sourcesUpdated: 0,     // last time every source updated cleanly
    sourcesTried: 0,       // last refresh attempt, to back off after failures
    sourcesLock: 0,        // a tab refreshing right now (expires after a minute)
  };

  const store = {
    get(key) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, DEFAULTS[key]);
      } catch (e) { /* fall through to defaults */ }
      return DEFAULTS[key];
    },
    set(key, value) {
      try { if (typeof GM_setValue === 'function') GM_setValue(key, value); }
      catch (e) { console.warn(TAG, 'could not save', key, e); }
    },
  };

  function loadSettings() {
    const s = {};
    for (const key of Object.keys(DEFAULTS)) s[key] = store.get(key);
    return s;
  }

  // ---------------------------------------------------------------------------
  // Text heuristics
  // ---------------------------------------------------------------------------

  const NEXT_WORDS = [
    'next', 'next page', 'next results', 'older', 'older posts', 'older entries', 'older articles',
    'older results', 'continue', 'continue reading',
    'next chapter', 'next post', 'next article', 'next ›', 'next »',
    'suivant', 'suivante', 'page suivante', 'weiter', 'nächste', 'nächste seite',
    'siguiente', 'página siguiente', 'próxima', 'próxima página', 'seguinte',
    'successivo', 'successiva', 'pagina successiva', 'avanti', 'volgende', 'volgende pagina',
    'nästa', 'neste', 'næste', 'seuraava', 'następna', 'następna strona', 'dalej',
    'další', 'ďalšia', 'következő', 'următoarea', 'înainte', 'επόμενη', 'sonraki', 'sonraki sayfa',
    'следующая', 'следующая страница', 'далее', 'вперёд', 'вперед', 'наступна', 'далі', 'напред',
    'tiếp', 'tiếp theo', 'trang sau', 'trang tiếp', 'berikutnya', 'selanjutnya', 'ถัดไป', 'หน้าถัดไป',
    '下一页', '下一頁', '下页', '下頁', '后页', '後頁', '下一章', '下一篇', '下一张', '下一張',
    '次へ', '次のページ', '次', '次ページ', '다음', '다음 페이지', 'التالي', 'الصفحة التالية',
    'הבא', 'הדף הבא', 'अगला', 'अगला पृष्ठ',
  ];
  const MORE_WORDS = [
    'more', 'load more', 'show more', 'see more', 'view more', 'more results', 'more posts',
    'mehr laden', 'mehr anzeigen', 'voir plus', 'charger plus', 'ver más', 'cargar más',
    'mostrar mais', 'carregar mais', 'mostra altro', 'meer laden', 'показать ещё', 'показать еще',
    'загрузить ещё', '加载更多', '載入更多', '查看更多', 'もっと見る', 'さらに表示', '더 보기', '더보기',
  ];
  const ARROWS = /^[\s>›»→⟩❯▶▸⇒⇨≫]+$/;
  // Previous, First and Last as whole words ("Página anterior", "Newer posts",
  // not "Prevention" or "Backyard"). WordPress puts "Newer posts" in .nav-next,
  // and it leads back toward page 1.
  const PREV_WORD_RE = /(^|[^a-z])(prev|previous|back|newer|first|last|précédente?|precedente|zurück|vorherige[nrs]?|anterior|предыдущ|назад|попередн)(?![a-z])|上一|上页|上頁|前へ|前の|前页|首页|首頁|尾页|尾頁|末页|末頁|最後|最初|이전|처음|마지막/i;
  // A label that starts like this is a next link whatever follows: "Next (last page)".
  const NEXT_START_RE = /^(?:(?:next|older|continue|more|load more|show more)(?![a-z])|suivant|weiter|nächste|siguiente|próxima|successiv|volgende|nästa|следующ|далее|下一|下页|下頁|次|다음)/i;
  const BACK_ARROWS = /^[<«‹←⟨❮◀⇐⇦≪]+$/;
  // 下一页 / 下一頁 / 次ページ / 下一章 and friends
  const CJK_NEXT_RE = /^翻?[下后後次][一ー─1]?[页頁张張章话話节節篇]/;
  const NEXT_ATTR_RE = /(^|[^a-z])next([^a-z]|$)|nextpage|next_page|pagenext|page-next|pager-next|pagination-next|nav-next|pager-older/i;
  const PREV_ATTR_RE = /(^|[^a-z])prev(ious)?([^a-z]|$)|prevpage|page-prev/i;
  const PAGINATION_RE = /pag(e|in|ing)|pager|page-?numbers|page-?nav|nav-?links|wp-pagenavi|seite/i;
  const WIDGET_RE = /slick|swiper|carousel|slider|slideshow|banner|gallery|lightbox|owl-|glide|splide|flickity|tabs?-|modal|datepicker|calendar/i;
  const MORE_MULTI_RE = /\s|[぀-ヿ一-鿿가-힯]/; // multi-word or CJK "load more" phrases
  const JUNK_HREF_RE = /^\s*(javascript:|#|$)/i;

  const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const stripDecor = (s) => s.replace(/^[\s<>›»→⟩❯▶▸«‹←⟨❮◀|\-–—:.()[\]]+|[\s<>›»→⟩❯▶▸«‹←⟨❮◀|\-–—:.()[\]]+$/g, '').trim();
  const NEXT_SET = new Set(NEXT_WORDS);
  const MORE_SET = new Set(MORE_WORDS);

  function labelOf(el) {
    const parts = [el.textContent || ''];
    if (el.tagName === 'INPUT') parts.push(el.value || '');
    for (const a of ['aria-label', 'title']) if (el.getAttribute(a)) parts.push(el.getAttribute(a));
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img) parts.push(img.getAttribute('alt'));
    return parts.map(normalize).filter(Boolean);
  }

  function attrText(el) {
    return [el.id, el.getAttribute('class'), el.getAttribute('rel'), el.getAttribute('aria-label'),
      el.getAttribute('title'), el.getAttribute('data-testid')].filter(Boolean).join(' ');
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  const isXPath = (sel) => /^(\(|\/|\.\/|id\()/.test(sel.trim());

  function queryAll(doc, sel, ctx) {
    if (!sel) return [];
    ctx = ctx || doc;
    try {
      if (isXPath(sel)) {
        const out = [];
        const r = doc.evaluate(sel, ctx, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
        for (let i = 0; i < r.snapshotLength; i++) {
          const n = r.snapshotItem(i);
          if (n.nodeType === 1) out.push(n);
        }
        return out;
      }
      return Array.from(ctx.querySelectorAll(sel));
    } catch (e) {
      console.warn(TAG, 'bad selector', sel, e.message);
      return [];
    }
  }

  const hasLayout = (doc) => !!(doc.defaultView && doc.defaultView.innerHeight > 0 && doc.documentElement.clientHeight > 0);

  function isVisible(el, layout) {
    if (layout) {
      if (!el.getClientRects().length) return false;
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.opacity !== '0';
    }
    // Parsed documents have no layout; fall back to what the markup says.
    for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 8; n = n.parentElement, depth++) {
      if (n.hidden || n.getAttribute('aria-hidden') === 'true') return false;
      const style = (n.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
      if (style.includes('display:none') || style.includes('visibility:hidden')) return false;
    }
    return true;
  }

  function inPagination(el) {
    for (let n = el.parentElement, depth = 0; n && depth < 5; n = n.parentElement, depth++) {
      if (n.tagName === 'NAV' || n.getAttribute('role') === 'navigation') return n;
      if (PAGINATION_RE.test(attrText(n))) return n;
    }
    return null;
  }

  function stripHash(u) {
    try { const x = new URL(u); x.hash = ''; return x.href; } catch (e) { return u; }
  }

  function absUrl(v, base) {
    try { return new URL(v, base).href; } catch (e) { return null; }
  }

  // ---------------------------------------------------------------------------
  // Next-page detection
  // ---------------------------------------------------------------------------

  /**
   * Find the link to the next page.
   * @returns {{url: string|null, el: Element, score: number, how: string}|null}
   *   url is null for a button that has to be clicked (load-more style).
   */
  function findNext(doc, pageUrl, opts) {
    opts = opts || {};
    const layout = opts.layout !== undefined ? opts.layout : hasLayout(doc);
    const here = stripHash(pageUrl);
    // Same origin only (scheme, host and port): a next link elsewhere would be
    // fetched with the user's cookies into a page whose scripts can read it.
    const origin = safeOrigin(pageUrl);
    const seen = opts.seen || new Set();

    const acceptUrl = (href) => {
      if (!href || JUNK_HREF_RE.test(href)) return null;
      let u = absUrl(href, pageUrl);
      if (!u || !/^https?:/.test(u)) return null;
      if (/^https:/.test(pageUrl) && /^http:/.test(u)) u = u.replace(/^http:/, 'https:');
      if (stripHash(u) === here || seen.has(stripHash(u))) return null;
      if (safeOrigin(u) !== origin) return null;
      return u;
    };

    // 1. Explicit rule
    if (opts.rule && opts.rule.next) {
      for (const el of queryAll(doc, opts.rule.next)) {
        // The same classes often mark Previous on later pages; never take that.
        if (looksPrevious(el)) continue;
        const u = acceptUrl(el.getAttribute('href') || el.getAttribute('value'));
        if (u) return { url: u, el, score: 1000, how: 'rule' };
        if (opts.rule.click && isVisible(el, layout)) return { url: null, el, score: 1000, how: 'rule-click' };
      }
      return null;
    }

    // 2. <link rel=next> in head is the strongest signal a page can give
    for (const el of doc.querySelectorAll('link[rel~="next" i][href]')) {
      const u = acceptUrl(el.getAttribute('href'));
      if (u) return { url: u, el, score: 500, how: 'link-rel' };
    }

    // 3. Score clickable candidates
    const body = doc.body || doc.documentElement;
    const cands = body.querySelectorAll('a[href], button, [role="button"], [role="link"], input[type="button"], input[type="submit"]');
    let best = null;
    const consider = (c) => {
      if (!best || c.score > best.score || (c.score === best.score && c.url && !best.url)) best = c;
    };
    const bumped = new Set(incrementUrls(pageUrl).map(stripHash));
    for (const el of cands) {
      const labels = labelOf(el);
      const attrs = attrText(el);
      const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
      const relNext = rel.includes('next');
      const longest = labels.reduce((m, s) => Math.max(m, s.length), 0);
      if (longest > 60 && !relNext) continue;
      if (looksPrevious(el, labels)) continue;
      if (isDisabledOrWidget(el, layout)) continue;

      let score = 0;
      if (relNext) score += 100;
      if (NEXT_ATTR_RE.test(attrs)) score += 45;
      let more = false;
      for (const raw of labels) {
        const t = stripDecor(raw);
        if (NEXT_SET.has(t) || (t.length <= 8 && CJK_NEXT_RE.test(t))) { score += 60; break; }
        if (t && MORE_SET.has(t)) { score += MORE_MULTI_RE.test(t) ? 45 : 20; more = true; break; }
        if (!t && ARROWS.test(raw) && raw.length <= 3) { score += 15; break; }
      }
      const href = el.getAttribute('href');
      const u = acceptUrl(href);
      if (u && bumped.has(stripHash(u))) score += 45; // ?page=N+1 or /page/N+1
      if (score === 0) continue;
      if (inPagination(el)) score += 20;
      else if (score < 45) continue; // a bare arrow or "more" outside pagination is too weak
      if (!isVisible(el, layout)) score -= 50;

      if (u) {
        consider({ url: u, el, score, how: more ? 'more-link' : 'text' });
      } else if (layout && isVisible(el, layout) && (more || opts.allowButtons)) {
        // Load-more buttons only make sense on the live page.
        consider({ url: null, el, score: score - 5, how: 'button' });
      }
    }

    // 4. Numbered pagination: current page N, link labelled N+1
    const numbered = findNumberedNext(doc, acceptUrl, layout);
    if (numbered) consider(numbered);

    return best && best.score >= 40 ? best : null;
  }

  /**
   * A Previous (or First/Last) control rather than a next one. The evidence is
   * taken strongest first: rel, a label that starts like Next, a class that only
   * says next, a short label with a Previous word (longer labels are usually a
   * post's title and can say anything), a class that only says previous, and
   * last a bare back arrow (which points forward on right-to-left pages).
   */
  function looksPrevious(el, raw) {
    const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (rel.includes('prev')) return true;
    if (rel.includes('next')) return false;
    raw = raw || labelOf(el);
    const labels = raw.map(stripDecor).filter(Boolean);
    if (labels.some((t) => NEXT_SET.has(t) || MORE_SET.has(t) || NEXT_START_RE.test(t) || CJK_NEXT_RE.test(t))) return false;
    const attrs = attrText(el);
    const prevAttr = PREV_ATTR_RE.test(attrs);
    const nextAttr = NEXT_ATTR_RE.test(attrs);
    if (nextAttr && !prevAttr) return false;
    if (labels.some((t) => t.split(' ').length <= 3 && PREV_WORD_RE.test(t))) return true;
    if (prevAttr && !nextAttr) return true;
    const dir = el.closest('[dir]');
    return !(dir && /^rtl$/i.test(dir.getAttribute('dir'))) && raw.some((t) => BACK_ARROWS.test(t));
  }

  function isDisabledOrWidget(el, layout) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return true;
    for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 6; n = n.parentElement, depth++) {
      if (n.tagName === 'BLOCKQUOTE') return true;
      const cls = n.getAttribute('class') || '';
      if (depth < 3 && /(^|\s)(disabled|is-disabled)(\s|$)/i.test(cls)) return true;
      const a = attrText(n);
      if (WIDGET_RE.test(a) && !PAGINATION_RE.test(a)) return true;
    }
    if (layout) {
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      if (cs.cursor === 'not-allowed' || cs.pointerEvents === 'none') return true;
    }
    return false;
  }

  /** The URLs page N+1 would most likely have, given this page's URL. */
  function incrementUrls(pageUrl) {
    const out = [];
    let m = /^(.*[?&](?:p|page|pg|pn|paged|pagenum|pageno|page_no|pagenumber|seite)=)(\d{1,4})((?:[&#].*)?)$/i.exec(pageUrl);
    if (m) out.push(m[1] + (Number(m[2]) + 1) + m[3]);
    m = /^(.*\/(?:page|p|seite|pagina|strona)[/-]?)(\d{1,4})(\/?(?:\.s?html?)?(?:[?#].*)?)$/i.exec(pageUrl);
    if (m) out.push(m[1] + (Number(m[2]) + 1) + m[3]);
    return out;
  }

  function findNumberedNext(doc, acceptUrl, layout) {
    const marks = doc.querySelectorAll('[aria-current="page"], [aria-current="true"], .current, .active, .selected, .is-current, .is-active, .on, .cur, .curr, strong, em, b, span');
    for (const m of marks) {
      const text = normalize(m.textContent);
      if (!/^\d{1,5}$/.test(text)) continue;
      const n = Number(text);
      const box = inPagination(m);
      if (box) {
        for (const a of box.querySelectorAll('a[href]')) {
          if (normalize(a.textContent) !== String(n + 1) || isDisabledOrWidget(a, layout)) continue;
          const u = acceptUrl(a.getAttribute('href'));
          if (u) return { url: u, el: a, score: 70, how: 'numbered' };
        }
        continue;
      }
      // Unlabelled pagers: the N+1 link has to sit right after the marker.
      const holder = m.tagName === 'A' ? m : m.closest('li, td') || m;
      const sib = holder.nextElementSibling;
      const a = sib && (sib.matches('a[href]') ? sib : sib.querySelector(':scope > a[href]'));
      if (a && normalize(a.textContent) === String(n + 1)) {
        const u = acceptUrl(a.getAttribute('href'));
        if (u) return { url: u, el: a, score: 55, how: 'numbered' };
      }
    }
    return null;
  }

  function safeHost(u) {
    try { return new URL(u).hostname; } catch (e) { return ''; }
  }

  // ---------------------------------------------------------------------------
  // Content detection
  // ---------------------------------------------------------------------------

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'SVG', 'BR', 'HR']);
  const STATE_CLASS_RE = /\d|active|selected|current|hover|focus|odd|even|first|last|visible|hidden|loaded|lazy|show|open|in-view|animate/i;

  function signature(el) {
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter((c) => c && !STATE_CLASS_RE.test(c)).sort().slice(0, 3);
    return el.tagName + (cls.length ? '.' + cls.join('.') : '');
  }

  function inChrome(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const tag = n.tagName;
      if (tag === 'HEADER' || tag === 'FOOTER' || tag === 'NAV' || tag === 'ASIDE') return true;
      const role = n.getAttribute('role');
      if (role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'menu' || role === 'menubar') return true;
    }
    return false;
  }

  /**
   * Find the element whose children are the page's repeated items (results,
   * posts, products, threads). Picks the container whose dominant group of
   * same-signature children covers the most area (or text, without layout).
   */
  function findContent(doc, opts) {
    opts = opts || {};
    const layout = opts.layout !== undefined ? opts.layout : hasLayout(doc);
    if (opts.rule && opts.rule.content) {
      const items = queryAll(doc, opts.rule.content);
      if (items.length) return { container: items[0].parentElement, items, how: 'rule' };
      return null;
    }
    const nextEl = opts.nextEl || null;
    const body = doc.body;
    if (!body) return null;
    let best = null;
    const all = body.getElementsByTagName('*');
    const limit = Math.min(all.length, 20000);
    for (let i = 0; i < limit; i++) {
      const box = all[i];
      if (box.childElementCount < 3 || SKIP_TAGS.has(box.tagName)) continue;
      const groups = new Map();
      for (const ch of box.children) {
        if (SKIP_TAGS.has(ch.tagName) || (nextEl && ch.contains(nextEl))) continue;
        const sig = signature(ch);
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(ch);
      }
      let group = null;
      for (const g of groups.values()) if (!group || g.length > group.length) group = g;
      if (!group || group.length < 3) continue;
      if (inChrome(box)) continue;
      if (/^(OPTION|SELECT|TR)$/.test(box.tagName) || box.tagName === 'THEAD') continue;

      let weight = 0;
      let linkOnly = 0;
      let textLen = 0;
      for (const g of group) {
        const text = normalize(g.textContent);
        textLen += text.length;
        if (layout) {
          const r = g.getBoundingClientRect();
          weight += r.width * r.height;
        } else {
          weight += Math.min(text.length, 2000) + 40 * g.getElementsByTagName('img').length;
        }
        if (text.length < 25 && g.getElementsByTagName('a').length <= 1 && !g.getElementsByTagName('img').length) linkOnly++;
      }
      if (weight <= 0) continue;
      let score = weight * Math.log2(group.length);
      if (linkOnly / group.length > 0.7) {
        if (textLen / group.length < 8) continue;                            // page numbers: the pager itself
        score *= 0.15;                                                       // menus, tag clouds
      }
      if (nextEl && (box.compareDocumentPosition(nextEl) & 2) && !box.contains(nextEl)) score *= 0.3; // below the pager
      if (!best || score > best.score) best = { container: box, score, how: 'auto' };
    }
    if (best) {
      // Every child counts, not just the dominant group: lists often interleave
      // row types (title row + meta row). Only the pager is left out.
      best.items = Array.from(best.container.children).filter((c) => !isPagerChild(c, nextEl));
      return best;
    }
    // Last resort: a conventional main-content element.
    const main = doc.querySelector('main, [role="main"], #content, #main, .content, article');
    if (main && main.childElementCount) {
      return { container: main, items: Array.from(main.children).filter((c) => !SKIP_TAGS.has(c.tagName)), how: 'main' };
    }
    return null;
  }

  // Describe an element's position so the same container can be found in a
  // freshly fetched copy of the site, where scripts haven't added state classes.
  function describePath(el) {
    const steps = [];
    for (let n = el; n && n.nodeType === 1 && n.tagName !== 'BODY' && n.tagName !== 'HTML'; n = n.parentElement) {
      const parent = n.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.tagName === n.tagName) : [n];
      steps.unshift({
        tag: n.tagName,
        id: n.id && !/\d{3,}/.test(n.id) ? n.id : '',
        cls: (n.getAttribute('class') || '').split(/\s+/).filter((c) => c && !STATE_CLASS_RE.test(c)),
        idx: same.indexOf(n),
      });
    }
    return steps;
  }

  function resolvePath(doc, steps) {
    const withId = steps.map((s, i) => (s.id ? i : -1)).filter((i) => i >= 0);
    let start = 0;
    let node = doc.body;
    // Jump to the deepest ancestor with an id when the fetched page has it too.
    for (let k = withId.length - 1; k >= 0; k--) {
      const found = doc.getElementById(steps[withId[k]].id);
      if (found && found.tagName === steps[withId[k]].tag) { node = found; start = withId[k] + 1; break; }
    }
    for (let i = start; i < steps.length && node; i++) {
      const s = steps[i];
      const kids = Array.from(node.children).filter((c) => c.tagName === s.tag);
      if (!kids.length) return null;
      let pick = s.id ? kids.find((c) => c.id === s.id) : null;
      if (!pick && s.cls.length) {
        let bestOverlap = 0;
        for (const c of kids) {
          const cl = c.classList;
          const overlap = s.cls.filter((x) => cl.contains(x)).length;
          if (overlap > bestOverlap) { bestOverlap = overlap; pick = c; }
        }
      }
      if (!pick) pick = kids[Math.min(s.idx, kids.length - 1)];
      node = pick;
    }
    return node;
  }

  /** Pull the items to append out of a fetched page. */
  function extractItems(doc, ctx, nextEl) {
    if (ctx.rule && ctx.rule.content) return queryAll(doc, ctx.rule.content);
    const box = resolvePath(doc, ctx.path);
    if (!box) return [];
    const kids = Array.from(box.children).filter((c) => !isPagerChild(c, nextEl));
    if (!ctx.shape) return kids;
    // Keep what looks like the items we saw on page 1, and drop anything that
    // repeats verbatim from it (headings, sticky threads, "sort by" bars).
    const shaped = kids.filter((c) => matchesShape(c, ctx.shape) && !ctx.shape.texts.has(normalize(c.textContent)));
    return shaped.length ? shaped : kids;
  }

  function isPagerChild(c, nextEl) {
    if (SKIP_TAGS.has(c.tagName)) return true;
    if (c.matches('nav, [role="navigation"]')) return true;
    if (nextEl && (c === nextEl || c.contains(nextEl)) && normalize(c.textContent).length < 300) return true;
    return PAGINATION_RE.test(attrText(c)) && c.querySelectorAll('a').length > 2 && normalize(c.textContent).length < 300;
  }

  function itemShape(items) {
    const shape = { tags: new Set(), classes: new Set(), classless: false, texts: new Set() };
    for (const it of items) {
      shape.tags.add(it.tagName);
      const stable = Array.from(it.classList).filter((c) => !STATE_CLASS_RE.test(c));
      if (!stable.length) shape.classless = true;
      for (const c of stable) shape.classes.add(c);
      const t = normalize(it.textContent);
      if (t) shape.texts.add(t);
    }
    return shape;
  }

  function matchesShape(el, shape) {
    if (!shape.tags.has(el.tagName)) return false;
    const stable = Array.from(el.classList).filter((c) => !STATE_CLASS_RE.test(c));
    if (!stable.length) return shape.classless;
    return stable.some((c) => shape.classes.has(c));
  }

  // ---------------------------------------------------------------------------
  // Preparing fetched content
  // ---------------------------------------------------------------------------

  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url', 'data-echo', 'data-actualsrc', 'lazy-src', 'data-hi-res-src'];
  const PLACEHOLDER_RE = /^data:|blank|placeholder|spacer|lazy|loading|grey|gray|transparent|1x1|pixel/i;

  function fixLazyImages(root) {
    for (const img of root.querySelectorAll('img, source')) {
      const src = img.getAttribute('src') || '';
      for (const a of LAZY_ATTRS) {
        const v = img.getAttribute(a);
        if (v && !/^data:/.test(v) && (!src || PLACEHOLDER_RE.test(src))) { img.setAttribute('src', v); break; }
      }
      const lazySet = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
      if (lazySet && !img.getAttribute('srcset')) img.setAttribute('srcset', lazySet);
    }
  }

  function absolutize(root, base) {
    for (const [sel, attr] of [['[href]', 'href'], ['[src]', 'src'], ['[action]', 'action'], ['[poster]', 'poster']]) {
      for (const el of root.querySelectorAll(sel)) {
        const v = el.getAttribute(attr);
        if (!v || /^(#|javascript:|data:|mailto:|tel:)/i.test(v)) continue;
        const u = absUrl(v, base);
        if (u) el.setAttribute(attr, u);
      }
    }
    for (const el of root.querySelectorAll('[srcset]')) {
      const fixed = el.getAttribute('srcset').split(',').map((part) => {
        const [u, ...rest] = part.trim().split(/\s+/);
        const a = u ? absUrl(u, base) : null;
        return a ? [a, ...rest].join(' ') : part.trim();
      }).join(', ');
      el.setAttribute('srcset', fixed);
    }
  }

  // Markup that acts on the page instead of showing content: a refresh
  // navigates the tab, <base> rebases every relative URL, srcdoc frames run
  // scripts, and <noscript> is live markup in a DOMParser document (which
  // parses with scripting off), so its images load twice and handlers fire.
  const INERT_SEL = 'script, meta, base, noscript, iframe[srcdoc]';
  const URL_ATTRS = ['src', 'href', 'action', 'formaction', 'xlink:href'];
  const JS_URL_RE = /^\s*javascript:/i;

  /** A placeholder image whose real URL is only in a sibling <noscript><img> takes it from there. */
  function takeNoscriptImages(root) {
    for (const ns of root.querySelectorAll('noscript')) {
      const real = ns.querySelector('img[src]');
      if (!real || !ns.parentElement) continue;
      for (const img of ns.parentElement.children) {
        if (img.tagName !== 'IMG') continue;
        const src = img.getAttribute('src') || '';
        const lazy = LAZY_ATTRS.some((a) => { const v = img.getAttribute(a); return v && !/^data:/.test(v); });
        if ((!src || PLACEHOLDER_RE.test(src)) && !lazy) {
          img.setAttribute('src', real.getAttribute('src'));
          if (real.getAttribute('srcset')) img.setAttribute('srcset', real.getAttribute('srcset'));
          break;
        }
      }
    }
  }

  function stripInert(root) {
    for (const el of root.querySelectorAll(INERT_SEL)) el.remove();
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const a of URL_ATTRS) if (JS_URL_RE.test(el.getAttribute(a) || '')) el.removeAttribute(a);
    }
  }

  function prepareItems(items, base) {
    const out = [];
    for (const it of items) {
      if (it.matches(INERT_SEL)) continue;
      takeNoscriptImages(it);
      stripInert(it);
      fixLazyImages(it);
      if (it.matches('img, source')) fixLazyImages(it.parentElement || it);
      absolutize(it, base);
      out.push(it);
    }
    return out;
  }

  function sniffCharset(bytes, contentType, fallback) {
    const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
    if (m) return m[1].toLowerCase();
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
    const head = new TextDecoder('windows-1252').decode(bytes.slice(0, 16384));
    const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
    // Same site, same encoding is the best guess when the page doesn't say.
    return (meta ? meta[1] : fallback || 'utf-8').toLowerCase();
  }

  function decode(bytes, contentType, fallback) {
    let cs = sniffCharset(bytes, contentType, fallback);
    if (cs === 'gb2312' || cs === 'gbk') cs = 'gb18030';
    try { return new TextDecoder(cs).decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
  }

  let ttPolicy = null;
  /** Parse HTML, getting past Trusted Types on sites that enforce them. */
  function parseHtml(html) {
    let input = html;
    const tt = win.trustedTypes;
    if (tt && tt.createPolicy) {
      try {
        ttPolicy = ttPolicy || tt.createPolicy('onward', { createHTML: (s) => s });
        input = ttPolicy.createHTML(html);
      } catch (e) { /* policy name not allowed; try the plain string */ }
    }
    return new DOMParser().parseFromString(input, 'text/html');
  }

  /** An image's own address: the lazy-load one first, since the site's loader
   * may have swapped src on the live page but not in a fetched copy. */
  function imageUrl(img) {
    for (const a of LAZY_ATTRS) {
      const v = img.getAttribute(a);
      if (v && !/^data:/.test(v)) return v;
    }
    const src = img.getAttribute('src');
    if (src && !PLACEHOLDER_RE.test(src)) return src;
    return img.getAttribute('data-srcset') || img.getAttribute('srcset') || src || '';
  }

  /**
   * One item's identity: its text and first link, or for a picture-only item
   * its first image. Items with none of these (spacer rows, clearfix divs) are
   * layout, not content: they get no key, so they are never taken for repeats.
   * Read before prepareItems() rewrites URLs, so every page is keyed the same way.
   */
  function itemKey(el) {
    const text = normalize(el.textContent);
    const a = el.matches('a[href]') ? el : el.querySelector('a[href]');
    let s = text + '|' + (a ? a.getAttribute('href') : '');
    if (!text && !a) {
      const img = el.matches('img') ? el : el.querySelector('img');
      const url = img && imageUrl(img);
      if (!url) return null;
      s += '|' + url;
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  /** Items not seen on earlier pages, and the share of content items that were. Layout filler is always kept. */
  function splitRepeats(items, seenKeys) {
    let content = 0;
    let repeats = 0;
    const fresh = items.filter((it) => {
      const k = itemKey(it);
      if (k === null) return true;
      content++;
      if (!seenKeys.has(k)) return true;
      repeats++;
      return false;
    });
    return { fresh, repeatShare: content ? repeats / content : 1 };
  }

  /** Remembers the keys of items now on screen. */
  function rememberItems(items, keys) {
    for (const it of items) {
      const k = itemKey(it);
      if (k !== null) keys.add(k);
    }
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  /**
   * Accepts Onward rules, AutoPagerize/wedata items, or a mix. Rules from a
   * downloaded list (fromList) never click: a compromised list could otherwise
   * press any button on any site it matches.
   */
  function normalizeRules(input, opts) {
    const fromList = !!(opts && opts.fromList);
    const list = Array.isArray(input) ? input : (input && Array.isArray(input.rules) ? input.rules : []);
    const out = [];
    for (const raw of list) {
      const r = raw && raw.data ? raw.data : raw;
      if (!r || typeof r !== 'object') continue;
      const rule = {
        name: raw.name || r.name || '',
        url: r.url,
        next: r.next || r.nextLink,
        content: r.content || r.pageElement,
        insert: r.insert || r.insertBefore || '',
        mode: r.mode || '',
        click: !fromList && !!r.click,
        excludeUrl: typeof r.excludeUrl === 'string' ? r.excludeUrl : '',
      };
      if (typeof rule.url !== 'string' || !rule.url) continue;
      if (r.excludeUrl != null && typeof r.excludeUrl !== 'string') continue;
      // A broken excludeUrl can't be honoured, so the rule can't be trusted either.
      try { new RegExp(rule.url); new RegExp(rule.excludeUrl); } catch (e) { continue; }
      out.push(rule);
    }
    return out;
  }

  /** Rules whose url pattern matches this address, in order. */
  function matchingRules(rules, href) {
    const out = [];
    for (const r of rules) {
      if (r.disabled) continue;
      try {
        // Catch-all rules from big lists (e.g. "^https?://.") shouldn't beat detection.
        if (r.url.replace(/[\^$]/g, '').length < 12 && /^\^?https?/.test(r.url) && !/[a-z0-9]\.[a-z]/i.test(r.url)) continue;
        if (!new RegExp(r.url).test(href)) continue;
        if (r.excludeUrl && new RegExp(r.excludeUrl).test(href)) continue;
        out.push(r);
      } catch (e) { /* skip bad pattern */ }
    }
    return out;
  }

  function matchRule(rules, href) {
    return matchingRules(rules, href)[0] || null;
  }

  /**
   * The first rule that works on this page: its next selector leads to a
   * usable link or button, and its content selector finds items. A rule may
   * leave either out, and detection fills that part in.
   */
  function fittingRule(rules, doc, href) {
    return rules.find((r) => (!r.next || !!findNext(doc, href, { rule: r })) && (!r.content || queryAll(doc, r.content).length > 0)) || null;
  }

  /**
   * Which rule to use here. { rule } normally; { wait } when a site rule
   * matches the address but not the page yet (probably still rendering).
   * Once the retries are spent, a site rule whose items are on the page but
   * whose next link isn't (a last page, or another section of the same site)
   * still supplies the items, and detection looks for the next link.
   */
  function chooseRule(userRules, listRules, href, doc, attempt) {
    const mine = matchingRules(userRules, href);
    const rule = fittingRule(mine, doc, href);
    if (rule) return { rule, mine: true };
    if (mine.length && attempt < 2) return { rule: null, wait: true };
    const byContent = mine.find((r) => r.content && queryAll(doc, r.content).length > 0);
    if (byContent) return { rule: Object.assign({}, byContent, { next: '', click: false }), mine: true };
    // Lists cached before list rules lost their clicks are held to the same rule here.
    const lists = matchingRules(listRules, href).map((r) => (r.click ? Object.assign({}, r, { click: false }) : r));
    return { rule: fittingRule(lists, doc, href) };
  }

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  const FETCH_TIMEOUT_MS = 20000;

  function fetchBytes(url, signal) {
    const sameOrigin = safeOrigin(url) === win.location.origin;
    if (sameOrigin || typeof GM_xmlhttpRequest !== 'function') {
      // One controller per request: the pager's signal or the timeout aborts it.
      const ctl = new AbortController();
      let timedOut = false;
      const expire = () => { timedOut = true; ctl.abort(); };
      let timer = setTimeout(expire, FETCH_TIMEOUT_MS);
      const follow = () => ctl.abort();
      if (signal) {
        if (signal.aborted) ctl.abort();
        else signal.addEventListener('abort', follow, { once: true });
      }
      return fetch(url, { credentials: 'include', redirect: 'follow', signal: ctl.signal }).then((r) => {
        // The 20 s is for an answer; a big page that is arriving gets longer to finish.
        clearTimeout(timer);
        timer = setTimeout(expire, 3 * FETCH_TIMEOUT_MS);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer().then((buf) => ({ bytes: new Uint8Array(buf), type: r.headers.get('content-type'), finalUrl: r.url || url }));
      }).catch((e) => {
        throw timedOut ? new Error('timed out') : e;
      }).finally(() => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', follow);
      });
    }
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Error('aborted'));
      const req = GM_xmlhttpRequest({
        // Only rule lists come this way (pages are same-origin fetches), and they need no cookies.
        method: 'GET', url, responseType: 'arraybuffer', timeout: FETCH_TIMEOUT_MS, anonymous: true,
        onload: (r) => {
          if (r.status >= 400) return reject(new Error('HTTP ' + r.status));
          const type = (/content-type:\s*([^\r\n]+)/i.exec(r.responseHeaders || '') || [])[1];
          resolve({ bytes: new Uint8Array(r.response), type, finalUrl: r.finalUrl || url });
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timed out')),
      });
      if (signal) signal.addEventListener('abort', () => { if (req && req.abort) req.abort(); reject(new Error('aborted')); }, { once: true });
    });
  }

  function fetchText(url) {
    return fetchBytes(url).then((r) => decode(r.bytes, r.type, 'utf-8'));
  }

  function safeOrigin(u) {
    try { return new URL(u).origin; } catch (e) { return ''; }
  }

  function loadViaIframe(url, ready, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Error('aborted'));
      const f = document.createElement('iframe');
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:900px;border:0;visibility:hidden;';
      // No top navigation (frame busters), no popups, no autoplay. Scripts and
      // same-origin access stay, since the point is to let the page render.
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      f.setAttribute('allow', "autoplay 'none'");
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        if (err) { f.remove(); reject(err); return; }
        silence(f.contentDocument);
        resolve({ doc: f.contentDocument, dispose: () => f.remove() });
      };
      const poll = setInterval(() => {
        try {
          const d = f.contentDocument;
          if (d) silence(d);
          if (d && d.readyState !== 'loading' && d.location.href !== 'about:blank' && ready(d)) finish();
        } catch (e) { finish(new Error('iframe blocked')); }
      }, 300);
      const timer = setTimeout(() => {
        try {
          // A page that loaded but never grew items is handed back; a frame
          // still on its blank placeholder never answered.
          const d = f.contentDocument;
          if (d && d.body && d.location.href !== 'about:blank' && d.readyState !== 'loading') return finish();
        } catch (e) { /* blocked */ }
        finish(new Error('timed out'));
      }, timeoutMs || FETCH_TIMEOUT_MS);
      if (signal) signal.addEventListener('abort', () => finish(new Error('aborted')), { once: true });
      f.src = url;
      document.body.appendChild(f);
    });
  }

  // Media in open shadow roots and same-origin child frames too. Detached
  // new Audio() objects are out of reach; allow="autoplay 'none'" covers those.
  function silence(root) {
    for (const m of root.querySelectorAll('video, audio')) {
      m.muted = true;
      if (!m.paused) m.pause();
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) silence(el.shadowRoot);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try { if (el.contentDocument) silence(el.contentDocument); } catch (e) { /* cross-origin */ }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // UI: separator bar, toasts, settings, picker (all inside shadow roots)
  // ---------------------------------------------------------------------------

  const THEME = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .bar { display: flex; align-items: center; gap: 10px; padding: 7px 14px; margin: 14px 0;
      background: linear-gradient(135deg, rgba(30,30,46,.94), rgba(49,50,68,.94)); color: #cdd6f4;
      border: 1px solid rgba(137,180,250,.35); border-radius: 10px; font-size: 13px; line-height: 1.4;
      box-shadow: 0 4px 18px rgba(0,0,0,.25); backdrop-filter: blur(6px); }
    .bar b { color: #89b4fa; font-weight: 600; }
    .bar a, .bar button { color: #cdd6f4; text-decoration: none; background: rgba(69,71,90,.7); border: 0;
      padding: 3px 9px; border-radius: 6px; cursor: pointer; font-size: 12px; transition: transform .12s, background .12s; }
    .bar a:hover, .bar button:hover { background: #585b70; transform: translateY(-1px); }
    .bar .url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #a6adc8; background: none; padding: 0; }
    .bar .url:hover { background: none; color: #cdd6f4; transform: none; }
    .bar.err { border-color: rgba(243,139,168,.6); }
    .bar.err b { color: #f38ba8; }
    .bar.end b { color: #a6e3a1; }
    .spin { width: 12px; height: 12px; border: 2px solid #45475a; border-top-color: #89b4fa; border-radius: 50%; animation: s .8s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
    @media (prefers-color-scheme: light) {
      .bar { background: linear-gradient(135deg, rgba(239,241,245,.96), rgba(230,233,239,.96)); color: #4c4f69; border-color: rgba(30,102,245,.3); }
      .bar b { color: #1e66f5; } .bar a, .bar button { color: #4c4f69; background: rgba(204,208,218,.8); }
      .bar a:hover, .bar button:hover { background: #bcc0cc; } .bar .url { color: #6c6f85; background: none; }
    }
  `;

  function shadowHost(tag, hostCss) {
    const host = document.createElement(tag);
    host.setAttribute('data-onward', '');
    host.style.cssText = hostCss;
    const sr = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = THEME;
    sr.appendChild(st);
    return { host, sr };
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids) if (k != null) el.append(k);
    return el;
  }

  let toastBox = null;
  function toast(msg, kind) {
    if (typeof document === 'undefined' || !document.body) return;
    if (!toastBox || !toastBox.host.isConnected) {
      toastBox = shadowHost('div', 'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:block;');
      toastBox.sr.appendChild(h('style', {}, `.t{margin-top:8px;padding:9px 14px;border-radius:10px;font-size:13px;color:#cdd6f4;
        background:rgba(30,30,46,.95);border:1px solid rgba(137,180,250,.4);box-shadow:0 6px 20px rgba(0,0,0,.35);
        animation:in .2s ease-out;max-width:360px}.t.err{border-color:#f38ba8}.t.ok{border-color:#a6e3a1}
        @keyframes in{from{opacity:0;transform:translateY(6px)}}`));
      document.documentElement.appendChild(toastBox.host);
    }
    const t = h('div', { class: 't ' + (kind || '') }, 'Onward: ' + msg);
    toastBox.sr.appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3200);
  }

  // ---------------------------------------------------------------------------
  // The pager
  // ---------------------------------------------------------------------------

  // Before its first load Onward waits this long near the end of the list, and
  // stands down if the site adds this many items by itself meanwhile.
  const PROBE_MS = 3000;
  const NATIVE_GROWTH = 3;
  const STANDING_BY = 'This site loads more by itself';

  class Pager {
    constructor(settings, rule, opts) {
      this.s = settings;
      this.rule = rule;
      this.opts = opts || {};
      this.wrap = !!this.opts.wrap;   // pages go in copies of the container (for lists a framework redraws)
      this.noGrowth = 0;
      this.page = 1;
      this.busy = false;
      this.stopped = false;
      this.failures = 0;
      this.seen = new Set([stripHash(location.href)]);
      this.itemKeys = new Set();  // every item shown so far, to catch repeats
      this.separators = [];
      this.inserted = [];  // nodes we added, so destroy() can take them back out
      this.ours = new WeakSet();
      this.abort = new AbortController();  // cancels in-flight loads on destroy()
      this.startUrl = location.href;
      this.mode = (rule && rule.mode) || settings.mode;
      this.onScroll = this.onScroll.bind(this);
    }

    /** Detect next link + content on the live page. Returns false when there's nothing to do. */
    detect() {
      const next = findNext(document, location.href, { rule: this.rule, seen: this.seen });
      if (!next) return false;
      const content = findContent(document, { rule: this.rule, nextEl: next.el });
      if (!content || !content.items.length) return false;
      this.next = next;
      this.nextPath = next.el.tagName === 'LINK' ? null : describePath(next.el);
      this.container = content.container;
      this.path = describePath(content.container);
      this.shape = content.how === 'auto' ? itemShape(content.items) : null;
      rememberItems(content.items, this.itemKeys);
      this.buttonMode = next.url === null;
      // Anchor: new pages go right after the last current item.
      const last = content.items[content.items.length - 1];
      const insertAt = this.rule && this.rule.insert ? queryAll(document, this.rule.insert)[0] : null;
      this.anchor = document.createComment('onward-anchor');
      if (insertAt) insertAt.parentNode.insertBefore(this.anchor, insertAt);
      else if (this.wrap && !this.buttonMode) content.container.after(this.anchor);
      else last.after(this.anchor);
      this.scroller = findScroller(content.container);
      if (!this.opts.force) this.watchNative(content.items);
      console.info(TAG, 'active:', next.how, next.url || '(button)', '| content:', content.how, this.wrap ? '(wrapped)' : '', content.container);
      return true;
    }

    start() {
      if (this.scroller) this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
      win.addEventListener('scroll', this.onScroll, { passive: true });
      win.addEventListener('resize', this.onScroll, { passive: true });
      this.onScroll();
    }

    // Stopping ends loading; the scroll listener stays so the address bar keeps
    // following the page in view. destroy() removes everything.
    // why: 'end' (no more pages), 'limit', 'error' or 'user'.
    stop(reason, kind, why) {
      this.stopped = true;
      this.endReason = why || (kind === 'err' ? 'error' : 'end');
      if (this.userStopped && why !== 'user') {
        // The real end (or an error) arrived after a Stop; there's nothing to resume.
        this.userStopped = false;
        if (this.stopBar) { this.removeBar(this.stopBar); this.stopBar = null; }
      }
      if (reason) this.addBar(null, reason, kind || 'end');
      this.refreshBars();
      setTimeout(this.onScroll, 0);
    }

    userStop() {
      if (this.stopped) return;
      this.userStopped = true;
      this.stop(null, 'end', 'user');
      this.stopBar = this.addBar(null, 'Stopped by you.', 'end', () => this.resume(), 'Resume');
    }

    resume() {
      if (!this.userStopped || this.destroyed) return;
      this.userStopped = false;
      this.stopped = false;
      this.endReason = null;
      if (this.stopBar) { this.removeBar(this.stopBar); this.stopBar = null; }
      this.refreshBars();
      this.onScroll();
    }

    /** Page bars show Stop or Resume depending on state; redraw them after a change. */
    refreshBars() {
      for (const sep of this.separators) if (sep.kind === '') this.setBar(sep, sep.url, sep.label, '');
    }

    metrics() {
      if (!this.scroller && this.container) {
        // An inner scroller may only become scrollable once pages are added.
        const found = findScroller(this.container);
        if (found) {
          this.scroller = found;
          found.addEventListener('scroll', this.onScroll, { passive: true });
        }
      }
      const sc = this.scroller;
      if (sc && sc.isConnected) {
        return { remaining: sc.scrollHeight - sc.scrollTop - sc.clientHeight, view: sc.clientHeight, height: sc.scrollHeight, top: sc.getBoundingClientRect().top };
      }
      const de = document.documentElement;
      const height = Math.max(de.scrollHeight, document.body.scrollHeight);
      return { remaining: height - (win.scrollY + win.innerHeight), view: win.innerHeight, height, top: 0 };
    }

    // Some sites load more by themselves (Discourse, feeds, Jetpack). Growth
    // Onward didn't cause only counts inside a watch window: while it waits
    // before its first load, and for PROBE_MS each time the reader reaches the
    // bottom. Outside those windows, ads and live updates look the same.
    // Growth is weighed in elements, so one wrapper holding a whole batch of
    // posts counts as much as the posts, and a re-render that swaps nodes
    // counts as nothing.
    watchNative(items) {
      let size = 0;
      for (const it of items) size += 1 + it.getElementsByTagName('*').length;
      this.growthLimit = NATIVE_GROWTH * Math.max(1, size / items.length);
      const weight = (n) => (n.nodeType === 1 && !this.ours.has(n) && !n.hasAttribute('data-onward') ? 1 + n.getElementsByTagName('*').length : 0);
      this.nativeObserver = new MutationObserver((records) => {
        if (!(this.watchUntil > Date.now()) || this.stoodDown || this.destroyed) return;
        for (const r of records) {
          for (const n of r.addedNodes) this.watchGrowth += weight(n);
          for (const n of r.removedNodes) this.watchGrowth -= weight(n);
        }
        if (this.watchGrowth >= this.growthLimit) this.standDown();
      });
      this.nativeObserver.observe(this.container, { childList: true });
    }

    openWatch() {
      if (!this.nativeObserver || this.watchUntil > Date.now()) return;
      this.watchUntil = Date.now() + PROBE_MS;
      this.watchGrowth = 0;
    }

    standDown() {
      if (this.stoodDown || this.destroyed) return;
      this.stoodDown = true;
      const hadPages = this.page > 1;
      console.info(TAG, STANDING_BY.toLowerCase() + '; standing by');
      // Cancels a load in flight and takes Onward's pages back out, so the
      // site's own pages are the only copy.
      this.destroy();
      if (this.opts.onStandDown) this.opts.onStandDown(hadPages);
    }

    scrollPos() {
      return this.scroller && this.scroller.isConnected ? this.scroller.scrollTop : win.scrollY;
    }

    /** Where the list ends, in viewport coordinates. */
    listEndBottom(m) {
      const end = this.wrap ? (this.lastInserted || this.container) : this.anchor.parentNode;
      return end && end.getBoundingClientRect ? end.getBoundingClientRect().bottom : m.top + m.view + m.remaining;
    }

    /** The reader's whole view is below the list (they are in the footer). */
    readerBelowList() {
      const m = this.metrics();
      return this.listEndBottom(m) < m.top;
    }

    // Scroll anchoring would pin a reader in the footer while the list grows
    // above them. While Onward adds items it is off; the site's own value comes
    // back two frames after the last hold ends.
    holdAnchoring() {
      const root = this.scroller || document.scrollingElement || document.documentElement;
      if (!this.anchorHolds) {
        this.anchorRoot = root;
        this.anchorSaved = [root.style.getPropertyValue('overflow-anchor'), root.style.getPropertyPriority('overflow-anchor')];
        root.style.setProperty('overflow-anchor', 'none', 'important');
      }
      this.anchorHolds = (this.anchorHolds || 0) + 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
          if (this.destroyed) return;
          if (--this.anchorHolds === 0) this.restoreAnchoring();
        }));
      };
    }

    restoreAnchoring() {
      this.anchorHolds = 0;
      const [value, priority] = this.anchorSaved;
      if (value) this.anchorRoot.style.setProperty('overflow-anchor', value, priority);
      else this.anchorRoot.style.removeProperty('overflow-anchor');
    }

    /** After a page lands below a reader in the footer, the next waits for them to scroll. */
    waitForReader() {
      this.awaitScroll = { pos: this.scrollPos(), height: this.metrics().height };
    }

    /** Frameworks sometimes redraw the list and throw away what we added. */
    lost() {
      return !this.anchor.isConnected || (this.lastInserted && !this.lastInserted.isConnected);
    }

    handleLost() {
      if (this.lostHandled) return;
      this.lostHandled = true;
      this.stopped = true;
      if (!this.wrap && !this.buttonMode && this.opts.onLost) {
        console.info(TAG, 'the site redrew its list; switching to wrapped pages');
        this.opts.onLost();
      } else {
        this.addBar(null, 'This site keeps redrawing its list, so pages can’t be added here.', 'err');
      }
    }

    destroy() {
      this.stopped = true;
      this.destroyed = true;
      this.abort.abort();
      // The added pages are about to go, so the address should too.
      if (this.selfUrl && location.href === this.selfUrl && this.startUrl !== this.selfUrl) {
        try { history.replaceState(history.state, '', this.startUrl); } catch (e) { /* ignore */ }
        if (this.opts.onUrl) this.opts.onUrl(location.href);
      }
      if (this.scroller) this.scroller.removeEventListener('scroll', this.onScroll);
      win.removeEventListener('scroll', this.onScroll);
      win.removeEventListener('resize', this.onScroll);
      if (this.anchorHolds) this.restoreAnchoring();
      if (this.nativeObserver) this.nativeObserver.disconnect();
      for (const s of this.separators) s.outer.remove();
      this.separators = [];
      if (this.anchor) this.anchor.remove();
      for (const n of this.inserted) n.remove();
      this.inserted = [];
    }

    onScroll() {
      if (this.scrollQueued) return;
      this.scrollQueued = true;
      win.requestAnimationFrame(() => {
        this.scrollQueued = false;
        if (this.destroyed) return;
        this.syncUrl();
        if (this.busy) return;
        if (this.page > 1 && this.lost()) return this.handleLost();
        const m = this.metrics();
        // The bottom of the page is where self-loading sites fetch more. Keep
        // watching after Onward stops too: the site may load its own copy then.
        if (m.remaining < m.view * 0.25) this.openWatch();
        if (this.stopped || this.paused) return;
        if (this.awaitScroll) {
          // A page landed while the reader sat below the list: wait until they
          // scroll. A shift that only matches content growing above them (late
          // images, the browser keeping its place) is not the reader. Being at
          // the very bottom is: an insert above always leaves page below them.
          const w = this.awaitScroll;
          const moved = this.scrollPos() - w.pos;
          const grew = m.height - w.height;
          if (m.remaining >= 2 && (Math.abs(moved) < 1 || Math.abs(moved - grew) <= 2)) {
            w.pos = this.scrollPos();
            w.height = m.height;
            return;
          }
          this.awaitScroll = null;
        }
        // Tall footers shouldn't delay loading: the end of the list counts too.
        const toListEnd = this.listEndBottom(m) - (m.top + m.view);
        if (Math.min(m.remaining, toListEnd) >= m.view * this.s.threshold) return;
        // The first time near the end, give the site PROBE_MS to show whether
        // it loads more by itself before Onward adds anything.
        if (!this.opts.force && !this.probed) {
          if (!this.probeStart) {
            this.probeStart = Date.now();
            this.openWatch();
            setTimeout(this.onScroll, PROBE_MS + 50);
            return;
          }
          if (Date.now() - this.probeStart < PROBE_MS) return;
          this.probed = true;
        }
        this.loadNext();
      });
    }

    syncUrl() {
      if (!this.s.updateUrl || !this.separators.length || this.buttonMode) return;
      const line = win.innerHeight * 0.35;
      let url = this.startUrl;
      for (const s of this.separators) {
        // Only finished pages count; a loading or error bar's page isn't on screen.
        if (s.url && s.kind === '' && s.outer.isConnected && s.outer.getBoundingClientRect().top < line) url = s.url;
      }
      if (url !== location.href && safeOrigin(url) === location.origin) {
        try {
          history.replaceState(history.state, '', url);
          this.selfUrl = url;
          if (this.opts.onUrl) this.opts.onUrl(url);
        } catch (e) { /* ignore */ }
      }
    }

    async loadNext() {
      if (this.busy || this.stopped) return;
      if (this.page >= this.s.maxPages) return this.stop(`Stopped after ${this.s.maxPages} pages (change the limit in settings).`, 'end', 'limit');
      this.busy = true;
      this.paused = false;
      const loading = this.addBar(this.next.url, 'Loading page ' + (this.page + 1) + '…', 'loading');
      try {
        // Space requests out, however they were triggered (scroll, chain, menu, click).
        const wait = (this.lastRequestAt || 0) + this.s.spacing - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (this.destroyed) return;
        this.lastRequestAt = Date.now();
        if (this.buttonMode) await this.clickMore(loading);
        else await this.appendPage(this.next.url, loading);
        if (this.destroyed) return;
        this.failures = 0;
      } catch (e) {
        if (this.destroyed) return;
        this.failures++;
        console.warn(TAG, e);
        this.removeBar(loading);
        if (this.failures >= 3) this.stop('Could not load the next page: ' + e.message, 'err');
        else {
          const retry = this.addBar(this.next && this.next.url, 'Page ' + (this.page + 1) + ' failed (' + e.message + '). Paused.', 'err', () => {
            this.removeBar(retry);
            this.paused = false;
            this.loadNext();
          });
          // Don't hammer a server that's failing or rate limiting; wait for a click.
          this.paused = true;
          this.busy = false;
          return;
        }
      }
      this.busy = false;
      if (!this.stopped) setTimeout(this.onScroll, 400); // keep filling short pages, gently
    }

    async appendPage(url, bar) {
      let doc;
      let dispose = () => {};
      let finalUrl = url;
      const signal = this.abort.signal;
      if (this.mode === 'iframe') {
        ({ doc, dispose } = await loadViaIframe(url, (d) => extractItems(d, this).length > 0, 0, signal));
        try { if (/^https?:/.test(doc.location.href)) finalUrl = doc.location.href; } catch (e) { /* keep the requested URL */ }
      } else {
        const r = await fetchBytes(url, signal);
        if (this.destroyed) return;
        finalUrl = r.finalUrl || url;
        if (safeOrigin(finalUrl) !== location.origin) throw new Error('redirected to another site');
        doc = parseHtml(decode(r.bytes, r.type, document.characterSet));
        if (!extractItems(doc, this).length && this.mode === 'auto' && safeOrigin(url) === location.origin) {
          // Probably rendered by scripts; a hidden iframe lets them run.
          console.info(TAG, 'no items in raw HTML, retrying in an iframe');
          ({ doc, dispose } = await loadViaIframe(url, (d) => extractItems(d, this).length > 0, 0, signal));
          this.mode = 'iframe';
        }
      }
      try {
        if (this.destroyed) return;
        // A redirect back to a page already on screen (/page/99 -> /page/1) is the real end.
        if (this.seen.has(stripHash(finalUrl))) {
          this.removeBar(bar);
          return this.stop('No more pages.');
        }
        // The page being loaded counts as seen for finding its next link, but it
        // only joins 'seen' once it is in: a failed attempt must stay retryable.
        const seenNow = new Set(this.seen).add(stripHash(url)).add(stripHash(finalUrl));
        const next = this.findNextIn(doc, finalUrl, seenNow);
        const items = extractItems(doc, this, next && next.el);
        if (!items.length) throw new Error('no content found on the next page');
        // A page that is (nearly) all repeats is the site sending the same page
        // again; a few repeats (products that moved) are just dropped.
        const { fresh, repeatShare } = splitRepeats(items, this.itemKeys);
        if (!fresh.length || repeatShare >= 0.9) { this.removeBar(bar); return this.stop('The site returned a page we already have. End of results.'); }
        rememberItems(fresh, this.itemKeys);
        this.seen.add(stripHash(url));
        this.seen.add(stripHash(finalUrl));

        const prepared = prepareItems(fresh, finalUrl);
        const frag = document.createDocumentFragment();
        for (const it of prepared) frag.appendChild(document.importNode(it, true));
        this.page++;
        this.setBar(bar, url, 'Page ' + this.page, '');
        const heightBefore = this.metrics().height;
        const below = this.readerBelowList();
        const release = this.holdAnchoring();
        if (this.wrap) {
          const shell = this.container.cloneNode(false);
          shell.removeAttribute('id');
          shell.setAttribute('data-onward-page', String(this.page));
          shell.appendChild(frag);
          this.anchor.parentNode.insertBefore(shell, this.anchor);
          this.lastInserted = shell;
          this.inserted.push(shell);
          this.ours.add(shell);
        } else {
          this.lastInserted = frag.firstChild;
          this.inserted.push(...frag.childNodes);
          for (const n of frag.childNodes) this.ours.add(n);
          this.anchor.parentNode.insertBefore(frag, this.anchor);
        }
        release();
        if (below) this.waitForReader();
        this.onPageAppended(url);
        setTimeout(() => { if (!this.destroyed && this.lost()) this.handleLost(); }, 1500);
        // Guard against loading forever when added pages don't make the page longer.
        this.noGrowth = this.metrics().height > heightBefore ? 0 : this.noGrowth + 1;
        if (this.noGrowth >= 2) return this.stop('Pages were added but the page isn’t getting longer, so Onward stopped.', 'err');
        if (next) this.next = next;
        else this.stop('No more pages.');
      } finally {
        dispose();
      }
    }

    findNextIn(doc, url, seen) {
      // Same spot as last time first, then the general heuristics.
      if (this.nextPath && !this.rule) {
        const el = resolvePath(doc, this.nextPath);
        const href = el && el.getAttribute('href');
        const u = href && absUrl(href, url);
        if (u && safeOrigin(u) === safeOrigin(url) && !seen.has(stripHash(u)) && stripHash(u) !== stripHash(url)
            && labelOf(el).join(' ') === labelOf(this.next.el).join(' ')) {
          return { url: u, el, how: 'path' };
        }
      }
      return findNext(doc, url, { rule: this.rule, seen, layout: false });
    }

    async clickMore(bar) {
      const el = this.next.el.isConnected ? this.next.el : (resolvePath(document, this.nextPath) || this.next.el);
      if (!el.isConnected || !isVisible(el, true) || el.disabled) {
        this.removeBar(bar);
        return this.stop('No more items.');
      }
      const before = this.container.childElementCount;
      const height = document.documentElement.scrollHeight;
      // From here on the list grows because of our clicks, not by itself.
      if (this.nativeObserver) { this.nativeObserver.disconnect(); this.nativeObserver = null; }
      const below = this.readerBelowList();
      const release = this.holdAnchoring();
      el.click();
      const grew = await waitFor(() => this.container.childElementCount > before || document.documentElement.scrollHeight > height + 50, 10000);
      release();
      if (this.destroyed) return;
      this.removeBar(bar);
      if (!grew) return this.stop('The “load more” button stopped adding items.');
      if (below) this.waitForReader();
      this.page++;
      this.onPageAppended(null);
    }

    onPageAppended(url) {
      win.dispatchEvent(new CustomEvent('onward:page', { detail: { page: this.page, url } }));
    }

    addBar(url, label, kind, onRetry, actionLabel) {
      // li/tr can't host a shadow root, so the bar lives in a div inside a
      // wrapper that is valid for the list it sits in.
      const tag = barTag(this.anchor ? this.anchor.parentNode : null);
      const outer = document.createElement(tag.outer);
      outer.setAttribute('data-onward', '');
      // Sites style their li/tr (fixed heights and the like); none of it should reach the bar.
      outer.style.cssText = 'display:block;width:auto;height:auto;min-height:0;grid-column:1/-1;flex:0 0 100%;float:none;clear:both;list-style:none;margin:0;padding:0;border:0;background:none;';
      let mount = outer;
      if (tag.inner) {
        outer.style.display = 'table-row';
        mount = document.createElement(tag.inner);
        mount.colSpan = tableColumns(this.anchor.parentNode);
        mount.style.cssText = 'padding:0;border:0;background:none;';
        outer.appendChild(mount);
      }
      const { host, sr } = shadowHost('div', 'display:block;');
      mount.appendChild(host);
      const sep = { outer, host, sr, url, display: outer.style.display, bar: h('div', { class: 'bar' }) };
      sr.appendChild(sep.bar);
      this.setBar(sep, url, label, kind, onRetry, actionLabel);
      // Load-more sites append their own items after our anchor, so status bars go last.
      if (this.anchor && this.anchor.parentNode) this.anchor.parentNode.insertBefore(outer, this.buttonMode ? null : this.anchor);
      else document.body.appendChild(outer);
      this.separators.push(sep);
      return sep;
    }

    removeBar(sep) {
      sep.outer.remove();
      this.separators = this.separators.filter((s) => s !== sep);
    }

    setBar(sep, url, label, kind, onRetry, actionLabel) {
      sep.url = url;
      sep.label = label;
      sep.kind = kind || '';
      sep.bar.className = 'bar ' + (kind || '');
      sep.bar.replaceChildren(...[
        kind === 'loading' ? h('span', { class: 'spin' }) : null,
        h('b', {}, label),
        url && kind !== 'loading' ? h('a', { class: 'url', href: url, title: url }, url) : h('span', { class: 'url' }),
        onRetry ? h('button', { onclick: onRetry }, actionLabel || 'Retry') : null,
        kind === '' ? h('button', { title: 'Scroll to top', onclick: () => (this.scroller || win).scrollTo({ top: 0, behavior: 'smooth' }) }, '↑ Top') : null,
        kind === '' && this.userStopped ? h('button', { title: 'Carry on loading pages', onclick: () => this.resume() }, 'Resume') : null,
        kind === '' && !this.stopped ? h('button', { title: 'Stop loading pages here', onclick: () => this.userStop() }, 'Stop') : null,
      ].filter(Boolean));
      // A hidden page bar keeps its (now zero-height) wrapper in the layout,
      // so the address bar can still tell which page is in view.
      sep.host.style.display = !this.s.separators && kind === '' ? 'none' : 'block';
    }
  }

  function tableColumns(section) {
    let cols = 1;
    for (const row of Array.from(section.rows || []).slice(0, 20)) {
      let n = 0;
      for (const cell of row.cells) n += cell.colSpan || 1;
      cols = Math.max(cols, n);
    }
    return cols;
  }

  function barTag(parent) {
    const tag = parent ? parent.tagName : '';
    if (tag === 'UL' || tag === 'OL') return { outer: 'li' };
    if (tag === 'TBODY' || tag === 'TABLE' || tag === 'THEAD' || tag === 'TFOOT') return { outer: 'tr', inner: 'td' };
    return { outer: 'div' };
  }

  /** The element that actually scrolls, when it isn't the window. */
  function findScroller(el) {
    const de = document.documentElement;
    if (de.scrollHeight > win.innerHeight + 20) return null;
    for (let n = el.parentElement; n && n !== document.body && n !== de; n = n.parentElement) {
      const oy = win.getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && n.scrollHeight > n.clientHeight + 20) return n;
    }
    return null;
  }

  function waitFor(test, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (test()) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  // ---------------------------------------------------------------------------
  // Settings panel
  // ---------------------------------------------------------------------------

  function openSettings(app) {
    const existing = document.querySelector('[data-onward-panel]');
    if (existing) { existing.remove(); return; }
    const s = loadSettings();
    const { host, sr } = shadowHost('div', 'position:fixed;inset:0;z-index:2147483647;display:block;');
    host.setAttribute('data-onward-panel', '');
    sr.appendChild(h('style', {}, `
      .bg{position:fixed;inset:0;background:rgba(17,17,27,.55);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center}
      .p{width:min(620px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;
        border-radius:14px;padding:20px 22px;box-shadow:0 20px 60px rgba(0,0,0,.5);font-size:13px}
      h2{margin:0 0 4px;font-size:17px;color:#89b4fa} .sub{color:#a6adc8;margin-bottom:14px}
      label{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid #313244}
      input[type=number]{width:80px} input,select,textarea{background:#181825;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:5px 7px;font:inherit}
      textarea{width:100%;min-height:90px;font-family:ui-monospace,Consolas,monospace;font-size:12px;margin-top:6px}
      .blk{padding:9px 0;border-bottom:1px solid #313244} .hint{color:#7f849c;font-size:12px;margin-top:3px}
      .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
      button{background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:8px;padding:7px 14px;cursor:pointer;font:inherit;transition:transform .12s,background .12s}
      button:hover{background:#45475a;transform:translateY(-1px)} button.pri{background:#89b4fa;color:#11111b;border-color:#89b4fa}
      .err{color:#f38ba8;min-height:16px;margin-top:6px}`));
    const num = (key, step) => h('input', { type: 'number', step, value: s[key], 'data-k': key });
    const chk = (key) => { const c = h('input', { type: 'checkbox', 'data-k': key }); c.checked = !!s[key]; return c; };
    const modeSel = h('select', { 'data-k': 'mode' }, ...['auto', 'fetch', 'iframe'].map((m) => { const o = h('option', { value: m }, m); o.selected = s.mode === m; return o; }));
    const rules = h('textarea', { spellcheck: 'false' }); rules.value = JSON.stringify(s.rules, null, 2);
    const excl = h('textarea', { spellcheck: 'false' }); excl.value = s.exclude.join('\n');
    const srcs = h('textarea', { spellcheck: 'false', style: 'min-height:50px' }); srcs.value = s.sources.join('\n');
    const err = h('div', { class: 'err' });
    const close = () => host.remove();
    const save = () => {
      let parsed;
      try { parsed = JSON.parse(rules.value || '[]'); } catch (e) { err.textContent = 'Site rules are not valid JSON: ' + e.message; return; }
      const normalized = normalizeRules(parsed);
      if (normalized.length !== (Array.isArray(parsed) ? parsed.length : 0)) { err.textContent = 'Every rule needs a valid "url" regex (and "excludeUrl", when set).'; return; }
      for (const el of sr.querySelectorAll('[data-k]')) {
        const k = el.getAttribute('data-k');
        let v = el.value;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'number') v = Number(v) > 0 ? Number(v) : DEFAULTS[k];
        if (k === 'maxPages') v = Math.max(1, Math.round(v));
        store.set(k, v);
      }
      store.set('rules', normalized);
      store.set('exclude', excl.value.split(/\s+/).filter(Boolean));
      store.set('sources', srcs.value.split(/\s+/).filter(Boolean));
      close();
      toast('Settings saved. Reload the page to apply them.', 'ok');
    };
    const panel = h('div', { class: 'p', role: 'dialog', 'aria-label': 'Onward settings' },
      h('h2', {}, 'Onward ' + VERSION),
      h('div', { class: 'sub' }, location.hostname + ': ' + (app.pager && !app.pager.stopped ? `active, page ${app.pager.page}` : app.status)),
      h('label', {}, 'Start loading when this many screens remain', num('threshold', '0.1')),
      h('label', {}, 'Maximum pages per visit', num('maxPages', '1')),
      h('label', {}, 'Wait between page requests (ms)', num('spacing', '100')),
      h('label', {}, 'Show a bar between pages', chk('separators')),
      h('label', {}, 'Update the address bar while scrolling', chk('updateUrl')),
      h('label', {}, 'Loading mode', modeSel),
      h('div', { class: 'blk' }, 'Site rules (JSON)', rules,
        h('div', { class: 'hint' }, '[{"url": "^https://example\\\\.com/list", "next": "a.next", "content": "#results > .item"}]. CSS or XPath. Optional: "insert", "mode", "click".')),
      h('div', { class: 'blk' }, 'Never run on these hosts', excl),
      h('div', { class: 'blk' }, 'Rule list URLs (optional)', srcs,
        h('div', { class: 'hint' }, `Onward or AutoPagerize/wedata JSON. ${s.sourceRules.length} cached rules.`),
        h('div', { class: 'row', style: 'justify-content:flex-start' }, h('button', { onclick: () => updateSources(srcs.value.split(/\s+/).filter(Boolean), true) }, 'Update rule lists now'))),
      err,
      h('div', { class: 'row' }, h('button', { onclick: close }, 'Cancel'), h('button', { class: 'pri', onclick: save }, 'Save')));
    const bg = h('div', { class: 'bg', onclick: (e) => { if (e.target === bg) close(); } }, panel);
    sr.appendChild(bg);
    document.documentElement.appendChild(host);
  }

  /**
   * Decide whether a downloaded rule list replaces the last good copy. Mirrors
   * have served an HTML error page as the list, so anything that isn't JSON,
   * holds no rules, or shrank by more than half keeps the old copy.
   */
  function acceptRuleList(prev, text, now) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return { entry: prev, error: 'not a rule list (not JSON)' }; }
    const rules = normalizeRules(parsed, { fromList: true });
    if (!rules.length) return { entry: prev, error: 'no rules in it' };
    if (prev && prev.rules.length && rules.length < prev.rules.length / 2) {
      return { entry: prev, error: `only ${rules.length} rules, down from ${prev.rules.length}` };
    }
    return { entry: { rules, at: now } };
  }

  async function updateSources(urls, loud) {
    // One tab at a time; the lock expires in case its tab closes mid-update.
    const now = Date.now();
    if (now - store.get('sourcesLock') < 60000) {
      if (loud) toast('Another tab is updating the rule lists right now.', 'err');
      return null;
    }
    store.set('sourcesLock', now);
    store.set('sourcesTried', now);
    try {
      const cache = Object.assign({}, store.get('sourceCache'));
      const failures = [];
      for (const u of urls) {
        let res;
        try { res = acceptRuleList(cache[u], await fetchText(u), Date.now()); } catch (e) { res = { entry: cache[u], error: e.message }; }
        if (res.error) {
          console.warn(TAG, 'rule list kept its last good copy', u, res.error);
          failures.push(`${safeHost(u)}: ${res.error}`);
        } else {
          cache[u] = res.entry;
          if (loud) toast(`${res.entry.rules.length} rules from ${safeHost(u)}`, 'ok');
        }
        if (!cache[u]) delete cache[u];
      }
      // Lists no longer configured leave the cache.
      for (const k of Object.keys(cache)) if (!urls.includes(k)) delete cache[k];
      const all = [].concat(...Object.values(cache).map((e) => e.rules));
      // Specific patterns first, so a catch-all never shadows a site rule.
      all.sort((a, b) => b.url.length - a.url.length);
      store.set('sourceCache', cache);
      store.set('sourceRules', all);
      if (failures.length) toast('Kept the last good copy of a rule list. ' + failures.join('; '), 'err');
      else store.set('sourcesUpdated', Date.now());
      return all;
    } finally {
      store.set('sourcesLock', 0);
    }
  }

  // ---------------------------------------------------------------------------
  // Element picker: click the next link, then one result item
  // ---------------------------------------------------------------------------

  function cssPath(el, pinned) {
    // An id only anchors the path when it is stable-looking and unique; pages
    // with a pager above and below the list often repeat one.
    const byId = (n) => n.id && !/\d{3,}/.test(n.id) && n.ownerDocument.querySelectorAll('#' + CSS.escape(n.id)).length === 1;
    if (byId(el)) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      if (byId(n)) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const cls = (n.getAttribute('class') || '').split(/\s+/).filter((c) => c && !STATE_CLASS_RE.test(c)).slice(0, 2);
      let step = n.tagName.toLowerCase() + cls.map((c) => '.' + CSS.escape(c)).join('');
      if (pinned && n.parentElement) step += ':nth-child(' + (Array.prototype.indexOf.call(n.parentElement.children, n) + 1) + ')';
      parts.unshift(step);
    }
    return parts.join(' > ');
  }

  function xpathString(s) {
    if (!s.includes("'")) return "'" + s + "'";
    if (!s.includes('"')) return '"' + s + '"';
    return 'concat(' + s.split("'").map((part) => "'" + part + "'").join(', "\'", ') + ')';
  }

  /**
   * A selector that matches this element and nothing else on the page: the
   * class path first, then the element's label (which stays put from page to
   * page), pinned by position when a pager repeats above and below the list,
   * and :nth-child steps only as a last resort (they shift between pages).
   */
  function uniqueSelector(el) {
    const doc = el.ownerDocument;
    const only = (sel) => { const m = queryAll(doc, sel); return m.length === 1 && m[0] === el; };
    const tag = el.tagName.toLowerCase();
    const candidates = [cssPath(el)];
    const tests = [];
    // JS \s folds a no-break space into a space; XPath's normalize-space() does not, so translate it first.
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 60) tests.push("normalize-space(translate(., '\u00a0', ' '))=" + xpathString(text));
    for (const a of ['aria-label', 'title', 'value']) {
      const v = el.getAttribute(a);
      if (v) tests.push('@' + a + '=' + xpathString(v));
    }
    for (const t of tests) {
      const xp = '//' + tag + '[' + t + ']';
      candidates.push(xp);
      const hits = queryAll(doc, xp);
      const i = hits.indexOf(el);
      if (hits.length > 1 && i >= 0) candidates.push('(' + xp + ')[' + (i === hits.length - 1 ? 'last()' : i + 1) + ']');
    }
    candidates.push(cssPath(el, true));
    return candidates.find(only) || null;
  }

  function pickElement(prompt) {
    return new Promise((resolve) => {
      const { host, sr } = shadowHost('div', 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;');
      sr.appendChild(h('style', {}, `.box{position:fixed;border:2px solid #89b4fa;background:rgba(137,180,250,.15);border-radius:4px;transition:all .06s;pointer-events:none}
        .tip{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#1e1e2e;color:#cdd6f4;border:1px solid #89b4fa;padding:9px 16px;border-radius:10px;font-size:13px;pointer-events:auto}
        .tip button{margin-left:10px;background:#313244;color:#cdd6f4;border:0;border-radius:6px;padding:3px 9px;cursor:pointer}`));
      const box = h('div', { class: 'box' });
      const tip = h('div', { class: 'tip' }, prompt, h('button', { onclick: () => finish(null) }, 'Cancel'));
      sr.append(box, tip);
      document.documentElement.appendChild(host);
      let current = null;
      const move = (e) => {
        let el = document.elementFromPoint(e.clientX, e.clientY);
        // Into open shadow roots, so a link in a web component is that link and
        // not its host (a rule can't reach it, and saying so beats a useless rule).
        while (el && el.shadowRoot) {
          const inner = el.shadowRoot.elementFromPoint(e.clientX, e.clientY);
          if (!inner || inner === el) break;
          el = inner;
        }
        if (!el || el === host || el.closest('[data-onward]')) return;
        current = el;
        const r = el.getBoundingClientRect();
        Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      };
      const click = (e) => {
        if (e.composedPath().includes(host)) return;
        e.preventDefault();
        e.stopPropagation();
        finish(current);
      };
      function finish(el) {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('click', click, true);
        host.remove();
        resolve(el);
      }
      document.addEventListener('mousemove', move, true);
      document.addEventListener('click', click, true);
    });
  }

  async function runPicker(app) {
    const opts = app.opts;
    app.picking = true;
    try {
      await pickRule(app);
    } catch (e) {
      console.warn(TAG, 'picker failed', e);
      toast('The picker couldn’t use that: ' + e.message, 'err');
    } finally {
      app.picking = false;
    }
    // Saved, refused, cancelled or failed: Onward starts again as it was running
    // (a start is refused while picking, so this has to come after the flag drops).
    app.restart(opts);
  }

  async function pickRule(app) {
    // Hold the page still while the user points at things.
    if (app.pager) { app.pager.destroy(); app.pager = null; }
    let nextEl = await pickElement('Click the “Next page” link or “Load more” button.');
    // Cancel: runPicker puts Onward back the way it was.
    if (!nextEl) return;
    nextEl = nextEl.closest('a, button, [role="button"], input') || nextEl;
    const itemEl = await pickElement('Now click one result, post or product in the list.');
    if (!itemEl) return;
    // Climb to the level where the item has same-looking siblings.
    let item = itemEl;
    while (item.parentElement && item.parentElement !== document.body) {
      const sig = signature(item);
      const sibs = Array.from(item.parentElement.children).filter((c) => signature(c) === sig);
      if (sibs.length >= 2) break;
      item = item.parentElement;
    }
    const parent = item.parentElement;
    if (!parent || item === document.body || parent === document.documentElement) {
      toast('That doesn’t look like one item in a list. Click a single result or post.', 'err');
      return;
    }
    const sig = signature(item);
    const container = cssPath(parent);
    const itemSel = sig.split('.').map((p, i) => (i === 0 ? p.toLowerCase() : '.' + CSS.escape(p))).join('');
    const rule = {
      name: location.hostname,
      // host, not hostname: a rule without the port never matches a site that has one.
      url: '^https?://' + location.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/',
      next: uniqueSelector(nextEl),
      content: container + ' > ' + itemSel,
      click: !nextEl.getAttribute('href') || JUNK_HREF_RE.test(nextEl.getAttribute('href')),
    };
    // The rule has to lead back to the element that was clicked, or it would
    // quietly page somewhere else (a class path shared by every pager link),
    // and its item selector has to find the item that was clicked.
    const check = rule.next && findNext(document, location.href, { rule });
    if (!check || check.el !== nextEl) {
      toast('Couldn’t build a rule that finds that link. Write one in Settings instead.', 'err');
      return;
    }
    if (!queryAll(document, rule.content).includes(item)) {
      toast('Couldn’t build a rule that finds those items. Write one in Settings instead.', 'err');
      return;
    }
    const rules = store.get('rules').filter((r) => r.url !== rule.url);
    rules.unshift(rule);
    store.set('rules', rules);
    toast('Rule saved for ' + location.hostname + '. Restarting.', 'ok');
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  /** Forum engines that already load more as you scroll. */
  function selfPagingSite() {
    const generator = document.querySelector('meta[name="generator" i]');
    if (generator && /\b(discourse|flarum)\b/i.test(generator.content)) return true;
    // Flarum doesn't always send a generator meta, but its app shell has these.
    return !!(document.getElementById('flarum-loading') || document.getElementById('flarum-json-payload'));
  }

  function boot() {
    if (win.top !== win.self || win.__onward) return;
    if (!document.body || !/html/i.test(document.contentType || 'text/html')) return;
    win.__onward = true;

    const app = {
      pager: null,
      status: 'idle',
      gen: 0,
      restart(opts) {
        if (this.pager) this.pager.destroy();
        this.pager = null;
        this.gen++;  // retries scheduled for the old start are void now
        this.tryStart(0, opts);
      },
      tryStart(attempt, opts) {
        opts = opts || {};
        if (this.picking || this.pager) return;
        this.opts = opts;
        const s = loadSettings();
        const host = location.hostname;
        if (s.disabledHosts.includes(host)) { this.status = 'disabled on this site'; return; }
        if (s.exclude.some((x) => host === x || host.endsWith('.' + x))) { this.status = 'excluded host'; return; }
        const gen = this.gen;
        const retry = () => {
          // Many lists are rendered after load; look again a couple of times.
          if (attempt < 2) setTimeout(() => { if (this.gen === gen) this.tryStart(attempt + 1, opts); }, attempt === 0 ? 1500 : 4000);
        };
        // A rule is only used where it works on this page; otherwise the next
        // rule, then detection. A site rule still rendering gets the retries first.
        const choice = chooseRule(s.rules, s.sourceRules, location.href, document, attempt);
        if (choice.wait) { this.status = 'waiting for the page to render'; return retry(); }
        const rule = choice.rule;
        const userRule = !!choice.mine;
        // A rule the user wrote or picked means they want paging here.
        if (!opts.force && !userRule && selfPagingSite()) {
          this.status = STANDING_BY;
          console.info(TAG, 'the page says it is Discourse or Flarum, which load more by themselves; standing by');
          return;
        }
        const pager = new Pager(s, rule, {
          wrap: !!opts.wrap,
          force: !!opts.force,
          onLost: () => this.restart({ wrap: true, force: opts.force }),
          onStandDown: (hadPages) => {
            this.status = STANDING_BY;
            this.pager = null;
            if (hadPages) toast(STANDING_BY + ', so Onward took its pages back out.');
          },
          onUrl: (u) => { this.expectUrl = u; },
        });
        if (pager.detect()) {
          this.pager = pager;
          this.status = 'active';
          pager.start();
          return;
        }
        this.status = 'no next page found';
        retry();
      },
    };

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Toggle Onward on this site', () => {
        const list = store.get('disabledHosts').slice();
        const i = list.indexOf(location.hostname);
        if (i >= 0) { list.splice(i, 1); store.set('disabledHosts', list); toast('Enabled on ' + location.hostname, 'ok'); app.restart(); }
        else { list.push(location.hostname); store.set('disabledHosts', list); if (app.pager) app.pager.destroy(); app.pager = null; toast('Disabled on ' + location.hostname); }
      });
      GM_registerMenuCommand('Load next page now', () => {
        const p = app.pager;
        if (!p) return toast('Nothing to load: ' + app.status, 'err');
        if (p.userStopped) {
          toast('Resuming. Paging was stopped by you.', 'ok');
          p.resume();
        } else if (p.paused) {
          toast('Trying again. Paging was paused after an error.', 'ok');
        } else if (p.stopped) {
          const why = { limit: 'Stopped at the page limit. You can raise it in Settings.', error: 'Stopped after repeated errors.' };
          return toast(why[p.endReason] || 'Last page reached.', 'err');
        }
        p.loadNext();
      });
      GM_registerMenuCommand('Run Onward here anyway', () => {
        toast('Running on this page.', 'ok');
        app.restart({ force: true });
      });
      GM_registerMenuCommand('Pick next link and content…', () => runPicker(app));
      GM_registerMenuCommand('Settings', () => openSettings(app));
    }

    // Refresh rule lists weekly, in the background.
    const s = loadSettings();
    // Weekly, and after a failed refresh no more often than every 6 hours.
    if (s.sources.length && Date.now() - s.sourcesUpdated > 7 * 864e5 && Date.now() - s.sourcesTried > 6 * 36e5) updateSources(s.sources, false);

    app.tryStart(0);

    // Single-page apps change the URL without a reload; start over when that happens.
    let lastUrl = location.href;
    const urlChanged = (delay) => {
      if (location.href === lastUrl) return;
      const ours = location.href === app.expectUrl
        || (app.pager && (location.href === app.pager.selfUrl || app.pager.separators.some((x) => x.url === location.href) || location.href === app.pager.startUrl));
      lastUrl = location.href;
      if (!ours && !app.picking) setTimeout(() => app.restart(), delay);
    };
    // The Navigation API says so as soon as a route changes; polling stays for
    // browsers without it (and as a backstop), giving the app longer to render.
    if (win.navigation && typeof win.navigation.addEventListener === 'function') {
      win.navigation.addEventListener('navigatesuccess', () => urlChanged(150));
    }
    setInterval(() => urlChanged(800), 1000);
  }

  return {
    VERSION, boot, findNext, findContent, describePath, resolvePath, extractItems, prepareItems,
    itemShape, fixLazyImages, absolutize, sniffCharset, decode, normalizeRules, matchRule, matchingRules, fittingRule, chooseRule, acceptRuleList, itemKey, splitRepeats, signature, barTag,
  };
});
