// Captures the README screenshots from the e2e fixture site (headless).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const site = require('../test/e2e/site');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../src/onward.user.js'), 'utf8');
const SHIM = `window.__menu = {}; window.GM_getValue = (k, d) => d; window.GM_setValue = () => {};
  window.GM_registerMenuCommand = (name, fn) => { window.__menu[name] = fn; };`;
const OUT = path.join(__dirname, '../docs');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await site.start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 }, colorScheme: 'dark', deviceScaleFactor: 1 });
  const pg = await ctx.newPage();
  await pg.goto(base + '/blog?page=1');
  await pg.addStyleTag({ content: 'body{background:#11111b;color:#cdd6f4} header,footer{background:#181825} a{color:#89b4fa} li{list-style:none;padding:8px 16px;margin:6px 16px;background:#1e1e2e;border-radius:8px;height:auto!important}' });
  await pg.addScriptTag({ content: SHIM + SCRIPT });
  for (let i = 0; i < 4; i++) { await pg.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await pg.waitForTimeout(400); }
  await pg.evaluate(() => {
    const bars = [...document.querySelectorAll('li[data-onward]')];
    bars[1].scrollIntoView({ block: 'center' });
  });
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: path.join(OUT, 'page-bar.png') });
  await pg.evaluate(() => window.__menu.Settings());
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: path.join(OUT, 'settings.png') });
  await browser.close();
  server.close();
  console.log('saved to', OUT);
})();
