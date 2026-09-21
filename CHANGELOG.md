# Changelog

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
