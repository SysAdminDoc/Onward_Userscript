// A tiny paginated test site covering the layouts Onward has to handle.
const http = require('http');

const PER = 5;
const LAST = 4;
// /live pages are long enough that a reader stays inside the list while paging.
const LIVE_PER = 10;
const LIVE_LAST = 5;
const LONG_LAST = 10;

const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}
<style>body{font:16px sans-serif;margin:0} header,footer{background:#ddd;padding:10px} footer{height:1600px}
li,tr{height:140px} .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}</style></head>
<body><header><a href="/">Home</a> <a href="/more-menu">More</a></header>${body}<footer>footer</footer></body></html>`;

const posts = (n, per = PER) => Array.from({ length: per }, (_, i) => {
  const k = (n - 1) * per + i + 1;
  return `<li class="post"><a href="/post/${k}">Post ${k}</a><p>Summary of post ${k}.</p><img data-src="/img/${k}.png" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></li>`;
}).join('');

const pager = (base, n, nextLabel, last = LAST) => `<div class="pagination">${Array.from({ length: last }, (_, i) => i + 1)
  .map((k) => (k === n ? `<span class="current">${k}</span>` : `<a href="${base}${k}">${k}</a>`)).join(' ')}
  ${n < last ? `<a class="next" href="${base}${n + 1}">${nextLabel}</a>` : ''}</div>`;

// One second of 8 kHz, 8-bit mono silence.
function wav() {
  const samples = 8000;
  const b = Buffer.alloc(44 + samples, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(samples, 40);
  return b;
}

function route(url) {
  const u = new URL(url, 'http://x');
  const n = Math.max(1, Number(u.searchParams.get('page') || (/(\d+)/.exec(u.pathname) || [])[1] || 1));

  if (u.pathname === '/blog') {
    return { body: page('Blog ' + n, `<main><h1>Blog</h1><ul class="posts">${posts(n)}</ul>${pager('/blog?page=', n, 'Next »')}</main>`) };
  }
  if (u.pathname.startsWith('/forum/')) {
    // windows-1252 with only a meta tag to say so; the CJK label is an entity because latin1 cannot hold it
    const rows = Array.from({ length: PER }, (_, i) => `<tr class="thread"><td>Café thread ${(n - 1) * PER + i + 1}</td><td>12</td></tr>`).join('');
    const html = `<!doctype html><html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><title>Forum</title>
      <style>tr{height:140px} footer{height:1600px}</style></head><body><table id="threads"><tbody>${rows}</tbody></table>
      <div class="pages">${n < LAST ? `<a href="/forum/${n + 1}.html">&#19979;&#19968;&#39029;</a>` : '<span>end</span>'}</div><footer>f</footer></body></html>`;
    return { body: Buffer.from(html, 'latin1'), type: 'text/html' };
  }
  if (u.pathname === '/spa') {
    // Items only exist after scripts run, so a plain fetch finds nothing.
    const items = JSON.stringify(Array.from({ length: PER }, (_, i) => `Card ${(n - 1) * PER + i + 1}`));
    return { body: page('SPA ' + n, `<section class="grid" id="cards"></section>${pager('/spa?page=', n, 'Next')}
      <script>for (const t of ${items}) { const a = document.createElement('article'); a.className = 'card'; a.style.height = '200px'; a.textContent = t + ' with enough text to count'; document.getElementById('cards').append(a); }</script>`) };
  }
  if (u.pathname === '/buster') {
    // Script-rendered like /spa, so Onward needs the iframe fallback, plus a
    // frame buster in its own script and an autoplaying track that reports
    // its muted state to the parent.
    const items = JSON.stringify(Array.from({ length: PER }, (_, i) => `Card ${(n - 1) * PER + i + 1}`));
    return { body: page('Buster ' + n, `<section class="grid" id="cards"></section>${pager('/buster?page=', n, 'Next')}
      <audio id="snd" src="/tone.wav" autoplay loop></audio>
      <script>if (top !== self) top.location.href = '/buster?page=1&busted=1';</script>
      <script>for (const t of ${items}) { const a = document.createElement('article'); a.className = 'card'; a.style.height = '200px'; a.textContent = t + ' with enough text to count'; document.getElementById('cards').append(a); }
        // Report from the setter itself: volumechange is queued as a task and
        // Onward removes the frame before that task would run.
        const muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
        const report = (el, where) => Object.defineProperty(el, 'muted', { configurable: true, get() { return muted.get.call(this); }, set(v) {
          muted.set.call(this, v);
          if (top !== self) parent.postMessage({ type: 'media', page: location.search, where, muted: muted.get.call(this), paused: this.paused }, '*');
        } });
        report(document.getElementById('snd'), 'light');
        // A second track inside an open shadow root.
        const host = document.createElement('div');
        document.body.append(host);
        const inner = document.createElement('audio');
        inner.src = '/tone.wav'; inner.autoplay = true; inner.loop = true;
        host.attachShadow({ mode: 'open' }).append(inner);
        report(inner, 'shadow');</script>`) };
  }
  if (u.pathname === '/tone.wav') return { body: wav(), type: 'audio/wav' };
  if (u.pathname === '/selfscroll') {
    // Loads more by itself near the bottom, and still advertises rel=next for crawlers.
    const more = JSON.stringify(Array.from({ length: LAST - n }, (_, i) => posts(n + i + 1)));
    return { body: page('Self ' + n, `<ul class="posts" id="list">${posts(n)}</ul>${pager('/selfscroll?page=', n, 'Next')}
      <script>const more = ${more}; let busy = false;
        addEventListener('scroll', () => {
          if (busy || !more.length || innerHeight + scrollY < document.documentElement.scrollHeight - 200) return;
          busy = true;
          setTimeout(() => { document.getElementById('list').insertAdjacentHTML('beforeend', more.shift()); busy = false; }, 100);
        });</script>`, n < LAST ? `<link rel="next" href="/selfscroll?page=${n + 1}">` : '') };
  }
  if (u.pathname === '/slow') {
    // Pages after the first take 2 s, so a test can act while one is in flight.
    return { body: page('Slow ' + n, `<ul class="posts">${posts(n)}</ul>${pager('/slow?page=', n, 'Next')}`), delay: n > 1 ? 2000 : 0 };
  }
  if (u.pathname === '/batch') {
    // Jetpack-style: each native batch arrives as ONE wrapper holding a page of posts.
    const article = (k) => `<article class="post"><h2><a href="/post/${k}">Post ${k}</a></h2><p>Summary of post ${k}.</p></article>`;
    const batch = (m) => Array.from({ length: PER }, (_, i) => article((m - 1) * PER + i + 1)).join('');
    const more = JSON.stringify(Array.from({ length: LAST - n }, (_, i) => `<div class="infinite-wrap">${batch(n + i + 1)}</div>`));
    return { body: page('Batch ' + n, `<div id="posts" class="posts">${batch(n)}</div>${pager('/batch?page=', n, 'Next')}
      <script>const more = ${more}; let busy = false;
        addEventListener('scroll', () => {
          if (busy || !more.length || innerHeight + scrollY < document.documentElement.scrollHeight - 200) return;
          busy = true;
          setTimeout(() => { document.getElementById('posts').insertAdjacentHTML('beforeend', more.shift()); busy = false; }, 100);
        });</script>`, n < LAST ? `<link rel="next" href="/batch?page=${n + 1}">` : '') };
  }
  if (u.pathname === '/ads') {
    // A plain paginated list whose own script drops an ad in whenever posts appear.
    return { body: page('Ads ' + n, `<ul class="posts" id="list">${posts(n)}</ul>${pager('/ads?page=', n, 'Next')}
      <script>const list = document.getElementById('list'); let ads = 0;
        new MutationObserver(() => {
          const want = Math.floor(list.querySelectorAll(':scope > li.post').length / ${PER});
          while (ads < want) { ads++; const li = document.createElement('li'); li.className = 'ad'; li.textContent = 'Sponsored ' + ads; list.append(li); }
        }).observe(list, { childList: true });</script>`) };
  }
  if (u.pathname === '/live') {
    // A plain paginated list with long pages that prepends one live item every 1.5 s.
    return { body: page('Live ' + n, `<ul class="posts" id="list">${posts(n, LIVE_PER)}</ul>${pager('/live?page=', n, 'Next', LIVE_LAST)}
      <script>let k = 0; setInterval(() => { k++; const li = document.createElement('li'); li.className = 'post live'; li.innerHTML = '<a href="/live/' + k + '">Live ' + k + '</a><p>Breaking item ' + k + '.</p>'; document.getElementById('list').prepend(li); }, 1500);</script>`) };
  }
  if (u.pathname === '/bs') {
    // Bootstrap pagination: every link shares .page-item > .page-link, Previous included.
    const item = (label, href, extra = '') => `<li class="page-item${extra}"><a class="page-link" href="${href}">${label}</a></li>`;
    const nav = `<nav aria-label="Pages"><ul class="pagination">
      ${n > 1 ? item('Previous', `/bs?page=${n - 1}`) : item('Previous', '#', ' disabled')}
      ${Array.from({ length: LAST }, (_, i) => item(String(i + 1), `/bs?page=${i + 1}`, i + 1 === n ? ' active' : '')).join('')}
      ${n < LAST ? item('Next', u.searchParams.has('ext') ? `https://elsewhere.example/bs?page=${n + 1}` : `/bs?page=${n + 1}`) : item('Next', '#', ' disabled')}</ul></nav>`;
    return { body: page('Bootstrap ' + n, `<main><ul class="posts">${posts(n)}</ul>${nav}</main>`) };
  }
  if (u.pathname === '/long') {
    // Ten ordinary pages, for readers who park in the footer.
    return { body: page('Long ' + n, `<ul class="posts" id="list">${posts(n)}</ul>${pager('/long?page=', n, 'Next', LONG_LAST)}`) };
  }
  if (u.pathname === '/generator') {
    return { body: page('Generator ' + n, `<main><ul class="posts">${posts(n)}</ul>${pager('/generator?page=', n, 'Next')}</main>`,
      '<meta name="generator" content="Discourse 2026.9.0-latest">') };
  }
  if (u.pathname === '/more') {
    return { body: page('Load more', `<ul class="posts" id="list">${posts(1)}</ul><button class="load-more" id="lm">Load more</button>
      <script>let n = 1; document.getElementById('lm').onclick = () => { n++; setTimeout(() => {
        for (let i = 1; i <= 5; i++) { const li = document.createElement('li'); li.className = 'post'; li.textContent = 'Loaded ' + n + '.' + i + ' with summary text'; document.getElementById('list').append(li); }
        if (n >= ${LAST}) document.getElementById('lm').remove(); }, 150); };</script>`) };
  }
  if (u.pathname === '/redraw') {
    // Mimics a framework that re-renders its list and drops foreign nodes.
    return { body: page('Redraw ' + n, `<main><div id="app"><ul class="posts">${posts(n)}</ul></div>${pager('/redraw?page=', n, 'Next')}</main>
      <script>const app = document.getElementById('app'); const html = app.firstElementChild.outerHTML;
        // Like React reconciling its own list: the list element is replaced, siblings are left alone.
        new MutationObserver(() => { const ul = app.firstElementChild; if (ul.children.length !== ${PER}) setTimeout(() => { ul.outerHTML = html; }, 50); })
          .observe(app, { childList: true, subtree: true });</script>`) };
  }
  if (u.pathname === '/flaky') {
    hits.flaky[n] = (hits.flaky[n] || 0) + 1;
    if (n === 2) return { status: 500, body: 'boom' };
    return { body: page('Flaky ' + n, `<ul class="posts">${posts(n)}</ul>${pager('/flaky?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/inner') {
    // The window never scrolls; a div does.
    return { body: `<!doctype html><html><head><meta charset="utf-8"><style>html,body{height:100%;margin:0;overflow:hidden}
      #scroller{height:100%;overflow-y:auto} li{height:140px}</style></head><body><div id="scroller"><h1>Inner</h1>
      <ul class="posts">${posts(n)}</ul>${pager('/inner?page=', n, 'Next')}</div></body></html>` };
  }
  if (u.pathname.startsWith('/img/')) return { body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), type: 'image/gif' };
  return null;
}

function start() {
  const server = http.createServer((req, res) => {
    const r = route(req.url);
    if (!r) { res.writeHead(404); res.end('nope'); return; }
    // Record requests the client gave up on before the answer went out.
    res.on('close', () => { if (!res.writableEnded) hits.aborted.push(req.url); });
    const send = () => {
      res.writeHead(r.status || 200, { 'content-type': r.type || 'text/html; charset=utf-8' });
      res.end(r.body);
    };
    if (r.delay) setTimeout(send, r.delay);
    else send();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const hits = { flaky: {}, aborted: [] };

module.exports = { start, hits, PER, LAST, LIVE_PER, LIVE_LAST };
