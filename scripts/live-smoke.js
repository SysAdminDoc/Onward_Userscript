// Headless smoke run against real sites.
//   npm run smoke                               checks every site in scripts/smoke-sites.json against its expected result
//   node scripts/live-smoke.js <url> [url...]   just reports what happens on those pages
// Set SHOT_DIR to keep screenshots. Be gentle: at most 3 pages are loaded per site.
// A site that shows a bot check or refuses Onward's requests (403, 429) is reported
// as not checked, since that says nothing about Onward. A real mismatch fails the run
// (exit 1), and so does a run that could check nothing (exit 2).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { verdict, exitCode } = require('./smoke-verdict');

const MAX_EXTRA_PAGES = 3;
const SOURCE = fs.readFileSync(path.join(__dirname, '../src/onward.user.js'), 'utf8');
// Settings for the run: page 1 plus at most 3 more.
const SCRIPT = `window.__gm = { maxPages: ${1 + MAX_EXTRA_PAGES} };
  window.GM_getValue = (k, d) => (k in window.__gm ? window.__gm[k] : d);
  window.GM_setValue = (k, v) => { window.__gm[k] = v; };
  window.GM_registerMenuCommand = () => {};\n` + SOURCE + '\n//# sourceURL=onward.user.js';
const BOT_CHECK_RE = /security verification|verify you are human|just a moment|checking your browser|attention required|access denied|are you a robot/i;

async function visit(browser, url) {
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
  const p = await ctx.newPage();
  const logs = [];
  const onwardErrors = [];
  p.on('console', (m) => { if (m.text().includes('[Onward]')) logs.push(m.text().split('\n')[0]); });
  p.on('pageerror', (e) => {
    logs.push('PAGEERROR ' + e.message.split('\n')[0]);
    // The script runs as onward.user.js; the site's own errors say nothing about Onward.
    if (/onward\.user\.js/.test(e.stack || '')) onwardErrors.push(e.message.split('\n')[0]);
  });
  try {
    await p.goto(url, { waitUntil: 'load', timeout: 30000 });
    // Before Onward adds anything: a thread titled "Access denied" on page 3 isn't a bot check.
    const botCheck = await p.evaluate((botRe) => new RegExp(botRe, 'i').test(document.title + ' ' + (document.body ? document.body.innerText.slice(0, 3000) : '')), BOT_CHECK_RE.source);
    await p.evaluate(SCRIPT);
    await p.waitForTimeout(500);
    const before = await p.evaluate(() => document.documentElement.scrollHeight);
    for (let i = 0; i < 10; i++) {
      await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await p.waitForTimeout(1500);
    }
    const r = await p.evaluate(() => {
      const bars = [];
      for (const w of document.querySelectorAll('[data-onward]')) {
        const bar = w.shadowRoot && w.shadowRoot.querySelector('.bar');
        if (!bar) continue;
        const b = bar.querySelector('b');
        // A finished page's bar is plain "bar"; loading, failed and end bars say which.
        bars.push({ kind: Array.from(bar.classList).filter((c) => c !== 'bar').join(' '), label: b ? b.textContent.trim() : '', text: bar.textContent.trim().slice(0, 90) });
      }
      return { height: document.documentElement.scrollHeight, url: location.href, bars };
    });
    await p.screenshot({ path: path.join(process.env.SHOT_DIR || os.tmpdir(), new URL(url).hostname + '.png') });
    const refused = (logs.join('\n').match(/HTTP (403|429)/) || [])[0];
    const active = logs.some((l) => /\[Onward\] active:/.test(l));
    return { ...r, botCheck, active, onwardErrors, before, logs, refused };
  } catch (e) {
    return { error: e.message.split('\n')[0], logs };
  } finally {
    await ctx.close();
  }
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
    else console.log(`   active: ${r.active}; height ${r.before} -> ${r.height}; address now ${r.url}\n   bars: ${JSON.stringify(r.bars.map((b) => b.text))}`);
    if (r.logs.length) console.log('   log: ' + r.logs.join('\n        '));
  }
  await browser.close();
  if (adhoc.length) process.exit(0);
  console.log(`\n${tally.OK} as expected, ${tally['NOT CHECKED']} not checked, ${tally.MISMATCH} mismatched.`);
  if (!tally.OK && !tally.MISMATCH) console.log('Nothing could be checked, so this run says nothing about Onward.');
  process.exit(exitCode(tally));
})();
