const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const O = require('../src/onward.user.js');

const BASE = 'https://example.com/list/';
const dom = (body, url = BASE, head = '') => new JSDOM(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, { url }).window.document;
const next = (doc, url = BASE, opts = {}) => O.findNext(doc, url, opts);

const items = (n, cls = 'post', start = 1) => Array.from({ length: n }, (_, i) =>
  `<li class="${cls}"><a href="/p/${start + i}">Post title number ${start + i}</a><p>Some summary text for post ${start + i} that is long enough.</p></li>`).join('');

test('link rel=next in head wins', () => {
  const d = dom('<a href="/list/?page=9">Next</a>', BASE, '<link rel="next" href="/list/?page=2">');
  const r = next(d);
  assert.equal(r.url, 'https://example.com/list/?page=2');
  assert.equal(r.how, 'link-rel');
});

test('text "Next »" inside a pager, previous link ignored', () => {
  const d = dom(`<ul>${items(5)}</ul><nav class="pagination"><a href="/list/?page=1">« Previous</a><a href="/list/?page=3">Next »</a></nav>`);
  assert.equal(next(d, 'https://example.com/list/?page=2').url, 'https://example.com/list/?page=3');
});

test('CJK next labels', () => {
  for (const label of ['下一页', '下一頁 >', '次へ', '다음', 'Следующая']) {
    const d = dom(`<div class="pages"><a href="/list/1">1</a><a href="/list/2">${label}</a></div>`);
    assert.equal(next(d)?.url, 'https://example.com/list/2', label);
  }
});

test('numbered pagination: current N, link N+1', () => {
  const d = dom(`<div class="paging"><a href="/l?p=1">1</a><span class="current">2</span><a href="/l?p=3">3</a><a href="/l?p=4">4</a></div>`);
  const r = next(d, 'https://example.com/l?p=2');
  assert.equal(r.url, 'https://example.com/l?p=3');
});

test('numbered pagination without a pager class needs an adjacent N+1 link', () => {
  const d = dom(`<div><b>2</b><a href="/l?p=3">3</a></div><div><span>1</span> comments <a href="/c">2</a></div>`);
  assert.equal(next(d, 'https://example.com/l?p=2').url, 'https://example.com/l?p=3');
});

test('rejects javascript:, same page, other hosts, disabled and seen links', () => {
  assert.equal(next(dom('<nav class="pager"><a href="javascript:void(0)">Next</a></nav>')), null);
  assert.equal(next(dom('<nav class="pager"><a href="/list/#top">Next</a></nav>')), null);
  assert.equal(next(dom('<nav class="pager"><a href="https://other.org/2">Next</a></nav>')), null);
  assert.equal(next(dom('<ul class="pagination"><li class="disabled"><a href="/list/2">Next</a></li></ul>')), null);
  assert.equal(next(dom('<nav class="pager"><a href="/list/2">Next</a></nav>'), BASE, { seen: new Set(['https://example.com/list/2']) }), null);
});

test('carousel and slider controls are not pagers', () => {
  const d = dom('<div class="slick-slider"><a class="slick-next" href="/list/slide2">Next</a></div><div class="hero-carousel"><a href="/x">Next</a></div>');
  assert.equal(next(d), null);
});

test('"preview" in a class does not read as "prev"', () => {
  const d = dom('<nav class="pagination"><a class="next preview-link" href="/list/2">Next</a></nav>');
  assert.equal(next(d).url, 'https://example.com/list/2');
});

test('bare arrow counts when its URL is the incremented page', () => {
  const d = dom('<div><a href="/search?q=x&page=4">›</a></div>');
  assert.equal(next(d, 'https://example.com/search?q=x&page=3').url, 'https://example.com/search?q=x&page=4');
  // Same arrow pointing somewhere unrelated is ignored.
  assert.equal(next(dom('<div><a href="/about">›</a></div>'), 'https://example.com/search?q=x&page=3'), null);
});

test('/page/N/ paths increment', () => {
  const d = dom('<div class="nav-links"><a href="/blog/page/3/">→</a></div>');
  assert.equal(next(d, 'https://example.com/blog/page/2/').url, 'https://example.com/blog/page/3/');
});

test('blogs: "Older posts" is next, "Newer posts" is not', () => {
  const d = dom('<div class="nav-links"><a href="/?paged=1">Newer posts</a><a href="/?paged=3">Older posts</a></div>');
  assert.equal(next(d, 'https://example.com/?paged=2').url, 'https://example.com/?paged=3');
});

test('a "More" menu link in the header is not a pager', () => {
  const d = dom('<header><a href="/more">More</a></header><main><p>article</p></main>');
  assert.equal(next(d), null);
});

test('next links must stay on the page\'s origin (besides the https upgrade)', () => {
  const pager = (href) => dom(`<nav class="pager"><a href="${href}">Next</a></nav>`);
  assert.equal(next(pager('https://example.com:8443/list/2')), null, 'another port');
  assert.equal(next(pager('https://sub.example.com/list/2')), null, 'another host');
  assert.equal(next(pager('https://example.com/list/2'), 'http://example.com/list/'), null, 'https from an http page is another origin');
  assert.equal(next(pager('http://example.com:8080/list/2'), 'http://example.com:8080/list/').url, 'http://example.com:8080/list/2', 'same scheme, host and port');
});

test('http next link is upgraded on an https page', () => {
  const d = dom('<nav class="pager"><a href="http://example.com/list/2">Next</a></nav>');
  assert.equal(next(d).url, 'https://example.com/list/2');
});

test('rule selectors: CSS and XPath', () => {
  const d = dom('<div id="x"><a class="go" href="/list/7">→</a></div>');
  assert.equal(next(d, BASE, { rule: { next: 'a.go' } }).url, 'https://example.com/list/7');
  assert.equal(next(d, BASE, { rule: { next: '//div[@id="x"]/a' } }).url, 'https://example.com/list/7');
  assert.equal(next(d, BASE, { rule: { next: 'a.missing' } }), null);
});

test('findContent picks the result list, not the menu or pager', () => {
  const menu = Array.from({ length: 12 }, (_, i) => `<li><a href="/c/${i}">Cat ${i}</a></li>`).join('');
  const d = dom(`<div class="sidebar"><ul class="menu">${menu}</ul></div>
    <div id="main"><h1>Results</h1><ol class="results">${items(10, 'post hentry')}</ol>
    <div class="pagination"><a href="/list/1">1</a><a href="/list/2">2</a><a href="/list/3">3</a><a href="/list/2">Next</a></div></div>`);
  const n = next(d);
  const c = O.findContent(d, { nextEl: n.el });
  assert.equal(c.container.className, 'results');
  assert.equal(c.items.length, 10);
});

test('findContent ignores header/footer/nav lists', () => {
  const links = Array.from({ length: 8 }, (_, i) => `<div class="item"><p>${'Footer link text that is quite long '.repeat(3)}${i}</p></div>`).join('');
  const d = dom(`<footer>${links}</footer><section class="grid">${Array.from({ length: 4 }, (_, i) => `<article class="card"><h2>Card ${i}</h2><p>Body text of the card ${i}</p></article>`).join('')}</section>`);
  assert.equal(O.findContent(d).container.className, 'grid');
});

test('describePath/resolvePath survive script-added state classes', () => {
  const live = dom(`<div id="wrap"><div class="col main is-loaded"><ul class="list active">${items(4)}</ul></div></div>`);
  const container = live.querySelector('ul');
  const path = O.describePath(container);
  const fetched = dom(`<div id="wrap"><div class="col side"><ul class="list"><li>ad</li></ul></div><div class="col main"><ul class="list">${items(4, 'post', 5)}</ul></div></div>`);
  const found = O.resolvePath(fetched, path);
  assert.ok(found);
  assert.match(found.textContent, /Post title number 5/);
});

test('extractItems keeps item-shaped children, drops pager, ads and repeated headers', () => {
  const live = dom(`<div id="list"><h2>Top</h2>${Array.from({ length: 4 }, (_, i) => `<div class="thread row">Thread title ${i}</div>`).join('')}</div>`);
  const content = O.findContent(live);
  const ctx = { path: O.describePath(content.container), shape: O.itemShape(content.items) };
  const page2 = dom(`<div id="list"><h2>Top</h2><div class="thread row">A</div><div class="thread row sticky">B</div><div class="ad-slot">ad</div><div class="pagination"><a href="1">1</a><a href="2">2</a><a href="3">3</a></div><script>x()</script></div>`);
  const got = O.extractItems(page2, ctx).map((e) => e.textContent);
  assert.deepEqual(got, ['A', 'B']);
});

