// Runs the real userscript in headless Chromium against the fixture site.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const site = require('./site');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../src/onward.user.js'), 'utf8');
// ONWARD_WORLD=isolated (npm run e2e:isolated) runs the script in an isolated
// world, as Tampermonkey and Violentmonkey do, instead of the page's own. The
// tests don't change: the page world reaches the script through DOM events and
// attributes, the only things both worlds share.
const WORLD = process.env.ONWARD_WORLD === 'isolated' ? 'isolated' : 'main';
// GM storage in window.__gm, seeded from the page world's window.__gm, with
// writes mirrored to data-onward-test-gm and reads counted in data-onward-test-reads.
// Menu commands also answer an onward-test-menu event.
const SHIM = `(() => {
  const root = document.documentElement;
  const seeded = root.getAttribute('data-onward-test-gm');
  window.__gm = seeded ? JSON.parse(seeded) : (window.__gm || {});
  const reads = {};
  window.GM_getValue = (k, d) => {
    reads[k] = (reads[k] || 0) + 1;
    root.setAttribute('data-onward-test-reads', JSON.stringify(reads));
    return k in window.__gm ? window.__gm[k] : d;
  };
  window.GM_setValue = (k, v) => { window.__gm[k] = v; root.setAttribute('data-onward-test-gm', JSON.stringify(window.__gm)); };
  window.__menu = {};
  window.GM_registerMenuCommand = (name, fn) => { window.__menu[name] = fn; };
  document.addEventListener('onward-test-menu', (e) => { const fn = window.__menu[e.detail]; if (fn) fn(); });
})();
`;
// In the page world when the script runs isolated: window.__gm reads the mirror, and window.__menu[name]() sends the event.
const BRIDGE = `(() => {
  const root = document.documentElement;
  Object.defineProperty(window, '__gm', { configurable: true, get: () => JSON.parse(root.getAttribute('data-onward-test-gm') || '{}') });
  window.__menu = new Proxy({}, { get: (_, name) => () => document.dispatchEvent(new CustomEvent('onward-test-menu', { detail: String(name) })) });
})()`;

/**
 * Runs the script (after a GM shim) on the page, in the chosen world.
 * Playwright's console and pageerror events report both worlds.
 */
async function inject(pg, shim = SHIM) {
  if (WORLD === 'main') return pg.addScriptTag({ content: shim + SCRIPT });
  // The page world's settings travel as an attribute.
  await pg.evaluate(() => document.documentElement.setAttribute('data-onward-test-gm', JSON.stringify(window.__gm || {})));
  await pg.evaluate(BRIDGE);
  const cdp = await pg.context().newCDPSession(pg);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'onward-e2e', grantUniveralAccess: true });
  const r = await cdp.send('Runtime.evaluate', { expression: shim + SCRIPT, contextId: executionContextId });
  if (r.exceptionDetails) throw new Error('the script failed in the isolated world: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  pg.onwardWorld = { cdp, contextId: executionContextId };
  return null;
}

/** Runs fn where the script runs (to stub a built-in it uses, say). */
async function inScriptWorld(pg, fn) {
  if (WORLD === 'main') return pg.evaluate(fn);
  const { cdp, contextId } = pg.onwardWorld;
  const r = await cdp.send('Runtime.evaluate', { expression: '(' + fn.toString() + ')()', contextId, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

let server, browser, base;

test.before(async () => {
  server = await site.start();
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
});

/** Opens url in a new context; prepare runs in the page's world first, and shim where the script runs. */
async function open(url, prepare, arg, shim = SHIM) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pg = await ctx.newPage();
  const errors = [];
  const logs = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  pg.on('console', (m) => logs.push(m.text()));
  await pg.goto(base + url, { waitUntil: 'load' });
  if (prepare) await pg.evaluate(prepare, arg);
  await inject(pg, shim);
  return { pg, ctx, errors, logs };
}

async function scrollToEnd(pg, until, rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await pg.waitForTimeout(350);
    if (await pg.evaluate(until)) return true;
  }
  return false;
}

const pageBars = () => ({
  bars: Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').filter((t) => /Page \d|Loading/.test(t)),
  posts: Array.from(document.querySelectorAll('#list > li.post > a')).map((a) => a.textContent),
});

const onwardText = () => Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').join(' | ');

const endBar = () => Array.from(document.querySelectorAll('[data-onward]'))
  .some((w) => /No more|End of results|No more items/.test(w.shadowRoot?.textContent || ''));

test('the script runs in the world the run says', async () => {
  // In an isolated world the page can't see the GM shim; in the page's own world it can.
  const { pg, ctx, logs } = await open('/blog?page=1');
  assert.equal(await pg.evaluate(() => typeof window.GM_getValue), WORLD === 'isolated' ? 'undefined' : 'function');
  // Its console messages reach the test once, from either world.
  await pg.waitForTimeout(300);
  assert.equal(logs.filter((l) => /\[Onward\] active:/.test(l)).length, 1);
  await ctx.close();
});

test('a listener in the page\'s own world gets onward:page with the page number', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1', () => {
    window.__pages = [];
    addEventListener('onward:page', (e) => window.__pages.push(e.detail && e.detail.page));
  });
  assert.ok(await scrollToEnd(pg, endBar), 'paged to the end');
  assert.deepEqual(await pg.evaluate(() => window.__pages), [2, 3, 4]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('blog: appends pages 2-4, fixes lazy images, updates URL, stops at the end', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  assert.ok(await scrollToEnd(pg, endBar), 'end bar shown');
  const r = await pg.evaluate(() => ({
    posts: document.querySelectorAll('ul.posts > li.post').length,
    bars: document.querySelectorAll('ul.posts > li[data-onward]').length,
    lastImg: [...document.querySelectorAll('ul.posts > li.post img')].at(-1).getAttribute('src'),
    url: location.href,
    pagers: document.querySelectorAll('.pagination').length,
  }));
  assert.equal(r.posts, site.PER * site.LAST);
  assert.ok(r.bars >= site.LAST - 1, 'page bars are li elements inside the list');
  assert.match(r.lastImg, /\/img\/20\.png$/);
  assert.match(r.url, /page=4$/);
  assert.equal(r.pagers, 1, 'pager is not copied');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('with page bars hidden, the address still follows the page in view', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1', () => { window.__gm = { separators: false }; });
  assert.ok(await scrollToEnd(pg, endBar), 'paged to the end');
  const search = async () => { await pg.waitForTimeout(400); return pg.evaluate(() => location.search); };
  assert.equal(await search(), '?page=4', 'at the end');
  const markers = await pg.evaluate(() => Array.from(document.querySelectorAll('ul.posts > li[data-onward]')).map((m) => ({
    height: m.getBoundingClientRect().height,
    display: getComputedStyle(m).display,
  })));
  assert.ok(markers.slice(0, 3).every((m) => m.height === 0 && m.display === 'none'), 'page bars are out of the layout');
  await pg.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await search(), '?page=1', 'back at the top');
  // An item the page hides (an ad blocker, say) doesn't mark where its page starts.
  await pg.addStyleTag({ content: 'li.post:has(> a[href$="/post/16"]) { display: none }' });
  // Put page 3's first post just under the top of the window: page 3 is in view.
  const top = await pg.evaluate(() => document.querySelector('a[href$="/post/11"]').closest('li').getBoundingClientRect().top + scrollY);
  await pg.evaluate((y) => window.scrollTo(0, y), top - 100);
  assert.equal(await search(), '?page=3', 'mid-page');
  assert.deepEqual(errors, []);
  await ctx.close();
});

