# Changelog

## [Unreleased]

- Turning Onward off, picking a new rule, or a site navigating while a page is still loading now cancels that load cleanly. Before, the old load could finish into a detached list and leave a "failed" bar behind.
- The address bar only moves to page N once page N is actually on screen, and goes back to where you started when Onward removes its pages.
- Onward stands by on sites that already load more as you scroll. Discourse and Flarum are recognised straight away. Anywhere else, the first page waits a few seconds, and if the site adds items by itself in that time Onward stays out of it. A new menu command, "Run Onward here anyway", overrides this for the current page.
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