test('prepareItems fixes lazy images, relative URLs and strips scripts', () => {
  const d = dom(`<div class="i"><img src="data:image/gif;base64,R0lGOD" data-src="img/a.jpg"><img src="/spacer.gif" data-original="b.png">
    <img data-srcset="s1.jpg 1x, s2.jpg 2x"><a href="../post/3">x</a><script>alert(1)</script></div>`);
  const [it] = O.prepareItems([d.querySelector('.i')], 'https://example.com/list/page/2/');
  const imgs = it.querySelectorAll('img');
  assert.equal(imgs[0].getAttribute('src'), 'https://example.com/list/page/2/img/a.jpg');
  assert.equal(imgs[1].getAttribute('src'), 'https://example.com/list/page/2/b.png');
  assert.equal(imgs[2].getAttribute('srcset'), 'https://example.com/list/page/2/s1.jpg 1x, https://example.com/list/page/2/s2.jpg 2x');
  assert.equal(it.querySelector('a').getAttribute('href'), 'https://example.com/list/page/post/3');
  assert.equal(it.querySelector('script'), null);
});

test('prepareItems strips markup that would act on the page', () => {
  const d = dom(`<ul>
    <li class="i" id="meta"><meta http-equiv="refresh" content="0;url=/elsewhere"><a href="/p/1">one</a></li>
    <li class="i" id="base"><base href="https://evil.example/"><a href="/p/2">two</a></li>
    <li class="i" id="ns"><noscript><img src="/tracker.gif" onerror="alert(1)"></noscript>three</li>
    <li class="i" id="frame"><iframe srcdoc="<script>parent.x=1</script>"></iframe><iframe src="/ok.html"></iframe>four</li>
    <li class="i" id="js"><a href="javascript:alert(1)">a</a><img src=" JavaScript:alert(2)"><form action="javascript:x()"><button formaction="javascript:y()">b</button></form></li>
  </ul>`);
  const [meta, base, ns, frame, js] = O.prepareItems([...d.querySelectorAll('li.i')], 'https://example.com/list/page/2/');
  assert.equal(meta.querySelector('meta'), null, 'meta refresh gone');
  assert.equal(base.querySelector('base'), null, 'base gone');
  assert.equal(base.querySelector('a').getAttribute('href'), 'https://example.com/p/2', 'links resolve against the page, not the removed base');
  assert.equal(ns.querySelector('noscript'), null, 'noscript gone');
  assert.equal(frame.querySelectorAll('iframe').length, 1, 'the srcdoc frame is gone, the plain one stays');
  assert.equal(frame.querySelector('iframe').getAttribute('src'), 'https://example.com/ok.html');
  assert.equal(js.querySelector('a').hasAttribute('href'), false, 'javascript: href removed');
  assert.equal(js.querySelector('img').hasAttribute('src'), false, 'javascript: src removed');
  assert.equal(js.querySelector('form').hasAttribute('action'), false, 'javascript: action removed');
  assert.equal(js.querySelector('button').hasAttribute('formaction'), false, 'javascript: formaction removed');
});

test('lazy images: the attributes lazy loaders use, one at a time', () => {
  const fixed = (img) => {
    const d = dom(`<div class="i">${img}</div>`);
    const [it] = O.prepareItems([d.querySelector('.i')], 'https://example.com/list/');
    return it.querySelector('img').getAttribute('src');
  };
  for (const attr of ['data-lazyload', 'data-lazyload-src', 'data-lazy-load-src', 'data-orig-file', 'data-ks-lazyload', 'data-ks-lazyload-custom',
    'data-defer-src', 'lazysrc', 'load-src', 'origin-src', 'real_src', 'imgsrc', 'src2', 'data-imageurl', 'data-isrc', 'data-s', 'data-cover', 'data-thumb']) {
    assert.equal(fixed(`<img src="/blank.gif" ${attr}="/real.jpg">`), 'https://example.com/real.jpg', attr);
  }
  // Discuz: a none.gif placeholder, the picture in zoomfile or file.
  assert.equal(fixed('<img src="static/image/common/none.gif" zoomfile="data/attachment/a.jpg" file="data/attachment/a_small.jpg">'), 'https://example.com/list/data/attachment/a.jpg');
  assert.equal(fixed('<img src="static/image/common/none.gif" file="data/attachment/b.jpg">'), 'https://example.com/list/data/attachment/b.jpg');
  assert.equal(fixed('<img original="/o.jpg">'), 'https://example.com/o.jpg', 'no src at all');
  assert.equal(fixed('<img _src="/u.jpg">'), 'https://example.com/u.jpg', '_src');
  assert.equal(fixed('<img src="/photo.jpg" data-src="/other.jpg">'), 'https://example.com/photo.jpg', 'a real src is kept');
  assert.equal(fixed('<img src="/blank.gif" data-placeholder="/tiny.jpg" data-src="/full.jpg">'), 'https://example.com/full.jpg', 'full size before a placeholder copy');
});

test('lazy images: a placeholder srcset gives way to data-srcset', () => {
  const d = dom(`<div class="i"><img src="/blank.gif" srcset="data:image/gif;base64,R0lGOD 1w" data-srcset="/a.jpg 1x, /a@2x.jpg 2x">
    <picture><source srcset="/spacer.gif" data-srcset="/b.webp"><img src="/b.jpg"></picture>
    <img class="keep" src="/c.jpg" srcset="/c.jpg 1x, /c@2x.jpg 2x" data-srcset="/other.jpg 1x"></div>`);
  const [it] = O.prepareItems([d.querySelector('.i')], 'https://example.com/');
  assert.equal(it.querySelector('img').getAttribute('srcset'), 'https://example.com/a.jpg 1x, https://example.com/a@2x.jpg 2x');
  assert.equal(it.querySelector('source').getAttribute('srcset'), 'https://example.com/b.webp');
  assert.match(it.querySelector('img.keep').getAttribute('srcset'), /c@2x\.jpg/, 'a real srcset is kept');
});

test('lazy images: data-bg and data-background-image become a background image', () => {
  const d = dom(`<div class="i"><div class="cover" data-bg="covers/1.jpg"></div>
    <a class="thumb" data-background-image="url('/t/2.jpg')"></a>
    <div class="set" style="background-image:url(/real.jpg)" data-bg="/other.jpg"></div></div>`);
  const [it] = O.prepareItems([d.querySelector('.i')], 'https://example.com/list/');
  assert.match(it.querySelector('.cover').style.backgroundImage, /^url\("?https:\/\/example\.com\/list\/covers\/1\.jpg"?\)$/);
  assert.match(it.querySelector('.thumb').style.backgroundImage, /^url\("?https:\/\/example\.com\/t\/2\.jpg"?\)$/);
  assert.match(it.querySelector('.set').style.backgroundImage, /real\.jpg/, 'a background already set is kept');
});

test('prepareItems removes javascript: URLs however they are spelled, after its repairs', () => {
  const d = dom(`<div class="i"><a href="java&#9;script:alert(1)">a</a><img src="java&#10;script:alert(2)"><form action="jav&#13;ascript:x()"><button formaction="&#1;javascript:y()">b</button></form>
    <iframe src="java&#10;script:parent.x=1"></iframe><object data="javascript:1"></object><img class="lazy" src="/blank.gif" data-src="javascript:alert(3)"></div>`);
  const [it] = O.prepareItems([d.querySelector('.i')], 'https://example.com/');
  assert.equal(it.querySelector('a').hasAttribute('href'), false);
  assert.equal(it.querySelector('img').hasAttribute('src'), false);
  assert.equal(it.querySelector('form').hasAttribute('action'), false);
  assert.equal(it.querySelector('button').hasAttribute('formaction'), false);
  assert.equal(it.querySelector('iframe').hasAttribute('src'), false);
  assert.equal(it.querySelector('object').hasAttribute('data'), false);
  assert.ok(!/javascript/i.test(it.querySelector('img.lazy').getAttribute('src') || ''), 'a lazy javascript: address is not moved into src');
});

test('prepareItems fixes an item that is itself a link, an image or a lazy background', () => {
  const d = dom('<div class="g"><a class="i" href="p/1"><img src="/blank.gif" data-src="t/1.jpg"></a><img class="i" src="/blank.gif" data-src="pics/2.jpg" srcset="/blank.gif 1x" data-srcset="pics/2@2x.jpg 2x"><div class="i" data-bg="bg/3.jpg"></div></div>');
  const [a, img, bg] = O.prepareItems([...d.querySelectorAll('.i')], 'https://example.com/list/page/2/');
  assert.equal(a.getAttribute('href'), 'https://example.com/list/page/2/p/1', 'a link item resolves against its own page');
  assert.equal(a.querySelector('img').getAttribute('src'), 'https://example.com/list/page/2/t/1.jpg');
  assert.equal(img.getAttribute('src'), 'https://example.com/list/page/2/pics/2.jpg', 'an image item');
  assert.equal(img.getAttribute('srcset'), 'https://example.com/list/page/2/pics/2@2x.jpg 2x');
  assert.match(bg.style.backgroundImage, /example\.com\/list\/page\/2\/bg\/3\.jpg/, 'a background item');
});

