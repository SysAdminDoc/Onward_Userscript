// Runs the real userscript in headless Chromium against the fixture site.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const site = require('./site');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../src/onward.user.js'), 'utf8');
const SHIM = `
  window.__gm = {};
  window.GM_getValue = (k, d) => (k in window.__gm ? window.__gm[k] : d);
  window.GM_setValue = (k, v) => { window.__gm[k] = v; };
  window.__menu = {};
  window.GM_registerMenuCommand = (name, fn) => { window.__menu[name] = fn; };
`;

let server, browser, base;

test.before(async () => {
  server = await site.start();
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  await browser?.close();
  server?.close();
});

async function open(url, prepare) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.goto(base + url, { waitUntil: 'load' });
  if (prepare) await pg.evaluate(prepare);
  await pg.addScriptTag({ content: SHIM + SCRIPT });
  return { pg, ctx, errors };
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

const endBar = () => Array.from(document.querySelectorAll('[data-onward]'))
  .some((w) => /No more|End of results|No more items/.test(w.shadowRoot?.textContent || ''));

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
  // The setter reports mid-silence (muted before pause), so judge each track by its last report.
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
  await pg.addScriptTag({ content: SHIM + SCRIPT });
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
  const { pg, ctx, errors } = await open('/selfscroll?page=1');
  const logs = [];
  pg.on('console', (m) => logs.push(m.text()));
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
  const { pg, ctx, errors } = await open('/bs?page=2');
  const logs = [];
  pg.on('console', (m) => logs.push(m.text()));
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

test('load-more button is clicked until it disappears', async () => {
  const { pg, ctx, errors } = await open('/more');
  assert.ok(await scrollToEnd(pg, endBar));
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#list > li.post').length), site.PER * site.LAST);
  assert.deepEqual(errors, []);
  await ctx.close();
});
