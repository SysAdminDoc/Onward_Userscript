# Roadmap

- [ ] Prefetch the next page (HTML only) once the current one lands, so scrolling never waits.
  Note (research 2026-09-21): make it opt-in per site and skip it in manual mode. Preloading broke banking and tax sites for Super-preloader users (machsix/Super-preloader#428). Use `fetch`, not Speculation Rules, whose cache `fetch()` never reads.
- [ ] Keep `<canvas>` content when copying items (Pagetual copies pixels; Onward drops them).
- [ ] Table column check: fall back to appending the whole table when fetched rows have a different column count.
- [ ] Form-based pagers (a "Next" submit button inside a GET form) turned into URLs.
- [ ] Optional `content-visibility: auto` on added pages for long sessions.
  Note (research 2026-09-21): pair it with `contain-intrinsic-size: auto <measured height>`. Pagetual's fix for scroll jumps was telling users to turn contentVisibility off (hoothin/UserScripts#139). Infy Scroll users crashed a tab at about 167 pages (sixcious/infy-scroll#132). `content-visibility` is Baseline since 2025-09-15.
- [ ] Per-site pause that survives reloads.
  Note (research 2026-09-21): build on the resumable Stop item below. hoothin/UserScripts#730 and sixcious/infy-scroll#27 ask for the same thing.
- [ ] Firefox check in Violentmonkey (so far only tested in Chromium).
  Note (research 2026-09-21): include Firefox for Android. Current Violentmonkey is 2.49.0 (2026-09-06). weAutoPagerize hit a Firefox `DOMException` when dispatching its page events (wantora/weautopagerize#67), so check that `onward:page` fires. The Navigation API needs Firefox 147+.

## Research-Driven Additions

### P0

- [ ] P0: Sandbox the hidden-iframe fallback and keep it silent
  Why: a frame-busting page loaded by the fallback navigated the user's tab away (probe 2026-09-21), and Pagetual's iframe mode doubled live-stream audio.
  Evidence: RESEARCH.md "Reported Issues"; `loadViaIframe` at src/onward.user.js:679; hoothin/UserScripts#131; MDN iframe `sandbox`.
  Touches: src/onward.user.js (`loadViaIframe`), test/e2e/site.js, test/e2e/pager.e2e.js.
  Acceptance: the iframe has `sandbox="allow-scripts allow-same-origin"` (no `allow-top-navigation*`, no `allow-popups`) and `allow="autoplay 'none'"`; every `video`/`audio` in the frame is paused and muted once it is ready; a new e2e fixture whose script-rendered page contains `if (top !== self) top.location = ...` keeps the tab on its original URL while pages still append.
  Complexity: S

- [ ] P0: Stand down on sites that already load more by themselves
  Why: on meta.discourse.org Onward followed the crawler `rel=next` link and stacked 7 hidden-iframe page loads onto Discourse's own infinite scroll.
  Evidence: live smoke 2026-09-21 (3,362 px to 46,347 px); Discourse emits `<meta name="generator" content="Discourse ...">`; Pagetual disables itself there (hoothin/UserScripts#660); Flarum's fake `?page=N` URLs (hoothin/UserScripts#722).
  Touches: `tryStart`, `Pager.detect`, `Pager.onScroll` in src/onward.user.js; test/e2e/site.js.
  Acceptance: Onward stays inactive when the generator meta names Discourse or Flarum, and backs off (status "This site loads more by itself") when the content container gains children within 3 s of reaching the bottom without Onward inserting anything; a menu command forces it on for the page; an e2e fixture with its own scroll loader and a `rel=next` link ends with no Onward bars and no duplicate items.
  Complexity: M

- [ ] P0: Cancel pending work when a pager is destroyed
  Why: restarting during a load threw `TypeError ... reading 'insertBefore'` and left a stray "failed" bar on `document.body`; the same path runs on SPA restarts, site toggles and the wrap-mode switch.
  Evidence: probe 2026-09-21; `destroy` at src/onward.user.js:874, `loadNext` at :917, `appendPage` at :948.
  Touches: `Pager` (constructor, `loadNext`, `appendPage`, `clickMore`, `destroy`), `fetchBytes`, `loadViaIframe`.
  Acceptance: `destroy()` aborts the pending fetch or iframe through an `AbortController`, and every step after an `await` returns when the pager is destroyed; an e2e test that restarts the pager while a slow page (2 s server delay) is loading ends with no bars, no inserted items and no page errors.
  Complexity: S

- [ ] P0: Make the picker save a selector that matches only the clicked element
  Why: on Bootstrap-style pagers the saved rule loads the previous page, while automatic detection had picked the right link.
  Evidence: probe 2026-09-21 (`nav > ul.pagination > li.page-item > a.page-link` matched Previous, 1, 2, 3, 4 and Next); `cssPath` at :1222, `runPicker` at :1268, the rule branch of `findNext` at :217.
  Touches: `cssPath`, `runPicker`, test/e2e/pager.e2e.js, test/detect.test.js.
  Acceptance: the saved `next` selector matches exactly one element on the page (falling back to `:nth-child` steps or an XPath with a `normalize-space()` text test), and `findNext` with the saved rule returns the clicked link's URL before the rule is stored; e2e on a Bootstrap pager fixture started at page 2 loads page 3 after picking "Next".
  Complexity: M

### P1

- [ ] P1: Strip non-content markup from imported pages
  Why: imported `<meta http-equiv=refresh>` navigates the tab, `<base href>` rewrites `document.baseURI`, `<noscript>` children become live (double image downloads, handlers fire), and `iframe srcdoc` runs scripts, all under `script-src 'self'`.
  Evidence: RESEARCH.md "Security" (Chromium 153, Firefox 155, WebKit 26.6 test); HTML spec on scripting-disabled parsing; `prepareItems` at :558 removes only `<script>`.
  Touches: `prepareItems`, `fixLazyImages`, test/detect.test.js.
  Acceptance: after `prepareItems`, imported items contain no `meta`, `base`, `noscript`, `iframe[srcdoc]` or `javascript:` `src`/`href`/`action`/`formaction`; an image whose real URL exists only in a sibling `<noscript><img>` takes that URL first; one unit test per vector; an e2e page 2 carrying `<meta http-equiv=refresh>` does not navigate.
  Complexity: S

- [ ] P1: Keep the last good rule-list cache when an update fails
  Why: `updateSources` stores `[]` and bumps `sourcesUpdated` on failure, switching imported rules off for 7 days, and a mirror has already served an HTML error page as `items_all.json`.
  Evidence: src/onward.user.js:1198-1216; hoothin/UserScripts commits ff973e67 (2026-02-24) and 606ad5d6; wedata outages reported 2019 to 2025 (wantora/weautopagerize#16, AMO reviews).
  Touches: `updateSources`, `boot` (weekly refresh), the settings panel hint.
  Acceptance: cache is kept per source; a response that is not JSON, yields 0 rules, or yields under half the previous count keeps the old copy and shows an error toast; `sourcesUpdated` moves only on success; a lock value in GM storage stops more than one tab refreshing at once; unit test feeding a 122-byte HTML body keeps the old rules.
  Complexity: S

- [ ] P1: Never let rules from rule lists click
  Why: `normalizeRules` keeps `click: true` from remote lists and `clickMore` clicks whatever the selector matches, so a compromised list can press any button on a matching site.
  Evidence: `normalizeRules` at :624, `clickMore` at :1020; Pagetual rule fields execute code (pagetual.hoothin.com/rule.html) as the supply-chain precedent.
  Touches: `normalizeRules`, `updateSources`, `findNext` rule branch.
  Acceptance: rules loaded from `sources` are stored with `click: false` whatever the list says; only rules written in Settings or saved by the picker can click; unit test.
  Complexity: S

- [ ] P1: Use a rule only when its selectors fit the page
  Why: a host-wide picker rule or a wedata rule switches auto-detection off on every page of the site where its selectors match nothing, and wedata's `excludeUrl` is ignored.
  Evidence: `tryStart` at :1323, `findNext` at :217-223; Pagetual and AutoPagerize only apply rules whose selectors exist; 2 wedata rules carry `excludeUrl` (scan 2026-09-21).
  Touches: `matchRule`, `tryStart`, `Pager.detect`, `normalizeRules`.
  Acceptance: a matching rule is used only when its `next` (and `content`, when set) resolve on the live page; otherwise the next matching rule is tried, then auto-detection; a rule whose `excludeUrl` matches is skipped; unit tests for each path.
  Complexity: S

- [ ] P1: Keep the address bar correct when page bars are hidden
  Why: with "Show a bar between pages" off, the address bar still read `?page=4` after scrolling back to the top.
  Evidence: probe 2026-09-21; `setBar` at :1083 uses `display:none`, `syncUrl` at :905 reads the zero rects.
  Touches: `addBar`, `setBar`, `syncUrl`.
  Acceptance: hidden bars keep a zero-height marker that still has a position; e2e with bars off: at the top the URL is the start URL and mid-page it is the page in view.
  Complexity: S

- [ ] P1: Make Stop resumable and report the real state
  Why: after Stop nothing can restart loading except a reload, and "Load next page now" answers "No more pages."
  Evidence: :1081 and :1344-1346; users can't get auto-pagers out of the way or back (hoothin/UserScripts#314, sixcious/infy-scroll#27).
  Touches: `Pager.stop`, `setBar`, `loadNext`, the menu commands in `boot`.
  Acceptance: Stop turns into Resume on the bar; "Load next page now" resumes a stopped pager; the toast tells apart "stopped by you", "last page reached" and "paused after an error"; e2e covers stop, resume, and the end of pages.
  Complexity: S

- [ ] P1: Time out same-origin page fetches
  Why: `fetch` has no timeout, so a hung request leaves "Loading page N" up forever while the `GM_xmlhttpRequest` path gives up after 20 s.
  Evidence: `fetchBytes` at :652.
  Touches: `fetchBytes` (shares the `AbortController` from the P0 cancel item).
  Acceptance: a request with no response after 20 s aborts and shows "failed (timed out). Paused." with Retry; e2e against a route that never answers.
  Complexity: S

- [ ] P1: Load pages only from the page's own origin
  Why: a next link on another port or scheme is fetched through `GM_xmlhttpRequest` with cookies and inserted where the page's scripts can read it.
  Evidence: `acceptUrl` at :206-213, `fetchBytes` at :649-668; Violentmonkey sends cookies by default (violentmonkey.github.io/api/gm); CVE-2005-2455.
  Touches: `acceptUrl`, `findNextIn`, `fetchBytes`.
  Acceptance: next URLs are accepted only when their origin equals the page's, apart from the existing http to https upgrade of the same host; `GM_xmlhttpRequest` is used only for rule lists, with `anonymous: true`; unit tests reject `:8443` and `http:` variants.
  Complexity: S

- [ ] P1: Stop when a redirect lands on a page already shown
  Why: sites redirect `/page/99` to the first page or the home page, and only the content hash stands between that and a duplicate page.
  Evidence: `appendPage` at :966-967 adds `finalUrl` to `seen` without checking it; machsix/Super-preloader#58.
  Touches: `appendPage`.
  Acceptance: when the final URL after redirects is the start URL or an already-loaded URL, the pager ends with "No more pages." before inserting anything; e2e route that redirects page 3 to page 1.
  Complexity: S

- [ ] P1: Detect repeated pages per item instead of by a truncated hash
  Why: only the first 5,000 characters are hashed, so pages that open with the same long post stop early, and single repeated products slip through.
  Evidence: `contentHash` at :599; loop and duplicate reports in 8 sources (sixcious/infy-scroll#76 and #81, hoothin/UserScripts#297 and #722, machsix/Super-preloader#58).
  Touches: `contentHash`, `appendPage`, `detect`.
  Acceptance: each item gets its own hash; a page where at least 90% of items were already seen ends paging; items already seen are dropped one by one; unit test where every page repeats a 6,000-character first post keeps paging.
  Complexity: S

### P2

- [ ] P2: Index cached rules by host and read them once per page
  Why: for anyone who adds a rule list, Violentmonkey ships the whole value store with every injection, so the 932 KB wedata cache is paid on every page load in every tab, plus about 2.5 ms of regex matching; `loadSettings()` reads it up to three times per page.
  Evidence: bench 2026-09-21 (932,445 bytes stored, 233,591 gzipped, 3,376 of 3,824 rules start with a literal host); Violentmonkey `preinject-prepare.js`; Tampermonkey#1787; tophf/autopagerize's per-URL cache and literal-string checks.
  Touches: `updateSources`, `loadSettings`, `matchRule`, `tryStart`.
  Acceptance: the stored rule-list value for wedata is under 350 KB (gzip through `CompressionStream`, base64); a page on a host with no rule compiles only the rules without a literal host; `sourceRules` is read at most once per page load; the bench script reports under 0.5 ms for an unmatched URL.
  Complexity: M

- [ ] P2: Support the AutoPagerize integration API
  Why: 4 sources ask for hooks so other scripts can process new pages; weAutoPagerize, uAutoPagerize and AutoPagerize speak this API and Pagetual does not.
  Evidence: weAutoPagerize README compatibility table; tophf/autopagerize `GM_AutoPagerizeNextPageDoc`; hoothin/UserScripts#234; sixcious/infy-scroll#9.
  Touches: `Pager.detect`, `appendPage`, `addBar`, `boot`, README.md.
  Acceptance: `GM_AutoPagerizeLoaded` fires on activation and `GM_AutoPagerizeNextPageLoaded` after each insert; `AutoPagerizeToggleRequest`, `AutoPagerizeEnableRequest` and `AutoPagerizeDisableRequest` on `document` control the pager; inserted page roots carry `autopagerize_page_element`; README documents these and `onward:page`; e2e listener sees every event.
  Complexity: M

- [ ] P2: Replace the site's pager with the latest loaded page's pager
  Why: the pager left at the bottom still points at page 2 after pages 2 to 5 are shown, so clicking it goes backwards.
  Evidence: sixcious/infy-scroll#133 (open since 2026-06-25); Pagetual uses `replaceElement` in 354 of 680 rules.
  Touches: `appendPage`, `findNextIn`.
  Acceptance: after each append the original pager container (found from the next link) is replaced by the fetched page's pager, in fetch mode only; e2e after page 3 shows the current-page marker "3".
  Complexity: M

- [ ] P2: Add manual mode and a Skip-to-footer button
  Why: auto-loading hides the footer and is costly for keyboard and switch users; accessibility guidance asks for a way to turn it off and a load-more fallback.
  Evidence: Deque 2019 on `role=feed`; Roselli's infinite-scroll checklist; NN/g infinite-scrolling tips; hoothin/UserScripts#730 and #533; swdyh/autopagerize#19 (inputs at the page bottom unreachable).
  Touches: `DEFAULTS`, `Pager.onScroll`, `setBar`, `openSettings`.
  Acceptance: a global and per-host setting "Load pages: automatically / when I click"; in manual mode the bar shows a "Load page N" button and scrolling loads nothing; every page bar has "Skip to footer", which stops auto-loading for 30 s and scrolls past the list; e2e covers both.
  Complexity: M

- [ ] P2: Add a "Load 5 more pages" command
  Why: loading several or all pages at once is requested in 8 sources, from reading to printing a whole thread.
  Evidence: sixcious/infy-scroll#66; hoothin/UserScripts#145; XIU2/UserScript#198; tophf/autopagerize's 1, 2, 5 and 10 commands; weAutoPagerize reviews.
  Touches: menu commands in `boot`, `Pager.loadNext`.
  Acceptance: the menu command loads up to 5 pages back to back within the page cap and the per-host spacing, with the bar counting them; e2e from page 1 reaches page 4 of 4 without scrolling.
  Complexity: S

- [ ] P2: Announce loads and fix the settings dialog for assistive tech
  Why: screen readers hear nothing when pages load, fail or end, and the settings dialog has three unlabeled textareas and no focus handling.
  Evidence: WCAG 4.1.3 Status Messages; `toast` at :760; settings markup at :1177-1192.
  Touches: `toast`, `setBar`, `openSettings`.
  Acceptance: a visually hidden `role="status"` region in Onward's shadow root announces "Page 3 loaded, 20 items", errors and the end; the dialog has `aria-modal="true"`, moves focus to its first control on open and back on close, and every control has an accessible name; an axe-core check of the panel in e2e reports no serious or critical violations.
  Complexity: S

- [ ] P2: Detect SPA navigation with the Navigation API
  Why: 1 s polling notices route changes late, and SPA late activation is requested in 4 sources.
  Evidence: Navigation API Baseline since 2026-01-13 (Chrome 102, Firefox 147, Safari 26.2); Infy Scroll V8 switched to it; `navigatesuccess` fires after the URL updates (wxt-dev/wxt PR 2623); `boot` at :1358-1365; sixcious/infy-scroll#34, XIU2/UserScript#578.
  Touches: `boot`.
  Acceptance: when `window.navigation` exists, a `navigatesuccess` to a URL Onward did not set restarts the pager within 300 ms; polling stays as the fallback; e2e fixture that swaps its list with `pushState` restarts Onward. Needs live validation in Tampermonkey's USER_SCRIPT world.
  Complexity: S

- [ ] P2: Add an allowlist mode and keep off sensitive pages by default
  Why: preloading and appending broke banking and tax flows, users asked for opt-in, and rapid paging got IPs banned.
  Evidence: machsix/Super-preloader#428; hoothin/UserScripts#691; Pagetual's `enableWhiteList` setting.
  Touches: `DEFAULTS`, `tryStart`, `openSettings`.
  Acceptance: a setting "Run on: every site / only listed sites"; a default, editable path pattern (`/(checkout|cart|login|signin|signup|account|password)`) keeps Onward inactive; e2e fixture at `/checkout?page=1` with a next link stays inactive.
  Complexity: S

- [ ] P2: Space out requests to the same host
  Why: fast scrolling can fire page requests back to back, which is how auto-pagers get rate limited or banned.
  Evidence: hoothin/UserScripts#691; `loadNext` at :917 only delays chained loads (400 ms at :945).
  Touches: `loadNext`, `DEFAULTS`, `openSettings`.
  Acceptance: at least 1,000 ms (configurable) between page requests to one host, for scroll-driven and chained loads alike; e2e records request timestamps on the fixture server.
  Complexity: S

- [ ] P2: Repair more lazy-image patterns
  Why: blank images are the most common auto-pager complaint and `fixLazyImages` knows 9 attributes to Pagetual's 30.
  Evidence: Infy Scroll wiki "Missing Images or Blank Pages"; wantora/weautopagerize#36; `LAZY_ATTRS` at :524; Pagetual `lazyImgAction` attribute list.
  Touches: `fixLazyImages`, test/detect.test.js.
  Acceptance: the attribute list covers Pagetual's set (including `data-lazyload`, `data-orig-file`, `data-ks-lazyload`, `data-defer-src`, `lazysrc`, `_src`, `file`, `original`); a placeholder `srcset` is replaced by `data-srcset`; `data-bg` and `data-background-image` become `background-image`; one unit test per pattern.
  Complexity: S

- [ ] P2: Document the install blockers and the event hooks
  Why: on current browsers the script silently never runs until a toggle or permission is granted, and the one integration event is undocumented.
  Evidence: Chrome 138+ per-extension "Allow User Scripts" toggle (developer.chrome.com userScripts reference); Tampermonkey 5.5.0 injection permission (changelog); `onward:page` at :1037.
  Touches: README.md.
  Acceptance: README "Install" names both steps with where to find them; an "Integration" section lists every event Onward fires and listens for.
  Complexity: S

- [ ] P2: Run the e2e suite in an isolated world like real managers
  Why: tests inject into the page's main world, unlike Tampermonkey (USER_SCRIPT world) or Violentmonkey (content mode), so isolation bugs (event `detail` across worlds, Trusted Types, globals) can't show up.
  Evidence: test/e2e/pager.e2e.js `open()` uses `addScriptTag`; CDP `Page.createIsolatedWorld` (devtools-protocol Page.pdl); weAutoPagerize's Firefox event-dispatch failure (wantora/weautopagerize#67).
  Touches: test/e2e/pager.e2e.js.
  Acceptance: `open()` can inject through `Page.createIsolatedWorld` plus `Runtime.evaluate` with the context id; every e2e test passes in both modes; a main-world listener receives `onward:page`.
  Complexity: M

- [ ] P2: Upgrade jsdom to 30 and unit-test the picker's selector builder
  Why: jsdom 26 has no `CSS.escape`, so `cssPath` can't be unit tested, and 26.1.0 is four majors behind.
  Evidence: jsdom v30.0.0 release notes (adds `CSS.escape()`, Node `^22.22.2 || ^24.15.0 || >=26.0.0`); package.json pins `^26.1.0`.
  Touches: package.json, package-lock.json, src/onward.user.js (export `cssPath`), test/detect.test.js.
  Acceptance: `npm test` passes on jsdom 30.1.0; unit tests cover `cssPath` on a Bootstrap pager, duplicate classes and numeric ids.
  Complexity: S

- [ ] P2: Show diagnostics in Settings with a copy button
  Why: when Onward does nothing, users see only "no next page found", and "which rule fired" is requested in 3 sources.
  Evidence: status text at :1179 and :1331; machsix/Super-preloader#468, sixcious/infy-scroll#74 and #108; Pagetual's prefilled issue link floods its tracker (hoothin/UserScripts#1225 to #1228).
  Touches: `Pager.detect`, `openSettings`.
  Acceptance: Settings lists next-link method, score and URL, content container path and item count, mode, wrapped, scroller, matched rule and its source, and the last error; "Copy diagnostics" puts a plain-text block on the clipboard; nothing is filed automatically.
  Complexity: S

- [ ] P2: Give the live smoke script a site list with expected outcomes
  Why: forums (9% of site requests), search (7%) and shops (7%) are where regressions show, and the smoke script today only prints.
  Evidence: site-family breakdown of Pagetual's issues in RESEARCH.md; scripts/live-smoke.js; the Discourse and phpBB findings from 2026-09-21.
  Touches: scripts/live-smoke.js, a new scripts/smoke-sites.json.
  Acceptance: `npm run smoke` reads a list of URLs with expected results (active with at least N pages, or inactive), loads at most 3 pages per site, and exits non-zero on a mismatch; it covers HN, a GitHub search, Discourse (expected inactive), phpBB and XenForo, plus a manual checklist entry for Google and Bing, which challenge headless browsers.
  Complexity: S

- [ ] P2: Run on managers that only offer async GM.* (Userscripts for Safari)
  Why: mobile support is requested in 8 sources, iOS included, and Userscripts for Safari has only async `GM.*` and no menu commands, so Onward can neither save rules nor open Settings there.
  Evidence: github.com/quoid/userscripts API notes; hoothin/UserScripts#359 and #722; sixcious/infy-scroll#130.
  Touches: `store`, `loadSettings`, `boot` (entry point when `GM_registerMenuCommand` is missing).
  Acceptance: storage falls back to `GM.getValue`/`GM.setValue`, loaded once at boot; without menu commands a small Onward button in the page bar opens Settings and the picker; verified on Safari with Userscripts. Needs a device.
  Complexity: M

### P3

- [ ] P3: Require real numbering for unlabelled pagers
  Why: a cell holding "2" next to a cell linking "3" counts as a pager, which fits numeric data tables.
  Evidence: `findNumberedNext` at :325-331; Pagetual's neighbouring-number check.
  Touches: `findNumberedNext`, test/detect.test.js.
  Acceptance: outside a pager container at least two more sibling links with consecutive numbers are required; unit test on a stats table yields no next link while the existing numbered tests pass.
  Complexity: S

- [ ] P3: Stop dropping items whose class merely contains "page"
  Why: `isPagerChild` discards any child whose class matches `/pag(e|in|ing)/` with more than two links and short text.
  Evidence: `isPagerChild` at :497; `PAGINATION_RE` at :107.
  Touches: `isPagerChild`, test/detect.test.js.
  Acceptance: pager children must contain mostly numeric or next/previous links; unit test with `li.product-page-card` items keeps all of them.
  Complexity: S

- [ ] P3: Route the path shortcut through `acceptUrl` and prefer the last candidate on ties
  Why: the path branch skips the host check and https upgrade, and ties go to the first candidate while Vivaldi and Pagetual prefer the last (bottom) one.
  Evidence: `findNextIn` at :1008-1016; `consider` at :236; Vivaldi Fast Forward documentation.
  Touches: `findNextIn`, `findNext`.
  Acceptance: unit tests show the path branch rejecting another host and equal-score candidates resolving to the later one.
  Complexity: S

- [ ] P3: Wait for a busy load-more button before ending
  Why: a button still disabled or hidden 400 ms after its items render ends paging with "No more items."
  Evidence: `clickMore` at :1022. Needs live validation.
  Touches: `clickMore`.
  Acceptance: when the button is hidden or disabled, Onward waits up to 3 s for it to come back; an e2e fixture that re-enables its button 1 s after rendering runs to the last page.
  Complexity: S

- [ ] P3: Insert large pages in chunks and defer offscreen images
  Why: a 200-item page is imported in one task, and imported images load eagerly.
  Evidence: web.dev browser-level lazy loading; MDN `decoding`; `scheduler.yield` in Chrome 129 and Firefox 142.
  Touches: `appendPage`, `prepareItems`.
  Acceptance: images without a `loading` attribute get `loading="lazy"` and `decoding="async"`; items are inserted in chunks with `scheduler.yield()` (or `setTimeout`) between them; an e2e long-task observer sees no task over 50 ms for a 200-item fixture page.
  Complexity: M

- [ ] P3: Narrow `@connect`
  Why: once page loads are same-origin, `GM_xmlhttpRequest` only needs the rule-list hosts, and Tampermonkey prompts for any other host.
  Evidence: Tampermonkey `@connect` documentation (initial and redirected host are checked); depends on "Load pages only from the page's own origin".
  Touches: userscript metadata block, README.md.
  Acceptance: metadata lists `@connect self`, `hoothin.github.io`, `cdn.jsdelivr.net` and `wedata.net` instead of `*`; a rule list on another host triggers the manager's prompt and still loads after approval.
  Complexity: S

- [ ] P3: Export and import all settings
  Why: backup and sync are requested in 3 sources; only rules can be copied today, through the textarea.
  Evidence: sixcious/infy-scroll#17; machsix/Super-preloader#100; hoothin/UserScripts#1187.
  Touches: `openSettings`.
  Acceptance: "Export" downloads a JSON file of every setting and rule (never the cached rule lists); "Import" validates it with the same checks as Save; round-trip unit test.
  Complexity: S

- [ ] P3: Option to open links on added pages in a new tab
  Why: requested in 4 sources; Infy Scroll made it the default in 8.1.
  Evidence: sixcious/infy-scroll#105; HN 40801083 and 40799969; machsix/Super-preloader#222.
  Touches: `prepareItems`, `DEFAULTS`, `openSettings`.
  Acceptance: when on, anchors inside appended items get `target="_blank"` and `rel="noopener"`; off by default; unit test.
  Complexity: S

- [ ] P3: Version the stored settings
  Why: rule and setting shapes are about to change (the rule source flag, manual mode, allowlist), and stored data has no version.
  Evidence: `DEFAULTS` at :39; `store` at :57.
  Touches: `loadSettings`, `store`.
  Acceptance: a `schema` value is written; loading 0.1.0 data migrates it; unit test with a 0.1.0 rules array.
  Complexity: S

- [ ] P3: Apply saved settings without a reload
  Why: Save ends with "Reload the page to apply them."
  Evidence: `openSettings` save handler at :1175.
  Touches: `openSettings`, `app.restart`.
  Acceptance: Save restarts the pager with the new settings and pages already loaded stay in place; e2e changes the page cap and sees it applied.
  Complexity: S

- [ ] P3: Localize the UI, starting with Simplified Chinese
  Why: Chinese-language sites and users dominate the Pagetual and XIU2 trackers, and Onward's UI strings are English only.
  Evidence: community research 2026-09-21; Pagetual ships its name and description in 30 locales.
  Touches: every user-facing string in src/onward.user.js.
  Acceptance: strings live in one table keyed by `navigator.language`, with `zh-CN` complete and English as the fallback; a test fails when a key is missing.
  Complexity: M