test('prepareItems gives an <img> item the address in the <noscript> after it', () => {
  const d = dom('<div class="grid"><img class="i" src="/blank.gif"><noscript><img src="/real1.jpg"></noscript><img class="i" src="/blank.gif"><noscript><img src="/real2.jpg"></noscript></div>');
  const out = O.prepareItems([...d.querySelectorAll('img.i')], 'https://example.com/');
  assert.deepEqual(out.map((i) => i.getAttribute('src')), ['https://example.com/real1.jpg', 'https://example.com/real2.jpg']);
});

test('next links never sign the reader out or delete something', () => {
  const pick = (links, url = BASE) => {
    const d = dom(links, url);
    const r = O.findNext(d, url, { rule: { url: 'x', next: 'a.n' }, layout: false });
    return r && r.url;
  };
  assert.equal(pick('<a class="n" href="/account/logout">Next</a>'), null, 'logout');
  assert.equal(pick('<a class="n" href="/ucp.php?mode=logout&sid=1">Next</a>'), null, 'mode=logout');
  assert.equal(pick('<a class="n" href="/sign-out">Next</a>'), null);
  assert.equal(pick('<a class="n" href="/posts/12/delete">Next</a>'), null);
  assert.equal(pick('<a class="n" href="/list?action=remove&id=3">Next</a>'), null);
  assert.equal(pick('<a class="n" href="/newsletter/unsubscribe?u=1">Next</a>'), null);
  assert.equal(pick('<a class="n" href="/2024/05/search-and-destroy/">Next</a>'), 'https://example.com/2024/05/search-and-destroy/', 'a title with the word is fine');
  assert.equal(pick('<a class="n" href="/list/?page=2">Next</a>'), 'https://example.com/list/?page=2');
  // Detection too.
  assert.equal(next(dom('<ul>' + items(5) + '</ul><a href="/logout">Next</a>')), null);
});

test('prepareItems takes an image URL from a sibling noscript, and drops inert top-level items', () => {
  const d = dom(`<div class="card"><img src="data:image/gif;base64,R0lGOD" class="lazy"><noscript><img src="/real.jpg" srcset="/real.jpg 1x, /real@2x.jpg 2x"></noscript></div>
    <div class="card"><img src="/placeholder.gif" data-src="/lazy.jpg"><noscript><img src="/fallback.jpg"></noscript></div>
    <noscript class="card"><p>no scripts</p></noscript>`);
  const cards = [...d.querySelectorAll('.card')];
  const out = O.prepareItems(cards, 'https://example.com/');
  assert.equal(out.length, 2, 'the top-level noscript item is dropped');
  assert.equal(out[0].querySelector('img').getAttribute('src'), 'https://example.com/real.jpg');
  assert.match(out[0].querySelector('img').getAttribute('srcset'), /real@2x\.jpg 2x/);
  assert.equal(out[1].querySelector('img').getAttribute('src'), 'https://example.com/lazy.jpg', 'a data-src image keeps its own lazy URL');
});

test('charset: header, meta, fallback', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(O.sniffCharset(enc('<html>'), 'text/html; charset=Shift_JIS'), 'shift_jis');
  assert.equal(O.sniffCharset(enc('<meta charset="gbk"><p>'), 'text/html'), 'gbk');
  assert.equal(O.sniffCharset(enc('<meta http-equiv="Content-Type" content="text/html; charset=euc-kr">'), ''), 'euc-kr');
  assert.equal(O.sniffCharset(enc('<p>'), '', 'windows-1251'), 'windows-1251');
  // "日本" in Shift_JIS
  assert.equal(O.decode(new Uint8Array([0x93, 0xfa, 0x96, 0x7b]), 'text/html; charset=shift_jis'), '日本');
  // gbk is decoded as its superset gb18030: "中文"
  assert.equal(O.decode(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), 'text/html; charset=gb2312'), '中文');
});

test('data-bg only becomes a background when it is an image address', () => {
  const base = 'https://example.com/list?page=2';
  // An empty one used to throw, which failed every page on the site.
  const d = dom(`<li class="card"><div class="thumb" data-bg=""></div><a href="/p/1">Item one</a></li>
    <section data-bg="dark"><p>x</p></section><section data-bg="#f5f5f5"><p>y</p></section><section data-bg="true"><p>z</p></section>
    <section data-bg="rgb(0 0 0 / 50%)"><p>c</p></section><section data-bg="1.25"><p>n</p></section>
    <div class="a" data-bg="covers/7.webp"></div><div class="b" data-bg="//cdn.example.com/c/8"></div><div class="c" data-background-image="url('/c/9.jpg')"></div>`, base);
  assert.doesNotThrow(() => O.prepareItems([d.querySelector('li')], base));
  O.prepareItems(Array.from(d.querySelectorAll('section, div.a, div.b, div.c')), base);
  assert.deepEqual(Array.from(d.querySelectorAll('section'), (x) => x.style.backgroundImage), ['', '', '', '', ''], 'flags, colours and numbers are left alone');
  // Addresses without an image extension are still addresses.
  const plain = dom('<div class="e" data-bg="covers/7"></div><div class="f" data-bg="image.php?id=5"></div><div class="g" data-bg="media/thumb?id=9&amp;w=300"></div>', base);
  O.prepareItems(Array.from(plain.querySelectorAll('div')), base);
  assert.deepEqual(Array.from(plain.querySelectorAll('div'), (x) => x.style.backgroundImage),
    ['url("https://example.com/covers/7")', 'url("https://example.com/image.php?id=5")', 'url("https://example.com/media/thumb?id=9&w=300")']);
  assert.equal(d.querySelector('.a').style.backgroundImage, 'url("https://example.com/covers/7.webp")');
  assert.equal(d.querySelector('.b').style.backgroundImage, 'url("https://cdn.example.com/c/8")');
  assert.equal(d.querySelector('.c').style.backgroundImage, 'url("https://example.com/c/9.jpg")');
});

test('a rule whose pattern stops inside the host is not indexed by a shorter host', async () => {
  // Real wedata patterns (0.1.0 matched each on these sites; the host index dropped them).
  const cases = [
    ['^https?://(www\\.)?(zcool|hellorf)\\.com', 'https://www.zcool.com.cn/discover?page=2'],
    ['^https://dual\\.nikkei\\.co', 'https://dual.nikkei.co.jp/atcl/column/17/'],
    ['^https?://(www\\.)?ebookjapan', 'https://ebookjapan.yahoo.co.jp/search/?keyword=x'],
    ['^https://(www\\.)?(studyplus|tech\\.torico-corp)', 'https://studyplus.jp/articles'],
    ['^https?://www\\.jillstuart', 'https://www.jillstuart-beauty.com/ja-jp/item'],
  ];
  for (const [url] of cases) assert.equal(O.literalHosts(url), null, url);
  // Where the pattern pins the host's end, it's still indexed.
  assert.deepEqual(O.literalHosts('^https?://(www\\.)?zcool\\.com/'), ['www.zcool.com', 'zcool.com']);
  assert.deepEqual(O.literalHosts('^https://dual\\.nikkei\\.co\\.jp(?:/|$)'), ['dual.nikkei.co.jp']);
  assert.deepEqual(O.literalHosts('^https://example\\.com:8080/'), ['example.com']);
  // A "/" that can be left out doesn't pin it, unless something required follows.
  for (const url of ['https://onejav.com/*', '^https?://ukdata\\.blog38\\.fc2\\.com(/page-[\\d]+\\.html)?', '^https://(?:www\\.)?mysku\\.ru(?:/index/page\\d+/)?']) assert.equal(O.literalHosts(url), null, url);
  assert.deepEqual(O.literalHosts('^https?://example\\.com/?(?:/|$)'), ['example.com']);
  const rules = O.normalizeRules(cases.map(([url]) => ({ url, next: 'a.next', content: '.item' })), { fromList: true });
  O.forgetListRules();
  const cache = { list: await O.buildListEntry(rules, 1) };
  for (const [url, href] of cases) {
    assert.ok(O.matchingRules(await O.listRulesFor(cache, href), href).some((r) => r.url === url), url + ' at ' + href);
  }
});

test('requiredLiteral: a code like \\x2D or \\u002F is not text every match contains', () => {
  for (const [re, href] of [
    ['^https?://[^/]+/list\\x2Dpage\\u002Fnext', 'https://a.example/list-page/next'],
    ['^https?://[^/]+/tag\\u{2F}archive/\\p{L}+/older', 'https://a.example/tag/archive/abc/older'],
  ]) {
    assert.ok(new RegExp(re, 'u').test(href), 'the pattern matches ' + href);
    const lit = O.requiredLiteral(re);
    assert.ok(href.includes(lit), `${JSON.stringify(lit)} is not in ${href}`);
  }
  assert.equal(O.requiredLiteral('^https?://[^/]+/forum/viewtopic\\.php'), '/forum/viewtopic.php', 'plain text, an escaped dot included, still counts');
});

