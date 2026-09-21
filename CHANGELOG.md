# Changelog

## [Unreleased]

- New menu command "Load 5 more pages" loads up to five pages one after another without scrolling, counting them in the loading bar. It keeps to the page limit and the gap between requests, and waits for a page that's already loading.
- A single scroll no longer fetches a string of pages on sites whose images don't reserve their size. Onward waits for a new page's images before deciding the page still needs another, and a page it was about to fetch is dropped if you've scrolled away in the meantime. Pages you ask for from the menu are always loaded.
- On single-page sites Onward notices a route change straight away through the browser's Navigation API, instead of within a second or two. Browsers without it are still covered by the old check.
- Page requests to a site are at least a second apart, however fast you scroll, so paging doesn't get you rate-limited or banned. The gap is a setting.
- Onward only loads next pages from the page's own origin (same scheme, host and port), apart from switching an `http` link to `https` on a secure page. A page that redirects to another site is refused. Rule-list downloads no longer send your cookies.
- Rules from a downloaded rule list can no longer make Onward click buttons. Only rules you write or pick yourself can use `click`.
- Rule lists keep their last good copy. A download that isn't a rule list (a mirror's error page, for instance), has no rules, or lost more than half of them is ignored with a message, and Onward tries again later instead of waiting a week. Only one tab refreshes the lists at a time.
- Pages Onward adds can no longer act on the page you're reading. A refresh tag can't send your tab elsewhere, a `<base>` tag can't redirect your links, frames with inline documents and `javascript:` links are removed, and `<noscript>` blocks are dropped. Images that kept their real address inside `<noscript>` get it back first.
- Repeats are now caught item by item. An item you've already seen on an earlier page (a product that moved, a pinned post) is left out, and paging only ends when a page is almost all repeats. Items are recognised by their text and link, and picture-only items by the image's real address rather than its placeholder, so a page the site sends again is still caught after its images have loaded. Spacer rows and other empty layout pieces are always kept. Before, only the first 5,000 characters of a whole page were compared, so a long post repeated at the top of every page could end paging early.
- When a site answers a page past the end by redirecting back to a page you already have (common on WordPress), Onward now stops there instead of adding that page again.
- A page that never answers now gives up after 20 seconds and pauses with a Retry button, instead of showing "Loading page N" forever.
- Stop can be undone. After you press it, the page bars show Resume, and "Load next page now" also picks up where you stopped. The menu now says whether paging was stopped by you, paused after an error, stopped because added pages weren't making the page longer or because the site keeps redrawing its list, or reached the last page, instead of always saying "No more pages".
- Stop also drops a page that's still on its way, instead of letting it land below the Stop bar. Retry and Resume both carry on after a Stop or a failed page. Before, Retry did nothing while you had stopped paging, and Resume stayed paused after an error.
- The picker recognises Next labels that use a narrow or thin space, not only a no-break space, so it saves a selector by the label instead of by position.
- With "Show a bar between pages" turned off, the address bar follows the page you're reading again. Before, it jumped to the last page loaded and stayed there.
- Page bars no longer pick up a site's list styles, such as a fixed row height. In a list laid out as a column, a bar is as tall as the bar, not as tall as the list. With bars turned off they take no room at all, in grids and tables too.
- Cancelling the picker puts Onward back to work on the page, running the way it was before (so "Run Onward here anyway" still holds). So does the picker hitting a problem, which it now tells you about. Before, Onward stayed off until you reloaded. The picker also refuses a click that isn't one item in a list it can use, such as the page background or a list inside a web component.
- A site rule is only used on pages where its selectors find something. It still gets a few seconds for a pager the page draws late. Where the rule's list is on the page but its Next link isn't, Onward uses the rule for the items and finds the next page itself. Elsewhere on the same site it goes back to finding everything itself, instead of doing nothing. Rules also honour `excludeUrl`, as AutoPagerize rules do.
- A rule that also matches the Previous link skips it, and real Next links are no longer mistaken for Previous because their label mentions another direction later on, like "Next post: Backyard gardening" or "Next (last page)". A bare back arrow such as « counts as Previous, except on right-to-left pages.
- Scrolling into the footer no longer loads every page at once. New items now appear where the footer was, and the next page waits until you scroll again. Images loading and widgets growing while you sit there don't count as scrolling. Your wheel, touch, keys and scrollbar do.
- Turning Onward off, picking a new rule, or a site navigating while a page is still loading now cancels that load cleanly. Before, the old load could finish into a detached list and leave a "failed" bar behind.
- The address bar only moves to page N once page N is actually on screen, and goes back to where you started when Onward removes its pages.
- Onward stands by on sites that already load more as you scroll. Discourse and Flarum are recognised straight away. Anywhere else, Onward watches for a few seconds before its first page and each time you reach the bottom. If the site adds items by itself in that time, Onward takes its own pages back out so nothing is shown twice. A new menu command, "Run Onward here anyway", overrides this for the current page.
- The picker now saves a selector that matches only the link you clicked. On Bootstrap-style pagers, where every link shares the same classes, the old rule loaded the previous page. It checks the rule leads back to that link before saving, and tells you when it can't build one.
- Rules saved with the picker now work on sites that use a port number in their address. Before, the saved rule never matched them.
- A rule you picked or wrote is used even on a page that looks like Discourse or Flarum.
- The hidden iframe used for script-rendered pages is now sandboxed. A page that tries to break out of frames can no longer navigate your tab away, and audio or video inside it is muted and paused.

## [0.1.0] (2026-09-21)

First release.

- Next-page detection from `rel="next"`, link labels in about 30 languages, pager classes, numbered pagers and `?page=N` / `/page/N/` URLs. Previous links, disabled items, carousels and sliders are ignored.
- Content detection that picks the largest repeating list on the page and matches it again in fetched pages, even when scripts added classes on the live page.
- Fetch mode with charset detection (header, meta tag, then the current page's encoding), lazy image repair and absolute URLs. Falls back to a hidden iframe for lists built by scripts.
- Load-more buttons are clicked until they go away.
- Wrapped mode for sites whose framework redraws the list, switched on automatically when added pages disappear.
- Inner scroll containers are supported.
- Page bars with the page number, URL, Top and Stop. The address bar follows the page in view.
- Safety limits: a page cap, pause on errors, a stop when added pages don't grow the page, and a stop when a site repeats a page.
- Element picker that writes a site rule. Hand-written rules take CSS or XPath, and AutoPagerize/wedata rule lists can be imported.
- Settings panel, per-site toggle and a host blocklist.