for (const shown of [true, false]) {
  test(`in a column flex list, ${shown ? 'a page bar takes its own height' : 'a hidden page bar takes none'}`, async () => {
    const { pg, ctx, errors } = await open('/flexcol?page=1', (s) => { window.__gm = { separators: s }; }, shown);
    await pg.evaluate(() => { window.__menu['Load next page now'](); });
    await pg.waitForFunction(() => document.querySelectorAll('ul.posts > li.post').length > 5);
    const heights = await pg.evaluate(() => Array.from(document.querySelectorAll('ul.posts > li[data-onward]')).map((m) => m.getBoundingClientRect().height));
    assert.equal(heights.length, 1);
    if (shown) assert.ok(heights[0] > 0 && heights[0] < 100, 'a bar, not the list\'s 600 px: ' + heights[0]);
    else assert.equal(heights[0], 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('page bars in a grid or a table take no more room than the bar, and none when hidden', async () => {
  const { pg, ctx, errors } = await open('/gridlist?page=1', () => { window.__gm = { separators: false }; });
  await pg.evaluate(() => { window.__menu['Load next page now'](); });
  await pg.waitForFunction(() => document.querySelectorAll('ul.posts > li.post').length > 5);
  const gap = await pg.evaluate(() => {
    const posts = document.querySelectorAll('ul.posts > li.post');
    return Math.round(posts[5].getBoundingClientRect().top - posts[0].getBoundingClientRect().bottom);
  });
  assert.equal(gap, 30, 'one row gap between pages, as between rows');
  await ctx.close();
  const t = await open('/forum/1.html', () => {
    window.__gm = { separators: false };
    const st = document.createElement('style');
    st.textContent = 'td{height:40px}';
    document.head.append(st);
  });
  await t.pg.evaluate(() => { window.__menu['Load next page now'](); });
  await t.pg.waitForFunction(() => document.querySelectorAll('tbody > tr[data-onward]').length > 0 && document.querySelectorAll('tbody > tr.thread').length > 5);
  assert.deepEqual(await t.pg.evaluate(() => Array.from(document.querySelectorAll('tbody > tr[data-onward]')).map((m) => m.getBoundingClientRect().height)), [0]);
  await t.ctx.close();
  // A shown bar in the same table is as tall as the bar, not the site's cell height.
  const v = await open('/forum/1.html', () => {
    const st = document.createElement('style');
    st.textContent = 'td{height:140px}';
    document.head.append(st);
  });
  await v.pg.evaluate(() => { window.__menu['Load next page now'](); });
  await v.pg.waitForFunction(() => document.querySelectorAll('tbody > tr.thread').length > 5);
  const [shown] = await v.pg.evaluate(() => Array.from(document.querySelectorAll('tbody > tr[data-onward]')).map((m) => m.getBoundingClientRect().height));
  assert.ok(shown > 0 && shown < 100, 'a bar-sized row: ' + shown);
  assert.deepEqual([...errors, ...t.errors, ...v.errors], []);
  await v.ctx.close();
});

test('forum table in windows-1252 with a 下一页 link', async () => {
  const { pg, ctx, errors } = await open('/forum/1.html');
  assert.ok(await scrollToEnd(pg, endBar));
  const r = await pg.evaluate(() => ({
    rows: document.querySelectorAll('#threads tr.thread').length,
    last: [...document.querySelectorAll('#threads tr.thread td:first-child')].at(-1).textContent,
    barRow: !!document.querySelector('#threads tr[data-onward] > td'),
  }));
  assert.equal(r.rows, site.PER * site.LAST);
  assert.equal(r.last, 'Café thread 20');
  assert.ok(r.barRow);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('script-rendered grid falls back to an iframe', async () => {
  const { pg, ctx, errors } = await open('/spa?page=1');
  assert.ok(await scrollToEnd(pg, endBar, 40));
  const cards = await pg.evaluate(() => Array.from(document.querySelectorAll('#cards > article.card')).map((c) => c.textContent));
  assert.equal(cards.length, site.PER * site.LAST);
  assert.match(cards.at(-1), /^Card 20/);
  assert.equal(await pg.evaluate(() => document.querySelectorAll('iframe').length), 0, 'iframes cleaned up');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('iframe fallback is sandboxed and silenced, and a frame buster cannot take the tab', async () => {
  const { pg, ctx, errors } = await open('/buster?page=1', () => {
    window.__alive = true;
    window.__frames = [];
    window.__media = [];
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        if (n.tagName === 'IFRAME') window.__frames.push({ sandbox: n.getAttribute('sandbox'), allow: n.getAttribute('allow') });
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('message', (e) => { if (e.data && e.data.type === 'media') window.__media.push(e.data); });
  });
  assert.ok(await scrollToEnd(pg, endBar, 40));
  const r = await pg.evaluate(() => ({
    alive: window.__alive === true,
    url: location.href,
    frames: window.__frames,
    media: window.__media,
    cards: document.querySelectorAll('#cards > article.card').length,
  }));
  assert.ok(r.alive, 'still the same document');
  assert.doesNotMatch(r.url, /busted/);
  assert.equal(r.cards, site.PER * site.LAST, 'pages still append');
  assert.ok(r.frames.length >= 1);
  for (const f of r.frames) {
    assert.equal(f.sandbox, 'allow-scripts allow-same-origin');
    assert.equal(f.allow, "autoplay 'none'");
  }
  // One report per track and frame, as the frame goes; keyed in case a frame reports twice.
  const last = {};
  for (const m of r.media) last[m.page + ' ' + m.where] = m;
  assert.equal(Object.keys(last).length, 2 * (site.LAST - 1), 'both tracks on every iframe page reported: ' + JSON.stringify(r.media));
  for (const m of Object.values(last)) assert.ok(m.muted && m.paused, 'iframe media muted and paused: ' + JSON.stringify(m));
  // The only page errors are the sandbox refusing each frame buster.
  assert.ok(errors.length >= 1, 'frame buster ran and was refused');
  for (const e of errors) assert.match(e, /does not have permission to navigate the target frame/);
  await ctx.close();
});

test('a list the site redraws switches to wrapped pages', async () => {
  const { pg, ctx, errors } = await open('/redraw?page=1');
  // The inline pass may finish before the redraw, so wait for the wrapped result itself.
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('ul.posts[data-onward-page] > li.post').length >= 15, 60));
  await pg.waitForTimeout(600);
  const r = await pg.evaluate(() => ({
    original: document.querySelectorAll('#app > ul.posts:not([data-onward-page]) > li.post').length,
    wrapped: document.querySelectorAll('ul.posts[data-onward-page] > li.post').length,
  }));
  assert.equal(r.original, site.PER, 'the site keeps its own list');
  assert.equal(r.wrapped, site.PER * (site.LAST - 1), 'pages 2-4 live in copies of the list');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a failing page pauses instead of retrying on every scroll', async () => {
  const { pg, ctx } = await open('/flaky?page=1');
  // Long enough to cover the first-load probe (3 s) plus several retry-tempting scrolls.
  for (let i = 0; i < 24; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await pg.waitForTimeout(250);
  }
  assert.equal(site.hits.flaky[2], 1, 'page 2 was requested once');
  const retry = await pg.evaluate(() => Array.from(document.querySelectorAll('[data-onward]'))
    .map((w) => w.shadowRoot?.textContent || '').some((t) => /failed.*Paused.*Retry/s.test(t)));
  assert.ok(retry, 'retry bar shown');
  await ctx.close();
});

test('pages load inside an inner scroll container', async () => {
  const { pg, ctx, errors } = await open('/inner?page=1');
  let done = false;
  for (let i = 0; i < 30 && !done; i++) {
    await pg.evaluate(() => { const s = document.getElementById('scroller'); s.scrollTop = s.scrollHeight; });
    await pg.waitForTimeout(350);
    done = await pg.evaluate(endBar);
  }
  assert.ok(done);
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER * site.LAST);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('element picker saves a working site rule', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pg = await ctx.newPage();
  const logs = [];
  pg.on('console', (m) => logs.push(m.text()));
  await pg.goto(base + '/blog?page=1');
  await inject(pg);
  // Don't return the picker's promise: evaluate would wait for clicks that can't happen yet.
  await pg.evaluate(() => { window.__menu['Pick next link and content…'](); });
  const clickOn = async (sel) => {
    const box = await pg.locator(sel).first().boundingBox();
    await pg.mouse.move(box.x + 5, box.y + 5);
    await pg.mouse.click(box.x + 5, box.y + 5);
  };
  await pg.locator('.pagination a.next').scrollIntoViewIfNeeded();
  await clickOn('.pagination a.next');
  await pg.locator('li.post p').first().scrollIntoViewIfNeeded();
  await clickOn('li.post p');
  const rules = await pg.evaluate(() => window.__gm.rules);
  assert.equal(rules.length, 1);
  assert.match(rules[0].next, /a\.next/);
  assert.match(rules[0].content, /ul\.posts > li\.post$/);
  assert.equal(rules[0].click, false);
  assert.ok(await scrollToEnd(pg, endBar), 'pager restarted with the rule');
  // Auto-detection pages /blog too, so check the saved rule is what ran.
  assert.ok(logs.some((l) => /active: rule/.test(l)), 'the saved rule matched this host (port included)');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER * site.LAST);
  await ctx.close();
});

test('a site that loads more by itself gets no Onward pages', async () => {
  const { pg, ctx, errors, logs } = await open('/selfscroll?page=1');
  for (let i = 0; i < 16; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await pg.waitForTimeout(300);
  }
  const r = await pg.evaluate(pageBars);
  assert.deepEqual(r.bars, [], 'no Onward bars');
  assert.equal(r.posts.length, site.PER * site.LAST, 'the site loaded its own pages');
  assert.equal(new Set(r.posts).size, r.posts.length, 'no duplicate items');
  assert.ok(logs.some((l) => /loads more by itself/.test(l)), 'Onward said why it stood down');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a Discourse generator meta keeps Onward off until forced', async () => {
  const { pg, ctx, errors } = await open('/generator?page=1');
  // Scroll past the 3 s first-load probe, or an unguarded pager would still be waiting.
  for (let i = 0; i < 16; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await pg.waitForTimeout(300);
  }
  assert.equal(await pg.evaluate(() => document.querySelectorAll('[data-onward]').length), 0, 'inactive by default');
  await pg.evaluate(() => { window.__menu['Run Onward here anyway'](); });
  assert.ok(await scrollToEnd(pg, endBar), 'forced run reaches the end');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER * site.LAST);
  assert.deepEqual(errors, []);
  await ctx.close();
});

const loadingBar = () => Array.from(document.querySelectorAll('[data-onward]'))
  .some((w) => /Loading page/.test(w.shadowRoot?.textContent || ''));

test('a checkout page is left alone unless you run Onward there anyway', async () => {
  const { pg, ctx, errors } = await open('/checkout?page=1');
  for (let i = 0; i < 16; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await pg.waitForTimeout(300);
  }
  assert.equal(await pg.evaluate(() => document.querySelectorAll('[data-onward]').length), 0, 'inactive');
  await pg.evaluate(() => { window.__menu['Run Onward here anyway'](); });
  assert.ok(await scrollToEnd(pg, endBar), 'forced, it pages to the end');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('with "only sites I list", Onward waits for the site to be listed', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1', () => { window.__gm = { runOn: 'listed', allowHosts: ['example.org'] }; });
  for (let i = 0; i < 12; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await pg.waitForTimeout(300);
  }
  assert.equal(await pg.evaluate(() => document.querySelectorAll('[data-onward]').length), 0, 'inactive on an unlisted site');
  await pg.evaluate(() => { window.__menu['Toggle Onward on this site'](); });
  assert.deepEqual(await pg.evaluate(() => window.__gm.allowHosts), ['example.org', '127.0.0.1'], 'the toggle listed it');
  assert.ok(await scrollToEnd(pg, endBar), 'and it pages');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Settings saves where Onward runs, and refuses a broken pattern', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  await pg.evaluate(() => { window.__menu['Settings'](); });
  await pg.getByRole('combobox', { name: /^Run on/ }).selectOption('listed');
  await pg.getByRole('textbox', { name: 'Sites to run on' }).fill('example.org\nnews.example.com');
  const skip = pg.getByRole('textbox', { name: 'Stay off pages whose path matches' });
  await skip.fill('/(checkout');
  await pg.getByRole('button', { name: 'Save' }).click();
  assert.match(await pg.evaluate(() => document.querySelector('[data-onward-panel]').shadowRoot.querySelector('.err').textContent), /valid regular expression/);
  await skip.fill('/(checkout|basket)');
  await pg.getByRole('button', { name: 'Save' }).click();
  const gm = await pg.evaluate(() => ({ runOn: window.__gm.runOn, allowHosts: window.__gm.allowHosts, skipPaths: window.__gm.skipPaths }));
  assert.deepEqual(gm, { runOn: 'listed', allowHosts: ['example.org', 'news.example.com'], skipPaths: '/(checkout|basket)' });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('turning Onward off mid-load leaves nothing behind', async () => {
  const { pg, ctx, errors } = await open('/slow?page=1');
  assert.ok(await scrollToEnd(pg, loadingBar), 'a slow load is in flight');
  await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await pg.waitForTimeout(300);
  assert.match(await pg.evaluate(() => location.search), /page=1$/, 'the address waits for page 2 to arrive');
  await pg.evaluate(() => { window.__menu['Toggle Onward on this site'](); });
  await pg.waitForTimeout(3000); // longer than the 2 s response
  const r = await pg.evaluate(() => ({
    wrappers: document.querySelectorAll('[data-onward]').length,
    posts: document.querySelectorAll('ul.posts > li.post').length,
    stray: Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').filter((t) => /failed|Page \d/.test(t)),
  }));
  // The toast host is the only Onward element allowed to remain.
  assert.deepEqual(r.stray, [], 'no page or failure bars');
  assert.ok(site.hits.aborted.some((u) => u.startsWith('/slow?page=2')), 'the in-flight request was aborted: ' + JSON.stringify(site.hits.aborted));
  assert.ok(r.wrappers <= 1, 'only the toast host remains');
  assert.equal(r.posts, site.PER, 'nothing was inserted');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('restarting mid-load does not duplicate pages or leave a failure bar', async () => {
  const { pg, ctx, errors } = await open('/slow?page=1');
  assert.ok(await scrollToEnd(pg, loadingBar), 'a slow load is in flight');
  await pg.evaluate(() => { window.__menu['Run Onward here anyway'](); });
  assert.ok(await scrollToEnd(pg, endBar, 60), 'the new pager reaches the end');
  const r = await pg.evaluate(() => ({
    posts: Array.from(document.querySelectorAll('ul.posts > li.post > a')).map((a) => a.textContent),
    failed: Array.from(document.querySelectorAll('[data-onward]')).some((w) => /failed/.test(w.shadowRoot?.textContent || '')),
  }));
  assert.equal(r.failed, false, 'no failure bar from the old pager');
  assert.equal(r.posts.length, site.PER * site.LAST);
  assert.equal(new Set(r.posts).size, r.posts.length, 'no duplicate items');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a slow reader on a self-loading site ends with only the site\'s own pages', async () => {
  const { pg, ctx, errors } = await open('/selfscroll?page=1');
  // Sit still past the probe so Onward loads first, read into page 2 long
  // enough for the address to move (and the SPA check to see it), then head
  // for the bottom where the site loads its own pages.
  await pg.waitForTimeout(3500);
  await pg.evaluate(() => window.scrollBy(0, 600));
  await pg.waitForFunction(() => /page=[2-9]/.test(location.search), null, { timeout: 5000 });
  await pg.waitForTimeout(1500);
  // Keep going long enough that a restarted pager would show itself.
  for (let i = 0; i < 36; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await pg.waitForTimeout(300);
  }
  const r = await pg.evaluate(pageBars);
  assert.deepEqual(r.bars, [], 'Onward took its pages back out');
  assert.equal(await pg.evaluate(() => location.search), '?page=1', 'the address went back to the start');
  assert.equal(r.posts.length, site.PER * site.LAST);
  assert.equal(new Set(r.posts).size, r.posts.length, 'no duplicate items');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a site that loads each batch in one wrapper is recognised', async () => {
  const { pg, ctx, errors } = await open('/batch?page=1');
  for (let i = 0; i < 16; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await pg.waitForTimeout(300);
  }
  const r = await pg.evaluate(() => ({
    bars: Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').filter((t) => /Page \d|Loading/.test(t)),
    posts: Array.from(document.querySelectorAll('#posts article.post h2 a')).map((a) => a.textContent),
  }));
  assert.deepEqual(r.bars, [], 'no Onward pages');
  assert.equal(r.posts.length, site.PER * site.LAST);
  assert.equal(new Set(r.posts).size, r.posts.length, 'no duplicate items');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('ads the site drops in as posts appear do not stop paging', async () => {
  const { pg, ctx, errors } = await open('/ads?page=1');
  assert.ok(await scrollToEnd(pg, endBar, 60));
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#list > li.post').length), site.PER * site.LAST);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a live item prepended every 1.5 s does not stop paging', async () => {
  // Long pages read at a steady pace: the session outlasts many live items,
  // and only growth inside a watch window may count against the site.
  const { pg, ctx, errors } = await open('/live?page=1');
  let done = false;
  for (let i = 0; i < 120 && !done; i++) {
    // Read down the list, never into the footer beneath it.
    await pg.evaluate(() => {
      const end = document.getElementById('list').getBoundingClientRect().bottom;
      window.scrollBy(0, Math.max(0, Math.min(400, end - innerHeight - 300)));
    });
    await pg.waitForTimeout(500);
    done = await pg.evaluate(endBar);
  }
  assert.ok(done, 'reached the last page');
  assert.ok(await pg.evaluate(() => document.querySelectorAll('#list > li.live').length) >= 4, 'enough live items arrived to matter');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#list > li.post:not(.live)').length), site.LIVE_PER * site.LIVE_LAST);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('picking Next on a Bootstrap pager saves a rule that pages forward', async () => {
  const { pg, ctx, errors, logs } = await open('/bs?page=2');
  await pg.evaluate(() => { window.__menu['Pick next link and content…'](); });
  const clickOn = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    await pg.mouse.move(box.x + 3, box.y + 3);
    await pg.mouse.click(box.x + 3, box.y + 3);
  };
  await clickOn(pg.locator('nav a.page-link', { hasText: /^Next$/ }));
  await clickOn(pg.locator('li.post p').first());
  const saved = await pg.evaluate(() => {
    const sel = window.__gm.rules[0].next;
    let hits = [];
    if (/^(\(|\/|\.\/|id\()/.test(sel)) {
      const r = document.evaluate(sel, document, null, 7, null);
      for (let i = 0; i < r.snapshotLength; i++) hits.push(r.snapshotItem(i));
    } else hits = Array.from(document.querySelectorAll(sel));
    return { sel, count: hits.length, text: hits[0] && hits[0].textContent.trim() };
  });
  assert.equal(saved.count, 1, 'the saved selector matches one element: ' + saved.sel);
  assert.equal(saved.text, 'Next');
  assert.ok(await scrollToEnd(pg, endBar), 'paged to the end');
  const posts = await pg.evaluate(() => Array.from(document.querySelectorAll('ul.posts > li.post > a')).map((a) => a.textContent));
  assert.deepEqual(posts, Array.from({ length: 15 }, (_, i) => 'Post ' + (i + 6)), 'pages 3 and 4 follow page 2; page 1 never loads');
  assert.ok(logs.some((l) => /active: rule/.test(l)), 'the saved rule is what ran');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a saved rule whose selectors miss this page gives way to detection', async () => {
  const { pg, ctx, errors, logs } = await open('/blog?page=1', () => {
    window.__gm = { rules: [{ name: 'other layout', url: '^https?://127\\.0\\.0\\.1(:\\d+)?/', next: 'a.nowhere', content: '.nothing > li', insert: '', mode: '', click: false, excludeUrl: '' }] };
  });
  // Two retries (1.5 s, then 4 s) belong to the rule before detection steps in.
  assert.ok(await scrollToEnd(pg, endBar, 60), 'detection paged to the end');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER * site.LAST);
  assert.ok(logs.some((l) => /active: text/.test(l)), 'auto-detection ran, not the rule');
  assert.deepEqual(errors, []);
  await ctx.close();
});

for (const step of [1, 2]) {
  test(`cancelling the picker at step ${step} puts Onward back`, async () => {
    const { pg, ctx, errors } = await open('/blog?page=1');
    await pg.evaluate(() => { window.__menu['Pick next link and content…'](); });
    if (step === 2) {
      const next = pg.locator('.pagination a.next');
      await next.scrollIntoViewIfNeeded();
      const box = await next.boundingBox();
      await pg.mouse.move(box.x + 3, box.y + 3);
      await pg.mouse.click(box.x + 3, box.y + 3);
    }
    // The picker's tip lives in an open shadow root; Playwright's locators reach into it.
    await pg.getByRole('button', { name: 'Cancel' }).click();
    assert.ok(await scrollToEnd(pg, endBar), 'Onward pages to the end again');
    assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER * site.LAST);
    assert.deepEqual(await pg.evaluate(() => window.__gm.rules || []), [], 'nothing was saved');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

const RULE = (next, content, url = '/') => ({ name: 'site', url: '^https?://127\\.0\\.0\\.1(:\\d+)?' + url, next, content, insert: '', mode: '', click: false, excludeUrl: '' });

test('a site rule waits for a pager the page draws after its items', async () => {
  const { pg, ctx, errors, logs } = await open('/latepager?page=1', (r) => { window.__gm = { rules: [r] }; }, RULE('.pagination a.next', 'ul.posts > li.post', '/latepager'));
  assert.ok(await scrollToEnd(pg, endBar, 60), 'paged to the end');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER * site.LAST);
  assert.ok(logs.some((l) => /active: rule/.test(l)), 'by the rule');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a site rule whose next link is missing here keeps its items and detection finds the link', async () => {
  // Another section of the same site: the rule's list is here, its Next link isn't.
  const { pg, ctx, errors, logs } = await open('/blog?page=1', (r) => { window.__gm = { rules: [r] }; }, RULE('a.nowhere', 'ul.posts > li.post'));
  assert.ok(await scrollToEnd(pg, endBar, 60), 'paged to the end');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER * site.LAST);
  assert.ok(logs.some((l) => /active: text/.test(l)), 'the next link came from detection');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('pending render retries do not start Onward under an open picker', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1', () => {
    window.__gm = { rules: [{ name: 'other layout', url: '^https?://127\\.0\\.0\\.1(:\\d+)?/', next: 'a.nowhere', content: '.nothing > li', insert: '', mode: '', click: false, excludeUrl: '' }] };
  });
  await pg.waitForTimeout(500);
  await pg.evaluate(() => { window.__menu['Pick next link and content…'](); });
  await pg.waitForTimeout(9000); // past both retries (1.5 s and 4 s) and a probe
  const r = await pg.evaluate(() => ({
    posts: document.querySelectorAll('ul.posts > li.post').length,
    search: location.search,
  }));
  assert.equal(r.posts, site.PER, 'nothing paged under the picker');
  assert.equal(r.search, '?page=1');
  assert.equal(await pg.getByRole('button', { name: 'Cancel', exact: true }).count(), 1, 'the picker is still open');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the picker refuses a rule that would not lead back to the clicked link', async () => {
  // "Next" goes to another site, which Onward never follows, so no rule can work.
  const { pg, ctx, errors } = await open('/bs?page=2&ext=1');
  await pg.evaluate(() => { window.__menu['Pick next link and content…'](); });
  const clickOn = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    await pg.mouse.move(box.x + 3, box.y + 3);
    await pg.mouse.click(box.x + 3, box.y + 3);
  };
  await clickOn(pg.locator('nav a.page-link', { hasText: /^Next$/ }));
  await clickOn(pg.locator('li.post p').first());
  await pg.waitForTimeout(300);
  const r = await pg.evaluate(() => ({
    rules: window.__gm.rules || [],
    toast: Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').some((t) => /Couldn’t build a rule/.test(t)),
  }));
  assert.deepEqual(r.rules, [], 'nothing stored');
  assert.ok(r.toast, 'the user was told');
  assert.deepEqual(errors, []);
  await ctx.close();
});

async function pick(pg, nextLocator, itemLocator) {
  await pg.evaluate(() => { window.__menu['Pick next link and content…'](); });
  for (const loc of [nextLocator, itemLocator]) {
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    await pg.mouse.move(box.x + 4, box.y + 4);
    await pg.mouse.click(box.x + 4, box.y + 4);
  }
  await pg.waitForTimeout(200);
  return pg.evaluate(() => (window.__gm.rules || [])[0] || null);
}

const matchCount = (sel) => {
  if (/^(\(|\/|\.\/|id\()/.test(sel)) return document.evaluate(sel, document, null, 7, null).snapshotLength;
  return document.querySelectorAll(sel).length;
};

test('picking the lower of two pagers (shared id, sliding numbers, &nbsp;) pages in order', async () => {
  const { pg, ctx, errors, logs } = await open('/bs2?page=1');
  const rule = await pick(pg, pg.locator('nav a.page-link', { hasText: /^Next/ }).last(), pg.locator('li.post p').first());
  assert.ok(rule, 'a rule was saved');
  assert.equal(await pg.evaluate(matchCount, rule.next), 1, 'the saved selector matches one element: ' + rule.next);
  assert.doesNotMatch(rule.next, /nth-child/, 'no :nth-child steps, which shift between pages');
  assert.ok(await scrollToEnd(pg, endBar, 60), 'paged to the end');
  const posts = await pg.evaluate(() => Array.from(document.querySelectorAll('ul.posts > li.post > a')).map((a) => a.textContent));
  assert.deepEqual(posts, Array.from({ length: 6 * site.PER }, (_, i) => 'Post ' + (i + 1)), 'every page, in order');
  assert.ok(logs.some((l) => /active: rule/.test(l)));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('picking a Next label with a narrow no-break space saves a text selector', async () => {
  const { pg, ctx, errors } = await open('/bs3?page=1');
  const rule = await pick(pg, pg.locator('nav a.page-link', { hasText: /^Suivant/ }).last(), pg.locator('li.post p').first());
  assert.ok(rule, 'a rule was saved');
  assert.match(rule.next, /translate/, 'by its label: ' + rule.next);
  assert.equal(await pg.evaluate(matchCount, rule.next), 1);
  assert.ok(await scrollToEnd(pg, endBar, 60), 'paged to the end');
  const posts = await pg.evaluate(() => Array.from(document.querySelectorAll('ul.posts > li.post > a')).map((a) => a.textContent));
  assert.deepEqual(posts, Array.from({ length: 6 * site.PER }, (_, i) => 'Post ' + (i + 1)), 'every page, in order');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a picked list rule still works when page 1 has an extra list of the same class', async () => {
  const { pg, ctx, errors } = await open('/featured?page=1');
  const rule = await pick(pg, pg.locator('.pagination a.next'), pg.locator('div.list:not(.featured) div.item p').first());
  assert.ok(rule, 'a rule was saved');
  assert.doesNotMatch(rule.content, /nth-child/);
  assert.ok(await scrollToEnd(pg, endBar, 60), 'paged to the end');
  const items = await pg.evaluate(() => Array.from(document.querySelectorAll('div.list:not(.featured) > div.item > a')).map((a) => a.textContent));
  assert.deepEqual(items, Array.from({ length: site.PER * site.LAST }, (_, i) => 'Item ' + (i + 1)));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a Next link inside a shadow root is refused instead of saved as its host', async () => {
  const { pg, ctx, errors } = await open('/shadownext?page=1');
  const rule = await pick(pg, pg.locator('page-nav'), pg.locator('li.post p').first());
  assert.equal(rule, null, 'nothing saved');
  assert.match(await pg.evaluate(onwardText), /Couldn’t build a rule/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('clicking the page background as the item is refused, and Onward pages again', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  // Leave a strip at the left that only <html> covers.
  await pg.evaluate(() => { document.body.style.marginLeft = '200px'; });
  await pg.evaluate(() => { window.__menu['Pick next link and content…'](); });
  const next = pg.locator('.pagination a.next');
  await next.scrollIntoViewIfNeeded();
  const box = await next.boundingBox();
  await pg.mouse.move(box.x + 3, box.y + 3);
  await pg.mouse.click(box.x + 3, box.y + 3);
  await pg.mouse.move(60, 300);
  await pg.mouse.click(60, 300);
  await pg.waitForTimeout(200);
  assert.match(await pg.evaluate(onwardText), /doesn’t look like one item in a list/);
  assert.deepEqual(await pg.evaluate(() => window.__gm.rules || []), [], 'nothing saved');
  assert.ok(await scrollToEnd(pg, endBar), 'Onward pages to the end again');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an error inside the picker is reported, and Onward pages again', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  await pg.evaluate(() => { window.__menu['Pick next link and content…'](); });
  const next = pg.locator('.pagination a.next');
  await next.scrollIntoViewIfNeeded();
  const box = await next.boundingBox();
  await pg.mouse.move(box.x + 3, box.y + 3);
  await pg.mouse.click(box.x + 3, box.y + 3);
  // Building the item selector throws once.
  await inScriptWorld(pg, () => { const real = CSS.escape; CSS.escape = () => { CSS.escape = real; throw new Error('boom'); }; });
  const item = pg.locator('li.post p').first();
  await item.scrollIntoViewIfNeeded();
  const ib = await item.boundingBox();
  await pg.mouse.move(ib.x + 3, ib.y + 3);
  await pg.mouse.click(ib.x + 3, ib.y + 3);
  await pg.waitForTimeout(200);
  assert.match(await pg.evaluate(onwardText), /The picker couldn’t use that: boom/);
  assert.ok(await scrollToEnd(pg, endBar), 'Onward pages to the end again');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('cancelling the picker after "Run Onward here anyway" keeps it running', async () => {
  const { pg, ctx, errors } = await open('/generator?page=1');
  await pg.evaluate(() => { window.__menu['Run Onward here anyway'](); });
  await pg.evaluate(() => { window.__menu['Pick next link and content…'](); });
  await pg.getByRole('button', { name: 'Cancel' }).click();
  assert.ok(await scrollToEnd(pg, endBar), 'still forced: pages to the end');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER * site.LAST);
  assert.deepEqual(errors, []);
  await ctx.close();
});

for (const direct of [false, true]) {
  test(`an item picked inside a shadow root${direct ? ' (straight in the root)' : ''} is refused`, async () => {
    const { pg, ctx, errors } = await open('/shadowlist?page=1' + (direct ? '&direct=1' : ''));
    const rule = await pick(pg, pg.locator('.pagination a.next'), pg.locator('x-list li.post p').first());
    assert.equal(rule, null, 'nothing saved');
    assert.match(await pg.evaluate(onwardText), direct ? /doesn’t look like one item in a list/ : /Couldn’t build a rule that finds those items/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('a picked class that also marks Previous on later pages still pages forward', async () => {
  // Start at the bare address: Previous on page 2 points at ?page=1, which is not a URL already seen.
  const { pg, ctx, errors } = await open('/prevcls');
  const rule = await pick(pg, pg.locator('a.pg', { hasText: 'Next' }), pg.locator('li.post p').first());
  assert.ok(rule, 'a rule was saved');
  assert.ok(await scrollToEnd(pg, endBar, 60), 'paged to the end');
  const posts = await pg.evaluate(() => Array.from(document.querySelectorAll('ul.posts > li.post > a')).map((a) => a.textContent));
  assert.deepEqual(posts, Array.from({ length: site.PER * site.LAST }, (_, i) => 'Post ' + (i + 1)), 'never back to page 1');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a picked rule runs even where the page says it is Discourse', async () => {
  const { pg, ctx, errors } = await open('/generator?page=1');
  await pg.evaluate(() => { window.__menu['Pick next link and content…'](); });
  const clickOn = async (sel) => {
    const el = pg.locator(sel).first();
    await el.scrollIntoViewIfNeeded();
    const box = await el.boundingBox();
    await pg.mouse.move(box.x + 3, box.y + 3);
    await pg.mouse.click(box.x + 3, box.y + 3);
  };
  await clickOn('.pagination a.next');
  await clickOn('li.post p');
  assert.ok(await scrollToEnd(pg, endBar), 'the picked rule pages to the end');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER * site.LAST);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an open picker is not disturbed by Onward putting the address back', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  assert.ok(await scrollToEnd(pg, () => /page=[34]$/.test(location.search)), 'pages loaded and the address moved');
  await pg.evaluate(() => { window.__menu['Pick next link and content…'](); });
  await pg.waitForTimeout(5000); // SPA check (1 s) + restart delay + a whole probe
  const r = await pg.evaluate(() => ({
    posts: document.querySelectorAll('ul.posts > li.post').length,
    search: location.search,
    bars: Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').filter((t) => /Page \d|Loading/.test(t)),
  }));
  assert.equal(r.posts, site.PER, 'the picker page holds still');
  assert.deepEqual(r.bars, []);
  assert.equal(r.search, '?page=1', 'the address went back to the start');
  // The site itself navigating while the picker is open must not restart Onward under it.
  await pg.evaluate(() => history.pushState({}, '', '/blog?page=1&view=list'));
  await pg.waitForTimeout(5500);
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER, 'still holding still');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a reader parked in the footer gets one page per scroll, not a burst', async () => {
  const { pg, ctx, errors } = await open('/long?page=1');
  const posts = () => pg.evaluate(() => document.querySelectorAll('#list > li.post').length);
  await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await pg.waitForTimeout(4500); // the first-load probe, then one load
  assert.equal(await posts(), 2 * site.PER, 'one page after reaching the footer');
  await pg.waitForTimeout(2000);
  assert.equal(await posts(), 2 * site.PER, 'nothing more without scrolling');
  for (let k = 3; k <= 4; k++) {
    await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await pg.waitForTimeout(1500);
    assert.equal(await posts(), k * site.PER, 'one more page per scroll');
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});


test('Stop becomes Resume, and the menu tells stopped, paused and finished apart', async () => {
  const { pg, ctx, errors } = await open('/long?page=1');
  const posts = () => pg.evaluate(() => document.querySelectorAll('#list > li.post').length);
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('#list > li.post').length >= 10), 'page 2 is in');
  await pg.getByRole('button', { name: 'Stop', exact: true }).first().click();
  const stoppedAt = await posts();
  for (let i = 0; i < 6; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await pg.waitForTimeout(300);
  }
  assert.equal(await posts(), stoppedAt, 'nothing loads after Stop');
  assert.match(await pg.evaluate(onwardText), /Stopped by you/);
  assert.ok(await pg.getByRole('button', { name: 'Resume', exact: true }).count() >= 1, 'Stop turned into Resume');
  assert.equal(await pg.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
  // The menu resumes a pager the user stopped.
  await pg.evaluate(() => { window.__menu['Load next page now'](); });
  await pg.waitForTimeout(800);
  assert.ok(await posts() > stoppedAt, 'the menu resumed paging');
  assert.match(await pg.evaluate(onwardText), /stopped by you/);
  // Stop again and Resume from the bar this time.
  await pg.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await pg.getByRole('button', { name: 'Resume', exact: true }).first().click();
  assert.ok(await scrollToEnd(pg, endBar, 80), 'Resume carried on to the end');
  assert.equal(await posts(), 10 * site.PER);
  await pg.evaluate(() => { window.__menu['Load next page now'](); });
  await pg.waitForTimeout(300);
  assert.match(await pg.evaluate(onwardText), /Last page reached/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an item repeated from an earlier page is dropped, and paging goes on', async () => {
  const { pg, ctx, errors } = await open('/shift?page=1');
  assert.ok(await scrollToEnd(pg, endBar), 'paged to the end');
  const posts = await pg.evaluate(() => Array.from(document.querySelectorAll('ul.posts > li.post > a')).map((a) => a.textContent));
  assert.deepEqual(posts, Array.from({ length: site.PER * site.LAST }, (_, i) => 'Post ' + (i + 1)), 'every post once, in order');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('page 1 served again after the site lazy-loaded its images ends paging', async () => {
  const { pg, ctx, errors } = await open('/lazyrepeat?page=1');
  assert.ok(await scrollToEnd(pg, endBar, 60), 'paging ended');
  const posts = await pg.evaluate(() => Array.from(document.querySelectorAll('ul.posts > li.post > a')).map((a) => a.textContent));
  assert.deepEqual(posts, Array.from({ length: 2 * site.PER }, (_, i) => 'Post ' + (i + 1)), 'pages 1 and 2, and page 1 not again');
  assert.match(await pg.evaluate(onwardText), /a page we already have/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a wallpaper grid with the same button under every picture pages to the end', async () => {
  const { pg, ctx, errors } = await open('/walls?page=1');
  assert.ok(await scrollToEnd(pg, endBar, 60), 'paged to the end');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#walls > li.w').length), site.PER * site.LAST);
  assert.doesNotMatch(await pg.evaluate(onwardText), /a page we already have/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a javascript: frame in page 2 does not run, however its scheme is spelled', async () => {
  const { pg, ctx, errors } = await open('/jsiframe?page=1');
  assert.ok(await scrollToEnd(pg, endBar), 'paged to the end');
  assert.equal(await pg.evaluate(() => window.__pwned), undefined);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a "Load more" link Onward won\'t follow is not clicked instead', async () => {
  const { pg, ctx, errors } = await open('/xmore?page=1');
  for (let i = 0; i < 16; i++) {
    await pg.keyboard.press('End');
    await pg.waitForTimeout(300);
  }
  assert.match(pg.url(), /^http:\/\/127\.0\.0\.1:\d+\/xmore\?page=1$/, 'the tab stayed');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#list > li.post').length), site.PER);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a clicking site rule doesn\'t click a link Onward won\'t follow', async () => {
  const { pg, ctx, errors } = await open('/xmore?page=1', (r) => { window.__gm = { rules: [r] }; },
    Object.assign(RULE('a.more', 'ul.posts > li.post', '/xmore'), { click: true }));
  for (let i = 0; i < 16; i++) {
    await pg.keyboard.press('End');
    await pg.waitForTimeout(300);
  }
  assert.match(pg.url(), /^http:\/\/127\.0\.0\.1:\d+\/xmore\?page=1$/, 'the tab stayed');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a refresh hidden in page 2 does not navigate the tab', async () => {
  const { pg, ctx, errors } = await open('/metaref?page=1', () => { window.__alive = true; });
  assert.ok(await scrollToEnd(pg, endBar), 'paged to the end');
  await pg.waitForTimeout(500);
  const r = await pg.evaluate(() => ({ alive: window.__alive === true, path: location.pathname, posts: document.querySelectorAll('ul.posts > li.post').length }));
  assert.ok(r.alive, 'still the same document');
  assert.equal(r.path, '/metaref');
  assert.equal(r.posts, site.PER * site.LAST);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('page requests are spaced out, by the configured gap', async () => {
  // A short page and a reader at the bottom: without spacing the three loads come back to back.
  const { pg, ctx, errors } = await open('/spaced?page=1', () => { window.__gm = { spacing: 1500 }; });
  site.hits.spaced.length = 0;
  assert.ok(await scrollToEnd(pg, endBar, 60), 'paged to the end');
  const t = site.hits.spaced;
  assert.equal(t.length, site.LAST - 1);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 1450, `gap ${t[i] - t[i - 1]} ms between requests ${i} and ${i + 1}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Stop while a page waits its turn sends no request', async () => {
  const { pg, ctx, errors } = await open('/spaced?page=1', () => { window.__gm = { spacing: 5000 }; });
  site.hits.spaced.length = 0;
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('ul.posts > li.post').length >= 10
    && Array.from(document.querySelectorAll('[data-onward]')).some((w) => /Loading page 3/.test(w.shadowRoot?.textContent || '')), 60), 'page 3 is waiting out the gap');
  await pg.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await pg.waitForTimeout(6000);
  assert.equal(site.hits.spaced.length, 1, 'only page 2 was ever asked for');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), 10);
  assert.deepEqual(errors, []);
  await ctx.close();
});

for (const api of [true, false]) {
  test(`a pushState route change restarts Onward (${api ? 'Navigation API' : 'polling fallback'})`, async () => {
    // Without the Navigation API, in the world the script runs in.
    const noNav = "Object.defineProperty(window, 'navigation', { value: undefined, configurable: true });";
    const { pg, ctx, errors, logs } = await open('/spapush?page=1', null, null, api ? SHIM : noNav + SHIM);
    const started = () => logs.filter((l) => /\[Onward\] active:/.test(l)).length;
    await pg.waitForTimeout(300);
    assert.equal(started(), 1, 'running on the first route');
    await pg.click('#filter');
    const t0 = Date.now();
    while (started() < 2 && Date.now() - t0 < 3000) await pg.waitForTimeout(25);
    const took = Date.now() - t0;
    assert.equal(started(), 2, 'restarted on the new route');
    if (api) assert.ok(took <= 300, `restarted within 300 ms (took ${took} ms)`);
    // Polling waits 800 ms after it notices, so a quick restart means the stub missed the script.
    else assert.ok(took >= 700, `the polling fallback restarted it (took ${took} ms)`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('Retry after a failed page loads it, instead of ending paging', async () => {
  // Page 2 is empty once (a failure), then fine: Retry must fetch it again. Fetch mode,
  // since auto mode would quietly retry an empty page in an iframe.
  const { pg, ctx, errors } = await open('/emptyonce?page=1', () => { window.__gm = { mode: 'fetch' }; });
  const failed = () => Array.from(document.querySelectorAll('[data-onward]')).some((w) => /failed/.test(w.shadowRoot?.textContent || ''));
  assert.ok(await scrollToEnd(pg, failed, 40), 'page 2 failed once');
  await pg.getByRole('button', { name: 'Retry', exact: true }).click();
  assert.ok(await scrollToEnd(pg, endBar, 60), 'paged to the end');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER * site.LAST);
  assert.doesNotMatch(await pg.evaluate(onwardText), /No more pages\.[^]*Page 3/, 'did not end early');
  assert.doesNotMatch(await pg.evaluate(onwardText), /failed/, 'the failure bar went away');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('in iframe mode a page that never answers times out, and Retry tries it again', async () => {
  const { pg, ctx, errors } = await open('/hang?page=1', () => { window.__gm = { mode: 'iframe' }; });
  const timedOut = () => Array.from(document.querySelectorAll('[data-onward]')).some((w) => /failed \(timed out\)\. Paused\./.test(w.shadowRoot?.textContent || ''));
  assert.ok(await scrollToEnd(pg, timedOut, 90), 'the frame gave up with "timed out"');
  await pg.getByRole('button', { name: 'Retry', exact: true }).click();
  await pg.waitForTimeout(1500);
  const text = await pg.evaluate(onwardText);
  assert.doesNotMatch(text, /No more pages/, 'the retry did not end paging');
  assert.match(text, /Loading page 2/, 'it is trying page 2 again');
  assert.deepEqual(errors, []);
  await ctx.close();
});

const barText = () => Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').join(' | ');
const postCount = () => document.querySelectorAll('ul.posts > li.post').length;

test('Retry after a Stop carries on paging', async () => {
  const { pg, ctx, errors } = await open('/emptyonce3?page=1', () => { window.__gm = { mode: 'fetch' }; });
  assert.ok(await scrollToEnd(pg, () => /Page 3 failed/.test(Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').join(' ')), 40), 'page 3 failed once');
  await pg.getByRole('button', { name: 'Stop', exact: true }).first().click();
  assert.match(await pg.evaluate(barText), /Stopped by you/);
  await pg.getByRole('button', { name: 'Retry', exact: true }).click();
  assert.ok(await scrollToEnd(pg, endBar, 40), 'paged to the end');
  assert.equal(await pg.evaluate(postCount), site.PER * site.LAST);
  assert.doesNotMatch(await pg.evaluate(barText), /Stopped by you|failed/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Resume after a failed page and a Stop tries the page again', async () => {
  // A low threshold, so the top of two pages is far enough from the end that nothing loads there.
  const { pg, ctx, errors } = await open('/emptyonce3r?page=1', () => { window.__gm = { mode: 'fetch', threshold: 0.3 }; });
  assert.ok(await scrollToEnd(pg, () => /Page 3 failed/.test(Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').join(' ')), 40), 'page 3 failed once');
  await pg.getByRole('button', { name: 'Stop', exact: true }).first().click();
  // Resume at the top of the page, where nothing needs loading yet.
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.waitForTimeout(300);
  await pg.evaluate(() => {
    const stopBar = Array.from(document.querySelectorAll('[data-onward]')).find((w) => /Stopped by you/.test(w.shadowRoot?.textContent || ''));
    Array.from(stopBar.shadowRoot.querySelectorAll('button')).find((b) => b.textContent === 'Resume').click();
  });
  await pg.waitForTimeout(1000);
  assert.equal(await pg.evaluate(postCount), 2 * site.PER, 'nothing loaded at the top');
  assert.doesNotMatch(await pg.evaluate(barText), /failed|Stopped by you/, 'the old failure bar went with the pause');
  assert.ok(await scrollToEnd(pg, endBar, 40), 'paged to the end');
  assert.equal(await pg.evaluate(postCount), site.PER * site.LAST);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Stop drops a page that is still on its way', async () => {
  const { pg, ctx, errors } = await open('/slow?page=1');
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('ul.posts > li.post').length === 10 && /Loading page 3/.test(Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').join(' ')), 60), 'page 3 on its way');
  await pg.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await pg.waitForTimeout(3000); // past the 2 s the slow page takes
  assert.equal(await pg.evaluate(postCount), 10, 'page 3 never landed');
  const text = await pg.evaluate(barText);
  assert.doesNotMatch(text, /Loading|failed/, 'dropped quietly, not as a failure');
  assert.match(text, /Stopped by you/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the menu names a stop for pages that don\'t make the page longer', async () => {
  const { pg, ctx, errors } = await open('/fixedh?page=1');
  assert.ok(await scrollToEnd(pg, () => /getting longer/.test(Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').join(' ')), 40));
  await pg.evaluate(() => { window.__menu['Load next page now'](); });
  const text = await pg.evaluate(barText);
  assert.match(text, /weren’t making the page any longer/);
  assert.doesNotMatch(text, /repeated errors/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a site that throws away every page Onward adds is told apart, in the bar and the menu', async () => {
  const { pg, ctx, errors } = await open('/redrawall?page=1');
  assert.ok(await scrollToEnd(pg, () => /keeps redrawing/.test(Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').join(' ')), 60));
  await pg.evaluate(() => { window.__menu['Load next page now'](); });
  const text = await pg.evaluate(barText);
  assert.match(text, /Stopped because this site keeps redrawing its list/);
  assert.doesNotMatch(text, /failed|Last page reached/);
  assert.equal(await pg.evaluate(postCount), site.PER, 'the site\'s own list, untouched');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('after a route change Onward waits for the new route\'s list instead of paging the old one', async () => {
  const { pg, ctx, errors } = await open('/spaslow?page=1');
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('#app ul.posts > li.post').length >= 10), 'page 2 of the first route');
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.click('#filter');
  await pg.waitForTimeout(2500);
  assert.ok(await scrollToEnd(pg, endBar, 60), 'paged to the end');
  const posts = await pg.evaluate(() => Array.from(document.querySelectorAll('#app ul.posts > li.post > a')).map((a) => a.textContent));
  assert.deepEqual(posts, Array.from({ length: site.PER * site.LAST }, (_, i) => 'Filtered ' + (i + 1)));
  assert.equal(await pg.evaluate(() => location.search), '?filter=x&page=4');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a jump to #comments keeps the pages already added', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('ul.posts > li.post').length >= 10), 'page 2 is in');
  const before = await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length);
  await pg.evaluate(() => { location.hash = 'comments'; });
  await pg.waitForTimeout(2000);
  assert.ok(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length) >= before, 'nothing was taken back out');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a frame held up by a script that never arrives is still used once its items are there', async () => {
  const { pg, ctx, errors } = await open('/iframeblock?page=1');
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('#cards > article.card').length >= 10, 40), 'page 2 is in');
  assert.doesNotMatch(await pg.evaluate(onwardText), /failed/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a held-up frame that never stops changing is still used when the time runs out', async () => {
  const { pg, ctx, errors } = await open('/iframebusy?page=1');
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('#cards > article.card').length >= 10, 100), 'page 2 is in');
  assert.doesNotMatch(await pg.evaluate(onwardText), /failed/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the iframe fallback waits its turn before asking for the page again', async () => {
  site.hits.iframespaced.length = 0;
  const { pg, ctx, errors } = await open('/iframespaced?page=1');
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('#cards > article.card').length >= 10, 40), 'page 2 is in');
  const two = site.hits.iframespaced.filter((h) => h.n === 2);
  assert.deepEqual(two.map((h) => h.dest), ['empty', 'iframe'], 'a fetch, then the frame');
  assert.ok(two[1].t - two[0].t >= 950, 'a second apart: ' + (two[1].t - two[0].t) + ' ms');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a redirect back to a page already shown ends paging', async () => {
  const { pg, ctx, errors } = await open('/redir?page=1');
  assert.ok(await scrollToEnd(pg, endBar), 'paging ended');
  const r = await pg.evaluate(() => ({
    posts: Array.from(document.querySelectorAll('ul.posts > li.post > a')).map((a) => a.textContent),
    text: Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').join(' | '),
  }));
  assert.deepEqual(r.posts, Array.from({ length: 2 * site.PER }, (_, i) => 'Post ' + (i + 1)), 'pages 1 and 2 only, nothing repeated');
  assert.match(r.text, /No more pages\./);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a page that never answers times out after 20 s and pauses', async () => {
  const { pg, ctx, errors } = await open('/hang?page=1');
  const failed = () => Array.from(document.querySelectorAll('[data-onward]')).some((w) => /failed \(timed out\)\. Paused\./.test(w.shadowRoot?.textContent || ''));
  // The 3 s probe, then the 20 s timeout.
  assert.ok(await scrollToEnd(pg, failed, 90), 'the stuck load gave up and paused');
  assert.equal(await pg.getByRole('button', { name: 'Retry', exact: true }).count(), 1, 'with a Retry button');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the menu says when paging was paused after an error', async () => {
  const { pg, ctx } = await open('/flaky?page=1');
  assert.ok(await scrollToEnd(pg, () => Array.from(document.querySelectorAll('[data-onward]')).some((w) => /Paused/.test(w.shadowRoot?.textContent || ''))), 'a page failed');
  await pg.evaluate(() => { window.__menu['Load next page now'](); });
  await pg.waitForTimeout(300);
  assert.match(await pg.evaluate(onwardText), /paused after an error/);
  await ctx.close();
});

const parkedReader = async (pg, url, count) => {
  // Scroll to the very bottom once and sit there.
  await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await pg.waitForTimeout(4500); // the first-load probe, then one load
  const first = await pg.evaluate(count);
  await pg.waitForTimeout(3000); // late images, anchoring, chained timers
  return { first, later: await pg.evaluate(count) };
};

test('a parked reader gets one page even while images above keep growing', async () => {
  const { pg, ctx, errors } = await open('/lateimg?page=1');
  const r = await parkedReader(pg, '/lateimg', () => document.querySelectorAll('#list > article.post').length);
  assert.equal(r.first, 2 * site.PER, 'one page after reaching the footer');
  assert.equal(r.later, 2 * site.PER, 'late images above did not pull in more pages');
  await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await pg.waitForTimeout(2500);
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#list > article.post').length), 3 * site.PER, 'a real scroll brings the next one');
  assert.equal(await pg.evaluate(() => document.documentElement.style.overflowAnchor), '', 'anchoring handed back');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a parked reader gets one page while the page shifts, and one more per key', async () => {
  // Late images above the reader and a widget below grow in the same frames,
  // and the widget grows on every scroll, so only real input shows the reader.
  const { pg, ctx, errors } = await open('/latefoot?page=1');
  const count = () => document.querySelectorAll('#list > article.post').length;
  const r = await parkedReader(pg, '/latefoot', count);
  assert.equal(r.first, 2 * site.PER, 'one page after reaching the footer');
  assert.equal(r.later, 2 * site.PER, 'the page shifting is not the reader');
  // End typed into a text box is not the reader either.
  await pg.evaluate(() => document.getElementById('q').focus({ preventScroll: true }));
  await pg.keyboard.press('End');
  await pg.waitForTimeout(2000);
  assert.equal(await pg.evaluate(count), 2 * site.PER, 'a key in a text box');
  await pg.evaluate(() => document.activeElement.blur());
  await pg.keyboard.press('End');
  await pg.waitForTimeout(2500);
  assert.equal(await pg.evaluate(count), 3 * site.PER, 'the End key brings the next page');
  await pg.waitForTimeout(3000);
  assert.equal(await pg.evaluate(count), 3 * site.PER, 'and only one: input before a page lands does not count for the next');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a wheel over a side panel is not the reader asking for more', async () => {
  const { pg, ctx, errors } = await open('/parkbox?page=1');
  const count = () => document.querySelectorAll('#list > li.post').length;
  const r = await parkedReader(pg, '/parkbox', count);
  assert.equal(r.later, 2 * site.PER, 'one page while parked');
  // Over the fixed panel, which scrolls itself and keeps the page still.
  await pg.mouse.move(1100, 250);
  for (let i = 0; i < 4; i++) {
    await pg.mouse.wheel(0, 150);
    await pg.waitForTimeout(250);
  }
  assert.ok(await pg.evaluate(() => document.getElementById('box').scrollTop) > 0, 'the panel scrolled');
  await pg.waitForTimeout(1500);
  assert.equal(await pg.evaluate(count), 2 * site.PER, 'no page for a wheel that moved only the panel');
  await pg.mouse.move(400, 400);
  await pg.mouse.wheel(0, 400);
  await pg.waitForFunction(() => document.querySelectorAll('#list > li.post').length === 15, null, { timeout: 8000 });
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Parks the reader, waits for page 2, then runs act() as soon as it lands.
const parkThen = async (pg, act) => {
  await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await pg.waitForFunction(() => document.querySelectorAll('#list > article.post').length === 10, null, { timeout: 8000 });
  await act();
};

test('input a while before the page shifts is not the reader moving', async () => {
  // Images land 2.5 s after the page and shift it; the only input came 2 s before that.
  const { pg, ctx, errors } = await open('/parklate?d=2500&page=1');
  await parkThen(pg, async () => {
    await pg.mouse.move(1100, 250);
    await pg.mouse.wheel(0, 150);
  });
  await pg.waitForTimeout(4500);
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#list > article.post').length), 10, 'still one page');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a click on the page is not the reader moving, even just before it shifts', async () => {
  const { pg, ctx, errors } = await open('/parklate?d=700&page=1');
  await parkThen(pg, async () => {
    await pg.mouse.click(1100, 250);
  });
  await pg.waitForTimeout(3500);
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#list > article.post').length), 10, 'still one page');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a reader parked just below the list gets one page, and the wheel brings the next', async () => {
  const { pg, ctx, errors } = await open('/lateimg?page=1');
  const count = () => document.querySelectorAll('#list > article.post').length;
  // In the footer, 300 px below the end of the list, not at the very bottom.
  await pg.evaluate(() => window.scrollTo(0, document.getElementById('list').getBoundingClientRect().bottom + scrollY + 300));
  await pg.waitForTimeout(4500);
  assert.equal(await pg.evaluate(count), 2 * site.PER, 'one page');
  await pg.waitForTimeout(3000);
  assert.equal(await pg.evaluate(count), 2 * site.PER, 'late images in the new page do not pull in more');
  await pg.mouse.move(600, 400);
  await pg.mouse.wheel(0, 400);
  await pg.waitForTimeout(2500);
  // The wheel leaves the reader inside the list, where pages fill to the threshold as usual.
  assert.ok(await pg.evaluate(count) >= 3 * site.PER, 'the wheel brings the next page');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a reader who reaches the very bottom as a batch lands gets the next one', async () => {
  const { pg, ctx, errors } = await open('/more');
  // The reader lands on the very bottom the moment items arrive, before Onward's click has settled.
  await pg.evaluate(() => new MutationObserver(() => window.scrollTo(0, document.documentElement.scrollHeight))
    .observe(document.getElementById('list'), { childList: true }));
  assert.ok(await scrollToEnd(pg, endBar, 40), 'every batch');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#list > li.post').length), site.PER * site.LAST);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the next check waits for the new page\'s images before calling it short', async () => {
  // No gap between requests, so only the wait for images can hold page 3 back.
  const { pg, ctx, errors } = await open('/tallimg?page=1', () => { window.__gm = { spacing: 0 }; });
  const count = () => document.querySelectorAll('#list > article.post').length;
  await pg.waitForTimeout(1200); // page 1's own images arrive
  // Near the end of the list, but still inside it.
  await pg.evaluate(() => window.scrollTo(0, document.getElementById('list').getBoundingClientRect().bottom + scrollY - 900));
  await pg.waitForFunction(() => document.querySelectorAll('#list > article.post').length >= 10, null, { timeout: 10000 });
  await pg.waitForTimeout(3000);
  assert.equal(await pg.evaluate(count), 10, 'page 2 filled the screen once its images came, so no page 3');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a load the scroll asked for is dropped if the reader moved away while it waited its turn', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1', () => { window.__gm = { spacing: 3000, threshold: 0.3 }; });
  const posts = () => document.querySelectorAll('ul.posts > li.post').length;
  // Forced, so there's no first-load probe; page 2 comes from the menu while the reader is at the top.
  await pg.evaluate(() => { window.__menu['Run Onward here anyway'](); });
  await pg.evaluate(() => { window.__menu['Load next page now'](); });
  await pg.waitForFunction(() => document.querySelectorAll('ul.posts > li.post').length === 10);
  // Near the end of the list, still inside it: page 3 is asked for and waits out the 3 s gap...
  await pg.evaluate(() => window.scrollTo(0, document.querySelector('ul.posts').getBoundingClientRect().bottom + scrollY - innerHeight + 50));
  await pg.waitForFunction(() => Array.from(document.querySelectorAll('[data-onward]')).some((w) => /Loading page 3/.test(w.shadowRoot?.textContent || '')));
  // ...and the reader goes back up before it's sent.
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.waitForTimeout(3500);
  assert.equal(await pg.evaluate(posts), 10, 'page 3 was not loaded');
  assert.doesNotMatch(await pg.evaluate(onwardText), /Loading page/);
  // A load you ask for is never dropped.
  await pg.evaluate(() => { window.__menu['Load next page now'](); });
  await pg.waitForFunction(() => document.querySelectorAll('ul.posts > li.post').length === 15, null, { timeout: 8000 });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a parked reader with a short footer still gets one page per scroll', async () => {
  const { pg, ctx, errors } = await open('/shortfoot?page=1');
  const r = await parkedReader(pg, '/shortfoot', () => document.querySelectorAll('#list > li.post').length);
  assert.equal(r.first, 2 * site.PER);
  assert.equal(r.later, 2 * site.PER, 'no more pages until the reader scrolls');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a load-more reader parked in the footer gets one batch per scroll', async () => {
  const { pg, ctx, errors } = await open('/more');
  const r = await parkedReader(pg, '/more', () => document.querySelectorAll('#list > li.post').length);
  assert.equal(r.first, 2 * site.PER, 'one click after reaching the footer');
  assert.equal(r.later, 2 * site.PER, 'no clicking spree');
  assert.equal(await pg.evaluate(() => document.documentElement.style.overflowAnchor), '', 'anchoring handed back');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// GM storage shared by every tab of a context (localStorage), like a real manager's.
const SHARED_SHIM = `
  const gmLoad = () => JSON.parse(localStorage.getItem('__gm') || '{}');
  window.GM_getValue = (k, d) => { const v = gmLoad(); return k in v ? v[k] : d; };
  window.GM_setValue = (k, v) => { const all = gmLoad(); all[k] = v; localStorage.setItem('__gm', JSON.stringify(all)); };
  window.__menu = {};
  window.GM_registerMenuCommand = (name, fn) => { window.__menu[name] = fn; };
  document.addEventListener('onward-test-menu', (e) => { const fn = window.__menu[e.detail]; if (fn) fn(); });
`;

test('only one tab refreshes the rule lists at a time', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await a.goto(base + '/blog?page=1');
  await b.goto(base + '/blog?page=1');
  const list = base + '/rules.json?mode=good';
  await a.evaluate((l) => localStorage.setItem('__gm', JSON.stringify({ sources: [l], sourcesUpdated: 0, sourcesTried: 0 })), list);
  site.hits.rules = 0;
  await inject(a, SHARED_SHIM);
  await a.waitForTimeout(300); // the first tab is mid-download (1.5 s) when the second starts
  await inject(b, SHARED_SHIM);
  // The second tab's own start backs off; its Settings button is refused by the lock.
  await b.evaluate(() => { window.__menu['Settings'](); });
  await b.getByRole('button', { name: 'Update rule lists now' }).click();
  await a.waitForTimeout(2500);
  const stored = await a.evaluate(() => JSON.parse(localStorage.getItem('__gm')));
  assert.equal(site.hits.rules, 1, 'the list was fetched once');
  assert.match(await b.evaluate(onwardText), /Another tab is updating/);
  assert.equal(stored.sourceCache[list].count, 2, 'stored packed, with its count');
  assert.equal(typeof stored.sourceCache[list].rules, 'string', 'packed');
  assert.deepEqual(stored.sourceRules, [], 'no flattened copy');
  assert.ok(stored.sourcesUpdated > 0, 'marked fresh');
  assert.equal(stored.sourcesLock, 0, 'lock released');
  await ctx.close();
});

test('a rule list that comes back as an error page keeps its last good copy', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pg = await ctx.newPage();
  await pg.goto(base + '/blog?page=1');
  const list = base + '/rules.json?mode=html';
  const rules = [1, 2, 3].map((k) => ({ name: '', url: `^https://keep${k}\\.example/`, next: 'a.n', content: undefined, insert: '', mode: '', click: false, excludeUrl: '' }));
  await pg.evaluate(([l, r]) => localStorage.setItem('__gm', JSON.stringify({ sources: [l], sourceCache: { [l]: { rules: r, at: 1 } }, sourceRules: r, sourcesUpdated: 0, sourcesTried: 0 })), [list, rules]);
  await inject(pg, SHARED_SHIM);
  await pg.waitForTimeout(2500);
  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('__gm')));
  assert.equal(stored.sourceCache[list].rules.length, 3, 'the cached copy survived');
  assert.equal(stored.sourceRules.length, 3, 'and is still what matching uses');
  assert.equal(stored.sourcesUpdated, 0, 'not marked fresh');
  assert.ok(stored.sourcesTried > 0, 'but the attempt is recorded, for the back-off');
  assert.match(await pg.evaluate(onwardText), /Kept the last good copy/);
  await ctx.close();
});

test('rules 0.1.0 cached are kept when the first refresh after the update fails', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pg = await ctx.newPage();
  await pg.goto(base + '/blog?page=1');
  const list = base + '/rules.json?mode=html';
  const rules = [1, 2, 3].map((k) => ({ name: '', url: `^https://keep${k}\\.example/`, next: 'a.n', insert: '', mode: '', click: false, excludeUrl: '' }));
  await pg.evaluate(([l, r]) => localStorage.setItem('__gm', JSON.stringify({ sources: [l], sourceRules: r, sourcesUpdated: 0, sourcesTried: 0 })), [list, rules]);
  await inject(pg, SHARED_SHIM);
  await pg.waitForTimeout(2500);
  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('__gm')));
  assert.equal(stored.sourceRules.length, 3, 'still there');
  assert.deepEqual(stored.sourceCache, {}, 'with nothing newer to replace them');
  assert.match(await pg.evaluate(onwardText), /Kept the last good copy/);
  await ctx.close();
});

test('a packed rule list is used on the site it names', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pg = await ctx.newPage();
  const logs = [];
  pg.on('console', (m) => logs.push(m.text()));
  await pg.goto(base + '/blog?page=1');
  const list = base + '/rules.json?mode=site';
  await pg.evaluate((l) => localStorage.setItem('__gm', JSON.stringify({ sources: [l], sourcesUpdated: 0, sourcesTried: 0 })), list);
  await inject(pg, SHARED_SHIM);
  await pg.waitForFunction((l) => ((JSON.parse(localStorage.getItem('__gm') || '{}').sourceCache || {})[l] || {}).count > 0, list, { timeout: 10000 });
  const entry = await pg.evaluate((l) => JSON.parse(localStorage.getItem('__gm')).sourceCache[l], list);
  assert.equal(entry.count, 201);
  assert.ok(JSON.stringify(entry).length < 6000, 'packed: ' + JSON.stringify(entry).length + ' characters');
  // The next page load reads the packed list and pages this site by its rule.
  await pg.reload();
  await inject(pg, SHARED_SHIM);
  assert.ok(await scrollToEnd(pg, endBar), 'paged to the end');
  assert.ok(logs.some((l) => /active: rule/.test(l)), 'by the list rule');
  // Diagnostics say which list the rule came from.
  await pg.evaluate(() => { window.__menu['Settings'](); });
  const diag = await pg.evaluate(() => document.querySelector('[data-onward-panel]').shadowRoot.querySelector('.diag').textContent);
  assert.match(diag, /\nRule: rule list http:\/\/127\.0\.0\.1:\d+\/rules\.json\?mode=site \{"url":/);
  await ctx.close();
});

test('rule lists are read from storage once per page, however often Onward looks again', async () => {
  // The last page has no next link, so Onward looks three times (now, after 1.5 s and after 4 s).
  const { pg, ctx, errors } = await open('/blog?page=4', () => {
    window.__gm = { sourceRules: [{ name: '', url: '^https://nowhere\\.example/', next: 'a.n', insert: '', mode: '', click: false, excludeUrl: '' }], sourceCache: {} };
  });
  await pg.waitForTimeout(6500);
  const reads = await pg.evaluate(() => JSON.parse(document.documentElement.getAttribute('data-onward-test-reads') || '{}'));
  assert.ok(reads.rules >= 3, 'it did look three times: ' + reads.rules);
  assert.equal(reads.sourceRules, 1);
  assert.equal(reads.sourceCache, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a tab never clears a refresh lock another tab has taken over', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pg = await ctx.newPage();
  await pg.goto(base + '/blog?page=1');
  const list = base + '/rules.json?mode=good';
  await pg.evaluate((l) => localStorage.setItem('__gm', JSON.stringify({ sources: [l], sourcesUpdated: 0, sourcesTried: 0 })), list);
  await inject(pg, SHARED_SHIM);
  await pg.waitForTimeout(400); // mid-download (1.5 s)
  await pg.evaluate(() => {
    const g = JSON.parse(localStorage.getItem('__gm'));
    g.sourcesLock = { at: Date.now(), id: 'other' };
    localStorage.setItem('__gm', JSON.stringify(g));
  });
  await pg.waitForTimeout(2500);
  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('__gm')));
  assert.equal(stored.sourcesLock.id, 'other', "the other tab's lock stays");
  assert.equal(stored.sourceCache[list].count, 2, 'and this tab still stored what it fetched');
  await ctx.close();
});

test('"Load 5 more pages" loads to the last page without scrolling, counting as it goes', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  await pg.evaluate(() => { window.__menu['Load 5 more pages'](); });
  await pg.waitForFunction(() => Array.from(document.querySelectorAll('[data-onward]')).some((w) => /Loading page 3 \(2 of 5\)/.test(w.shadowRoot?.textContent || '')), null, { timeout: 8000 });
  await pg.waitForFunction(() => document.querySelectorAll('ul.posts > li.post').length === 20, null, { timeout: 15000 });
  await pg.waitForTimeout(500);
  assert.equal(await pg.evaluate(() => scrollY), 0, 'the reader never moved');
  assert.match(await pg.evaluate(onwardText), /No more pages/);
  assert.equal(await pg.evaluate(() => location.search), '?page=1', 'the address stays with the page in view');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('"Load 5 more pages" pressed while a page is loading waits for it, then carries on', async () => {
  const { pg, ctx, errors } = await open('/slow?page=1');
  assert.ok(await scrollToEnd(pg, loadingBar), 'page 2 is on its way');
  await pg.evaluate(() => { window.__menu['Load 5 more pages'](); });
  await pg.waitForFunction(() => document.querySelectorAll('ul.posts > li.post').length === 20, null, { timeout: 20000 });
  assert.match(await pg.evaluate(onwardText), /No more pages/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// What the live regions say now (Onward writes the two in turn and empties the other).
const statusText = () => Array.from(document.querySelector('[data-onward-status]')?.shadowRoot.querySelectorAll('[role="status"]') || []).map((r) => r.textContent).join('');

test('screen readers hear pages load, and the end', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('ul.posts > li.post').length >= 10), 'page 2 is in');
  await pg.waitForFunction('/^Page [23] loaded, 5 items\\.$/.test((' + statusText + ')())');
  assert.ok(await scrollToEnd(pg, endBar), 'paged to the end');
  await pg.waitForTimeout(250);
  // The last page's load and the end are said at the same moment, so they're read as one.
  assert.equal(await pg.evaluate(statusText), 'Page 4 loaded, 5 items. No more pages.');
  assert.equal(await pg.evaluate(() => document.querySelector('[data-onward-status]').hasAttribute('data-onward')), false, 'not counted as a page bar');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Settings keeps focus in the dialog and gives it back however it closes', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  const inPanel = () => document.activeElement && document.activeElement.hasAttribute('data-onward-panel');
  const onPage = () => { const a = document.activeElement; return !!a && a !== document.body && !a.hasAttribute('data-onward-panel'); };
  // Closed with the Settings command: focus comes back.
  await pg.evaluate(() => document.querySelector('a[href="/post/1"]').focus());
  await pg.evaluate(() => { window.__menu['Settings'](); });
  assert.ok(await pg.evaluate(inPanel));
  // Tab and Shift+Tab never reach the page behind the dialog.
  for (const key of ['Shift+Tab', 'Shift+Tab', 'Tab', 'Tab']) {
    await pg.keyboard.press(key);
    assert.equal(await pg.evaluate(onPage), false, 'focus reached the page after ' + key);
  }
  await pg.evaluate(() => { window.__menu['Settings'](); });
  assert.equal(await pg.evaluate(() => document.activeElement.getAttribute('href')), '/post/1', 'focus came back');
  assert.equal(await pg.evaluate(() => document.body.inert), false, 'the page works again');
  // Focus on a button inside Onward's own page bar (a shadow root) comes back to that button.
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('ul.posts > li.post').length >= 10), 'page 2 is in');
  await pg.getByRole('button', { name: '↑ Top' }).first().focus();
  await pg.evaluate(() => { window.__menu['Settings'](); });
  await pg.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await pg.evaluate(() => { const a = document.activeElement; return a && a.shadowRoot && a.shadowRoot.activeElement && a.shadowRoot.activeElement.textContent; }), '↑ Top');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('announcements take turns between the two regions, and toasts are announced too', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  // Which region each message lands in.
  await pg.waitForFunction(() => document.querySelector('[data-onward-status]'));
  await pg.evaluate(() => {
    window.__said = [];
    document.querySelector('[data-onward-status]').shadowRoot.querySelectorAll('[role="status"]').forEach((r, i) => {
      new MutationObserver(() => { if (r.textContent) window.__said.push([i, r.textContent]); }).observe(r, { childList: true, characterData: true, subtree: true });
    });
  });
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('ul.posts > li.post').length >= 10), 'page 2 is in');
  await pg.waitForTimeout(250);
  // The same toast twice: each goes to the other region, so it's news both times.
  for (let i = 0; i < 2; i++) {
    await pg.evaluate(() => { window.__menu['Settings'](); });
    await pg.getByRole('button', { name: 'Save' }).click();
    await pg.waitForTimeout(250);
  }
  const said = await pg.evaluate(() => window.__said);
  const saved = 'Settings saved. Reload the page to apply them.';
  assert.deepEqual(said, [[0, 'Page 2 loaded, 5 items.'], [1, saved], [0, saved]], JSON.stringify(said));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the settings panel passes axe, and focus goes in and comes back', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  await pg.evaluate(() => document.querySelector('a[href="/post/1"]').focus());
  await pg.evaluate(() => { window.__menu['Settings'](); });
  assert.equal(await pg.evaluate(() => document.querySelector('[data-onward-panel]').shadowRoot.activeElement?.getAttribute('data-k')), 'threshold', 'focus moved into the dialog');
  assert.equal(await pg.evaluate(() => document.querySelector('[data-onward-panel]').shadowRoot.querySelector('[role="dialog"]').getAttribute('aria-modal')), 'true');
  // With an error showing, so its text is checked too.
  await pg.getByRole('textbox', { name: 'Site rules (JSON)' }).fill('[');
  await pg.getByRole('button', { name: 'Save' }).click();
  assert.match(await pg.getByRole('alert').textContent(), /not valid JSON/);
  await pg.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await pg.evaluate(async () => {
    const res = await window.axe.run({ include: { fromShadowDom: ['[data-onward-panel]', '.p'] } }, { resultTypes: ['violations'] });
    return res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id + ': ' + v.nodes.map((n) => JSON.stringify(n.target)).join(', '));
  });
  assert.deepEqual(violations, []);
  // axe can't find the backgrounds inside the panel's shadow root, so it files
  // every colour contrast check there as incomplete. Measure it here instead:
  // each piece of text against the nearest opaque background, to WCAG AA.
  const lowContrast = await pg.evaluate(() => {
    const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = (c) => c.slice(0, 3).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const background = (el) => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement || n.getRootNode().host) {
        const c = rgb(getComputedStyle(n).backgroundColor);
        if (c.length === 3 || c[3] === 1) return c;
      }
      return [255, 255, 255];
    };
    const low = [];
    for (const el of document.querySelector('[data-onward-panel]').shadowRoot.querySelectorAll('.p, .p *')) {
      if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const cs = getComputedStyle(el);
      const [a, b] = [lum(rgb(cs.color)), lum(background(el))];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = parseFloat(cs.fontSize);
      if (ratio < (size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700) ? 3 : 4.5)) low.push(`${el.tagName.toLowerCase()}.${el.className} ${ratio.toFixed(2)}`);
    }
    return low;
  });
  assert.deepEqual(lowContrast, []);
  await pg.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await pg.evaluate(() => document.activeElement.getAttribute('href')), '/post/1', 'focus came back');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Settings shows diagnostics and copies them', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('ul.posts > li.post').length >= 10), 'page 2 is in');
  await pg.evaluate(() => { window.__menu['Settings'](); });
  await pg.getByRole('button', { name: 'Copy diagnostics' }).click();
  await pg.waitForTimeout(200);
  const text = await pg.evaluate(() => navigator.clipboard.readText());
  assert.match(text, /^Onward \d+\.\d+\.\d+ on http:\/\/127\.0\.0\.1:\d+\/blog/);
  assert.match(text, /\nNext link: text, score \d+; next page http:\/\/127\.0\.0\.1:\d+\/blog\?page=3\r?\n/, 'the clipboard may hand back CRLF');
  assert.match(text, /\nContent: .*ul\.posts, 5 items on the first page \(auto\)/);
  assert.match(text, /\nMode: auto; wrapped pages: no; scrolls: the window/);
  assert.match(text, /\nLast error: none/);
  assert.match(text, /\nRule: none; found by detection/);
  assert.match(await pg.evaluate(onwardText), /Diagnostics copied/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Copy diagnostics falls back to a selected textarea where the clipboard API is blocked', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  // Blocked where the script runs; the test still reads the clipboard.
  await inScriptWorld(pg, () => {
    const read = navigator.clipboard.readText.bind(navigator.clipboard);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('blocked')), readText: read } });
  });
  await pg.evaluate(() => { window.__menu['Settings'](); });
  await pg.getByRole('button', { name: 'Copy diagnostics' }).click();
  await pg.waitForTimeout(300);
  assert.match(await pg.evaluate(() => navigator.clipboard.readText()), /^Onward \d+\.\d+\.\d+ on http/);
  assert.match(await pg.evaluate(onwardText), /Diagnostics copied/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('diagnostics name the rule and the last error', async () => {
  const { pg, ctx, errors } = await open('/flaky?page=1', (r) => { window.__gm = { rules: [r] }; }, RULE('.pagination a.next', 'ul.posts > li.post', '/flaky'));
  assert.ok(await scrollToEnd(pg, () => /failed/.test(Array.from(document.querySelectorAll('[data-onward]')).map((w) => w.shadowRoot?.textContent || '').join(' ')), 40));
  await pg.evaluate(() => { window.__menu['Settings'](); });
  const text = await pg.evaluate(() => document.querySelector('[data-onward-panel]').shadowRoot.querySelector('.diag').textContent);
  assert.match(text, /\nLast error: page 2: HTTP 500/);
  assert.match(text, /\nRule: your site rule \{"url":/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a hash route to another list restarts Onward there', async () => {
  const { pg, ctx, errors } = await open('/hashapp#/cats');
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('#list > li.post').length >= 10), 'the cats list pages');
  await pg.evaluate(() => { window.scrollTo(0, 0); location.hash = '#/dogs'; });
  await pg.waitForTimeout(2500);
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('#list > li.post').length >= 20, 40), 'the dogs list pages to the end');
  assert.ok(await pg.evaluate(() => Array.from(document.querySelectorAll('#list > li.post')).every((li) => /^dogs /.test(li.textContent))));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a single-page app\'s #/checkout route is left alone too', async () => {
  const { pg, ctx, errors } = await open('/hashapp#/checkout');
  for (let i = 0; i < 12; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await pg.waitForTimeout(300);
  }
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#list > li.post').length), 5, 'nothing loaded on the checkout route');
  // Leaving the checkout for a list: that list pages.
  await pg.evaluate(() => { window.scrollTo(0, 0); location.hash = '#/dogs'; });
  await pg.waitForTimeout(2500);
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('#list > li.post').length >= 20, 40), 'the dogs list pages');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('after a hash route to a detail view, Onward clicks nothing there', async () => {
  const { pg, ctx, errors } = await open('/hashapp2#/list');
  await pg.waitForTimeout(1500);
  // The reader opens an item before reaching the end of the list (so still on
  // page 1); its view has a Delete button where Load more was.
  await pg.evaluate(() => { location.hash = '#/item'; });
  await pg.waitForTimeout(500);
  await pg.evaluate(() => window.scrollBy(0, 20));
  // Past the first-time wait (3 s) and the gap between loads.
  await pg.waitForTimeout(5000);
  assert.equal(await pg.evaluate(() => window.__deleted), 0, 'the Delete button was clicked');
  assert.deepEqual(errors, []);
  await ctx.close();
});

for (const fixture of ['/spascroll', '/spascroll2']) {
  test(`a router that scrolls to the top keeps its new address, and its list gets its own pages (${fixture})`, async () => {
    const { pg, ctx, errors } = await open(fixture + '?page=1');
    assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('#app ul.posts > li.post').length >= 10), 'page 2 of the first route');
    // Reading page 2: the address follows it.
    const y = await pg.evaluate(() => document.querySelector('a[href$="/post/7"]').closest('li').getBoundingClientRect().top + scrollY);
    await pg.evaluate((v) => window.scrollTo(0, v - 100), y);
    await pg.waitForTimeout(1500);
    assert.equal(await pg.evaluate(() => location.search), '?page=2', 'the address follows page 2');
    await pg.click('#filter');
    await pg.waitForTimeout(3000);
    assert.equal(await pg.evaluate(() => location.search), '?filter=x&page=1', 'the new route keeps its address');
    assert.ok(await scrollToEnd(pg, endBar, 40), 'the new list pages to the end');
    const stale = await pg.evaluate(() => Array.from(document.querySelectorAll('#app ul.posts > li.post > a')).map((a) => a.textContent).filter((t) => !/^Filtered/.test(t)));
    assert.deepEqual(stale, [], 'no posts of the old route under the new one');
    await pg.evaluate(() => window.scrollTo(0, 0));
    await pg.waitForTimeout(1200);
    assert.equal(await pg.evaluate(() => location.search), '?filter=x&page=1', 'back at the top of the new list');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('"Load next page now" pressed while a scroll load waits its turn is not dropped', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1', () => { window.__gm = { spacing: 3000, threshold: 0.3 }; });
  const posts = () => document.querySelectorAll('ul.posts > li.post').length;
  await pg.evaluate(() => { window.__menu['Run Onward here anyway'](); });
  await pg.evaluate(() => { window.__menu['Load next page now'](); });
  await pg.waitForFunction(() => document.querySelectorAll('ul.posts > li.post').length === 10);
  await pg.evaluate(() => window.scrollTo(0, document.querySelector('ul.posts').getBoundingClientRect().bottom + scrollY - innerHeight + 50));
  await pg.waitForFunction(() => Array.from(document.querySelectorAll('[data-onward]')).some((w) => /Loading page 3/.test(w.shadowRoot?.textContent || '')));
  // The reader goes back up and asks for the next page from the menu while page 3 still waits its turn.
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.waitForTimeout(100);
  await pg.evaluate(() => { window.__menu['Load next page now'](); });
  await pg.waitForFunction(() => document.querySelectorAll('ul.posts > li.post').length === 15, null, { timeout: 5000 });
  // The request was for page 3 only: a scroll load for page 4 that the page stops needing while it waits is still dropped.
  await pg.evaluate(() => window.scrollTo(0, document.querySelector('ul.posts').getBoundingClientRect().bottom + scrollY - innerHeight + 50));
  await pg.waitForFunction(() => Array.from(document.querySelectorAll('[data-onward]')).some((w) => /Loading page 4/.test(w.shadowRoot?.textContent || '')));
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.waitForTimeout(3500);
  assert.equal(await pg.evaluate(posts), 15, 'page 4 was not loaded');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Resume at the end of the list loads the next page, even if you scroll away while it waits', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1', () => { window.__gm = { spacing: 3000, threshold: 0.3 }; });
  const posts = () => document.querySelectorAll('ul.posts > li.post').length;
  await pg.evaluate(() => { window.__menu['Run Onward here anyway'](); });
  await pg.evaluate(() => { window.__menu['Load next page now'](); });
  await pg.waitForFunction(() => document.querySelectorAll('ul.posts > li.post').length === 10);
  await pg.getByRole('button', { name: 'Stop', exact: true }).first().click();
  // The Stop bar sits at the end of the list.
  await pg.getByRole('button', { name: 'Resume', exact: true }).last().click();
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.waitForTimeout(4500);
  assert.equal(await pg.evaluate(posts), 15);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a Load more link whose address is this page is clicked, since it can only stay here', async () => {
  const { pg, ctx, errors } = await open('/samemore');
  assert.ok(await scrollToEnd(pg, endBar, 40), 'to the end');
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#list > li.post').length), site.PER * site.LAST);
  assert.equal(await pg.evaluate(() => location.pathname), '/samemore');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('with "only sites I list", the toggle really turns on a site turned off earlier, and Settings shows the list', async () => {
  const { pg, ctx, errors } = await open('/blog?page=1', () => { window.__gm = { runOn: 'listed', allowHosts: [], disabledHosts: ['127.0.0.1'] }; });
  await pg.evaluate(() => { window.__menu['Settings'](); });
  assert.equal(await pg.getByRole('textbox', { name: 'Turned off on these sites' }).inputValue(), '127.0.0.1');
  await pg.getByRole('button', { name: 'Cancel' }).click();
  await pg.evaluate(() => { window.__menu['Toggle Onward on this site'](); });
  assert.match(await pg.evaluate(onwardText), /Enabled on 127\.0\.0\.1/);
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('ul.posts > li.post').length > 5), 'it pages');
  const gm = await pg.evaluate(() => window.__gm);
  assert.deepEqual([gm.allowHosts, gm.disabledHosts], [['127.0.0.1'], []]);
  // The list is yours to edit.
  await pg.evaluate(() => { window.__menu['Settings'](); });
  await pg.getByRole('textbox', { name: 'Turned off on these sites' }).fill('x.example\nold.example');
  await pg.getByRole('button', { name: 'Save' }).click();
  assert.deepEqual(await pg.evaluate(() => window.__gm.disabledHosts), ['x.example', 'old.example']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('right after an update from 0.1.0, the rule lists are fetched again so their index is used', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pg = await ctx.newPage();
  await pg.goto(base + '/blog?page=1');
  const list = base + '/rules.json?mode=good';
  const rules = [1, 2, 3].map((k) => ({ name: '', url: `^https://keep${k}\\.example/`, next: 'a.n', insert: '', mode: '', click: false, excludeUrl: '' }));
  // What 0.1.0 left: every rule flattened, and a refresh only yesterday (the weekly one is days away).
  await pg.evaluate(([l, r]) => localStorage.setItem('__gm', JSON.stringify({ sources: [l], sourceRules: r, sourcesUpdated: Date.now() - 864e5, sourcesTried: Date.now() - 864e5 })), [list, rules]);
  site.hits.rules = 0;
  await inject(pg, SHARED_SHIM);
  await pg.waitForFunction((l) => ((JSON.parse(localStorage.getItem('__gm')).sourceCache || {})[l] || {}).count > 0, list, { timeout: 10000 });
  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('__gm')));
  assert.equal(site.hits.rules, 1, 'fetched now, once');
  assert.equal(typeof stored.sourceCache[list].rules, 'string', 'stored packed');
  assert.deepEqual(stored.sourceRules, [], 'the flattened copy is gone');
  await ctx.close();
});

test('a tab that lost the refresh lock to another never takes it back, with several lists', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pg = await ctx.newPage();
  await pg.goto(base + '/blog?page=1');
  const lists = [base + '/rules.json?mode=good&k=1', base + '/rules.json?mode=good&k=2'];
  await pg.evaluate((l) => localStorage.setItem('__gm', JSON.stringify({ sources: l, sourcesUpdated: 0, sourcesTried: 0 })), lists);
  await inject(pg, SHARED_SHIM);
  await pg.waitForTimeout(400); // mid-way through the first list (1.5 s)
  await pg.evaluate(() => {
    const g = JSON.parse(localStorage.getItem('__gm'));
    g.sourcesLock = { at: Date.now(), id: 'other' };
    localStorage.setItem('__gm', JSON.stringify(g));
  });
  let retaken = null;
  for (let i = 0; i < 30 && !retaken; i++) {
    await pg.waitForTimeout(150);
    const l = await pg.evaluate(() => JSON.parse(localStorage.getItem('__gm')).sourcesLock);
    if (!l || l.id !== 'other') retaken = JSON.stringify(l);
  }
  const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('__gm')));
  assert.equal(retaken, null, 'this tab took the lock back: ' + retaken);
  assert.equal(stored.sourcesLock && stored.sourcesLock.id, 'other');
  assert.equal(stored.sourceCache[lists[1]].count, 2, 'and it still stored both lists');
  await ctx.close();
});

test('load-more button is clicked until it disappears', async () => {
  const { pg, ctx, errors } = await open('/more');
  assert.ok(await scrollToEnd(pg, endBar));
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#list > li.post').length), site.PER * site.LAST);
  assert.deepEqual(errors, []);
  await ctx.close();
});