test('a danger word the page\'s own address has is not signing out', () => {
  const list = `<ul>${items(5)}</ul>`;
  // Next pages of a search for the word, a tag and a forum about it (0.1.0 followed all of these).
  for (const [page, href] of [
    ['https://example.com/search?q=logout', '/search?q=logout&page=2'],
    ['https://example.com/search?q=unsubscribe', '/search?q=unsubscribe&page=2'],
    ['https://example.com/search?q=remove', '/search?q=remove&page=2'],
    ['https://example.com/questions/tagged/delete', '/questions/tagged/delete?page=2'],
    ['https://example.com/tag/sign-out', '/tag/sign-out/page/2'],
    ['https://example.com/forum/unsubscribe-help', '/forum/unsubscribe-help?page=2'],
  ]) {
    const r = next(dom(`${list}<nav class="pagination"><a rel="next" href="${href}">Next</a></nav>`, page), page);
    assert.equal(r && r.url, new URL(href, page).href, href + ' from ' + page);
  }
  // Still refused: sign-out and delete links the page's address doesn't already name.
  for (const [page, href] of [
    ['https://example.com/forum/thread/1', '/logout?next=/forum/thread/2'],
    ['https://example.com/wiki/Page', '/wiki/index.php?action=logout'],
    ['https://example.com/search?q=delete', '/users/sign_out'],
    ['https://example.com/search?q=logout', '/search?q=logout&page=2&do=unsubscribe'],
    ['https://example.com/posts/7', '/posts/7/delete'],
    // The word is in the page's address, but somewhere else.
    ['https://example.com/help/logout-help', '/logout'],
    ['https://example.com/forum/why-sign-out-matters', '/users/sign_out'],
    ['https://example.com/search?q=delete', '/posts/7/delete'],
    ['https://example.com/login?reason=logout', '/account/logout?next=/x'],
    // The same segment, at another place in the path.
    ['https://example.com/delete/archive', '/posts/7/delete'],
  ]) {
    assert.equal(next(dom(`${list}<nav class="pagination"><a rel="next" href="${href}">Next</a></nav>`, page), page), null, href + ' from ' + page);
  }
});

test('toggling a site: both lists, in both modes', () => {
  const t = (s, host) => O.toggleLists(Object.assign({ runOn: 'all', allowHosts: [], disabledHosts: [] }, s), host);
  // Every site: off and on again.
  assert.deepEqual(t({}, 'a.example'), { on: false, allowHosts: [], disabledHosts: ['a.example'] });
  assert.deepEqual(t({ disabledHosts: ['a.example', 'b.example'] }, 'a.example'), { on: true, allowHosts: [], disabledHosts: ['b.example'] });
  // Only listed sites, listed by name: off takes it off the list.
  assert.deepEqual(t({ runOn: 'listed', allowHosts: ['a.example'] }, 'a.example'), { on: false, allowHosts: [], disabledHosts: [] });
  assert.deepEqual(t({ runOn: 'listed' }, 'a.example'), { on: true, allowHosts: ['a.example'], disabledHosts: [] });
  // Covered by a parent domain on the list: off holds against it, and on again lifts that.
  const off = t({ runOn: 'listed', allowHosts: ['example.com'] }, 'www.example.com');
  assert.deepEqual(off, { on: false, allowHosts: ['example.com'], disabledHosts: ['www.example.com'] });
  assert.deepEqual(t(Object.assign({ runOn: 'listed' }, off), 'www.example.com'), { on: true, allowHosts: ['example.com'], disabledHosts: [] });
  // Left over from "every site" mode: on clears it and lists the site.
  assert.deepEqual(t({ runOn: 'listed', disabledHosts: ['a.example'] }, 'a.example'), { on: true, allowHosts: ['a.example'], disabledHosts: [] });
});

test('a live page\'s raw <noscript> picture keys like the fetched copy of it', () => {
  // WordPress writes & in attributes as &#038;. A fetched copy decodes it; the live page's raw text used not to.
  const fetched = dom('<ul><li><img src="/blank.gif"><noscript><img src="/p/9.jpg?w=300&#038;h=200"></noscript></li></ul>').querySelector('li');
  const live = dom('<ul><li><img src="/blank.gif"></li></ul>').querySelector('li');
  const ns = live.ownerDocument.createElement('noscript');
  ns.textContent = '<img src="/p/9.jpg?w=300&#038;h=200">';
  live.appendChild(ns);
  assert.equal(O.itemKey(live, true), O.itemKey(fetched, true));
  const other = dom('<ul><li><img src="/blank.gif"><noscript><img src="/p/10.jpg?w=300&#038;h=200"></noscript></li></ul>').querySelector('li');
  assert.notEqual(O.itemKey(live, true), O.itemKey(other, true), 'the picture is what tells them apart');
  // Hex and named references too.
  const hex = dom('<ul><li><img src="/blank.gif"></li></ul>').querySelector('li');
  const ns2 = hex.ownerDocument.createElement('noscript');
  ns2.textContent = '<img src="/p/9.jpg?w=300&#x26;h=200">';
  hex.appendChild(ns2);
  assert.equal(O.itemKey(hex, true), O.itemKey(fetched, true));
});

test('rules: AutoPagerize/wedata items normalize and match; catch-alls are skipped', () => {
  const rules = O.normalizeRules([
    { name: 'generic', data: { url: '^https?://.', nextLink: '//a[@rel="next"]', pageElement: '//*[contains(@class,"autopagerize_page_element")]' } },
    { name: 'ex', data: { url: '^https://example\\.com/list', nextLink: '//a[@class="nx"]', pageElement: '//ul/li', insertBefore: '' } },
    { url: '([bad', next: 'a' },
    { url: '^https://site\\.org/', next: 'a.n', content: '.r > .i', click: true },
  ]);
  assert.equal(rules.length, 3);
  assert.equal(rules[1].next, '//a[@class="nx"]');
  assert.equal(rules[1].content, '//ul/li');
  assert.equal(O.matchRule(rules, 'https://example.com/list/?p=2').name, 'ex');
  assert.equal(O.matchRule(rules, 'https://unknown.net/'), null);
  assert.equal(O.matchRule(rules, 'https://site.org/x').click, true);
});

test('rules: excludeUrl skips a rule, and a broken one drops it', () => {
  const rules = O.normalizeRules([
    { url: '^https://ex\\.com/', next: 'a.n', excludeUrl: '/search' },
    { url: '^https://ex\\.com/', next: 'a.m' },
    { url: '^https://ex\\.com/', next: 'a.x', excludeUrl: '([bad' },
  ]);
  assert.equal(rules.length, 2, 'the rule with a broken excludeUrl is dropped');
  assert.equal(O.normalizeRules([{ url: '^https://ex\\.com/', next: 'a', excludeUrl: ['/search'] }]).length, 0, 'a non-string excludeUrl is refused, not ignored');
  assert.deepEqual(O.matchingRules(rules, 'https://ex.com/list').map((r) => r.next), ['a.n', 'a.m']);
  assert.deepEqual(O.matchingRules(rules, 'https://ex.com/search?q=1').map((r) => r.next), ['a.m']);
});

test('fittingRule: a rule is used only where it works on the page', () => {
  const d = dom('<div class="list"><div class="item">x</div></div><a class="m" href="/list/2">Next</a><a class="dead" href="#">Next</a>');
  const rules = [
    { url: 'x', next: 'a.n', content: '.list > .item' },
    { url: 'x', next: 'a.m', content: '.results > .row' },
    { url: 'x', next: '//a[@class="m"]', content: '.list > .item' },
  ];
  // fittingRule takes the page address so it can tell a usable next link from a dead one.
  assert.equal(O.fittingRule(rules, d, BASE), rules[2], 'next missing, then content missing, then a fit');
  assert.equal(O.fittingRule(rules.slice(0, 2), d, BASE), null, 'nothing fits');
  assert.equal(O.fittingRule([{ url: 'x', next: 'a.m' }], d, BASE).next, 'a.m', 'content is optional');
  assert.equal(O.fittingRule([{ url: 'x', next: 'a.dead' }], d, BASE), null, 'a next link going nowhere does not fit');
  assert.ok(O.fittingRule([{ url: 'x', content: '.list > .item' }], d, BASE), 'a content-only rule fits');
  assert.ok(O.fittingRule([{ url: 'x', mode: 'iframe' }], d, BASE), 'a mode-only rule fits');
});

