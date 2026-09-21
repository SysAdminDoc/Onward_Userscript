# Changelog

## [Unreleased]

- Repeats are now caught item by item. An item you've already seen on an earlier page (a product that moved, a pinned post) is left out, and paging only ends when a page is almost all repeats. Before, only the first 5,000 characters of a whole page were compared, so a long post repeated at the top of every page could end paging early.
- When a site answers a page past the end by redirecting back to a page you already have (common on WordPress), Onward now stops there instead of adding that page again.
- A page that never answers now gives up after 20 seconds and pauses with a Retry button, instead of showing "Loading page N" forever.
- Stop can be undone. After you press it, the page bars show Resume, and "Load next page now" also picks up where you stopped. The menu now says whether paging was stopped by you, paused after an error, or reached the last page, instead of always saying "No more pages".
- With "Show a bar between pages" turned off, the address bar follows the page you're reading again. Before, it jumped to the last page loaded and stayed there.
- Page bars no longer pick up a site's list styles, such as a fixed row height.
- Cancelling the picker puts Onward back to work on the page. Before, it stayed off until you reloaded.
- A site rule is only used on pages where its selectors find something. Elsewhere on the same site Onward goes back to finding the next page itself, instead of doing nothing. Rules also honour `excludeUrl`, as AutoPagerize rules do.
- Scrolling into the footer no longer loads every page at once. New items now appear where the footer was, and the next page waits until you scroll again.
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
