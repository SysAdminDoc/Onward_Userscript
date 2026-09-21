// Headless smoke run against real sites.
//   npm run smoke                               checks every site in scripts/smoke-sites.json against its expected result
//   node scripts/live-smoke.js <url> [url...]   just reports what happens on those pages
// Set SHOT_DIR to keep screenshots. Be gentle: at most 3 pages are loaded per site.
// A site that shows a bot check or refuses Onward's requests (403, 429) is reported
// as not checked, since that says nothing about Onward; only a real mismatch fails the run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const MAX_EXTRA_PAGES = 3;
const SOURCE = fs.readFileSync(path.join(__dirname, '../src/onward.user.js'), 'utf8');
// Settings for the run: page 1 plus at most 3 more.
const SCRIPT = `window.__gm = { maxPages: ${1 + MAX_EXTRA_PAGES} };
  window.GM_getValue = (k, d) => (k in window.__gm ? window.__gm[k] : d);
  window.GM_setValue = (k, v) => { window.__gm[k] = v; };
  window.GM_registerMenuCommand = () => {};\n` + SOURCE;
const BOT_CHECK_RE = /security verification|verify you are human|just a moment|checking your browser|attention required|access denied|are you a robot/i;

async function visit(browser, url) {
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
  const p = await ctx.newPage();
  const logs = [];
  p.on('console', (m) => { if (m.text().includes('[Onward]')) logs.push(m.text().split('\n')[0]); });
  p.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message.split('\n')[0]));
  try {
    await p.goto(url, { waitUntil: 'load', timeout: 30000 });
    await p.evaluate(SCRIPT);
    await p.waitForTimeout(500);
    const before = await p.evaluate(() => document.documentElement.scrollHeight);
    for (let i = 0; i < 10; i++) {
      await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await p.waitForTimeout(1500);
    }
    const r = await p.evaluate((botRe) => {
      const bars = [];
      for (const w of document.querySelectorAll('[data-onward]')) {
        const bar = w.shadowRoot && w.shadowRoot.querySelector('.bar');
        if (bar) bars.push(bar.textContent.trim().slice(0, 90));
      }
      const pages = bars.map((t) => /^Page (\d+)/.exec(t)).filter(Boolean).map((m) => Number(m[1]));
      const text = document.title + ' ' + (document.body ? document.body.innerText.slice(0, 3000) : '');
      return { height: document.documentElement.scrollHeight, url: location.href, bars, pages: pages.length ? Math.max(...pages) : 1, botCheck: new RegExp(botRe, 'i').test(text) };
    }, BOT_CHECK_RE.source);
    await p.screenshot({ path: path.join(process.env.SHOT_DIR || os.tmpdir(), new URL(url).hostname + '.png') });
    const refused = (logs.join('\n').match(/HTTP (403|429)/) || [])[0];
    return { ...r, before, logs, refused };
  } catch (e) {
    return { error: e.message.split('\n')[0], logs };
  } finally {
    await ctx.close();
  }
}

function verdict(site, r) {
  if (!site.expect) return '';
  if (r.error) return 'NOT CHECKED (the page did not load: ' + r.error + ')';
  if (r.botCheck) return 'NOT CHECKED (the site showed a bot check to the headless browser)';
  if (site.expect === 'inactive') return r.pages === 1 ? 'OK' : 'MISMATCH (expected inactive)';
  const want = site.minPages || 2;
  if (r.pages >= want) return 'OK';
  if (r.refused) return `NOT CHECKED (the site refused Onward's request: ${r.refused})`;
  return `MISMATCH (expected active, at least page ${want})`;
}

(async () => {
  const adhoc = process.argv.slice(2);
  const sites = adhoc.length ? adhoc.map((url) => ({ name: url, url })) : JSON.parse(fs.readFileSync(path.join(__dirname, 'smoke-sites.json'), 'utf8'));
  const browser = await chromium.launch();
  const tally = { OK: 0, 'NOT CHECKED': 0, MISMATCH: 0 };
  for (const site of sites) {
    if (site.manual) {
      console.log(`\n-- ${site.name} (check by hand): ${site.manual}\n   ${site.url}`);
      continue;
    }
    const r = await visit(browser, site.url);
    const v = verdict(site, r);
    for (const k of Object.keys(tally)) if (v.startsWith(k)) tally[k]++;
    console.log(`\n== ${site.name} ${v}\n   ${site.url}`);
    if (r.error) console.log('   did not load: ' + r.error);
    else console.log(`   pages shown: ${r.pages}; height ${r.before} -> ${r.height}; address now ${r.url}\n   bars: ${JSON.stringify(r.bars)}`);
    if (r.logs.length) console.log('   log: ' + r.logs.join('\n        '));
  }
  await browser.close();
  if (!adhoc.length) console.log(`\n${tally.OK} as expected, ${tally['NOT CHECKED']} not checked, ${tally.MISMATCH} mismatched.`);
  process.exit(tally.MISMATCH ? 1 : 0);
})();