test('chooseRule: site rules first, render retries, then list rules', () => {
  const href = 'https://example.com/list/';
  const page = dom('<ul class="posts"><li>a</li><li>b</li></ul><a class="next" href="/list/2">Next</a>');
  const noNext = dom('<ul class="posts"><li>a</li><li>b</li></ul>');
  const blank = dom('<p>loading…</p>');
  const fits = { url: '^https://example\\.com/', next: 'a.next', content: 'ul.posts > li' };
  const other = { url: '^https://example\\.com/', next: 'a.elsewhere', content: '.grid > .card' };
  const list = { url: '^https://example\\.com/list/', next: 'a.next' };
  assert.deepEqual(O.chooseRule([fits], [list], href, page, 0), { rule: fits, mine: true }, 'a site rule that works wins');
  assert.deepEqual(O.chooseRule([other], [list], href, blank, 0), { rule: null, wait: true }, 'not rendered yet: wait');
  assert.deepEqual(O.chooseRule([other], [list], href, page, 2), { rule: list }, 'after the retries, a list rule');
  assert.deepEqual(O.chooseRule([other], [], href, page, 2), { rule: null }, 'or detection');
  // Items first and the pager drawn later is common, so the retries come first;
  // after them the rule still supplies the items and detection finds the next link.
  assert.deepEqual(O.chooseRule([fits], [list], href, noNext, 0), { rule: null, wait: true }, 'the rule\'s items but no next link yet: wait');
  assert.deepEqual(O.chooseRule([fits], [list], href, noNext, 2), { rule: { ...fits, next: '', click: false, strictNext: true }, mine: true }, 'then its items, with strict detection for the next link');
  const excluded = { ...fits, excludeUrl: '/list/' };
  assert.deepEqual(O.chooseRule([excluded], [list], href, page, 0), { rule: list }, 'an excluded site rule does not count');
});

test('a rule\'s next link is taken unless it really is Previous', () => {
  const pick = (html, dir) => {
    const d = dom(`<div${dir ? ' dir="rtl"' : ''}>${html}</div>`);
    const r = O.findNext(d, BASE, { rule: { url: 'x', next: 'a.n, a.page-link' }, layout: false });
    return r ? r.el.textContent || r.el.getAttribute('aria-label') || r.el.querySelector('img').alt : null;
  };
  // Found wrongly rejected in review: a Previous word later in the label.
  for (const label of ['Next post: Backyard gardening', 'Next (last page)', 'Next: Prevention tips', 'Next: The first snow',
    'Load more (last 10 days)', 'Página siguiente', 'Back to school deals']) {
    assert.equal(pick(`<a class="n" href="/2">${label}</a>`), label, label);
  }
  assert.equal(pick('<a class="n" href="/2" title="Next. Use back to return">2</a>'), '2', 'a title that mentions back');
  assert.equal(pick('<a class="n next" href="/2"><img alt="arrow-back"></a>'), 'arrow-back', 'an icon named back on a next-classed link');
  assert.equal(pick('<a class="n" href="/1"><img alt="arrow-back"></a><a class="n" href="/3">Next</a>'), 'Next', 'with nothing saying next, that icon is Previous');
  assert.equal(pick('<a class="pagination__prev-next page-link" href="/2">Next post: A</a>'), 'Next post: A', 'a class with both words');
  // Previous in all its forms is still skipped; the real next link after it is taken.
  for (const prev of ['« Previous', 'Prev', 'Página anterior', 'Page précédente', 'Newer posts »', 'First', 'Last »', 'Zurück', '上一页', '‹',
    'Previous page of results', '« Previous post: How we built it']) {
    assert.equal(pick(`<a class="n" href="/1">${prev}</a><a class="n" href="/3">Next</a>`), 'Next', prev);
  }
  assert.equal(pick('<a class="page-link" aria-label="Go to the previous page" href="/1">1</a><a class="n" href="/3">3</a>'), '3', 'an aria-label that says previous');
  assert.equal(pick('<a class="n prev" href="/1">Older</a>'), 'Older', 'a label that says next beats a prev class');
  assert.equal(pick('<a class="n page-prev" href="/1">2</a><a class="n" href="/3">3</a>'), '3', 'a class that only says previous');
  assert.equal(pick('<a class="n" rel="prev" href="/1">Next</a><a class="n" href="/3">3</a>'), '3', 'rel=prev wins over the label');
  assert.equal(pick('<a class="n" href="/1">«</a><a class="n" href="/3">»</a>'), '»', 'a bare back arrow');
  assert.equal(pick('<a class="n" href="/3">«</a>', true), '«', 'which points forward on a right-to-left page');
  assert.equal(pick('<a class="n" href="/2">Entradas anteriores</a>'), 'Entradas anteriores', 'Spanish WordPress: older entries is next');
});

test('the default pages to stay off, and the host list', () => {
  // The pattern Onward ships with, not a copy of it.
  const skip = (path) => O.pathSkipped(O.DEFAULTS.skipPaths, path);
  for (const path of ['/checkout', '/checkout/step-2', '/cart', '/Cart/', '/basket.php', '/login', '/log-in', '/login.php', '/users/sign_in', '/signin', '/SignUp',
    '/register', '/account', '/account/orders', '/account/settings', '/my-account/', '/password/reset',
    // Named pages, as shop and CMS engines write them (Salesforce Commerce, Django, Plone).
    '/on/demandware.store/Sites-Shop-Site/en_US/Cart-Show', '/Checkout-Begin', '/Login-Show', '/Account-Show',
    '/accounts/password_reset/', '/login_form', '/checkout-step-2', '/account-settings']) assert.ok(skip(path), path);
  // A listing about the word isn't that page.
  for (const path of ['/', '/blog/page/2/', '/cartoons/page/3', '/accounts/list', '/forum/tips-for-login', '/registered-users?page=2', '/passwords-101',
    '/questions/tagged/login-page', '/topics/password-manager', '/tag/account-security/page/2/', '/category/cart-accessories/page/3', '/r/signup_bonuses/'])
    assert.ok(!skip(path), path);
  // A single-page app's #/route counts as its path; an anchor doesn't.
  for (const href of ['https://shop.example/#/checkout', 'https://shop.example/app#!/account/orders?x=1', 'https://shop.example/checkout?step=2#top'])
    assert.ok(O.pageSkipped(O.DEFAULTS.skipPaths, href), href);
  for (const href of ['https://shop.example/blog#checkout', 'https://shop.example/blog?page=2', 'https://shop.example/#/catalog/page/2'])
    assert.ok(!O.pageSkipped(O.DEFAULTS.skipPaths, href), href);
  assert.equal(O.pathSkipped('', '/checkout'), false, 'an empty pattern skips nothing');
  assert.equal(O.pathSkipped('([bad', '/checkout'), false, 'a broken pattern skips nothing');
  assert.ok(O.hostListed(['example.com'], 'www.example.com'));
  assert.ok(!O.hostListed(['example.com'], 'badexample.com'));
});

test('a site rule that supplied only the items takes a next page by address, not a next thread', () => {
  const rule = { url: '^https://example\\.com/', next: 'a.pg-next', content: 'ul.posts > li' };
  // The last page of a thread: the rule's items, no rule next link, and a link to the next thread.
  const thread = dom(`<ul class="posts">${items(3)}</ul><a class="next-thread" href="/t/124">Next thread ›</a>`, 'https://example.com/t/123');
  const choice = O.chooseRule([rule], [], 'https://example.com/t/123', thread, 2);
  assert.equal(choice.rule.strictNext, true);
  assert.equal(O.findNext(thread, 'https://example.com/t/123', { rule: choice.rule }), null, 'no next thread');
  // Another section with different pager markup: page 2 by address is fine.
  const tag = dom(`<ul class="posts">${items(3)}</ul><div class="nav"><a href="/tag/x?page=2">Older entries</a></div>`, 'https://example.com/tag/x');
  assert.equal(O.findNext(tag, 'https://example.com/tag/x', { rule: O.chooseRule([rule], [], 'https://example.com/tag/x', tag, 2).rule }).url, 'https://example.com/tag/x?page=2');
});

test('nextByAddress: the page after this one, going by the address', () => {
  const yes = [['https://e.com/l?page=3', 'https://e.com/l?page=4'], ['https://e.com/l', 'https://e.com/l?page=2'], ['https://e.com/tag/x/', 'https://e.com/tag/x/page/2/'],
    ['https://e.com/l?sort=new', 'https://e.com/l?sort=new&p=2'], ['https://e.com/blog/page/7/', 'https://e.com/blog/page/8/']];
  const no = [['https://e.com/t/123', 'https://e.com/t/124'], ['https://e.com/l', 'https://e.com/l?page=3'], ['https://e.com/l', 'https://e.com/other?page=2'],
    ['https://e.com/l', 'https://f.com/l?page=2'], ['https://e.com/l?sort=new', 'https://e.com/l?page=2']];
  for (const [a, b] of yes) assert.ok(O.nextByAddress(b, a), a + ' -> ' + b);
  for (const [a, b] of no) assert.ok(!O.nextByAddress(b, a), a + ' -/-> ' + b);
});

