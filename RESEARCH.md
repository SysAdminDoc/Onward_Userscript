# Research: Onward
Date: 2026-09-21. Replaces all prior research.

Confidence labels: **Verified** (reproduced here, read in code, or fetched from the primary source), **Likely** (secondary source or search snippet), **Needs live validation**.

## Executive Summary

Onward 0.1.0 is a single-file, MIT-licensed auto-pager userscript, about 1,370 lines, released 2026-09-21. It finds next pages without a rule database, appends them, and handles script-rendered lists (hidden iframe), load-more buttons, framework redraws (wrapped mode) and inner scrollers, with 24 jsdom unit tests and 8 headless end-to-end tests. Its best feature is one no competitor has: rule-free detection in a file small enough to audit, with safety stops (page cap, pause on error, no-growth stop, repeat-page stop). Its weak spot is everything that touches other people's markup and the user's tab. Probes run on 2026-09-21 reproduced five defects, including a page navigating the user's tab away and Onward stacking hidden-iframe loads on top of Discourse's own infinite scroll.

The direction with the most value is trust first (sandbox, sanitize, cancel, stand down), then the three things users of every competitor keep asking for: fewer loops and duplicates, a way to control loading (manual mode, load N more, stop and resume), and hooks so other scripts can process new pages.

Top opportunities, in priority order:

