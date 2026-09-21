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
  window.GM_registerMenuCommand = () => {};
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

async function open(url) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.goto(base + url, { waitUntil: 'load' });
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

test('a list the site redraws switches to wrapped pages', async () => {
  const { pg, ctx, errors } = await open('/redraw?page=1');
  // The inline pass may finish before the redraw, so wait for the wrapped result itself.
  assert.ok(await scrollToEnd(pg, () => document.querySelectorAll('ul.posts[data-onward-page] > li.post').length >= 15));
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
  for (let i = 0; i < 12; i++) {
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
  await pg.goto(base + '/blog?page=1');
  await pg.addScriptTag({ content: SHIM.replace('window.GM_registerMenuCommand = () => {};', 'window.__menu = {}; window.GM_registerMenuCommand = (n, f) => { window.__menu[n] = f; };') + SCRIPT });
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
  assert.equal(await pg.evaluate(() => document.querySelectorAll('ul.posts > li.post').length), site.PER * site.LAST);
  await ctx.close();
});

test('load-more button is clicked until it disappears', async () => {
  const { pg, ctx, errors } = await open('/more');
  assert.ok(await scrollToEnd(pg, endBar));
  assert.equal(await pg.evaluate(() => document.querySelectorAll('#list > li.post').length), site.PER * site.LAST);
  assert.deepEqual(errors, []);
  await ctx.close();
});
