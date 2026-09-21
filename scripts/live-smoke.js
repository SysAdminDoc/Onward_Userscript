// Headless smoke run against real sites: node scripts/live-smoke.js <url> [url...]
// Set SHOT_DIR to keep screenshots. Be gentle; each run fetches up to a few pages per site.
const fs = require('fs'); const path = require('path'); const { chromium } = require('playwright');
const SCRIPT = 'window.GM_getValue=(k,d)=>d;window.GM_setValue=()=>{};' + fs.readFileSync(path.join(__dirname, '../src/onward.user.js'), 'utf8');
const urls = process.argv.slice(2);
(async () => {
  const b = await chromium.launch();
  for (const url of urls) {
    const ctx = await b.newContext({ bypassCSP: true, viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
    const p = await ctx.newPage();
    const logs = [];
    p.on('console', (m) => { if (m.text().includes('[Onward]')) logs.push(m.text()); });
    p.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
    try {
      await p.goto(url, { waitUntil: 'load', timeout: 30000 });
      await p.evaluate(SCRIPT);
      await p.waitForTimeout(500);
      const before = await p.evaluate(() => document.documentElement.scrollHeight);
      for (let i = 0; i < 8; i++) { await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(1500); }
      const r = await p.evaluate(() => ({
        h: document.documentElement.scrollHeight,
        bars: [...document.querySelectorAll('[data-onward]')].map((w) => (w.querySelector('div')?.shadowRoot?.querySelector('.bar')?.textContent || '').slice(0, 90)),
        url: location.href,
      }));
      console.log('\n==', url, '\n  height', before, '->', r.h, '\n  url now', r.url, '\n  bars', r.bars, '\n  logs', logs);
      await p.screenshot({ path: path.join(process.env.SHOT_DIR || require('os').tmpdir(), new URL(url).hostname + '.png') });
    } catch (e) { console.log('\n==', url, 'FAILED', e.message, logs); }
    await ctx.close();
  }
  await b.close();
})();