test('picker selectors: cssPath and uniqueSelector', () => {
  // The script calls CSS.escape as a browser global; jsdom 30 has it.
  globalThis.CSS = new JSDOM('').window.CSS;
  const one = (d, sel) => (/^(\(|\/)/.test(sel) ? d.evaluate(sel, d, null, 7, null).snapshotLength : d.querySelectorAll(sel).length);
  // Bootstrap: every pager link shares .page-item > .page-link, Previous included.
  const bs = dom(`<nav id="pages"><ul class="pagination">
    <li class="page-item"><a class="page-link" href="?page=1">Previous</a></li><li class="page-item active"><a class="page-link" href="?page=2">2</a></li>
    <li class="page-item"><a class="page-link" href="?page=3">3</a></li><li class="page-item"><a class="page-link" href="?page=3">Next&nbsp;»</a></li></ul></nav>`);
  const nextLink = [...bs.querySelectorAll('a.page-link')].at(-1);
  assert.equal(O.cssPath(nextLink), '#pages > ul.pagination > li.page-item > a.page-link', 'a stable unique id anchors the path; state classes are left out');
  assert.equal(one(bs, O.cssPath(nextLink)), 4, 'which every pager link matches');
  const sel = O.uniqueSelector(nextLink);
  assert.match(sel, /^\/\/a\[normalize-space\(translate/, 'so the picker falls back to the label: ' + sel);
  assert.equal(one(bs, sel), 1);
  assert.equal(bs.evaluate(sel, bs, null, 9, null).singleNodeValue, nextLink);
  // Two lists with the same classes: the pinned path tells them apart.
  const dup = dom('<div class="list"><div class="item">a</div><div class="item">b</div></div><div class="list"><div class="item">c</div><div class="item">d</div></div>');
  const c = dup.querySelectorAll('.item')[2];
  assert.equal(O.cssPath(c), 'div.list > div.item');
  assert.equal(one(dup, O.cssPath(c, true)), 1, O.cssPath(c, true));
  assert.equal(dup.querySelector(O.cssPath(c, true)), c);
  // Ids that look generated (3+ digits) or repeat on the page anchor nothing.
  const ids = dom('<main id="post-12345"><div id="pager" class="nav"><a class="nx" href="/2">Next</a></div><div id="pager" class="nav"><a class="nx" href="/2">Next</a></div></main>');
  const lower = ids.querySelectorAll('a.nx')[1];
  assert.equal(O.cssPath(lower), 'main > div.nav > a.nx');
  const u = O.uniqueSelector(lower);
  assert.equal(one(ids, u), 1, u);
  assert.equal(ids.evaluate(u, ids, null, 9, null).singleNodeValue, lower);
  // A state class on the path (the current page's li.active) is left out too.
  assert.equal(O.cssPath(bs.querySelector('li.active > a')), '#pages > ul.pagination > li.page-item > a.page-link');
  // An id that starts with a digit is fine to anchor on, escaped.
  const digit = dom('<div id="2nd"><a class="nx" href="/3">Next</a></div>');
  assert.equal(O.cssPath(digit.querySelector('a')), '#\\32 nd > a.nx');
  assert.equal(one(digit, O.cssPath(digit.querySelector('a'))), 1);
});

test('picker selectors: the bottom pager stays the bottom one, two classes, quotes and odd spaces', () => {
  globalThis.CSS = new JSDOM('').window.CSS;
  const hit = (d, sel) => d.evaluate(sel, d, null, 7, null);
  // Next above and below the list: the bottom one is saved as the last match,
  // so a page that shows a third (a sidebar) still gets the bottom one.
  const pager = '<div class="nav"><a class="nx" href="/2">Next</a></div>';
  const two = dom(`${pager}<ul>${items(3)}</ul>${pager}`);
  const bottom = two.querySelectorAll('a.nx')[1];
  const sel = O.uniqueSelector(bottom);
  assert.match(sel, /\[last\(\)\]$/, sel);
  const three = dom(`${pager}<ul>${items(3)}</ul><aside>${pager}</aside>${pager}`);
  assert.equal(hit(three, sel).snapshotItem(0), three.querySelectorAll('a.nx')[2]);
  // Two lists told apart only by their second class.
  const lists = dom('<ul class="list a"><li class="item">x</li><li class="item">y</li></ul><ul class="list b"><li class="item">z</li><li class="item">w</li></ul>');
  assert.equal(O.cssPath(lists.querySelector('ul.b > li')), 'ul.list.b > li.item');
  // Labels with quotes still make a working label XPath (not a position that shifts on page 2).
  for (const label of ["Page d'après", 'Say "next"', `It's "next"`]) {
    const d = dom(`<div class="pagination"><a class="page-link" href="/1">1</a><a class="page-link" href="/3">${label.replace(/"/g, '&quot;')}</a><a class="page-link" href="/4">4</a></div>`);
    const a = d.querySelectorAll('a')[1];
    const u = O.uniqueSelector(a);
    assert.match(u, /^\/\/a\[normalize-space\(translate/, label + ': ' + u);
    assert.equal(hit(d, u).snapshotLength, 1, u);
    assert.equal(hit(d, u).snapshotItem(0), a, u);
  }
  // A form feed is a space to the picker but not to XPath: the label test then
  // matches another link, and that must never be saved for this one.
  const ff = dom('<div class="p"><a class="n" href="/2">Next\fpage</a></div><div class="p"><a class="n" href="/9">Next page</a></div>');
  const mine = ff.querySelector('div.p a');
  const u2 = O.uniqueSelector(mine);
  const found = /^(\(|\/)/.test(u2) ? hit(ff, u2).snapshotItem(0) : ff.querySelector(u2);
  assert.equal(found, mine, u2);
});

test('rules from a downloaded list never click; rules you write can', () => {
  const clicky = [{ url: '^https://shop\\.example/', next: 'button.buy', click: true }];
  assert.equal(O.normalizeRules(clicky)[0].click, true, 'a rule written in Settings keeps click');
  assert.equal(O.normalizeRules(clicky, { fromList: true })[0].click, false, 'a list rule loses it');
  assert.equal(O.acceptRuleList(undefined, JSON.stringify(clicky), 1).entry.rules[0].click, false, 'downloads are stored without it');
  // A list cached by an older version still can't click.
  const d = dom('<button class="buy">Buy</button>', 'https://shop.example/cart');
  const legacy = [{ url: '^https://shop\\.example/', next: 'button.buy', click: true }];
  assert.equal(O.chooseRule([], legacy, 'https://shop.example/cart', d, 2).rule, null, 'no clicking rule from a list');
});

test('rule lists: packing round-trips', async () => {
  const value = { hosts: { 'a.com': [0, 2] }, rules: Array.from({ length: 50 }, (_, i) => ({ url: '^https://site' + i + '\\.example/', next: 'a.next' })) };
  const packed = await O.packJSON(value);
  assert.ok(!packed.startsWith('j:'), 'gzipped here');
  assert.ok(packed.length < JSON.stringify(value).length / 3, 'and much smaller: ' + packed.length);
  assert.deepEqual(await O.unpackJSON(packed), value);
  assert.deepEqual(await O.unpackJSON('j:' + JSON.stringify(value)), value, 'the plain fallback reads back too');
});

test('rule lists: the hosts a pattern names', () => {
  const cases = [
    ['^https?://example\\.com/list', ['example.com']],
    ['^https://www.amazon.co.jp/vine/', ['www.amazon.co.jp']],
    ['^https?://(?:www\\.)?example\\.com/', ['www.example.com', 'example.com']],
    ['^https://xxxclub\\.(cc|to)/', ['xxxclub.cc', 'xxxclub.to']],
    ['^https://www\\.dmm\\.co(?:m|\\.jp)/mono/', ['www.dmm.com', 'www.dmm.co.jp']],
    ['^https?://example\\.com:8080/', ['example.com']],
    ['^https?://example\\.com(?:/|$)', ['example.com']],
    ['https://www.dlsite.com/*/mypage', ['www.dlsite.com']],
    ['^http:\\/\\/old\\.example\\.org\\/', ['old.example.org']],
  ];
  for (const [pattern, hosts] of cases) assert.deepEqual(O.literalHosts(pattern), hosts, pattern);
  for (const pattern of ['^https?://[^/]+\\.weblio\\.jp/', '^https?://.', '^https://\\d+\\.peta2\\.jp/', '^(https://)?m\\.xsnvshen\\.com/', '^https?://\\w+\\.example\\.com/'])
    assert.equal(O.literalHosts(pattern), null, pattern);
});

test('rule lists: the text every match of a pattern needs', () => {
  const cases = [
    ['^https://[^/]+\\.weblio\\.jp/.', '.weblio.jp/'],
    ['^https?://(?:[^.]+\\.)?breached\\.vc/', 'breached.vc/'],
    ['^https?://[^./]+\\.google(?:\\.[^./]{2,3}){1,2}/search', '.google'],
    ['^(https://)?m\\.xsnvshen\\.com/album/', 'm.xsnvshen.com/album/'],
    ['^https?://.', 'http'],
    ['^https?://(a|b)\\.example\\.com/', '.example.com/'],
    ['foo|bar', ''],
    ['^https?://x\\.y/', '://x.y/'],
    ['^\\d+/[a-z]+/\\d', ''],
    ['^https?://blogs?\\.example\\.com/', '.example.com/'],
  ];
  for (const [pattern, lit] of cases) assert.equal(O.requiredLiteral(pattern), lit, pattern);
});

test('rule lists: a page looks up its host and only the other rules its address matches', async () => {
  const rules = O.normalizeRules([
    { url: '^https://example\\.com/list', next: 'a.n' },
    { url: '^https://example\\.com/', next: 'a.m' },
    { url: '^https://other\\.com/', next: 'a.n' },
    { url: '^https?://[^/]+\\.blogspot\\.com/', next: 'a.b' },
    { url: '^https?://.', next: 'a.all' },
  ], { fromList: true });
  O.forgetListRules();
  const entry = await O.buildListEntry(rules, 5);
  assert.equal(entry.count, 5, 'the count covers the whole list');
  assert.equal(entry.hosts, '\nexample.com 0,1\nother.com 2\n', 'a line per host');
  assert.deepEqual(entry.generic.map((g) => g[1]), ['.blogspot.com/'], 'the catch-all is left out; the other keeps the text it needs');
  assert.equal((await O.unpackJSON(entry.rules)).length, 3, 'the rules indexed by host');
  assert.equal((await O.unpackJSON(entry.general)).length, 1, 'the general one, packed apart');
  const cache = { 'https://lists.example/one.json': entry };
  const at = async (href) => (await O.listRulesFor(cache, href)).map((r) => r.next);
  assert.deepEqual(await at('https://example.com/list/2'), ['a.n', 'a.m'], 'its host, longest pattern first');
  assert.deepEqual(await at('https://foo.blogspot.com/2024/'), ['a.b']);
  assert.deepEqual(await at('https://unlisted.example.net/'), []);
  assert.deepEqual(await at('https://ample.com/'), [], 'a host line is matched whole');
  const [first] = await O.listRulesFor(cache, 'https://other.com/x');
  assert.equal(first.source, 'https://lists.example/one.json', 'each rule knows its list');
  assert.equal(first.click, false);
  // A list kept unpacked by an earlier build is still read.
  const legacy = { 'https://lists.example/old.json': { rules: rules.slice(2, 3), at: 1 } };
  assert.deepEqual((await O.listRulesFor(legacy, 'https://other.com/')).map((r) => r.next), ['a.n']);
});

test('rule lists: a page only a general rule matches never unpacks the rules indexed by host', async () => {
  const rules = O.normalizeRules([
    { url: '^https://example\\.com/', next: 'a.m', content: '.x' },
    { url: '^https?://(www\\.)?.+\\.com/', next: 'a.g', content: '.y' },
  ], { fromList: true });
  O.forgetListRules();
  const entry = await O.buildListEntry(rules, 5);
  // Proof it's never read: a host pack that can't be unpacked.
  const cache = { list: Object.assign({}, entry, { rules: 'j:{broken' }) };
  const found = await O.listRulesFor(cache, 'https://shop.unlisted.com/list?page=2');
  assert.deepEqual(found.map((r) => [r.url, r.next, r.content, r.source]), [['^https?://(www\\.)?.+\\.com/', 'a.g', '.y', 'list']]);
  // An entry from before the split (one pack, general rules numbered among all) still reads.
  O.forgetListRules();
  const old = { list: { at: 1, count: 2, hosts: '\nexample.com 0\n', generic: [[1, '.com/', rules[1].url]], rules: await O.packJSON(rules.map((r) => ({ url: r.url, next: r.next, content: r.content }))) } };
  assert.deepEqual((await O.listRulesFor(old, 'https://example.com/a')).map((r) => r.next), ['a.m', 'a.g']);
});

test('rules 0.1.0 kept flattened are only tested while some list has no copy of its own', async () => {
  const rules = O.normalizeRules([{ url: '^https://example\\.com/', next: 'a.m' }], { fromList: true });
  O.forgetListRules();
  const packed = await O.buildListEntry(rules, 5);
  const href = 'https://example.com/a';
  const n = async (cache, sources) => (await O.candidateRules(cache, rules, sources, href)).length;
  assert.equal(await n({}, ['L']), 1, 'no copy yet: the flattened rules stand in');
  assert.equal(await n({ L: packed }, ['L']), 1, 'the packed copy, once');
  assert.equal(await n({ L: { rules, at: 1 } }, ['L']), 1, 'an unpacked copy from an earlier build, once');
  assert.equal(await n({ L: packed }, ['L', 'M']), 2, 'M has no copy, so the flattened rules still count');
});

test('a rule list that comes back broken keeps the last good copy', () => {
  const good = { rules: O.normalizeRules([{ url: '^https://a\\.com/', next: 'a.n' }, { url: '^https://b\\.com/', next: 'a.n' }, { url: '^https://c\\.com/', next: 'a.n' }]), at: 1 };
  const html = '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>'.padEnd(122, ' ');
  assert.equal(html.length, 122);
  const bad = O.acceptRuleList(good, html, 2);
  assert.equal(bad.entry, good, 'the old copy stays');
  assert.match(bad.error, /not JSON/);
  assert.match(O.acceptRuleList(good, '[]', 2).error, /no rules/);
  assert.match(O.acceptRuleList(good, JSON.stringify([{ url: '^https://a\\.com/', next: 'x' }]), 2).error, /down from 3/);
  assert.match(O.acceptRuleList({ count: 10, index: 'x', rules: 'y', at: 1 }, JSON.stringify([{ url: '^https://a\\.com/', next: 'x' }]), 2).error, /down from 10/, 'a packed copy counts too');
  const fresh = O.acceptRuleList(good, JSON.stringify([{ url: '^https://d\\.com/', next: 'x' }, { url: '^https://e\\.com/', next: 'x' }]), 2);
  assert.equal(fresh.error, undefined);
  assert.equal(fresh.entry.rules.length, 2);
  assert.equal(fresh.entry.at, 2);
  assert.equal(O.acceptRuleList(undefined, html, 2).entry, undefined, 'no old copy: nothing to keep');
});

test('item keys: same item, same key; different item or picture, different key', () => {
  const a = [...dom(`<ul>${items(3)}</ul>`).querySelectorAll('li')];
  const b = [...dom(`<ul>${items(3)}</ul>`).querySelectorAll('li')];
  const c = [...dom(`<ul>${items(3, 'post', 4)}</ul>`).querySelectorAll('li')];
  assert.deepEqual(a.map(O.itemKey), b.map(O.itemKey));
  assert.equal(new Set([...a, ...c].map(O.itemKey)).size, 6);
  // Text-free picture items differ by their image.
  const pics = [...dom('<ul><li><img src="/a.jpg"></li><li><img src="/b.jpg"></li></ul>').querySelectorAll('li')];
  assert.notEqual(O.itemKey(pics[0]), O.itemKey(pics[1]));
});

test('repeats: a page repeated after the site lazy-loaded its images is still caught', () => {
  // Page 1 on screen: the site's loader has swapped src (and here dropped data-src).
  const live = dom('<ul><li class="post"><a href="/p/1">One</a><img src="/img/1.jpg"></li>'
    + '<li class="pic"><img src="/img/2.jpg"></li></ul>').querySelectorAll('li');
  // The same page fetched again, before any loader ran.
  const fetched = dom('<ul><li class="post"><a href="/p/1">One</a><img src="data:image/gif;base64,R0lGOD" data-src="/img/1.jpg"></li>'
    + '<li class="pic"><img src="/placeholder.gif" data-src="/img/2.jpg"></li></ul>').querySelectorAll('li');
  assert.deepEqual([...live].map(O.itemKey), [...fetched].map(O.itemKey));
  const seen = new Set([...live].map(O.itemKey));
  assert.equal(O.splitRepeats([...fetched], seen).repeatShare, 1);
  // A loader that picks a sized copy changes the address itself; an item with text is known by its text and link.
  const sized = dom('<ul><li class="post"><a href="/p/1">One</a><img src="/img/1.jpg?w=640"></li></ul>').querySelector('li');
  assert.equal(O.itemKey(sized), O.itemKey(fetched[0]));
});

test('repeats: picture-only items with one placeholder each keep their own key', () => {
  const pics = (from) => [...dom(`<ul>${[0, 1, 2].map((i) => `<li><img src="/blank.gif" data-original="/img/${from + i}.jpg"></li>`).join('')}</ul>`).querySelectorAll('li')];
  const first = pics(1);
  assert.equal(new Set(first.map(O.itemKey)).size, 3);
  const second = O.splitRepeats(pics(4), new Set(first.map(O.itemKey)));
  assert.equal(second.fresh.length, 3, 'a page of new pictures is all new');
  assert.equal(second.repeatShare, 0);
  // With nothing but a srcset, the srcset tells them apart, past a placeholder src.
  const sets = [...dom('<ul><li><img srcset="/a.jpg 1x"></li><li><img srcset="/b.jpg 1x"></li></ul>').querySelectorAll('li')];
  assert.notEqual(O.itemKey(sets[0]), O.itemKey(sets[1]));
  const lazySets = [...dom('<ul><li><img src="/blank.gif" data-srcset="/a.jpg 1x"></li><li><img src="/blank.gif" data-srcset="/b.jpg 1x"></li></ul>').querySelectorAll('li')];
  assert.notEqual(O.itemKey(lazySets[0]), O.itemKey(lazySets[1]));
});

test('repeats: layout filler is kept on every page and does not count', () => {
  // Hacker News-style rows: story, details, spacer.
  const rows = (start) => [...dom(`<table><tbody>${[0, 1, 2].map((i) => `<tr class="athing"><td><a href="/item?id=${start + i}">Story ${start + i}</a></td></tr>`
    + `<tr><td>${start + i} points</td></tr><tr class="spacer" style="height:5px"></tr>`).join('')}</tbody></table>`, BASE).querySelectorAll('tr')];
  const seen = new Set(rows(1).map(O.itemKey).filter(Boolean));
  const second = O.splitRepeats(rows(4), seen);
  assert.equal(second.fresh.filter((r) => r.className === 'spacer').length, 3, 'every spacer row stays');
  assert.equal(second.repeatShare, 0);
  const again = O.splitRepeats(rows(1), seen);
  assert.deepEqual(again.fresh.map((r) => r.className), ['spacer', 'spacer', 'spacer'], 'only filler is new on a repeated page');
  assert.equal(again.repeatShare, 1, 'which is still all repeats');
  // Bootstrap clearfix divs in a float grid.
  const grid = [...dom('<div class="row"><div class="col"><a href="/a">A</a></div><div class="clearfix"></div><div class="col"><a href="/b">B</a></div><div class="clearfix"></div></div>').querySelectorAll('.row > div')];
  assert.equal(O.itemKey(grid[1]), null);
  assert.equal(O.splitRepeats(grid, new Set(grid.map(O.itemKey).filter(Boolean))).fresh.length, 2, 'both clearfix divs stay');
  assert.equal(O.splitRepeats([grid[1]], new Set()).repeatShare, 1, 'a page of nothing but filler has nothing new');
});

test('repeats: items that share their text and link on a page are told apart by their picture', () => {
  const walls = (from) => [...dom(`<ul>${[0, 1, 2, 3, 4].map((i) => `<li><img src="/wall/${from + i}.jpg"><button>Download</button></li>`).join('')}</ul>`).querySelectorAll('li')];
  const seen = new Set(O.pageKeys(walls(1)));
  assert.equal(seen.size, 5);
  const next = O.splitRepeats(walls(6), seen);
  assert.equal(next.fresh.length, 5, 'a page of new wallpapers is new');
  assert.equal(O.splitRepeats(walls(1), seen).repeatShare, 1, 'the same page again is still caught');
  const photos = (from) => [...dom(`<ul>${[0, 1, 2].map((i) => `<li><a href="#"><img src="/photo/${from + i}.jpg"></a></li>`).join('')}</ul>`).querySelectorAll('li')];
  assert.equal(O.splitRepeats(photos(4), new Set(O.pageKeys(photos(1)))).fresh.length, 3, 'pictures linked to #');
});

test('repeats: pictures kept in lazy srcsets, <picture>, noscript copies and backgrounds', () => {
  // Each kind: the same page again is all repeats, a page of other pictures all new.
  const check = (item, label) => {
    const page = (from) => [...dom(`<ul>${[0, 1, 2].map((i) => item(from + i)).join('')}</ul>`).querySelectorAll('ul > li')];
    const seen = new Set(O.pageKeys(page(1)));
    assert.equal(seen.size, 3, label + ': three pictures');
    assert.equal(O.splitRepeats(page(1), seen).repeatShare, 1, label + ': the same page again is caught');
    assert.equal(O.splitRepeats(page(4), seen).fresh.length, 3, label + ': other pictures are new');
  };
  check((k) => `<li><img src="/blank.gif" data-lazy-srcset="/p/${k}.jpg 1x"></li>`, 'data-lazy-srcset');
  check((k) => `<li><picture><source data-srcset="/p/${k}.webp"><img src="/blank.gif"></picture></li>`, 'a picture source');
  check((k) => `<li><img src="/blank.gif"><noscript><img src="/p/${k}.jpg"></noscript></li>`, 'a noscript copy');
  check((k) => `<li class="tile" style="background-image:url(/t/${k}.jpg)"></li>`, 'a background');
  check((k) => `<li data-bg="/t/${k}.jpg"></li>`, 'data-bg');
  // A picture that can't be told apart from the others is always new, never a repeat.
  const blank = () => [...dom('<ul><li><img src="/blank.gif"></li><li><img src="/blank.gif"></li></ul>').querySelectorAll('li')];
  const r = O.splitRepeats(blank(), new Set(O.pageKeys(blank())));
  assert.deepEqual([r.fresh.length, r.repeatShare], [2, 0]);
});

test('repeats: a live page\'s <noscript> text is not part of an item', () => {
  // With scripts on, a live page keeps <noscript> content as raw text; a fetched copy parses it.
  const fetched = dom('<ul><li><a href="/p/1">One</a><noscript><img src="/p/1.jpg"></noscript></li></ul>').querySelector('li');
  const live = dom('<ul><li><a href="/p/1">One</a></li></ul>').querySelector('li');
  const ns = live.ownerDocument.createElement('noscript');
  ns.textContent = '<img src="/p/1.jpg">';
  live.appendChild(ns);
  assert.equal(O.itemKey(live), O.itemKey(fetched));
  // A picture-only item: on the live page its real address is only in that raw text.
  const pic = (d) => d.querySelector('li');
  const fetchedPic = pic(dom('<ul><li><img src="/blank.gif"><noscript><img src="/p/9.jpg"></noscript></li></ul>'));
  const livePic = pic(dom('<ul><li><img src="/blank.gif"></li></ul>'));
  const ns2 = livePic.ownerDocument.createElement('noscript');
  ns2.textContent = '<img src="/p/9.jpg">';
  livePic.appendChild(ns2);
  assert.equal(O.itemKey(livePic), O.itemKey(fetchedPic));
});

test('repeats: a long first post on every page does not end paging', () => {
  const long = 'A long opening post that every page repeats. '.repeat(140); // about 6,300 characters
  const page = (start) => dom(`<ul><li class="post"><p>${long}</p></li>${items(4, 'post', start)}</ul>`).querySelectorAll('ul > li');
  const seen = new Set([...page(1)].map(O.itemKey));
  const second = O.splitRepeats([...page(5)], seen);
  assert.equal(second.fresh.length, 4, 'only the repeated first post is dropped');
  assert.ok(second.repeatShare < 0.9, 'page 2 keeps paging');
  const again = O.splitRepeats([...page(1)], seen);
  assert.equal(again.fresh.length, 0, 'the same page again is all repeats');
  assert.equal(again.repeatShare, 1);
});

test('page bar wrapper matches the list type', () => {
  const d = dom('<ul></ul><table><tbody></tbody></table><div></div>');
  assert.deepEqual(O.barTag(d.querySelector('ul')), { outer: 'li' });
  assert.deepEqual(O.barTag(d.querySelector('tbody')), { outer: 'tr', inner: 'td' });
  assert.deepEqual(O.barTag(d.querySelector('div')), { outer: 'div' });
});

test('interleaved table rows (Hacker News style) are all kept, the More row is not', () => {
  const rows = (start) => Array.from({ length: 5 }, (_, i) => `<tr class="athing"><td class="title"><a href="/item?id=${start + i}">Story ${start + i} headline</a></td></tr>
    <tr><td class="subtext">${start + i} points by someone 1 hour ago | ${i} comments</td></tr><tr class="spacer"></tr>`).join('');
  const page = (p) => dom(`<table><tbody>${rows(p * 10)}<tr class="morespace"></tr><tr><td class="title"><a href="/news?p=${p + 1}" class="morelink" rel="next">More</a></td></tr></tbody></table>`, `https://news.example.com/news?p=${p}`);
  const live = page(1);
  const n = next(live, 'https://news.example.com/news?p=1');
  assert.equal(n.url, 'https://news.example.com/news?p=2');
  const content = O.findContent(live, { nextEl: n.el });
  assert.equal(content.container.tagName, 'TBODY');
  assert.equal(content.items.length, 16, '5 x 3 rows + morespace, no More row');
  const p2 = page(2);
  const n2 = next(p2, 'https://news.example.com/news?p=2');
  const got = O.extractItems(p2, { path: O.describePath(content.container), shape: O.itemShape(content.items) }, n2.el);
  assert.equal(got.filter((r) => r.querySelector('.subtext')).length, 5, 'subtext rows kept');
  assert.equal(got.filter((r) => r.querySelector('.morelink')).length, 0, 'More row dropped');
});
