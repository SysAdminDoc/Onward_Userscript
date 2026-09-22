// ==UserScript==
// @name         Onward
// @namespace    https://github.com/SysAdminDoc/Onward_Userscript
// @version      0.2.0
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
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @grant        GM.registerMenuCommand
// @connect      self
// @connect      wedata.net
// @connect      hoothin.github.io
// @connect      cdn.jsdelivr.net
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

  const VERSION = '0.2.0';
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
    loadPages: 'auto',     // auto | click: load as you scroll, or only when you press the bar's button
    hostLoadPages: {},     // per-host override of loadPages: { host: 'auto' | 'click' }
    newTabLinks: false,    // open links on added pages in a new tab
    skipFooterMs: 30000,   // how long "Skip to footer" holds loading off
    runOn: 'all',          // all | listed (only the hosts in allowHosts)
    allowHosts: [],
    // Pages Onward stays off: appending pages broke checkout and account flows for other auto-pagers.
    // A path part that starts with one of these words ("/login.php", "/Cart-Show", "/my-account/",
    // "/password_reset/"), unless the path runs through a listing ("/tag/account-security" lists posts).
    skipPaths: '/(my[-_]?)?(checkout|cart|basket|log[-_]?in|sign[-_]?in|sign[-_]?up|register|account|password)([/._?-]|$)',
    disabledHosts: [],
    exclude: [
      'mail.google.com', 'docs.google.com', 'drive.google.com', 'calendar.google.com',
      'www.youtube.com', 'x.com', 'twitter.com', 'www.facebook.com', 'www.instagram.com',
      'outlook.live.com', 'outlook.office.com', 'web.whatsapp.com', 'discord.com',
    ],
    rules: [],             // user rules (Onward format)
    sources: [],           // URLs of rule lists (Onward or AutoPagerize/wedata JSON)
    sourceRules: [],       // rules 0.1.0 cached flattened; used until every list has a packed copy
    sourceCache: {},       // each rule list's last good copy: { url: { at, count, hosts, generic, rules } }
    sourcesUpdated: 0,     // last time every source updated cleanly
    sourcesTried: 0,       // last refresh attempt, to back off after failures
    sourcesLock: 0,        // { at, id } of the tab refreshing right now (expires after a minute)
    sourcesFormat: 0,      // the LIST_FORMAT the lists were last all stored in (0: 0.1.0's, or never)
    schema: 1,             // settings version; 0 or absent means 0.1.0 data
  };
  // How rule lists are stored now: packed, indexed by host, general rules apart.
  // An older form is refreshed on the next page load instead of a week later.
  const LIST_FORMAT = 3;

  // The async GM.* API, where a manager offers only that (Userscripts for Safari).
  const gm4 = () => (typeof GM === 'object' && GM && typeof GM.getValue === 'function' ? GM : null);
  let asyncValues = null; // every value, read once at boot when only the async API exists

  const store = {
    get(key) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, DEFAULTS[key]);
        if (asyncValues && key in asyncValues) return asyncValues[key];
      } catch (e) { /* fall through to defaults */ }
      return DEFAULTS[key];
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, value);
        else if (gm4()) {
          if (asyncValues) asyncValues[key] = value;
          Promise.resolve(GM.setValue(key, value)).catch((e) => console.warn(TAG, 'could not save', key, e));
        }
      } catch (e) { console.warn(TAG, 'could not save', key, e); }
    },
  };

  /**
   * With only the async API, read the values once, before anything needs one.
   * The rule lists are big, so they're only read where some are configured.
   */
  async function loadAsyncValues() {
    if (typeof GM_getValue === 'function' || !gm4()) return;
    const read = (k) => Promise.resolve(GM.getValue(k, DEFAULTS[k])).catch(() => DEFAULTS[k]);
    const light = Object.keys(DEFAULTS).filter((k) => !HEAVY_KEYS.has(k));
    const values = await Promise.all(light.map(read));
    asyncValues = {};
    light.forEach((k, i) => { asyncValues[k] = values[i]; });
    if ((asyncValues.sources || []).length) for (const k of HEAVY_KEYS) asyncValues[k] = await read(k);
  }

  /** host is one of the listed hosts, or a subdomain of one. */
  function hostListed(list, host) {
    return list.some((x) => host === x || host.endsWith('.' + x));
  }

  /** The path is one Onward stays off (skipPaths, case-insensitive). A broken pattern skips nothing. */
  function pathSkipped(pattern, path) {
    if (!pattern) return false;
    try { return new RegExp(pattern, 'i').test(path); } catch (e) { return false; }
  }

  /**
   * What toggling Onward on this host does: its new state, and both host lists.
   * Off takes the host off "Sites to run on" where it's listed by name, and
   * turns it off outright where it's still covered (every site, or a parent
   * domain on the list). On undoes that, listing the host when nothing covers it.
   */
  function toggleLists(s, host) {
    const listed = s.runOn === 'listed';
    const covered = (list) => !listed || hostListed(list, host);
    let allow = s.allowHosts.slice();
    let off = s.disabledHosts.filter((h) => h !== host);
    const wasOn = !s.disabledHosts.includes(host) && covered(allow);
    if (wasOn) {
      if (listed) allow = allow.filter((h) => h !== host);
      if (covered(allow)) off = off.concat(host);
    } else if (!covered(allow)) {
      allow = allow.concat(host);
    }
    return { on: !wasOn, allowHosts: allow, disabledHosts: off };
  }

  /** The page at href is one Onward stays off: its path, or a single-page app's #/route, matches the pattern. */
  const LISTING_RE = /\/(tags?|topics?|categor(?:y|ies)|tagged|labels?|collections?|forums?|r|b|market)\//i;
  function pageSkipped(pattern, href) {
    let x;
    try { x = new URL(href); } catch (e) { return false; }
    const check = (path) => {
      if (!pathSkipped(pattern, path)) return false;
      const m = path.match(new RegExp(pattern, 'i'));
      if (!m) return true;
      const before = path.slice(0, m.index);
      return !LISTING_RE.test(before + '/');
    };
    if (check(x.pathname)) return true;
    return /^#!?\//.test(x.hash) && check(x.hash.replace(/^#!?/, '').split('?')[0]);
  }

  // Rule lists can be hundreds of kilobytes, so they're read once, where they're used.
  const HEAVY_KEYS = new Set(['sourceRules', 'sourceCache']);

  function loadSettings() {
    const s = {};
    for (const key of Object.keys(DEFAULTS)) if (!HEAVY_KEYS.has(key)) s[key] = store.get(key);
    if (!s.schema) {
      s.schema = DEFAULTS.schema;
      store.set('schema', s.schema);
    }
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
  // A label that starts with one of these is Previous however long it is: "Previous page of results".
  const PREV_STRONG_RE = /^(?:(?:prev|previous|précédente?|precedente|vorherige[nrs]?|anterior)(?![a-z])|предыдущ|попередн|上一|上页|上頁|前へ|前の|前页|이전)/i;
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
  // Onward fetches next pages with the reader's cookies, so a next link must never sign them out or delete something.
  const DANGER_URL_RE = /(^|[^a-z])(log[-_]?out|log[-_]?off|sign[-_]?out|sign[-_]?off|unsubscribe)([^a-z]|$)|[/=](delete|destroy|remove)([/?&#]|$)/i;

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

  /** What a button says, numbers aside ("Load 20 more" and "Load 15 more" are one button). */
  const labelKey = (el) => labelOf(el).join(' ').replace(/\d[\d,.]*/g, '#').replace(/\b(\w{3,})s\b/gi, '$1');

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

  /** A #/route or #!/route hash names a view of a single-page app; #comments is just a spot on the page. */
  const routeHash = (u) => /#!?\//.test(u);
  /** Two addresses of the same page, maybe scrolled to another spot on it. */
  const samePage = (a, b) => a === b || (stripHash(a) === stripHash(b) && !routeHash(a) && !routeHash(b));

  /**
   * Clicking it would take the tab to another page: a link with a real address.
   * A link to the page itself doesn't (a script-driven "Load more" often keeps
   * one for browsers without scripts).
   */
  const navigates = (el, pageUrl) => {
    const href = el.getAttribute('href');
    if (!href || JUNK_HREF_RE.test(href)) return false;
    const u = absUrl(href, pageUrl);
    return !(u && samePage(u, pageUrl));
  };

  /**
   * Where an address has a sign-out, unsubscribe or delete word: each path
   * segment with one (by its position) and each query pair with one. null for
   * a broken address.
   */
  function dangerPlaces(u) {
    let x;
    try { x = new URL(u); } catch (e) { return null; }
    const words = new Set();
    const add = (s) => { const m = s.match(DANGER_URL_RE); if (m) words.add((m[2] || m[4]).toLowerCase().replace(/[-_]/g, '')); };
    for (const seg of x.pathname.split('/')) add('/' + seg + '/');
    for (const [k, v] of x.searchParams) add('?' + k + '=' + v + '&');
    return words;
  }

  /**
   * u would sign the reader out or delete something. A danger word the
   * page's own address also carries (anywhere) doesn't count: the next page
   * of /search/logout or ?q=logout isn't signing out, but /logout from
   * /about is.
   */
  function dangerousUrl(u, pageUrl) {
    const words = dangerPlaces(u);
    if (!words) return true;
    if (!words.size) return false;
    const here = (pageUrl && dangerPlaces(pageUrl)) || new Set();
    for (const w of words) if (!here.has(w)) return true;
    return false;
  }

  function absUrl(v, base) {
    try { return new URL(v, base).href; } catch (e) { return null; }
  }

  function formUrl(el, base) {
    const form = el.closest('form');
    if (!form) return null;
    const method = (el.getAttribute('formmethod') || form.getAttribute('method') || 'GET').toUpperCase();
    if (method !== 'GET') return null;
    const action = el.getAttribute('formaction') || form.getAttribute('action') || base;
    let u;
    try { u = new URL(action, base); } catch (e) { return null; }
    const data = new URLSearchParams();
    for (const inp of form.elements) {
      if (inp.disabled || !inp.name) continue;
      if ((inp.type === 'checkbox' || inp.type === 'radio') && !inp.checked) continue;
      if (inp.type === 'submit' && inp !== el) continue;
      if (inp.type === 'image' || inp.type === 'file' || inp.type === 'reset') continue;
      data.append(inp.name, inp.value);
    }
    u.search = data.toString();
    return u.href;
  }

  // ---------------------------------------------------------------------------
  // Next-page detection
  // ---------------------------------------------------------------------------

  /**
   * Find the link to the next page.
   * @returns {{url: string|null, el: Element, score: number, how: string}|null}
   *   url is null for a button that has to be clicked (load-more style).
   */
  /**
   * For links on the page at pageUrl: the address a next link leads to, or null
   * when Onward won't follow it (not http(s), this page or one already shown,
   * another origin, a sign-out or delete link). http becomes https on a secure page.
   */
  function nextUrlChecker(pageUrl, seen) {
    const here = stripHash(pageUrl);
    // Same origin only (scheme, host and port): a next link elsewhere would be
    // fetched with the user's cookies into a page whose scripts can read it.
    const origin = safeOrigin(pageUrl);
    return (href) => {
      if (!href || JUNK_HREF_RE.test(href)) return null;
      let u = absUrl(href, pageUrl);
      if (!u || !/^https?:/.test(u)) return null;
      if (/^https:/.test(pageUrl) && /^http:/.test(u)) u = u.replace(/^http:/, 'https:');
      if (stripHash(u) === here || (seen && seen.has(stripHash(u)))) return null;
      if (safeOrigin(u) !== origin) return null;
      if (dangerousUrl(u, pageUrl)) return null;
      return u;
    };
  }

  function findNext(doc, pageUrl, opts) {
    opts = opts || {};
    const layout = opts.layout !== undefined ? opts.layout : hasLayout(doc);
    const acceptUrl = nextUrlChecker(pageUrl, opts.seen);

    // 1. Explicit rule
    if (opts.rule && opts.rule.next) {
      for (const el of queryAll(doc, opts.rule.next)) {
        // The same classes often mark Previous on later pages; never take that.
        if (looksPrevious(el)) continue;
        const u = acceptUrl(el.getAttribute('href') || el.getAttribute('value'));
        if (u) return { url: u, el, score: 1000, how: 'rule' };
        // A link Onward refused (another site, a page already shown) isn't clicked instead: that would leave the page.
        if (opts.rule.click && isVisible(el, layout) && !navigates(el, pageUrl)) return { url: null, el, score: 1000, how: 'rule-click' };
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
    // On a tie the later one wins (the pager under the list, as Vivaldi and
    // Pagetual do), unless it's a button and the earlier one is a link.
    const consider = (c) => {
      if (!best || c.score > best.score || (c.score === best.score && (c.url || !best.url))) best = c;
    };
    const bumped = new Set(incrementUrls(pageUrl).map(stripHash));
    // A site rule that supplied only the items: its own next link wasn't on the
    // page, so only a next page by address or rel counts ("Next thread" won't).
    const strict = !!(opts.rule && opts.rule.strictNext);
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
      const href = el.getAttribute('href') || (el.type === 'submit' || el.tagName === 'BUTTON' ? formUrl(el, pageUrl) : null);
      const u = acceptUrl(href);
      if (strict && !relNext && !(u && nextByAddress(u, pageUrl))) continue;
      if (u && bumped.has(stripHash(u))) score += 45; // ?page=N+1 or /page/N+1
      if (score === 0) continue;
      if (inPagination(el)) score += 20;
      else if (score < 45) continue; // a bare arrow or "more" outside pagination is too weak
      if (!isVisible(el, layout)) score -= 50;

      if (u) {
        consider({ url: u, el, score, how: more ? 'more-link' : 'text' });
      } else if (layout && isVisible(el, layout) && (more || opts.allowButtons) && !navigates(el, pageUrl)) {
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
    if (labels.some((t) => PREV_STRONG_RE.test(t) || (t.split(' ').length <= 3 && PREV_WORD_RE.test(t)))) return true;
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
  const PAGE_PARAM_RE = /^(p|page|pg|pn|paged|pagenum|pageno|page_no|pagenumber|seite)$/i;

  /** u is the page after pageUrl going by the address alone: N+1 of a numbered one, or page 2 of an unnumbered one. */
  function nextByAddress(u, pageUrl) {
    if (incrementUrls(pageUrl).some((x) => stripHash(x) === stripHash(u))) return true;
    let a;
    let b;
    try { a = new URL(pageUrl); b = new URL(u); } catch (e) { return false; }
    if (a.origin !== b.origin) return false;
    if (a.pathname === b.pathname) {
      const added = [...b.searchParams.keys()].filter((k) => !a.searchParams.has(k));
      const kept = [...a.searchParams.keys()].every((k) => b.searchParams.get(k) === a.searchParams.get(k));
      return kept && added.length === 1 && PAGE_PARAM_RE.test(added[0]) && b.searchParams.get(added[0]) === '2';
    }
    const base = a.pathname.replace(/\/$/, '');
    return b.search === a.search && /^\/(page|p|seite|pagina|strona)[/-]?2\/?$/i.test(b.pathname.slice(base.length)) && b.pathname.startsWith(base + '/');
  }

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
      // Unlabelled pagers: the N+1 link sits right after the marker, in a run of
      // consecutive numbers with at least two more links (a table cell holding 2
      // next to a link to 3 is data, not a pager).
      const holder = m.tagName === 'A' ? m : m.closest('li, td') || m;
      const numberAt = (el) => {
        const a = el && (el.matches('a[href]') ? el : el.querySelector(':scope > a[href]'));
        const t = a && normalize(a.textContent);
        return t && /^\d{1,5}$/.test(t) ? { a, n: Number(t) } : null;
      };
      const after = numberAt(holder.nextElementSibling);
      if (!after || after.n !== n + 1) continue;
      let more = 0;
      for (let s = holder.nextElementSibling.nextElementSibling, k = n + 2; s && (numberAt(s) || {}).n === k; s = s.nextElementSibling, k++) more++;
      for (let s = holder.previousElementSibling, k = n - 1; s && (numberAt(s) || {}).n === k; s = s.previousElementSibling, k--) more++;
      if (more < 2) continue;
      const u = acceptUrl(after.a.getAttribute('href'));
      if (u) return { url: u, el: after.a, score: 55, how: 'numbered' };
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
    if (!PAGINATION_RE.test(attrText(c)) || normalize(c.textContent).length >= 300) return false;
    // A class with "page" in it isn't enough (li.product-page-card): most links
    // have to be page numbers or next/previous.
    const links = Array.from(c.querySelectorAll('a'));
    if (links.length <= 2) return false;
    const pagerish = links.filter((a) => {
      const raw = normalize(a.textContent);
      const t = stripDecor(raw);
      return /^\d{1,5}$/.test(t) || NEXT_SET.has(t) || PREV_WORD_RE.test(t) || ARROWS.test(raw) || BACK_ARROWS.test(raw) || t === '…' || t === '...';
    });
    return pagerish.length * 2 >= links.length;
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

  // Where lazy loaders keep the real address, full-size first (Pagetual's set
  // and a few more). Used only when src is missing or a placeholder.
  const LAZY_ATTRS = [
    'data-src', 'data-original', 'data-lazy-src', 'data-lazyload', 'data-lazyload-src', 'data-lazy-load-src',
    'data-ks-lazyload', 'data-ks-lazyload-custom', 'data-defer-src', 'data-actualsrc', 'data-orig-file',
    'data-hi-res-src', 'zoomfile', 'file', 'original', 'data-lazy', 'data-echo', 'data-url', 'data-imageurl',
    'data-isrc', 'data-s', 'lazy-src', 'lazysrc', 'load-src', 'origin-src', 'real_src', 'imgsrc', 'src2', '_src',
    'data-cover', 'data-thumb', 'data-placeholder',
  ];
  const PLACEHOLDER_RE = /^data:|blank|placeholder|spacer|lazy|loading|grey|gray|transparent|1x1|pixel|(^|\/)none\.(gif|png)/i;
  const BG_ATTRS = ['data-bg', 'data-background-image'];
  // What an image address looks like, as against the flags and colours sites
  // also keep in data-bg ("dark", "#f5f5f5", "rgba(0,0,0,.5)", "1"): a URL or a
  // path, anything with a "/" or a "?", or a file name with an extension.
  const imageRef = (v) => !/^(#|rgba?\(|hsla?\(|var\(|oklch\(|oklab\(|lch\(|lab\(|color\(|hwb\()/i.test(v) && !/^[\d.\s%]+$/.test(v)
    && (/^(https?:|\/|\.\.?\/|data:image\/)/i.test(v) || /[/?]/.test(v) || /\.[a-z0-9]{2,5}([?#]|$)/i.test(v));

  /** A srcset that only offers placeholders (data: URIs, blank.gif and the like). */
  const placeholderSet = (set) => /^\s*data:/i.test(set) || set.split(',').every((part) => PLACEHOLDER_RE.test(part.trim().split(/\s+/)[0] || ''));

  /** root itself when it matches, then everything below it that does: items are often the <a> or <img> themselves. */
  const selfAndBelow = (root, sel) => (root.matches && root.matches(sel) ? [root] : []).concat(Array.from(root.querySelectorAll(sel)));

  function fixLazyImages(root, base) {
    for (const img of selfAndBelow(root, 'img, source')) {
      const src = img.getAttribute('src') || '';
      for (const a of LAZY_ATTRS) {
        const v = img.getAttribute(a);
        if (v && !/^data:/.test(v) && (!src || PLACEHOLDER_RE.test(src))) { img.setAttribute('src', v); break; }
      }
      const lazySet = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
      const set = img.getAttribute('srcset');
      if (lazySet && (!set || placeholderSet(set))) img.setAttribute('srcset', lazySet);
    }
    // Lazy background images: <div data-bg="/cover.jpg">.
    for (const el of selfAndBelow(root, BG_ATTRS.map((a) => '[' + a + ']').join(','))) {
      if (el.style.backgroundImage && !/^url\(["']?data:/.test(el.style.backgroundImage)) continue;
      const v = (BG_ATTRS.map((a) => el.getAttribute(a)).find((x) => x && x.trim()) || '').trim();
      const inner = /^url\(/i.test(v) ? v.replace(/^url\(\s*["']?|["']?\s*\)$/gi, '') : v;
      if (!imageRef(inner)) continue;
      const u = base ? absUrl(inner, base) : inner;
      if (u) el.style.backgroundImage = 'url("' + u.replace(/["\\]/g, '\\$&') + '")';
    }
  }

  function absolutize(root, base) {
    for (const [sel, attr] of [['[href]', 'href'], ['[src]', 'src'], ['[action]', 'action'], ['[poster]', 'poster']]) {
      for (const el of selfAndBelow(root, sel)) {
        const v = el.getAttribute(attr);
        if (!v || /^(#|javascript:|data:|mailto:|tel:)/i.test(v)) continue;
        const u = absUrl(v, base);
        if (u) el.setAttribute(attr, u);
      }
    }
    for (const el of selfAndBelow(root, '[srcset]')) {
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
  const URL_ATTRS = ['src', 'href', 'action', 'formaction', 'xlink:href', 'data'];
  // The URL parser drops tabs and newlines anywhere, and control characters and
  // spaces in front, so "java&#9;script:" is javascript: too.
  const jsUrl = (v) => /^javascript:/i.test(v.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, ''));

  /** A placeholder image with no lazy address of its own takes the real one from a <noscript> copy. */
  function fillFromNoscript(img, real) {
    const src = img.getAttribute('src') || '';
    const lazy = LAZY_ATTRS.some((a) => { const v = img.getAttribute(a); return v && !/^data:/.test(v); });
    if ((src && !PLACEHOLDER_RE.test(src)) || lazy) return false;
    img.setAttribute('src', real.getAttribute('src'));
    if (real.getAttribute('srcset')) img.setAttribute('srcset', real.getAttribute('srcset'));
    return true;
  }

  /** Placeholder images whose real URL is only in a sibling <noscript><img> take it from there. */
  function takeNoscriptImages(root) {
    for (const ns of root.querySelectorAll('noscript')) {
      const real = ns.querySelector('img[src]');
      if (!real || !ns.parentElement) continue;
      for (const img of ns.parentElement.children) {
        if (img.tagName === 'IMG' && fillFromNoscript(img, real)) break;
      }
    }
  }

  function stripInert(root) {
    for (const el of root.querySelectorAll(INERT_SEL)) el.remove();
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const a of URL_ATTRS) if (jsUrl(el.getAttribute(a) || '')) el.removeAttribute(a);
    }
  }

  function prepareItems(items, base) {
    const out = [];
    for (const it of items) {
      if (it.matches(INERT_SEL)) continue;
      // An item that is the <img> itself: its <noscript> copy sits right after it.
      const ns = it.tagName === 'IMG' ? it.nextElementSibling : null;
      const real = ns && ns.tagName === 'NOSCRIPT' ? ns.querySelector('img[src]') : null;
      if (real) fillFromNoscript(it, real);
      takeNoscriptImages(it);
      fixLazyImages(it, base);
      absolutize(it, base);
      // Last, so nothing the repairs above wrote can act on the page either.
      stripInert(it);
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
      if (!ttPolicy) {
        try { ttPolicy = tt.createPolicy('onward', { createHTML: (s) => s }); } catch (e) { /* name not allowed */ }
      }
      if (ttPolicy) try { input = ttPolicy.createHTML(html); } catch (e) { /* nothing */ }
    }
    return new DOMParser().parseFromString(input, 'text/html');
  }

  /** An image's own address: the lazy-load one first, since the site's loader
   * may have swapped src on the live page but not in a fetched copy. '' for a placeholder. */
  function imageUrl(img) {
    for (const a of LAZY_ATTRS) {
      const v = img.getAttribute(a);
      if (v && !/^data:/.test(v)) return v;
    }
    const src = img.getAttribute('src');
    if (src && !PLACEHOLDER_RE.test(src)) return src;
    const set = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset') || img.getAttribute('srcset');
    if (set && !placeholderSet(set)) return set;
    const pic = img.parentElement;
    const source = pic && pic.tagName === 'PICTURE' ? pic.querySelector('source[data-srcset], source[srcset]') : null;
    return source ? source.getAttribute('data-srcset') || source.getAttribute('srcset') : '';
  }

  const BG_SEL = BG_ATTRS.map((a) => '[' + a + ']').join(',') + ',[style*="background-image"]';

  /** The picture an item shows, wherever its loader keeps it: an image, a lazy background, a <noscript> copy. */
  const NAMED_REFS = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  /** Undoes the character references an attribute value can carry (&#038;, &#x26;, &amp;). */
  const decodeRefs = (v) => v.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (ref, r) => {
    if (r[0] !== '#') return NAMED_REFS[r.toLowerCase()];
    const n = /^#x/i.test(r) ? parseInt(r.slice(2), 16) : parseInt(r.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ref;
  });

  function pictureOf(el) {
    for (const img of el.matches('img') ? [el] : el.querySelectorAll('img')) {
      const u = imageUrl(img);
      if (u) return u;
    }
    for (const b of el.matches(BG_SEL) ? [el] : el.querySelectorAll(BG_SEL)) {
      const u = BG_ATTRS.map((a) => b.getAttribute(a)).find(Boolean) || (/url\(\s*["']?([^"')]+)/i.exec(b.getAttribute('style') || '') || [])[1];
      if (u && !PLACEHOLDER_RE.test(u)) return u;
    }
    // A <noscript> copy: markup in a fetched page, raw text on the live one. The
    // raw text's src has its character references undone ("&#038;" is "&"), as
    // the fetched copy's attribute has, without parsing any markup (which a
    // page that enforces Trusted Types would refuse).
    for (const ns of el.querySelectorAll('noscript')) {
      const img = ns.querySelector('img[src]');
      if (img) return img.getAttribute('src');
      const m = /<img\b[^>]*?\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(ns.textContent || '');
      if (m) return decodeRefs(m[1]);
    }
    return '';
  }

  /** An item's words, leaving out <noscript>, <script> and <style> (raw text on a live page, markup in a fetched one). */
  function textOf(el) {
    const walker = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
    let out = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const skip = n.parentElement && n.parentElement.closest('noscript, script, style');
      if (!skip || !el.contains(skip)) out += n.data;
    }
    return normalize(out);
  }

  const MEDIA_SEL = 'img, picture, video, canvas, svg, iframe, object, embed';
  let unkeyed = 0;

  /**
   * One item's identity: its text and first link, plus its picture when asked
   * for (see pageKeys) or when it has neither. Items with no text, link or
   * media (spacer rows, clearfix divs) are layout, not content: no key, never
   * taken for repeats. A picture Onward can't identify is always new. Read
   * before prepareItems() rewrites URLs, so every page is keyed the same way.
   */
  function itemKey(el, withPicture) {
    const text = textOf(el);
    const a = el.matches('a[href]') ? el : el.querySelector('a[href]');
    let s = text + '|' + (a ? a.getAttribute('href') : '');
    if (withPicture || (!text && !a)) {
      const pic = pictureOf(el);
      if (pic) s += '|' + pic;
      else if (!text && !a) return el.matches(MEDIA_SEL) || el.querySelector(MEDIA_SEL) ? 'unkeyed:' + (++unkeyed) : null;
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  /**
   * Keys for one page's items. Items that share their text and link on the
   * page (the same "Download" button under every wallpaper, a picture linked
   * to "#") are told apart by their picture; others don't need it, so a
   * resized copy of an image doesn't change them.
   */
  function pageKeys(items) {
    const first = items.map((it) => itemKey(it, false));
    const count = new Map();
    for (const k of first) if (k !== null) count.set(k, (count.get(k) || 0) + 1);
    return items.map((it, i) => (first[i] !== null && count.get(first[i]) > 1 ? itemKey(it, true) : first[i]));
  }

  /**
   * Items not seen on earlier pages, their keys, and the share of content
   * items that were seen. Layout filler is always kept and has no key.
   */
  function splitRepeats(items, seenKeys) {
    let content = 0;
    let repeats = 0;
    const keys = pageKeys(items);
    const freshKeys = [];
    const fresh = items.filter((it, i) => {
      const k = keys[i];
      if (k === null) return true;
      content++;
      if (!seenKeys.has(k)) { freshKeys.push(k); return true; }
      repeats++;
      return false;
    });
    return { fresh, freshKeys, repeatShare: content ? repeats / content : 1 };
  }

  /** Remembers the keys of items now on screen. */
  function rememberItems(items, keys) {
    for (const k of pageKeys(items)) if (k !== null) keys.add(k);
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

  /** A catch-all from a big list ("^https?://."): it shouldn't beat detection, so it's never used. */
  const catchAll = (r) => r.url.replace(/[\^$]/g, '').length < 12 && /^\^?https?/.test(r.url) && !/[a-z0-9]\.[a-z]/i.test(r.url);

  /** Rules whose url pattern matches this address, in order. */
  function matchingRules(rules, href) {
    const out = [];
    for (const r of rules) {
      if (r.disabled) continue;
      try {
        if (catchAll(r)) continue;
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
    if (byContent) return { rule: Object.assign({}, byContent, { next: '', click: false, strictNext: true }), mine: true };
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
    const gmXhr = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
      : (gm4() && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest.bind(GM) : null);
    if (sameOrigin || !gmXhr) {
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
      const req = gmXhr({
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
      let lastSize = -1;
      let still = 0;
      const poll = setInterval(() => {
        try {
          const d = f.contentDocument;
          if (d) silence(d);
          if (!d || d.location.href === 'about:blank' || !ready(d)) return;
          if (d.readyState !== 'loading') return finish();
          // Items there but the page still loading: a parser held up by a
          // script that never arrives. Take it once it stops changing for 3 s.
          const size = d.getElementsByTagName('*').length;
          still = size === lastSize ? still + 1 : 0;
          lastSize = size;
          if (still >= 10) finish();
        } catch (e) { finish(new Error('iframe blocked')); }
      }, 300);
      const timer = setTimeout(() => {
        try {
          // A page that loaded, or has its items, is handed back; a frame still
          // on its blank placeholder never answered.
          const d = f.contentDocument;
          if (d && d.body && d.location.href !== 'about:blank' && (d.readyState !== 'loading' || ready(d))) return finish();
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
      .bar b { color: #1553d0; } .bar a, .bar button { color: #4c4f69; background: rgba(204,208,218,.8); }
      .bar a:hover, .bar button:hover { color: #1e1e2e; background: #bcc0cc; } .bar .url { color: #5c5f77; background: none; } .bar .url:hover { color: #4c4f69; background: none; }
      .bar.err b { color: #b80d33; } .bar.end b { color: #276a19; }
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

  /** An AutoPagerize API event on document, as weAutoPagerize and uAutoPagerize send them. */
  function fireAutoPagerize(name) {
    document.dispatchEvent(new Event(name, { bubbles: false, cancelable: true }));
  }

  let statusBox = null;
  /** Two visually hidden live regions for screen readers, made once Onward starts so they're there before anything is said. */
  function statusRegions() {
    if (typeof document === 'undefined' || !document.body) return null;
    if (!statusBox || !statusBox.host.isConnected) {
      statusBox = shadowHost('div', 'position:fixed;top:0;left:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;display:block;');
      // Not part of the page's Onward UI (bars, toasts); nothing to see or click.
      statusBox.host.removeAttribute('data-onward');
      statusBox.host.setAttribute('data-onward-status', '');
      statusBox.regions = [h('div', { role: 'status', 'aria-live': 'polite' }), h('div', { role: 'status', 'aria-live': 'polite' })];
      statusBox.turn = 0;
      statusBox.queue = [];
      statusBox.sr.append(...statusBox.regions);
      document.documentElement.appendChild(statusBox.host);
    }
    return statusBox;
  }

  /**
   * Tells screen readers what happened (a page loaded or failed, the end, a
   * toast) without showing anything. What's said at the same moment is read
   * as one ("Page 4 loaded, 5 items. No more pages."), and each turn writes
   * the other region, so the same words twice are still news.
   */
  function announce(msg) {
    const box = statusRegions();
    if (!box) return;
    if (!box.queue.includes(msg)) box.queue.push(msg);
    if (box.timer) return;
    box.timer = setTimeout(() => {
      box.timer = 0;
      const text = box.queue.join(' ');
      box.queue = [];
      const [now, before] = box.turn ? [box.regions[1], box.regions[0]] : [box.regions[0], box.regions[1]];
      box.turn = 1 - box.turn;
      before.textContent = '';
      now.textContent = text;
    }, 100);
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
    announce(msg);
  }

  // ---------------------------------------------------------------------------
  // The pager
  // ---------------------------------------------------------------------------

  // Before its first load Onward waits this long near the end of the list, and
  // stands down if the site adds this many items by itself meanwhile.
  const PROBE_MS = 3000;
  const NATIVE_GROWTH = 3;
  const STANDING_BY = 'This site loads more by itself';
  // The reader moving, as opposed to the page shifting under them.
  const INPUT_EVENTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'];
  const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'End', 'Home', 'ArrowDown', 'ArrowUp', ' ', 'Spacebar']);

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
      this.onInput = this.onInput.bind(this);
      this.inputAt = 0;
      // Pages load only when you press the bar's button, for everyone who'd rather reach the footer.
      this.manual = ((settings.hostLoadPages || {})[location.hostname] || settings.loadPages) === 'click';
      this.skipUntil = 0;
    }

    /** Detect next link + content on the live page. Returns false when there's nothing to do. */
    detect() {
      const next = findNext(document, location.href, { rule: this.rule, seen: this.seen });
      if (!next) return false;
      const content = findContent(document, { rule: this.rule, nextEl: next.el });
      if (!content || !content.items.length) return false;
      this.next = next;
      this.nextPath = next.el.tagName === 'LINK' ? null : describePath(next.el);
      // What a load-more button said when it was found; clickMore only clicks one that still says it.
      this.nextLabel = labelKey(next.el);
      this.container = content.container;
      this.path = describePath(content.container);
      // The site's own pager, kept in step with the pages added (fetch mode).
      this.pagerEl = next.url === null || next.el.tagName === 'LINK' ? null : this.findPager(next.el);
      this.pagerPath = this.pagerEl ? describePath(this.pagerEl) : null;
      this.shape = content.how === 'auto' ? itemShape(content.items) : null;
      this.firstItem = content.items[0] || null;
      this.firstKey = this.listFingerprint(content.items);
      this.tableCols = content.items[0] && content.items[0].tagName === 'TR' ? Math.max(...content.items.map((r) => r.cells ? r.cells.length : 0)) : 0;
      this.startItems = content.items.length;
      this.contentHow = content.how;
      this.firstNext = { how: next.how, score: next.score };
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
      for (const t of INPUT_EVENTS) win.addEventListener(t, this.onInput, { passive: true, capture: true });
      statusRegions();
      this.showManualBar();
      this.onScroll();
    }

    /** In manual mode, the bar at the end of the list that loads the next page. */
    showManualBar() {
      if (this.manualBar) { this.removeBar(this.manualBar); this.manualBar = null; }
      if (!this.manual || this.stopped || this.destroyed || !this.next) return;
      const n = this.page + 1;
      this.manualBar = this.addBar(this.next.url, 'Page ' + n + ' is next.', 'manual', () => this.loadNext(), 'Load page ' + n);
    }

    /** Scroll past the list and hold loading off for a while, so the footer can be reached. */
    skipToFooter() {
      this.skipUntil = Date.now() + this.s.skipFooterMs;
      if (this.abort) this.abort.abort();
      this.abort = new AbortController();
      const m = this.metrics();
      const past = this.listEndBottom(m) - m.top + 1;
      if (this.scroller && this.scroller.isConnected) this.scroller.scrollTop += past;
      else win.scrollTo(0, win.scrollY + past);
      toast(`Loading waits ${Math.round(this.s.skipFooterMs / 1000)} s so you can reach the footer.`, 'ok');
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
      if (this.manualBar) { this.removeBar(this.manualBar); this.manualBar = null; }
      if (reason) {
        this.addBar(null, reason, kind || 'end');
        announce(reason);
      }
      this.refreshBars();
      setTimeout(this.onScroll, 0);
    }

    userStop() {
      if (this.stopped) return;
      this.userStopped = true;
      // A page on its way is dropped rather than landing under the Stop bar.
      if (this.loadCtl) this.loadCtl.abort();
      this.stop(null, 'end', 'user');
      this.stopBar = this.addBar(null, 'Stopped by you.', 'end', () => this.resume(), 'Resume');
      announce('Stopped by you.');
    }

    // loadNow: false when the caller loads the pages itself (the menu's commands).
    resume(loadNow = true) {
      if (!this.userStopped || this.destroyed) return;
      this.userStopped = false;
      this.stopped = false;
      this.busy = false;
      this.endReason = null;
      // Resume means carry on, past a failed page too.
      this.paused = false;
      if (this.stopBar) { this.removeBar(this.stopBar); this.stopBar = null; }
      if (this.retryBar) { this.removeBar(this.retryBar); this.retryBar = null; }
      this.refreshBars();
      this.showManualBar();
      // Pressed at the end of the list, Resume loads the next page as asked (in
      // manual mode the bar's button does that); elsewhere paging carries on as you scroll.
      if (loadNow && !this.manual && this.nearEnd()) this.loadNext();
      else this.onScroll();
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
      if (hadPages) announce(STANDING_BY + ', so Onward took its pages back out.');
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
      const m = this.metrics();
      // An insert above always leaves page below the reader, so one at the very
      // bottom already scrolled there after the page landed (while a load-more
      // click was still settling, say): that is the reader moving.
      if (m.remaining < 2) return;
      this.awaitScroll = { pos: this.scrollPos(), height: m.height, since: Date.now() };
    }

    /** The reader's own input: the wheel, touch, scroll keys, the scrollbar. */
    onInput(e) {
      if (e.type === 'keydown') {
        const t = e.composedPath()[0];
        if (!SCROLL_KEYS.has(e.key) || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
      } else if (e.type === 'pointerdown') {
        const sc = this.scroller;
        const onBar = e.clientX >= document.documentElement.clientWidth || (sc && e.target === sc && e.offsetX >= sc.clientWidth);
        if (!onBar) return;
      }
      this.inputAt = Date.now();
      this.onScroll();
    }

    listFingerprint(items) {
      const hrefs = [];
      for (const it of items.slice(0, 5)) {
        const a = it.matches && it.matches('a[href]') ? it : it.querySelector && it.querySelector('a[href]');
        if (a) hrefs.push(a.href);
      }
      return hrefs.join('\n') || null;
    }

    /** The list Onward pages is still there, starting with the item it started with. */
    sameList() {
      const first = this.firstItem;
      if (this.listGone() || !first || !first.isConnected || !this.container.contains(first)) return false;
      return this.listFingerprint(Array.from(this.container.children).slice(0, 5)) === this.firstKey;
    }

    /** Nothing to add pages to: the list itself (load-more mode), or our place in it, is gone. */
    listGone() {
      return this.buttonMode ? !this.container.isConnected : this.lost();
    }

    /** Frameworks sometimes redraw the list and throw away what we added. */
    lost() {
      if (!this.anchor.isConnected) return true;
      if (this.lastInserted && !this.lastInserted.isConnected) {
        const prev = this.lastPageNodes && this.lastPageNodes.filter((n) => n.isConnected).pop();
        if (prev) { this.lastInserted = prev; return false; }
        if (this.anchor.previousElementSibling) { this.lastInserted = this.anchor.previousElementSibling; return false; }
        return true;
      }
      return false;
    }

    handleLost() {
      if (this.lostHandled) return;
      this.lostHandled = true;
      this.stopped = true;
      if (!this.wrap && !this.buttonMode && this.opts.onLost) {
        console.info(TAG, 'the site redrew its list; switching to wrapped pages');
        this.opts.onLost();
      } else {
        this.endReason = 'lost';
        this.addBar(null, 'This site keeps redrawing its list, so pages can’t be added here.', 'err');
        announce('This site keeps redrawing its list, so pages can’t be added here.');
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
      for (const t of INPUT_EVENTS) win.removeEventListener(t, this.onInput, true);
      if (this.anchorHolds) this.restoreAnchoring();
      if (this.nativeObserver) this.nativeObserver.disconnect();
      for (const s of this.separators) s.outer.remove();
      this.separators = [];
      if (this.anchor) this.anchor.remove();
      for (const n of this.inserted) n.remove();
      this.inserted = [];
      // The site's own pager goes back too.
      if (this.pagerOriginal && this.pagerEl && this.pagerEl.isConnected) this.pagerEl.replaceWith(this.pagerOriginal);
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
        // Manual mode loads only from the bar's button; "Skip to footer" holds loading off.
        if (this.manual || this.skipUntil > Date.now()) return;
        if (this.awaitScroll) {
          // A page landed while the reader sat below the list: the next one
          // waits for them. The page has to move, and move because of the
          // reader: with its height steady (a scrollbar drag the browser sends
          // no events for), or right after their wheel, touch, keys or
          // scrollbar. Input alone isn't enough: a wheel over a side panel
          // moves only the panel. A scroll that comes with growth and no input
          // is the browser keeping its place as images and widgets load.
          const w = this.awaitScroll;
          const pos = this.scrollPos();
          const moved = Math.abs(pos - w.pos) >= 1;
          const steady = Math.abs(m.height - w.height) < 1;
          const byReader = this.inputAt > w.since && Date.now() - this.inputAt < 1000;
          w.pos = pos;
          w.height = m.height;
          if (!moved || !(steady || byReader)) return;
          this.awaitScroll = null;
        }
        if (!this.nearEnd(m)) return;
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
        this.loadNext(true);
      });
    }

    /** Close enough to the end to want the next page. Tall footers shouldn't delay loading, so the end of the list counts too. */
    nearEnd(m) {
      m = m || this.metrics();
      const toListEnd = this.listEndBottom(m) - (m.top + m.view);
      return Math.min(m.remaining, toListEnd) < m.view * this.s.threshold;
    }

    /** Resolves when the last page's images have loaded or failed (natively lazy ones aside), or after ms. */
    imagesSettled(ms) {
      const pending = [];
      for (const n of this.lastPageNodes || []) {
        if (n.nodeType !== 1 || !n.isConnected) continue;
        for (const img of n.tagName === 'IMG' ? [n] : n.querySelectorAll('img')) {
          if (!img.complete && img.loading !== 'lazy') pending.push(img);
        }
      }
      if (!pending.length) return Promise.resolve();
      return new Promise((resolve) => {
        let left = pending.length;
        const done = () => { if (--left === 0) resolve(); };
        for (const img of pending) {
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        }
        setTimeout(resolve, ms);
      });
    }

    syncUrl() {
      if (!this.s.updateUrl || !this.separators.length || this.buttonMode) return;
      // The site went to an address of its own (a route change): not Onward's to rewrite.
      if (![this.startUrl, this.selfUrl, ...this.separators.map((s) => s.url)].some((u) => u && samePage(u, location.href))) return;
      const line = win.innerHeight * 0.35;
      let url = this.startUrl;
      for (const s of this.separators) {
        // Only finished pages count; a loading or error bar's page isn't on screen.
        if (!s.url || s.kind !== '') continue;
        const top = this.pageTop(s);
        if (top !== null && top < line) url = s.url;
      }
      if (url !== location.href && safeOrigin(url) === location.origin) {
        try {
          history.replaceState(history.state, '', url);
          this.selfUrl = url;
          if (this.opts.onUrl) this.opts.onUrl(url);
        } catch (e) { /* ignore */ }
      }
    }

    // auto: asked for by scrolling, so dropped if the page no longer needs it.
    async loadNext(auto) {
      if (this.busy) {
        // A load you ask for while a scroll load waits its turn: that load is now yours, and stays.
        if (!auto && this.waitingTurn) this.asked = true;
        return;
      }
      if (this.stopped) return;
      // The list is gone (redrawn, or the site moved to another view): nothing loads or clicks into it.
      if (this.listGone()) return this.handleLost();
      if (this.page >= this.s.maxPages) return this.stop(`Stopped after ${this.s.maxPages} pages (change the limit in settings).`, 'end', 'limit');
      this.busy = true;
      this.paused = false;
      if (this.retryBar) { this.removeBar(this.retryBar); this.retryBar = null; }
      if (this.manualBar) { this.removeBar(this.manualBar); this.manualBar = null; }
      const loading = this.addBar(this.next.url, 'Loading page ' + (this.page + 1) + (this.batch ? ` (${this.batch.i} of ${this.batch.n})` : '') + '…', 'loading');
      // Stop cancels this load; so does destroy().
      const ctl = new AbortController();
      const cancel = () => ctl.abort();
      this.abort.signal.addEventListener('abort', cancel);
      this.loadCtl = ctl;
      try {
        // Space requests out, however they were triggered (scroll, chain, menu, click).
        const wait = (this.lastRequestAt || 0) + this.s.spacing - Date.now();
        this.waitingTurn = true;
        this.asked = false;
        // Stop ends the wait at once, so a Resume or a menu load right after starts
        // afresh instead of being handed to this load, which is cancelled.
        if (wait > 0) {
          await new Promise((r) => {
            const t = setTimeout(r, wait);
            ctl.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
          });
        }
        this.waitingTurn = false;
        if (this.destroyed) return;
        if (ctl.signal.aborted) throw new Error('stopped');
        // Late images may have filled the page while this load waited its turn,
        // or the reader skipped to the footer (which holds loading off).
        if (auto && !this.asked && (this.skipUntil > Date.now() || !this.nearEnd())) {
          this.removeBar(loading);
          this.busy = false;
          return;
        }
        this.lastRequestAt = Date.now();
        // A load-more click can't be taken back, but that mode has no page bars, so no Stop either.
        if (this.buttonMode) await this.clickMore(loading);
        else await this.appendPage(this.next.url, loading, ctl.signal);
        if (this.destroyed) return;
        this.failures = 0;
      } catch (e) {
        if (this.destroyed) return;
        this.removeBar(loading);
        if (ctl.signal.aborted) { this.busy = false; return; }
        this.failures++;
        this.lastError = 'page ' + (this.page + 1) + ': ' + e.message;
        console.warn(TAG, e);
        if (this.failures >= 3) this.stop('Could not load the next page: ' + e.message, 'err');
        else {
          const failed = 'Page ' + (this.page + 1) + ' failed (' + e.message + '). Paused.';
          announce(failed);
          this.retryBar = this.addBar(this.next && this.next.url, failed, 'err', () => {
            this.paused = false;
            // Retry means carry on, after a Stop too.
            if (this.userStopped) this.resume();
            this.loadNext();
          });
          // Don't hammer a server that's failing or rate limiting; wait for a click.
          this.paused = true;
          this.busy = false;
          return;
        }
      } finally {
        this.abort.signal.removeEventListener('abort', cancel);
        if (this.loadCtl === ctl) this.loadCtl = null;
      }
      this.busy = false;
      this.showManualBar();
      // Keep filling short pages, gently, once the new page's images have their size:
      // images without a set height make every new page look short until they load.
      if (!this.stopped) Promise.all([this.imagesSettled(1500), new Promise((r) => setTimeout(r, 400))]).then(this.onScroll);
    }

    /** Loads up to n pages back to back, within the page cap and the gap between requests. */
    async loadMany(n) {
      for (let i = 1; i <= n; i++) {
        while (this.busy && !this.destroyed) await new Promise((r) => setTimeout(r, 100));
        if (this.stopped || this.destroyed || (i > 1 && this.paused)) break;
        this.batch = { i, n };
        try { await this.loadNext(); } finally { this.batch = null; }
        if (this.paused) break;
      }
    }

    async appendPage(url, bar, signal) {
      let doc;
      let dispose = () => {};
      let finalUrl = url;
      signal = signal || this.abort.signal;
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
          // The frame asks the site for the page again, so it waits its turn too.
          const wait = (this.lastRequestAt || 0) + this.s.spacing - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          if (this.destroyed || signal.aborted) throw new Error('stopped');
          this.lastRequestAt = Date.now();
          ({ doc, dispose } = await loadViaIframe(url, (d) => extractItems(d, this).length > 0, 0, signal));
          this.mode = 'iframe';
        }
      }
      try {
        if (this.destroyed) return;
        if (signal.aborted) throw new Error('stopped');
        // The site threw our place in the list away before this page arrived.
        if (this.lost()) {
          this.removeBar(bar);
          return this.handleLost();
        }
        // A redirect back to a page already on screen (/page/99 -> /page/1) is the real end.
        if (this.seen.has(stripHash(finalUrl))) {
          this.removeBar(bar);
          return this.stop('No more pages.');
        }
        // The page being loaded counts as seen for finding its next link, but it
        // only joins 'seen' once it is in: a failed attempt must stay retryable.
        const seenNow = new Set(this.seen).add(stripHash(url)).add(stripHash(finalUrl));
        const next = this.findNextIn(doc, finalUrl, seenNow);
        let items = extractItems(doc, this, next && next.el);
        if (!items.length) throw new Error('no content found on the next page');
        if (this.tableCols && items[0].tagName === 'TR') {
          const cols = Math.max(...items.map((r) => r.cells ? r.cells.length : 0));
          if (cols !== this.tableCols) {
            const box = resolvePath(doc, this.path);
            if (box) items = [box];
          }
        }
        // A page that is (nearly) all repeats is the site sending the same page
        // again; a few repeats (products that moved) are just dropped.
        // Keyed here, before prepareItems() rewrites their URLs, like every other page.
        const { fresh, freshKeys, repeatShare } = splitRepeats(items, this.itemKeys);
        if (!fresh.length || repeatShare >= 0.9) { this.removeBar(bar); return this.stop('The site returned a page we already have. End of results.'); }
        const prepared = prepareItems(fresh, finalUrl);
        const frag = document.createDocumentFragment();
        for (const it of prepared) {
          const clone = document.importNode(it, true);
          const srcCanvases = it.querySelectorAll ? [].concat(it.tagName === 'CANVAS' ? [it] : [], Array.from(it.querySelectorAll('canvas'))) : [];
          const dstCanvases = clone.querySelectorAll ? [].concat(clone.tagName === 'CANVAS' ? [clone] : [], Array.from(clone.querySelectorAll('canvas'))) : [];
          for (let c = 0; c < srcCanvases.length && c < dstCanvases.length; c++) {
            try {
              const src = srcCanvases[c], dst = dstCanvases[c];
              dst.width = src.width; dst.height = src.height;
              dst.getContext('2d').drawImage(src, 0, 0);
            } catch (e) { /* tainted or no context */ }
          }
          frag.appendChild(clone);
        }
        this.lastPageNodes = Array.from(frag.childNodes);
        // Scripts written for AutoPagerize find added items by this class.
        for (const n of this.lastPageNodes) if (n.nodeType === 1) n.classList.add('autopagerize_page_element');
        if (this.s.newTabLinks) for (const n of this.lastPageNodes) if (n.querySelectorAll) for (const a of n.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = (a.rel ? a.rel + ' ' : '') + 'noopener'; }
        this.page++;
        this.setBar(bar, url, 'Page ' + this.page, '');
        const heightBefore = this.metrics().height;
        const below = this.readerBelowList();
        const release = this.holdAnchoring();
        if (this.wrap) {
          const shell = this.container.cloneNode(false);
          shell.removeAttribute('id');
          shell.setAttribute('data-onward-page', String(this.page));
          shell.classList.add('autopagerize_page_element');
          shell.appendChild(frag);
          this.anchor.parentNode.insertBefore(shell, this.anchor);
          this.lastPageNodes = [shell];
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
        // Only now is the page on screen: a failure before this stays retryable.
        for (const k of freshKeys) this.itemKeys.add(k);
        this.seen.add(stripHash(url));
        this.seen.add(stripHash(finalUrl));
        this.replacePager(doc, finalUrl);
        bar.first = this.lastInserted;
        bar.size = this.wrap ? 1 : prepared.length;
        announce(`Page ${this.page} loaded, ${prepared.length} ${prepared.length === 1 ? 'item' : 'items'}.`);
        if (below) this.waitForReader();
        this.onPageAppended(url);
        setTimeout(() => { if (!this.destroyed && this.lost()) this.handleLost(); }, 1500);
        // Guard against loading forever when added pages don't make the page longer.
        this.noGrowth = this.metrics().height > heightBefore ? 0 : this.noGrowth + 1;
        if (this.noGrowth >= 2) return this.stop('Pages were added but the page isn’t getting longer, so Onward stopped.', 'err', 'nogrowth');
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
        const u = el && nextUrlChecker(url, seen)(el.getAttribute('href'));
        if (u && labelOf(el).join(' ') === labelOf(this.next.el).join(' ')) return { url: u, el, how: 'path' };
      }
      return findNext(doc, url, { rule: this.rule, seen, layout: false });
    }

    async clickMore(bar) {
      // The list may have gone while this click waited its turn.
      if (this.listGone()) {
        this.removeBar(bar);
        return this.handleLost();
      }
      // The button as it was found: the same element or one the site drew in its
      // place, saying what it said then (numbers aside). The same node reused for
      // something else (a Delete button after a route change) is never clicked.
      const ready = () => {
        const el = this.next.el.isConnected ? this.next.el : resolvePath(document, this.nextPath);
        if (!el || !el.isConnected || !isVisible(el, true) || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
        return labelKey(el) === this.nextLabel ? el : null;
      };
      // A button still busy ("Loading…", disabled, hidden) just after its items render comes back; give it 3 s.
      let el = ready();
      if (!el) {
        await waitFor(() => !!(el = ready()), 3000, this.ctl && this.ctl.signal);
        if (this.destroyed) return;
      }
      if (!el) {
        this.removeBar(bar);
        return this.stop('No more items.');
      }
      const before = this.container.childElementCount;
      const height = document.documentElement.scrollHeight;
      // From here on the list grows because of our clicks, not by itself.
      if (this.nativeObserver) { this.nativeObserver.disconnect(); this.nativeObserver = null; }
      this.lastPageNodes = [];
      const below = this.readerBelowList();
      const release = this.holdAnchoring();
      el.click();
      const grew = await waitFor(() => this.container.childElementCount > before || document.documentElement.scrollHeight > height + 50, 10000, this.ctl && this.ctl.signal);
      release();
      if (this.destroyed) return;
      this.removeBar(bar);
      if (!grew) return this.stop('The “load more” button stopped adding items.');
      if (below) this.waitForReader();
      this.page++;
      announce('More items loaded.');
      this.onPageAppended(null);
    }

    /** The site's pager around the next link, outside the list. */
    findPager(el) {
      for (let n = el.parentElement, i = 0; n && n !== document.body && i < 6; n = n.parentElement, i++) {
        if (n.contains(this.container) || this.container.contains(n)) return null;
        if (n.tagName === 'NAV' || n.getAttribute('role') === 'navigation' || PAGINATION_RE.test((n.id || '') + ' ' + (n.getAttribute('class') || ''))) return n;
      }
      return null;
    }

    /**
     * Swap the site's pager for the one on the page just added, so its current
     * page and its links match what's on screen (the old one still pointed at
     * page 2). Fetch mode only: an iframe's document is gone by then.
     */
    replacePager(doc, base) {
      if (!this.pagerPath || this.mode === 'iframe' || !this.pagerEl || !this.pagerEl.isConnected) return;
      const theirs = resolvePath(doc, this.pagerPath);
      if (!theirs || theirs === doc.body) return;
      const [fresh] = prepareItems([theirs], base);
      if (!fresh) return;
      const mine = document.importNode(fresh, true);
      if (!this.pagerOriginal) this.pagerOriginal = this.pagerEl;
      this.pagerEl.replaceWith(mine);
      this.pagerEl = mine;
    }

    onPageAppended(url) {
      // AutoPagerize filters get each added node, then the page as a whole.
      for (const n of this.lastPageNodes || []) {
        if (n.nodeType === 1 && n.isConnected) n.dispatchEvent(new CustomEvent('AutoPagerize_DOMNodeInserted', { bubbles: true, detail: url }));
      }
      fireAutoPagerize('GM_AutoPagerizeNextPageLoaded');
      win.dispatchEvent(new CustomEvent('onward:page', { detail: { page: this.page, url } }));
    }

    addBar(url, label, kind, onRetry, actionLabel) {
      // li/tr can't host a shadow root, so the bar lives in a div inside a
      // wrapper that is valid for the list it sits in.
      const list = this.anchor ? this.anchor.parentNode : null;
      const tag = barTag(list);
      const outer = document.createElement(tag.outer);
      outer.setAttribute('data-onward', '');
      // A whole row in a wrapping flex list; in a column one, just its own height.
      const basis = list && list.nodeType === 1 && /^column/.test(win.getComputedStyle(list).flexDirection) ? 'auto' : '100%';
      // Sites style their li/tr (fixed heights and the like); none of it should reach the bar.
      outer.style.cssText = 'display:block;width:auto;height:auto;min-height:0;grid-column:1/-1;flex:0 0 ' + basis + ';float:none;clear:both;list-style:none;margin:0;padding:0;border:0;background:none;';
      let mount = outer;
      if (tag.inner) {
        outer.style.display = 'table-row';
        mount = document.createElement(tag.inner);
        mount.colSpan = tableColumns(this.anchor.parentNode);
        mount.style.cssText = 'height:auto;padding:0;border:0;background:none;';
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
        kind === '' && this.opts.onMenu ? h('button', { title: 'Settings and commands', onclick: this.opts.onMenu }, 'Onward…') : null,
        kind === '' || kind === 'manual' ? h('button', { title: 'Jump past the list; loading waits a while', onclick: () => this.skipToFooter() }, 'Skip to footer') : null,
      ].filter(Boolean));
      // A hidden page bar leaves the layout (a zero-height wrapper still takes
      // a grid row, flex space or a table row); syncUrl uses the page's items.
      sep.outer.style.display = !this.s.separators && kind === '' ? 'none' : sep.display;
    }

    /** Where a finished page starts on screen: its bar, or with bars hidden, its first item that is laid out. */
    pageTop(sep) {
      if (sep.outer.style.display !== 'none') return sep.outer.isConnected ? sep.outer.getBoundingClientRect().top : null;
      let n = sep.first;
      for (let i = 0; n && i < (sep.size || 1); i++, n = n.nextElementSibling) {
        if (!n.isConnected) return null;
        const r = n.getBoundingClientRect();
        if (r.width || r.height) return r.top;
      }
      return null;
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

  function waitFor(test, ms, signal) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (signal && signal.aborted) return resolve(false);
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

  let closeSettings = null; // the open panel's close(), so the Settings command closes it the same way
  function openSettings(app) {
    const existing = document.querySelector('[data-onward-panel]');
    if (existing) {
      if (closeSettings) closeSettings();
      else existing.remove();
      return;
    }
    const s = loadSettings();
    const { host, sr } = shadowHost('div', 'position:fixed;inset:0;z-index:2147483647;display:block;');
    host.setAttribute('data-onward-panel', '');
    sr.appendChild(h('style', {}, `
      .bg{position:fixed;inset:0;background:rgba(17,17,27,.55);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center}
      .p{width:min(620px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;
        border-radius:14px;padding:20px 22px;box-shadow:0 20px 60px rgba(0,0,0,.5);font-size:13px}
      h2{margin:0 0 4px;font-size:17px;color:#89b4fa} .sub{color:#a6adc8;margin-bottom:14px}
      label{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid #313244}
      input[type=number]{width:80px} input,select,textarea{background:#181825;color:#cdd6f4;border:1px solid #7f849c;border-radius:6px;padding:5px 7px;font:inherit}
      textarea{width:100%;min-height:90px;font-family:ui-monospace,Consolas,monospace;font-size:12px;margin-top:6px}
      .blk{padding:9px 0;border-bottom:1px solid #313244} .hint{color:#9399b2;font-size:12px;margin-top:3px}
      .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
      button{background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:8px;padding:7px 14px;cursor:pointer;font:inherit;transition:transform .12s,background .12s}
      button:hover{background:#45475a;transform:translateY(-1px)} button.pri{background:#89b4fa;color:#11111b;border-color:#89b4fa}
      .err{color:#f38ba8;min-height:16px;margin-top:6px}
      .diag{white-space:pre-wrap;word-break:break-all;background:#181825;border:1px solid #45475a;border-radius:6px;padding:8px;margin:6px 0 0;
        max-height:170px;overflow:auto;font:12px ui-monospace,Consolas,monospace}`));
    const num = (key, step) => h('input', { type: 'number', step, value: s[key], 'data-k': key });
    const chk = (key) => { const c = h('input', { type: 'checkbox', 'data-k': key }); c.checked = !!s[key]; return c; };
    const modeSel = h('select', { 'data-k': 'mode' }, ...['auto', 'fetch', 'iframe'].map((m) => { const o = h('option', { value: m }, m); o.selected = s.mode === m; return o; }));
    const choice = (k, v, pairs, current) => h('select', k ? { 'data-k': k } : {}, ...pairs.map(([val, text]) => { const o = h('option', { value: val }, text); o.selected = current === val; return o; }));
    const loadSel = choice('loadPages', null, [['auto', 'as I scroll'], ['click', 'when I click']], s.loadPages);
    const hostLoadSel = choice(null, null, [['', 'as set above'], ['auto', 'as I scroll'], ['click', 'when I click']], s.hostLoadPages[location.hostname] || '');
    const runOnSel = h('select', { 'data-k': 'runOn' }, ...[['all', 'every site'], ['listed', 'only sites I list']].map(([v, t]) => { const o = h('option', { value: v }, t); o.selected = s.runOn === v; return o; }));
    const allow = h('textarea', { spellcheck: 'false', style: 'min-height:50px', 'aria-label': 'Sites to run on' }); allow.value = s.allowHosts.join('\n');
    const offHosts = h('textarea', { spellcheck: 'false', style: 'min-height:50px', 'aria-label': 'Turned off on these sites' }); offHosts.value = s.disabledHosts.join('\n');
    const skip = h('input', { type: 'text', spellcheck: 'false', value: s.skipPaths, 'data-k': 'skipPaths', 'aria-label': 'Stay off pages whose path matches', style: 'width:100%;margin-top:6px;font-family:ui-monospace,Consolas,monospace;font-size:12px' });
    const rules = h('textarea', { spellcheck: 'false', 'aria-label': 'Site rules (JSON)' }); rules.value = JSON.stringify(s.rules, null, 2);
    const excl = h('textarea', { spellcheck: 'false', 'aria-label': 'Never run on these hosts' }); excl.value = s.exclude.join('\n');
    const srcs = h('textarea', { spellcheck: 'false', style: 'min-height:50px', 'aria-label': 'Rule list URLs' }); srcs.value = s.sources.join('\n');
    const err = h('div', { class: 'err', role: 'alert' });
    const diagText = diagnostics(app);
    // Focusable, so a keyboard can scroll it.
    const diag = h('pre', { class: 'diag', tabindex: '0', 'aria-label': 'Diagnostics' }, diagText);
    // Focus goes into the dialog and, when it closes, back where it was.
    // Focus inside a shadow root (a page bar's button, a web component) shows
    // here as its host, which can't take it back; follow it down.
    let opener = document.activeElement;
    while (opener && opener.shadowRoot && opener.shadowRoot.activeElement) opener = opener.shadowRoot.activeElement;
    // A modal dialog: the page behind it can't be reached by Tab while it's open.
    const wasInert = document.body.inert;
    document.body.inert = true;
    const close = () => {
      closeSettings = null;
      if (obs) obs.disconnect();
      if (host.isConnected) host.remove();
      document.body.inert = wasInert;
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
    closeSettings = close;
    const obs = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => { if (!host.isConnected) close(); }) : null;
    if (obs) obs.observe(host.parentNode || document.documentElement, { childList: true });
    const save = () => {
      let parsed;
      try { parsed = JSON.parse(rules.value || '[]'); } catch (e) { err.textContent = 'Site rules are not valid JSON: ' + e.message; return; }
      const normalized = normalizeRules(parsed);
      if (normalized.length !== (Array.isArray(parsed) ? parsed.length : 0)) { err.textContent = 'Every rule needs a valid "url" regex (and "excludeUrl", when set).'; return; }
      try { new RegExp(skip.value); } catch (e) { err.textContent = 'The pages to stay off need a valid regular expression: ' + e.message; return; }
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
      store.set('disabledHosts', offHosts.value.split(/\s+/).filter(Boolean));
      store.set('allowHosts', allow.value.split(/\s+/).filter(Boolean));
      const hostLoad = Object.assign({}, s.hostLoadPages);
      if (hostLoadSel.value) hostLoad[location.hostname] = hostLoadSel.value;
      else delete hostLoad[location.hostname];
      store.set('hostLoadPages', hostLoad);
      const sources = srcs.value.split(/\s+/).filter(Boolean);
      // A changed list of lists is fetched on the next page load.
      if (sources.join('\n') !== s.sources.join('\n')) {
        store.set('sourcesUpdated', 0);
        store.set('sourcesTried', 0);
      }
      store.set('sources', sources);
      close();
      const fresh = loadSettings();
      const p = app.pager;
      const needRestart = !p || fresh.mode !== s.mode || fresh.runOn !== s.runOn || fresh.skipPaths !== s.skipPaths
        || JSON.stringify(fresh.rules) !== JSON.stringify(s.rules) || JSON.stringify(fresh.exclude) !== JSON.stringify(s.exclude)
        || JSON.stringify(fresh.disabledHosts) !== JSON.stringify(s.disabledHosts) || JSON.stringify(fresh.allowHosts) !== JSON.stringify(s.allowHosts);
      if (needRestart) { app.restart(); toast('Settings saved and applied.', 'ok'); }
      else { if (p) p.s = fresh; toast('Settings saved and applied.', 'ok'); }
    };
    const panel = h('div', { class: 'p', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Onward settings' },
      h('h2', {}, 'Onward ' + VERSION),
      h('div', { class: 'sub' }, location.hostname + ': ' + (app.pager && !app.pager.stopped ? `active, page ${app.pager.page}` : app.status)),
      h('label', {}, 'Start loading when this many screens remain', num('threshold', '0.1')),
      h('label', {}, 'Maximum pages per visit', num('maxPages', '1')),
      h('label', {}, 'Wait between page requests (ms)', num('spacing', '100')),
      h('label', {}, 'Show a bar between pages', chk('separators')),
      h('label', {}, 'Update the address bar while scrolling', chk('updateUrl')),
      h('label', {}, 'Open links on added pages in a new tab', chk('newTabLinks')),
      h('label', {}, 'Loading mode', modeSel),
      h('label', {}, 'Load pages', loadSel),
      h('label', {}, 'Load pages on ' + location.hostname, hostLoadSel),
      h('label', {}, 'Run on', runOnSel),
      h('div', { class: 'blk' }, 'Sites to run on, one per line (with “only sites I list”)', allow),
      h('div', { class: 'blk' }, 'Turned off on these sites, one per line (the toggle command adds them)', offHosts,
        h('div', { class: 'hint' }, 'Exact host names: example.com here leaves www.example.com on.')),
      h('div', { class: 'blk' }, 'Stay off pages whose path matches', skip,
        h('div', { class: 'hint' }, 'A regular expression. Leave it empty to run on every page.')),
      h('div', { class: 'blk' }, 'Site rules (JSON)', rules,
        h('div', { class: 'hint' }, '[{"url": "^https://example\\\\.com/list", "next": "a.next", "content": "#results > .item"}]. CSS or XPath. Optional: "insert", "mode", "click".')),
      h('div', { class: 'blk' }, 'Never run on these hosts', excl),
      app.commands ? h('div', { class: 'blk' }, 'Commands',
        h('div', { class: 'row', style: 'justify-content:flex-start' },
          ...app.commands.filter(([name]) => name !== 'Settings').map(([name, run]) => h('button', { onclick: () => { close(); run(); } }, name)))) : null,
      h('div', { class: 'blk' }, 'Diagnostics', diag,
        h('div', { class: 'hint' }, 'What Onward found on this page, for a bug report. It includes this page’s address and the next one, which can hold private details (a search, a session), so read it over before you paste it anywhere. Nothing is sent.'),
        h('div', { class: 'row', style: 'justify-content:flex-start' }, h('button', {
          onclick: async () => {
            const ok = await copyText(diagText);
            toast(ok ? 'Diagnostics copied.' : 'Couldn’t copy. Select the text and copy it yourself.', ok ? 'ok' : 'err');
          },
        }, 'Copy diagnostics'))),
      h('div', { class: 'blk' }, 'Rule list URLs (optional)', srcs,
        h('div', { class: 'hint' }, `Onward or AutoPagerize/wedata JSON. ${Object.values(store.get('sourceCache') || {}).reduce((n, e) => n + listCount(e), 0) || (store.get('sourceRules') || []).length} cached rules.`),
        h('div', { class: 'row', style: 'justify-content:flex-start' }, h('button', { onclick: () => updateSources(srcs.value.split(/\s+/).filter(Boolean), true) }, 'Update rule lists now'))),
      err,
      h('div', { class: 'row' },
        h('button', { onclick: () => {
          const data = {};
          for (const key of Object.keys(DEFAULTS)) if (!HEAVY_KEYS.has(key)) data[key] = store.get(key);
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: 'onward-settings.json' }); a.click(); URL.revokeObjectURL(a.href);
        } }, 'Export'),
        h('button', { onclick: () => {
          const inp = h('input', { type: 'file', accept: '.json' });
          inp.addEventListener('change', () => {
            const f = inp.files && inp.files[0]; if (!f) return;
            const r = new FileReader();
            r.onload = () => {
              let d; try { d = JSON.parse(r.result); } catch (e) { err.textContent = 'Not valid JSON.'; return; }
              if (!d || typeof d !== 'object') { err.textContent = 'Not a settings object.'; return; }
              for (const key of Object.keys(DEFAULTS)) if (!HEAVY_KEYS.has(key) && key in d) store.set(key, d[key]);
              toast('Settings imported. Reload the page to apply them.', 'ok');
              close();
            };
            r.readAsText(f);
          });
          inp.click();
        } }, 'Import'),
        h('button', { onclick: close }, 'Cancel'), h('button', { class: 'pri', onclick: save }, 'Save')));
    const bg = h('div', { class: 'bg', onclick: (e) => { if (e.target === bg) close(); } }, panel);
    sr.appendChild(bg);
    document.documentElement.appendChild(host);
    const first = panel.querySelector('input, select, textarea, button');
    if (first) first.focus();
  }

  // ---------------------------------------------------------------------------
  // Rule lists: stored packed, and indexed by host
  // ---------------------------------------------------------------------------

  /** JSON, gzipped and in base64 where the browser allows it; 'j:' and plain JSON where it doesn't. */
  async function packJSON(value) {
    const json = JSON.stringify(value);
    try {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    } catch (e) {
      return 'j:' + json;
    }
  }

  async function unpackJSON(packed) {
    if (packed.startsWith('j:')) return JSON.parse(packed.slice(2));
    const bin = atob(packed);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  /** Skips a [...] class or (...) group starting at i; returns the index of its closing bracket. */
  function skipGroup(src, i) {
    const open = src[i];
    const close = open === '[' ? ']' : ')';
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (c === '\\') { j++; continue; }
      if (open === '(' && c === '[') { j = skipGroup(src, j); continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return j;
    }
    return src.length;
  }
  const QUANT_RE = /^(\?|\*|\+|\{\d*,?\d*\})\??/;
  // A quantifier that lets what it follows be left out.
  const OPTIONAL_RE = /^(\?|\*|\{0[,}])/;

  // The rest of a pattern after a host ends that host for sure: a "/", ":" or
  // "$" (or a group starting the path) that can't be left out, maybe after ones
  // that can (the "/*" in "example.com/*/list"). "example.com/*" alone doesn't.
  function pinsHostEnd(rest) {
    for (let i = 0; i < rest.length;) {
      const c = rest[i];
      if (c === '$') return true;
      let end;
      if (c === '/' || c === ':') end = i + 1;
      else if (c === '(' && /^(\?:)?(\/|\$)/.test(rest.slice(i + 1))) end = skipGroup(rest, i) + 1;
      else return false;
      const q = QUANT_RE.exec(rest.slice(end));
      if (!q || !OPTIONAL_RE.test(q[0])) return true;
      i = end + q[0].length;
    }
    return false;
  }

  /**
   * The hosts a rule's pattern can only mean, with small groups expanded; null
   * when its host part isn't plain, or doesn't end where the host does (a
   * pattern that stops at "zcool\.com" matches www.zcool.com.cn too).
   */
  function literalHosts(pattern) {
    let s = pattern.replace(/\\\//g, '/').replace(/^\^/, '');
    // Alternatives at the top (^https://a\.com/|^https://b\.com/) can match either host.
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === '(' || s[i] === '[') { i = skipGroup(s, i); continue; }
      if (s[i] === '|') return null;
    }
    const m = /^https?(\?|\[s\]\?)?:\/\//i.exec(s);
    if (!m) return null;
    s = s.slice(m[0].length);
    let hosts = [''];
    let pinned = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '/' || c === ':' || c === '$') { pinned = pinsHostEnd(s.slice(i)); break; }
      if (/[a-z0-9-]/i.test(c)) { hosts = hosts.map((h) => h + c.toLowerCase()); continue; }
      if (c === '.' || (c === '\\' && s[i + 1] === '.')) {
        if (c === '\\') i++;
        hosts = hosts.map((h) => h + '.');
        continue;
      }
      if (c === '(') {
        const end = skipGroup(s, i);
        const body = s.slice(i + 1, end).replace(/^\?:/, '');
        const alts = body.split('|');
        // (?:/|$) starts the path; a group that may also go on with the host ((/|\.cn/)) can't be indexed.
        const toPath = alts.filter((a) => /^(\/|\$)/.test(a)).length;
        if (toPath) {
          if (toPath < alts.length) return null;
          pinned = pinsHostEnd(s.slice(i));
          break;
        }
        if (alts.some((a) => !/^([a-z0-9-]|\\\.|\.)*$/i.test(a))) return null;
        const opts = alts.map((a) => a.replace(/\\\./g, '.').toLowerCase());
        let j = end + 1;
        if (s[j] === '?') { opts.push(''); j++; }
        else if (QUANT_RE.test(s.slice(j))) return null;
        hosts = [].concat(...hosts.map((h) => opts.map((o) => h + o)));
        if (hosts.length > 16) return null;
        i = j - 1;
        continue;
      }
      return null;
    }
    if (!pinned) return null;
    hosts = hosts.filter((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h));
    return hosts.length ? hosts : null;
  }

  /** The longest run of plain characters every match must contain, or '' when there's no such run of 4 or more. */
  function requiredLiteral(src) {
    let best = '';
    let run = '';
    const flush = () => { if (run.length > best.length) best = run; run = ''; };
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '|') return ''; // alternatives: no one run is required
      if (c === '\\') {
        const n = src[++i];
        if (n && !/[a-zA-Z0-9]/.test(n) && !QUANT_RE.test(src.slice(i + 1))) { run += n; continue; } // an escaped symbol is itself
        flush(); // \d, \w, \b, a code like \x2D, or an optional one
        // A code's digits (\x2D, \u002F, \u{2F}, \cJ) or name (\p{L}, \k<n>) belong to it, not to the text.
        if (n === 'x') i += 2;
        else if (n === 'c') i += 1;
        else if (n === 'u' && src[i + 1] !== '{') i += 4;
        else if (/[upPk]/.test(n)) { const end = src.indexOf(n === 'k' ? '>' : '}', i); if (end > 0) i = end; }
        continue;
      }
      if (c === '[' || c === '(') {
        flush();
        i = skipGroup(src, i);
        const q = QUANT_RE.exec(src.slice(i + 1));
        if (q) i += q[0].length;
        continue;
      }
      if (c === '?' || c === '*' || c === '{') { // the character before may be missing
        run = run.slice(0, -1);
        flush();
        const q = QUANT_RE.exec(src.slice(i));
        if (q) i += q[0].length - 1;
        continue;
      }
      if (c === '.' || c === '^' || c === '$' || c === '+' || QUANT_RE.test(src.slice(i + 1))) { flush(); continue; }
      run += c;
    }
    flush();
    return best.length >= 4 ? best : '';
  }

  // What a list rule needs to work; names cost a quarter of the space and aren't used.
  const slimRule = (r) => {
    const o = { url: r.url };
    for (const k of ['next', 'content', 'insert', 'mode', 'excludeUrl']) if (r[k]) o[k] = r[k];
    return o;
  };
  const listCount = (e) => (e ? (e.count != null ? e.count : (e.rules || []).length) : 0);

  // A big list's host rules go in up to this many buckets, about 400 rules each,
  // so a page on a site with a rule unpacks one; a small list keeps them in one.
  const BUCKETS = 8;
  const bucketOf = (host, count) => {
    let h = 0;
    for (let i = 0; i < host.length; i++) h = (Math.imul(h, 31) + host.charCodeAt(i)) >>> 0;
    return h % count;
  };

  /**
   * A rule list as stored (catch-alls, which are never used, left out). Plain
   * text a page can search without unpacking anything: a line per host
   * ("\nexample.com 3.0,5.1a": each of its rules as bucket.number, the number
   * in base 36), and the other, general rules' patterns with the text every
   * match of each needs. The rules themselves are packed apart: the host
   * rules in buckets, so a page on a site with a rule unpacks one bucket, and
   * the general ones on their own, so a page only they match (any .com
   * address, say) unpacks just them.
   */
  async function buildListEntry(rules, at) {
    const byHost = {};
    const kept = rules.filter((r) => !catchAll(r)).map((r) => [r, literalHosts(r.url)]);
    const count = Math.min(BUCKETS, Math.max(1, Math.round(kept.filter(([, hs]) => hs).length / 400)));
    const buckets = Array.from({ length: count }, () => []);
    const generic = [];
    const general = [];
    for (const [r, hs] of kept) {
      if (hs) {
        const b = bucketOf(hs[0], count);
        const ref = b + '.' + (buckets[b].push(slimRule(r)) - 1).toString(36);
        for (const h of hs) (byHost[h] = byHost[h] || []).push(ref);
      } else {
        // Its pattern is kept in plain text already.
        const { url, ...rest } = slimRule(r);
        generic.push([general.push(rest) - 1, requiredLiteral(url), url]);
      }
    }
    let hosts = '\n';
    for (const h of Object.keys(byHost)) hosts += h + ' ' + byHost[h].join(',') + '\n';
    return { at, count: rules.length, hosts, generic, buckets: await Promise.all(buckets.map(packJSON)), general: await packJSON(general) };
  }

  /** A list entry this version can read without the network: packed, in buckets or (the previous form) in one. */
  const listPacked = (e) => !!e && (Array.isArray(e.buckets) || typeof e.rules === 'string');

  const testUrl = (pattern, href) => {
    try { return new RegExp(pattern).test(href); } catch (e) { return false; }
  };

  const unpacked = new Map(); // a packed value -> its promise, once per page
  const unpackOnce = (p) => {
    if (!unpacked.has(p)) unpacked.set(p, unpackJSON(p));
    return unpacked.get(p);
  };

  /** The list rules that could apply at href, most specific first, each with its list's address as .source. */
  async function listRulesFor(cache, href) {
    let host;
    try { host = new URL(href).hostname; } catch (e) { return []; }
    const bucket = [];
    const general = [];
    for (const [source, entry] of Object.entries(cache || {})) {
      if (!entry) continue;
      if (Array.isArray(entry.rules)) { // kept unpacked by an earlier build
        for (const r of entry.rules) general.push(Object.assign({}, r, { source }));
        continue;
      }
      if (typeof entry.hosts !== 'string' || !listPacked(entry)) continue;
      const at = entry.hosts.indexOf('\n' + host + ' ');
      const mine = at < 0 ? [] : entry.hosts.slice(at + host.length + 2, entry.hosts.indexOf('\n', at + 1)).split(',');
      const maybe = (entry.generic || []).filter(([, lit, url]) => (!lit || href.includes(lit)) && testUrl(url, href));
      if (!mine.length && !maybe.length) continue;
      const blank = { name: '', insert: '', mode: '', click: false, excludeUrl: '' };
      for (const ref of mine) {
        // "3.1a" is rule 1a of bucket 3; an entry stored in one pack has just the number.
        const dot = ref.indexOf('.');
        const rules = await unpackOnce(dot < 0 ? entry.rules : entry.buckets[Number(ref.slice(0, dot))]);
        bucket.push(Object.assign({}, blank, rules[parseInt(ref.slice(dot + 1), 36)], { source }));
      }
      if (maybe.length) {
        // An entry from before the general rules were packed apart numbers them among all the rules.
        const rules = await unpackOnce(typeof entry.general === 'string' ? entry.general : entry.rules);
        for (const g of maybe) general.push(Object.assign({}, blank, rules[g[0]], { url: g[2], source }));
      }
    }
    const longestFirst = (a, b) => b.url.length - a.url.length;
    return bucket.sort(longestFirst).concat(general.sort(longestFirst));
  }

  /**
   * The list rules that could apply at href: the cached lists', and the rules
   * 0.1.0 kept flattened, but only while some list has no cached copy (after
   * that they'd all be tested twice).
   */
  async function candidateRules(cache, legacy, sources, href) {
    const lists = await listRulesFor(cache, href);
    const copied = sources.length > 0 && sources.every((u) => cache[u]);
    return legacy.length && !copied ? lists.concat(legacy) : lists;
  }

  let listStore = null; // the stored lists, read once per page
  const readLists = () => {
    if (!listStore) listStore = { cache: store.get('sourceCache') || {}, legacy: store.get('sourceRules') || [] };
    return listStore;
  };
  function loadListRules(href) {
    const { cache, legacy } = readLists();
    return candidateRules(cache, legacy, store.get('sources') || [], href);
  }
  function forgetListRules() {
    listStore = null;
    unpacked.clear();
  }

  /** Plain-text state for a bug report: what Onward found here, and what went wrong. */
  function diagnostics(app) {
    const p = app.pager;
    const lines = ['Onward ' + VERSION + ' on ' + location.href];
    lines.push('Status: ' + (p && !p.stopped ? 'active, page ' + p.page : app.status + (p && p.endReason ? ' (stopped: ' + p.endReason + ')' : '')));
    if (p && p.next) {
      // How the link was first found; later pages reuse its spot, so their own find says less.
      const f = p.firstNext || p.next;
      lines.push('Next link: ' + f.how + (f.score != null ? ', score ' + f.score : '') + '; next page ' + (p.next.url || 'loads by clicking a button'));
      lines.push('Content: ' + (p.container ? cssPath(p.container) : '?') + ', ' + p.startItems + ' items on the first page (' + p.contentHow + ')');
      lines.push('Mode: ' + p.mode + '; wrapped pages: ' + (p.wrap ? 'yes' : 'no') + '; scrolls: ' + (p.scroller ? cssPath(p.scroller) : 'the window'));
      lines.push('Last error: ' + (p.lastError || 'none'));
    }
    const choice = app.choice || {};
    const rule = choice.rule;
    let from = 'none; found by detection';
    if (rule && choice.mine) from = 'your site rule' + (rule.next ? '' : ', for the items only (its next link isn’t on this page)');
    else if (rule) from = 'rule list ' + (rule.source || 'saved by 0.1.0');
    lines.push('Rule: ' + from + (rule ? ' ' + JSON.stringify({ url: rule.url, next: rule.next, content: rule.content }) : ''));
    return lines.join('\n');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Some pages block the async clipboard; a selected textarea still copies.
      const ta = h('textarea', { style: 'position:fixed;top:0;left:0;opacity:0' });
      ta.value = text;
      // The page's copy handlers run at capture phase on document too; block them all.
      const block = (e) => { if (ta.contains(e.target)) e.stopImmediatePropagation(); };
      document.addEventListener('copy', block, true);
      // Not in the body: Settings, where this runs, makes the body inert.
      document.documentElement.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { /* nothing more to try */ }
      ta.remove();
      document.removeEventListener('copy', block, true);
      return ok;
    }
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
    const before = listCount(prev);
    if (before && rules.length < before / 2) return { entry: prev, error: `only ${rules.length} rules, down from ${before}` };
    return { entry: { rules, at: now } };
  }

  async function updateSources(urls, loud) {
    // One tab at a time. The lock names its tab, is renewed before each list so
    // a slow refresh keeps it (but never taken back from a tab that took over
    // after a long stall), expires in case its tab closes, and only ever gets
    // cleared by the tab that holds it.
    const id = Math.random().toString(36).slice(2);
    const lock = () => {
      const l = store.get('sourcesLock');
      return l && typeof l === 'object' ? l : { at: Number(l) || 0, id: '' };
    };
    const busy = () => {
      if (loud) toast('Another tab is updating the rule lists right now.', 'err');
      return null;
    };
    if (Date.now() - lock().at < 60000) return busy();
    const take = () => store.set('sourcesLock', { at: Date.now(), id });
    take();
    store.set('sourcesTried', Date.now());
    // Managers hand values between tabs a moment late; if two tabs took it at once, the later write wins.
    await new Promise((r) => setTimeout(r, 50));
    if (lock().id !== id) return busy();
    try {
      const cache = Object.assign({}, store.get('sourceCache'));
      const failures = [];
      for (const u of urls) {
        if (lock().id === id) take();
        let res;
        try { res = acceptRuleList(cache[u], await fetchText(u), Date.now()); } catch (e) { res = { entry: cache[u], error: e.message }; }
        if (res.error) {
          console.warn(TAG, 'rule list kept its last good copy', u, res.error);
          failures.push(`${safeHost(u)}: ${res.error}`);
        } else {
          cache[u] = await buildListEntry(res.entry.rules, res.entry.at);
          if (loud) toast(`${cache[u].count} rules from ${safeHost(u)}`, 'ok');
        }
        if (!cache[u]) delete cache[u];
      }
      // Lists no longer configured leave the cache.
      for (const k of Object.keys(cache)) if (!urls.includes(k)) delete cache[k];
      store.set('sourceCache', cache);
      // 0.1.0 kept every list's rules flattened. That copy goes once every list
      // has a packed one, and not before: a failed refresh must not lose them.
      if (urls.every((u) => listPacked(cache[u]))) store.set('sourceRules', []);
      // Track whether every list is in this version's form. A list whose refresh
      // failed or that was never cached resets this so the boot check retries.
      store.set('sourcesFormat', urls.every((u) => cache[u] && Array.isArray(cache[u].buckets)) ? LIST_FORMAT : 0);
      forgetListRules();
      if (failures.length) toast('Kept the last good copy of a rule list. ' + failures.join('; '), 'err');
      else store.set('sourcesUpdated', Date.now());
      return Object.values(cache).reduce((n, e) => n + listCount(e), 0);
    } finally {
      if (lock().id === id) store.set('sourcesLock', 0);
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
    const body = el.ownerDocument.body;
    for (let n = el; n && n.nodeType === 1 && n !== body; n = n.parentElement) {
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
  const XPATH_SPACES = '\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

  function uniqueSelector(el) {
    const doc = el.ownerDocument;
    const only = (sel) => { const m = queryAll(doc, sel); return m.length === 1 && m[0] === el; };
    const tag = el.tagName.toLowerCase();
    const candidates = [cssPath(el)];
    const tests = [];
    // JS \s folds no-break, thin, ideographic and other spaces into a space;
    // XPath's normalize-space() only knows ASCII ones, so translate the rest first.
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 60) tests.push("normalize-space(translate(., '" + XPATH_SPACES + "', '" + ' '.repeat(XPATH_SPACES.length) + "'))=" + xpathString(text));
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

  async function boot() {
    if (win.top !== win.self || win.__onward) return;
    if (!document.body || !/html/i.test(document.contentType || 'text/html')) return;
    win.__onward = true;
    await loadAsyncValues();

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
        if (hostListed(s.exclude, host)) { this.status = 'excluded host'; return; }
        // "Run Onward here anyway" gets past these two.
        if (!opts.force && s.runOn === 'listed' && !hostListed(s.allowHosts, host)) { this.status = 'not on your list of sites'; return; }
        if (!opts.force && pageSkipped(s.skipPaths, location.href)) { this.status = 'a checkout, sign-in or account page'; return; }
        const gen = this.gen;
        const retry = () => {
          // Many lists are rendered after load; look again a couple of times.
          if (attempt < 2) setTimeout(() => { if (this.gen === gen) this.tryStart(attempt + 1, opts); }, attempt === 0 ? 1500 : 4000);
        };
        // A rule is only used where it works on this page; otherwise the next
        // rule, then detection. A site rule still rendering gets the retries first.
        // This address's rule list candidates, unpacked once (a promise the first time).
        if (this.listHref !== location.href) {
          const href = location.href;
          loadListRules(href).catch((e) => { console.warn(TAG, 'rule lists unreadable', e); return []; }).then((rules) => {
            if (this.gen !== gen) return;
            this.listRules = rules;
            this.listHref = href;
            this.tryStart(attempt, opts);
          });
          return;
        }
        const choice = chooseRule(s.rules, this.listRules, location.href, document, attempt);
        this.choice = choice;
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
          onMenu: this.commands ? () => openSettings(this) : null,
        });
        if (pager.detect()) {
          // Right after a route change the old route's list can still be on
          // screen (the address changes first, the data lands later): wait.
          const from = opts.navFrom;
          if (from && attempt < 2 && pager.container === from.container && pager.firstKey === from.first) {
            pager.destroy();
            this.status = 'waiting for the new page to render';
            return retry();
          }
          this.pager = pager;
          this.status = 'active';
          pager.start();
          fireAutoPagerize('GM_AutoPagerizeLoaded');
          return;
        }
        this.status = 'no next page found';
        retry();
      },
    };

    // The pager, ready for a load you asked for; or null, having said why not.
    const pagerForLoad = () => {
      const p = app.pager;
      if (!p) { toast('Nothing to load: ' + app.status, 'err'); return null; }
      if (p.userStopped) {
        toast('Resuming. Paging was stopped by you.', 'ok');
        p.resume(false);
      } else if (p.paused) {
        toast('Trying again. Paging was paused after an error.', 'ok');
      } else if (p.stopped) {
        const why = {
          limit: 'Stopped at the page limit. You can raise it in Settings.',
          error: 'Stopped after repeated errors.',
          nogrowth: 'Stopped because added pages weren’t making the page any longer.',
          lost: 'Stopped because this site keeps redrawing its list.',
        };
        toast(why[p.endReason] || 'Last page reached.', 'err');
        return null;
      }
      return p;
    };
    const commands = [
      ['Toggle Onward on this site', () => {
        const host = location.hostname;
        const t = toggleLists(loadSettings(), host);
        store.set('allowHosts', t.allowHosts);
        store.set('disabledHosts', t.disabledHosts);
        if (t.on) {
          toast('Enabled on ' + host, 'ok');
          app.restart();
        } else {
          if (app.pager) app.pager.destroy();
          app.pager = null;
          app.status = t.disabledHosts.includes(host) ? 'disabled on this site' : 'not on your list of sites';
          toast('Disabled on ' + host);
        }
      }],
      ['Load next page now', () => { const p = pagerForLoad(); if (p) p.loadNext(); }],
      ['Load 5 more pages', () => { const p = pagerForLoad(); if (p) p.loadMany(5); }],
      ['Run Onward here anyway', () => {
        toast('Running on this page.', 'ok');
        app.restart({ force: true });
      }],
      ['Pick next link and content…', () => runPicker(app)],
      ['Settings', () => openSettings(app)],
    ];
    const registerMenu = typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand
      : (typeof GM === 'object' && GM && typeof GM.registerMenuCommand === 'function' ? GM.registerMenuCommand.bind(GM) : null);
    if (registerMenu) for (const [name, fn] of commands) registerMenu(name, fn);
    // No menu at all (Userscripts for Safari): page bars carry an "Onward…" button,
    // Settings lists the commands, and a small corner button opens it where there's
    // no bar yet (before page 2, or where Onward found nothing to page).
    else {
      app.commands = commands;
      const { host, sr } = shadowHost('div', 'position:fixed;left:8px;bottom:8px;z-index:2147483646;display:block;');
      host.setAttribute('data-onward-corner', '');
      sr.appendChild(h('style', {}, `.o{font:12px system-ui,sans-serif;color:#cdd6f4;background:rgba(30,30,46,.92);border:1px solid #7f849c;border-radius:8px;
        padding:4px 9px;cursor:pointer;opacity:.45;transition:opacity .12s}.o:hover,.o:focus{opacity:1}`));
      sr.appendChild(h('button', { class: 'o', title: 'Onward settings and commands', onclick: () => openSettings(app) }, 'Onward'));
      document.documentElement.appendChild(host);
    }

    // Refresh rule lists weekly, in the background.
    const s = loadSettings();
    // Weekly, and after a failed refresh no more often than every 6 hours. Right
    // away when the lists were stored by an earlier version (0.1.0), without
    // reading them: some managers hand a script its whole storage per read.
    if (s.sources.length && Date.now() - s.sourcesTried > 6 * 36e5
        && (Date.now() - s.sourcesUpdated > 7 * 864e5 || s.sourcesFormat !== LIST_FORMAT)) updateSources(s.sources, false);

    // The AutoPagerize API: other scripts can pause paging and start it again.
    const setPaging = (on) => {
      const p = app.pager;
      if (on) {
        if (p && p.userStopped) p.resume(false);
        else if (!p) app.restart();
      } else if (p && !p.stopped) {
        p.userStop();
      }
    };
    document.addEventListener('AutoPagerizeEnableRequest', () => setPaging(true));
    document.addEventListener('AutoPagerizeDisableRequest', () => setPaging(false));
    document.addEventListener('AutoPagerizeToggleRequest', () => setPaging(!(app.pager && !app.pager.stopped)));

    app.tryStart(0);

    // Single-page apps change the URL without a reload; start over when that happens.
    let lastUrl = location.href;
    const urlChanged = (delay) => {
      if (location.href === lastUrl) return;
      const prev = lastUrl;
      const ours = location.href === app.expectUrl
        || (app.pager && (location.href === app.pager.selfUrl || app.pager.separators.some((x) => x.url === location.href) || location.href === app.pager.startUrl));
      lastUrl = location.href;
      if (ours || app.picking) return;
      const p = app.pager;
      const navFrom = p && p.container ? { container: p.container, first: p.firstKey } : null;
      if (stripHash(location.href) !== stripHash(prev)) {
        setTimeout(() => app.restart({ navFrom }), delay);
        return;
      }
      // Only the hash changed. A jump to #comments stays on the same page. A
      // #/route starts over only when the list Onward pages went with it: an
      // overlay (#/quickview/7), or a router noting how far it has loaded
      // (#/list?page=3), leaves the list as it was. Apps draw the new route
      // after the address changes, some after fetching it, so look a few times.
      if (!routeHash(location.href) && !routeHash(prev)) return;
      const url = location.href;
      const look = (i) => setTimeout(() => {
        if (location.href !== url || app.picking) return;
        if (!app.pager || !app.pager.sameList()) {
          app.restart({ navFrom });
          return;
        }
        if (i < 2) look(i + 1);
      }, [delay, 1500, 4000][i]);
      look(0);
    };
    // The Navigation API says so as soon as a route changes; polling stays for
    // browsers without it (and as a backstop), giving the app longer to render.
    if (win.navigation && typeof win.navigation.addEventListener === 'function') {
      win.navigation.addEventListener('navigatesuccess', () => urlChanged(150));
    }
    setInterval(() => urlChanged(800), 1000);
  }

  return {
    VERSION, DEFAULTS, boot, hostListed, pathSkipped, pageSkipped, toggleLists, nextByAddress, nextUrlChecker, cssPath, uniqueSelector, findNext, findContent, describePath, resolvePath, extractItems, prepareItems,
    itemShape, fixLazyImages, absolutize, sniffCharset, decode, normalizeRules, matchRule, matchingRules, fittingRule, chooseRule, acceptRuleList, packJSON, unpackJSON, literalHosts, requiredLiteral, buildListEntry, listRulesFor, candidateRules, forgetListRules, itemKey, pageKeys, splitRepeats, signature, barTag, labelKey, formUrl,
  };
});