1. **Sandbox the hidden iframe** (Verified defect). A frame-busting page loaded by the iframe fallback navigated the tab to `?page=2&busted=1`. `loadViaIframe` (`src/onward.user.js:679`) sets no `sandbox` and no autoplay policy. Pagetual's iframe mode doubled live-stream audio (hoothin/UserScripts#131).
2. **Neutralize non-content markup before import.** Tests across Chromium 153, Firefox 155 and WebKit 26.6 showed imported `<meta http-equiv=refresh>` navigates the tab, `<base href>` rewrites `document.baseURI`, and `<noscript>` children become live elements, all under `script-src 'self'`. `prepareItems` (`:558`) removes only `<script>`.
3. **Stand down where the site already infinite-scrolls** (Verified on meta.discourse.org). Discourse ships `<link rel="next">` for crawlers; Onward followed it, found no items in the raw HTML, and appended 7 pages through hidden iframes (3,362 px to 46,347 px). Pagetual disables itself on Discourse (hoothin/UserScripts#660).
4. **Cancel in-flight work when a pager is destroyed** (Verified defect). A restart during a load threw `TypeError: Cannot read properties of null (reading 'insertBefore')` and left a stray "failed" bar.
5. **Make the picker save a selector that matches only the clicked element** (Verified defect). On Bootstrap-style pagers it saved `nav > ul.pagination > li.page-item > a.page-link`, which matches all six links, so the saved rule loads the **previous** page.
6. **Keep the rule-list cache when an update fails.** `updateSources` (`:1198`) writes `[]` over the last good copy, and the HTTPS mirror did publish a 122-byte HTML error page as `items_all.json` on 2026-02-24 (hoothin/UserScripts commit ff973e67). wedata itself answers only over plain HTTP and has had reported outages in 2019, 2022 and 2025.
7. **Cut the per-page cost of rule lists.** Violentmonkey ships a script's whole value store with every injection. The wedata list stores as 932 KB (233 KB gzipped) and matching all 3,824 regexes costs about 2.5 ms per page; 3,376 rules start with a literal host.
8. **Fix loop and duplicate handling**: per-item repeat detection instead of a hash truncated at 5,000 characters, and a stop when a redirect lands on an already-loaded URL (Super-preloader#58). Loops and duplicates are reported in 8 competitor threads.
9. **Give users control**: resumable Stop, manual mode, "Load N more pages", and a Skip-to-footer button (Deque, Roselli, NN/g; Infy#66; Pagetual#730; 8 sources ask for load-N/load-all).
10. **Speak the AutoPagerize integration API** (`GM_AutoPagerizeNextPageLoaded`, `autopagerize_page_element` and friends). Four sources ask for hooks; weAutoPagerize and uAutoPagerize implement them, Pagetual does not.

## Product Map

- **Core workflows**
  - Rule-free paging: `findNext` (link rel, label scoring, numbered pagers, URL increment) → `findContent` (largest repeating child group) → fetch, parse, fix URLs and lazy images → insert before an anchor comment.
  - Fallbacks: hidden-iframe load when fetched HTML has no items, load-more clicking, wrapped mode after a framework redraw, inner scroll containers.
  - Teaching a site: two-click element picker, hand-written CSS/XPath rules, or imported AutoPagerize/wedata lists.
  - Safety: 40-page cap, pause on error, stop on no growth, stop on a repeated content hash.
- **Personas**: readers of paginated sites who install userscripts. The 337 Pagetual issue titles that name a site (264 distinct domains) break down as manga and web novels 11%, forums 9%, video 8%, image boards 7%, search 7%, shops 7%, docs 6%, long tail 42%. Power users who write or import rules are a minority; "custom rules impossible to figure out" (Super-preloader#468) is a recurring theme.
- **Platforms and distribution**: Tampermonkey and Violentmonkey on Chromium and Firefox, tested only in headless Chromium with page-world injection. Installed from the raw GitHub URL with `@updateURL`. Not on Greasy Fork, where the two largest competitors (XIU2 AutoPager 579,923 installs, Pagetual 463,679) get their reach.
- **Data flows**: same-origin `fetch` with cookies; `GM_xmlhttpRequest` for other origins and rule lists (`@connect *`); settings, rules and cached lists in GM storage; `history.replaceState` URL sync; 1 s `location.href` polling for SPA navigation; an `onward:page` CustomEvent on `window`.

## Competitive Landscape

- **XIU2 AutoPager** (自动无缝翻页, Greasy Fork 419215, 579,923 installs, 187 KB; github.com/XIU2/UserScript). The largest userscript in the space, built on per-site rules. Learn: the tracker shows what breaks (Bing, XIU2/UserScript#360 with 25 comments; SPA activation, #578 with 15). Avoid: #317, users could not turn off history and title rewriting; Onward already has an off switch and should keep it.
- **Pagetual** (hoothin, MPL-2.0, 463,679 installs, last script commit 2026-08-08). Strong: 680 own rules plus wedata, about 50 rule fields, `replaceElement` in 354 of 680 rules to swap the pager, a `postMessage` API. Learn: pager swap, lazy-image attribute list (about 30 attributes), whitelist mode. Avoid: rule fields that execute code (`init`, `pageAction`, `nextLinkByJs`; at least 7 `Function` call sites), a prefilled "request support" link that floods the tracker with duplicates (#1202 to #1206, #1225 to #1228), 13.6k lines. 83% of its 389 issues are site or rule requests, about 130 a year.
- **Infy Scroll** (V10, 2026-05-01; 40,000 Chrome users, 4.8 stars). Strong: four actions, six append modes, duplicate prevention, Navigation API for SPAs since V8, confidence-scored auto settings, `iframeSandbox` and `pageLimit` fields. Learn: keep the pager current (#133, open since 2026-06-25), load all without scrolling (#66), open appended links in new tabs (default since 8.1, #105). Avoid: configuration sprawl ("over complicated", "too many options and terms related to coding" in 2025-26 reviews), rewriting grid templates for dividers (#96). A tab crashed at about 167 pages (#132).
- **uAutoPagerize** (Chrome, 90,000 users, v0.4.18 on 2026-09-14). Largest extension installed base, still wedata-driven; recent reviews report sites it no longer handles. Firefox listing disabled.
- **weAutoPagerize** (Firefox, v2.1.0 on 2025-09-29). Learn: bundles a wedata snapshot and documents the AutoPagerize event and class API. Open: HTTPS-only mode blocks SITEINFO updates (#42), lazy images missing after page 2 (#36), `replaceState` (#22).
- **tophf/autopagerize** (MV3 rework, last push 2024-05-21). Learn: per-URL rule-match cache, simple regexes turned into string checks, generic rules off by default because they "break the page layout on less popular sites", load 1/2/5/10 more pages, a pre-insert `GM_AutoPagerizeNextPageDoc` event.
- **Super-preloader** (machsix, GPL-3.0 plus a no-commercial clause). Deleted from Greasy Fork in 2021 over minified code (#641). Learn: preloading broke banking and tax sites so users asked for opt-in (#428), and a WordPress `/page/N` fallback looped until the final URL was compared (#58).
- **AutoPagerize (original)**. Userscript last pushed 2012; the Chrome listing is gone; MutationEvent removal broke it in 2025 (swdyh/autopagerize#20), and Firefox 145 users reported it stops after page 2 (Likely). Open: back navigation (autopagerize_for_chrome#13).
- **nextpage** (Chrome, 8,000 users). Sends each page URL to its server to find rules. Avoid: a browsing-history leak Onward does not need.
- **Vivaldi Fast Forward** (built in). First `link[rel=next]`, then `a[rel=next]`, then the *last* anchor labelled exactly "Next" among the last 1,000 anchors; navigates instead of appending. Learn: prefer the last matching candidate.
- **wedata** (the shared SITEINFO database). `http://wedata.net/.../items_all.json` serves 3,824 rules frozen since 2024-08-30; port 443 refuses and the site pages return 502 (Verified 2026-09-21). HTTPS copies on `hoothin.github.io` and jsDelivr are byte-identical, but the mirror job syncs over plain HTTP and once committed an HTML error page. 3,813 of the `nextLink` values are XPath; 7 rules match every site.

**What users say** (issue trackers, HN, Reddit, AMO and Chrome Web Store reviews; counts are distinct sources):

- Sites break and rules rot: dominant everywhere (Pagetual 83% of issues).
- Loops, duplicates, phantom pages: 8 (Infy #76 #81, Pagetual #297 #722 #191, Super-preloader #58, XIU2/UserScript#211, weAutoPagerize #18).
- Appended content that doesn't work (lazy images blank, GIF previews dead, other scripts skip page 2): 10.
- Memory and speed over long sessions: 7 (Infy #132 crash at about 167 pages).
- Broken layouts and sensitive sites: 7 (Super-preloader #428 banking and tax).
- Hard to get out of the way (can't stop, blocks bottom-of-page inputs): 5.
- History and URL rewriting wanted by some (Pagetual #276, #925; weAutoPagerize #22) and unwanted by others (XIU2/UserScript#317; weAutoPagerize #14): 6. Onward's on-by-default plus a switch fits both.
- Too complex: 6.
- Requests: load N or load all (8), manual or opt-in mode (6), mobile including iOS, Orion and Kiwi (8), separator styling and dark mode (6, already covered by Onward's themed bar and its hide option), hooks for other scripts (4), open links in a new tab (4), SPA late activation (4), backup and export (3), picker or "which rule fired" (3), keyboard toggles (3, excluded by project rules).
- Against infinite scroll generally: NN/g (footer unreachable, can't find items again, costly for keyboard and screen-reader users), Baymard (over 90% of load-more sites broke Back), and an HN tally of 11 threads (footer 107 mentions, Back and lost position 79, scrollbar 78, memory 55, jump to page 48). Paging a finite list on request is a different thing from an engagement feed, and Onward's controls should make that obvious.

## Reported Issues

The repo tracker has 0 issues, 0 pull requests and no discussions (checked 2026-09-21), and there is no fork parent. Everything below comes from code review of `src/onward.user.js` 0.1.0, headless probes, and a live smoke run on 2026-09-21.

Verified defects:

- **Frame buster hijacks the tab** (`loadViaIframe`, `:679`). A same-origin, script-rendered page containing `if (top !== self) top.location = ...` navigated the tab when Onward loaded it in the iframe fallback.
- **Onward stacks on Discourse's own infinite scroll** (live, meta.discourse.org). Detection took `link[rel=next]` (`:227`), raw HTML had no items, so each page loaded through a hidden iframe running the full Ember app. The page reports itself with `<meta name="generator" content="Discourse ...">`.
- **Destroyed pager keeps writing** (`appendPage`, `:948`; `loadNext`, `:917`). `destroy()` (`:874`) removes nodes and listeners, but pending fetches resume, hit the detached anchor, throw, and add a retry bar to `document.body`.
- **Picker selector matches every pager link** (`cssPath`, `:1222`; `runPicker`, `:1268`). The rule branch of `findNext` (`:217`) returns the first acceptable match, which was "Previous".
- **Address bar wrong when bars are hidden** (`setBar`, `:1083`; `syncUrl`, `:905`). Hidden bars are `display:none`, their rects are all zeros, so every bar counts as scrolled past.

Seen once in the live smoke run, not diagnosed (the probe that followed hit a Cloudflare challenge): on phpbb.com `viewforum.php?f=46` Onward appended page 2, then stopped with "The site returned a page we already have." phpBB appends a `sid=` session parameter to links, so repeated URLs can look new. Needs live validation.

Found by reading the code:

- **Stop cannot be undone** (`:1081`, `:1344`). After Stop, `loadNext` returns early and "Load next page now" says "No more pages."
- **No timeout on same-origin fetches** (`fetchBytes`, `:652`). A hung request leaves "Loading page N" up forever; the GM path has 20 s.
- **A matched rule disables auto-detection** (`tryStart`, `:1323`; `findNext`, `:217`). Picker rules cover the whole host (`^https?://host/`); where their selectors match nothing, Onward does nothing. Pagetual and AutoPagerize only use a rule whose selectors exist on the page. wedata's `excludeUrl` (2 rules) is ignored.
- **Repeat-page check truncates** (`contentHash`, `:599`). Only the first 5,000 characters are hashed, so pages that open with the same long post stop as "already have".
- **Redirects to a loaded page are not caught** (`appendPage`, `:966`). `finalUrl` is added to `seen` without checking whether it was already there; only the content hash stands between a `/page/99 → /` redirect and a duplicate page.
- **Unlabelled numbered-pager false positive** (`findNumberedNext`, `:325`). Any `td`/`li` holding "2" followed by a cell linking "3" counts as a pager, which fits numeric data tables.
- **Pager filter drops real items** (`isPagerChild`, `:497`). `PAGINATION_RE` matches "page" anywhere in a class, so an item such as `li.product-page-card` with three links and short text is discarded.
- **Load-more race** (`clickMore`, `:1022`). A button that is still disabled or hidden 400 ms after its items render ends paging with "No more items." Needs live validation.
- **Path shortcut skips URL checks** (`findNextIn`, `:1008`). The resolved-path branch accepts any `http(s)` URL without the host check and https upgrade in `acceptUrl`.
- **Every tab refreshes rule lists at once** after 7 days (`boot`, `:1354`), and a failed refresh stores `[]` (`updateSources`, `:1213`).

## Security, Privacy, and Reliability

- **Imported markup is not inert** (Verified in three engines by the platform research run). After `importNode`: `img onerror`, `details ontoggle`, `input autofocus onfocus`, SVG `animate onbegin`, `iframe srcdoc` scripts and `iframe src=javascript:` fire. `<noscript>` children are live because DOMParser parses with scripting disabled. `<meta http-equiv=refresh>`, `<base href>`, `<style>` and `<link rel=stylesheet>` act on the host page even under `script-src 'self'`. Same-site handlers running is equivalent to visiting page 2; `noscript` reparsing, `base`, `meta refresh` and `srcdoc` are behaviour Onward introduces.
- **Cross-origin reads with cookies.** `acceptUrl` (`:212`) requires the same hostname, but a different port or scheme goes through `GM_xmlhttpRequest` with cookies (Violentmonkey sends them by default) and the response lands in a DOM the page's scripts can read. Narrow today; it widens as soon as a rule or feature allows another host. Precedent: CVE-2005-2455.
- **Rule lists can make Onward click things.** `normalizeRules` (`:624`) keeps `click: true` from remote lists and `clickMore` clicks whatever matches. A compromised list could target any button on any matching site.
- **Rule-list transport and integrity.** wedata answers only over HTTP; the HTTPS mirror is filled by an HTTP sync job and once served an HTML error page. A download must parse, pass a sanity check, and never replace a good cache with a bad one.
- **ReDoS.** Rule `url` patterns run on every page (`matchRule`, `:633`). 14 of 3,824 wedata patterns have nested quantifiers; none took over 20 ms on hostile inputs (platform research run). Third-party lists are the risk; a host index avoids compiling most patterns.
- **Hidden iframe side effects.** No sandbox, no autoplay policy, and page scripts and analytics run. Note that `allow-scripts` with `allow-same-origin` lets a same-origin frame remove its own sandbox (MDN), so the sandbox stops frame-busters but is not a boundary against hostile same-site code.
- **`@connect *`.** Tampermonkey checks the initial and redirected host and prompts for undeclared ones; Violentmonkey does not enforce `@connect`. Page loads need only `self`.
- **Trusted Types.** Isolated worlds ignore the page's Trusted Types (W3C wiki), so the `onward` policy (`parseHtml`, `:587`) only matters under main-world injection; it is already wrapped in try/catch.
- **Recovery.** No way to recover a lost rule cache, no export of settings, no schema version for future migrations.

## Architecture Assessment

- **Async lifecycle.** `Pager` awaits fetches and iframe loads with no generation token or `AbortController`. Every `await` in `loadNext`, `appendPage`, `clickMore` and `loadViaIframe` needs a "still current?" check, and `fetchBytes` needs a signal and a timeout.
- **Import pipeline.** `prepareItems` (`:558`) is the single choke point for sanitizing, lazy-image repair (`fixLazyImages`, `:527`, 9 attributes against Pagetual's 30), `<noscript>` fallback harvesting and URL fixing.
- **Rules.** Matching should be host index → candidate rules → verify selectors on the live page → otherwise auto-detect. `loadSettings()` reads the whole `sourceRules` value on every `tryStart` attempt (`:1319`, up to three per page).
- **Activation policy.** `tryStart` has no notion of "the site already pages itself" or "this is a sensitive page". Both belong before `detect()`.
- **UI.** Settings, picker, toasts and bars are built inline. The settings dialog lacks labels on its three textareas, `aria-modal`, and focus management; toasts and bar status are not announced (WCAG 4.1.3).
- **Tests.** e2e injects with `addScriptTag` into the main world, unlike Tampermonkey (USER_SCRIPT world) or Violentmonkey (content mode). CDP `Page.createIsolatedWorld` reproduces separate globals over a shared DOM. Missing coverage: picker selector uniqueness (jsdom 26 lacks `CSS.escape`; jsdom 30.0.0 added it), destroy during load, hidden bars and URL sync, frame busters, rule fallback, rule-list failure, native-infinite-scroll sites. The live smoke script has no curated site list or expected outcomes.
- **Scope.** Multi-user features do not apply: settings live in one browser profile's manager storage. Upgrades arrive through `@updateURL`, so stored data needs a schema version before its shape changes (roadmap P3).
- **Docs.** README misses install blockers: Chrome 138+ requires the per-extension "Allow User Scripts" toggle, and Tampermonkey 5.5.0 added a separate injection permission. The `onward:page` event is undocumented.

## Rejected Ideas

- Rule fields that execute JavaScript (Pagetual `init`, `pageAction`, `nextLinkByJs`): a supply-chain hole. Source: pagetual.hoothin.com/rule.html.
- Server-side rule lookup by URL (nextpage): leaks browsing history.
- Speculation Rules for prefetching: the prefetch cache is per document and `fetch()` does not read it; Chromium only. Source: MDN Speculation Rules API.
- Wrapping site markup in `role=feed`/`article`: Onward does not own that markup; announce status instead. Sources: APG feed pattern, Deque 2019.
- Keyboard toggles and APG feed keys (requested in swdyh/autopagerize#19, Pagetual #703, Infy #55): conflict with the project's no-keyboard-shortcuts rule; bar buttons and menu commands cover the need.
- DOM virtualization of appended pages: requires owning the render tree. `content-visibility` gets most of the benefit. Source: web.dev virtualize-long-lists.
- Visible-iframe append (Pagetual `action: 2`) and click emulation inside an iframe: large surface for a niche; wrapped mode covers the React case.
- Auto-scroll and double-click-to-pause (Pagetual): not paging, and double-click collides with other extensions (Pagetual #356).
- A prefilled "request support for this site" issue link: floods the tracker (Pagetual #1225 to #1228); a copyable diagnostics block instead.
- A built-in wedata dependency or bundled rule snapshot: wedata is frozen since 2024-08-30, HTTP-only, and has had outages; rule-free detection is the product.

## Sources

Competitors
- https://github.com/XIU2/UserScript
- https://github.com/hoothin/UserScripts/tree/master/Pagetual
- https://pagetual.hoothin.com/rule.html
- https://github.com/hoothin/UserScripts/issues/131
- https://github.com/hoothin/UserScripts/issues/660
- https://github.com/hoothin/UserScripts/issues/691
- https://github.com/hoothin/UserScripts/commit/ff973e67
- https://github.com/sixcious/infy-scroll/wiki
- https://github.com/sixcious/infy-scroll/issues/133
- https://github.com/sixcious/infy-scroll/issues/132
- https://github.com/sixcious/infy-scroll/issues/66
- https://github.com/sixcious/infy-scroll/issues/34
- https://chromewebstore.google.com/detail/uautopagerize/kdplapeciagkkjoignnkfpbfkebcfbpb
- https://github.com/wantora/weautopagerize
- https://github.com/wantora/weautopagerize/issues/42
- https://github.com/wantora/weautopagerize/issues/36
- https://github.com/tophf/autopagerize
- https://github.com/machsix/Super-preloader/issues/428
- https://github.com/machsix/Super-preloader/issues/58
- https://github.com/swdyh/autopagerize/issues/20
- https://github.com/swdyh/autopagerize_for_chrome/issues/13
- https://help.vivaldi.com/developers/web/vivaldi-fast-forward-for-web-developers/
- http://wedata.net/databases/AutoPagerize/items_all.json
- https://hoothin.github.io/UserScripts/Pagetual/items_all.json

Platform
- https://developer.chrome.com/docs/extensions/reference/api/userScripts
- https://www.tampermonkey.net/changelog.php
- https://www.tampermonkey.net/documentation.php?q=GM_xmlhttpRequest
- https://violentmonkey.github.io/api/gm/
- https://github.com/violentmonkey/violentmonkey/releases/tag/v2.46.0
- https://github.com/violentmonkey/violentmonkey/blob/620fe4dd660cc09e0ea8c23aa87283c47b460dfb/src/background/utils/preinject-prepare.js
- https://github.com/Tampermonkey/tampermonkey/issues/1787
- https://github.com/quoid/userscripts
- https://docs.scriptcat.org/en/docs/dev/api/
- https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API
- https://web.dev/articles/content-visibility
- https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API
- https://github.com/w3c/trusted-types/wiki/Effects-of-deploying-Trusted-Types-on-browser-extension-developers
- https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Page.pdl
- https://github.com/jsdom/jsdom/releases/tag/v30.0.0
- https://greasyfork.org/en/help/code-rules

Security
- https://html.spec.whatwg.org/multipage/scripting.html
- https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- https://nvd.nist.gov/vuln/detail/CVE-2005-2455
- https://v8.dev/blog/non-backtracking-regexp

Accessibility, UX and performance
- https://www.w3.org/WAI/ARIA/apg/patterns/feed/
- https://www.deque.com/blog/infinite-scrolling-rolefeed-accessibility-issues/
- https://adrianroselli.com/2014/05/so-you-think-you-built-good-infinite.html
- https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- https://www.nngroup.com/articles/infinite-scrolling-tips/
- https://www.smashingmagazine.com/2016/03/pagination-infinite-scrolling-load-more-buttons/
- https://developer.chrome.com/blog/infinite-scroller
- https://web.dev/articles/browser-level-image-lazy-loading

## Open Questions

- Publish on Greasy Fork? The two largest competitors get their reach there and Onward meets its no-minification rule, but it needs an account decision from the owner.
