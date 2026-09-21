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

// Articles whose images reserve no height and arrive 700 ms late, so the
// list keeps growing above a reader after each page lands.
const lateArts = (n, h, d) => Array.from({ length: PER }, (_, i) => {
  const k = (n - 1) * PER + i + 1;
  return `<article class="post"><a href="/post/${k}">Post ${k}</a><p>Summary of post ${k}.</p><img src="/slow.svg?k=${k}${h ? '&h=' + h : ''}${d ? '&d=' + d : ''}"></article>`;
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

function route(url, req) {
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
  if (u.pathname === '/shift') {
    // Each page starts with the last post of the page before it, as lists do when items shift.
    const prev = n > 1 ? posts(n - 1).split('</li>').filter(Boolean).at(-1) + '</li>' : '';
    return { body: page('Shift ' + n, `<ul class="posts">${prev}${posts(n)}</ul>${pager('/shift?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/redir') {
    // Like a WordPress /page/N past the end: page 3 redirects back to page 1.
    if (n === 3) return { status: 302, location: '/redir?page=1', body: '' };
    // A per-request timestamp in every item, so the repeat-content check can't be what catches it.
    const stamped = posts(n).replace(/<\/li>/g, `<small>${process.hrtime.bigint()}</small></li>`);
    return { body: page('Redir ' + n, `<ul class="posts">${stamped}</ul>${pager('/redir?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/hang') {
    // Pages after the first never answer.
    return { body: page('Hang ' + n, `<ul class="posts">${posts(n)}</ul>${pager('/hang?page=', n, 'Next')}`), delay: n > 1 ? 1e9 : 0 };
  }
  if (u.pathname === '/lateimg') {
    return { body: page('Late ' + n, `<div class="posts" id="list">${lateArts(n)}</div>${pager('/lateimg?page=', n, 'Next', LONG_LAST)}`) };
  }
  if (u.pathname === '/latefoot') {
    // /lateimg plus a widget after the footer that grows 300 px once, 450 ms
    // after the first added page, and 2 px on every scroll; and a search box.
    const extra = `<div id="widget" style="height:10px;background:#fcc"></div><input id="q" style="position:fixed;top:0;right:0">
      <script>let grown = false; const L = document.getElementById('list'); const W = document.getElementById('widget');
      const grow = (px) => { W.style.height = (parseInt(W.style.height, 10) + px) + 'px'; };
      new MutationObserver(() => { if (grown || L.querySelectorAll('article.post').length <= ${PER}) return; grown = true; setTimeout(() => grow(300), 450); }).observe(L, { childList: true });
      addEventListener('scroll', () => grow(2), { passive: true });</script>`;
    return { body: page('Latefoot ' + n, `<div class="posts" id="list">${lateArts(n)}</div>${pager('/latefoot?page=', n, 'Next', LONG_LAST)}`).replace('</body>', extra + '</body>') };
  }
  if (u.pathname === '/slow.svg') {
    const h = Number(u.searchParams.get('h')) || 160;
    return { body: `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="${h}"></svg>`, type: 'image/svg+xml', delay: Number(u.searchParams.get('d')) || 700 };
  }
  if (u.pathname === '/tallimg') {
    // /lateimg with images 3000 px tall: one page fills any screen once they arrive.
    return { body: page('Tall ' + n, `<div class="posts" id="list">${lateArts(n, 3000)}</div>${pager('/tallimg?page=', n, 'Next', LONG_LAST)}`) };
  }
  if (u.pathname === '/shortfoot') {
    // A footer shorter than a page, so one page is enough to pull the list end into view.
    return { body: page('Short ' + n, `<ul class="posts" id="list">${posts(n)}</ul>${pager('/shortfoot?page=', n, 'Next', LONG_LAST)}`, '<style>footer{height:300px}</style>') };
  }
  if (u.pathname === '/long') {
    // Ten ordinary pages, for readers who park in the footer.
    return { body: page('Long ' + n, `<ul class="posts" id="list">${posts(n)}</ul>${pager('/long?page=', n, 'Next', LONG_LAST)}`) };
  }
  if (u.pathname === '/bs2') {
    // A pager above and below the list, both id="pager", a sliding window of
    // page numbers, Previous only after page 1, and "Next&nbsp;»".
    const last = 6;
    const item = (label, href, extra = '') => `<li class="page-item${extra}"><a class="page-link" href="${href}">${label}</a></li>`;
    const nums = [];
    for (let k = Math.max(1, n - 1); k <= Math.min(last, n + 2); k++) nums.push(item(String(k), `/bs2?page=${k}`, k === n ? ' active' : ''));
    const nav = `<nav id="pager"><ul class="pagination">${n > 1 ? item('Previous', `/bs2?page=${n - 1}`) : ''}${nums.join('')}${n < last ? item('Next&nbsp;»', `/bs2?page=${n + 1}`) : ''}</ul></nav>`;
    return { body: page('BS2 ' + n, `<main>${nav}<ul class="posts">${posts(n)}</ul>${nav}</main>`) };
  }
  if (u.pathname === '/featured') {
    // Page 1 alone has a same-class "featured" list above the real one.
    const list = (k0, label) => Array.from({ length: PER }, (_, i) => `<div class="item"><a href="/i/${k0 + i}">${label} ${k0 + i}</a><p>About item ${k0 + i}, long enough to count.</p></div>`).join('');
    const featured = n === 1 ? `<div class="list featured">${list(100, 'Featured').split('</div>').slice(0, 6).join('</div>')}</div></div>` : '';
    return { body: page('Featured ' + n, `<main>${featured}<div class="list">${list((n - 1) * PER + 1, 'Item')}</div>${pager('/featured?page=', n, 'Next')}</main>`) };
  }
  if (u.pathname === '/shadownext') {
    // The pager lives in a web component's open shadow root, where no selector reaches.
    return { body: page('Shadow ' + n, `<ul class="posts">${posts(n)}</ul><page-nav data-next="/shadownext?page=${n + 1}"></page-nav>
      <script>customElements.define('page-nav', class extends HTMLElement { connectedCallback() {
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<a href="' + this.dataset.next + '" style="display:inline-block;padding:10px">Next</a>';
      } });</script>`) };
  }
  if (u.pathname === '/prevcls') {
    // One class for both links: on page 1 it only marks Next, later it marks Previous too.
    const links = (n > 1 ? `<a class="pg" href="/prevcls?page=${n - 1}">← Previous page</a> ` : '') + (n < LAST ? `<a class="pg" href="/prevcls?page=${n + 1}">Next page →</a>` : '');
    return { body: page('Prevcls ' + n, `<ul class="posts">${posts(n)}</ul><div class="nav">${links}</div>`) };
  }
  if (u.pathname === '/metaref') {
    // Pages after the first hide a refresh in their first post.
    const list = n > 1 ? posts(n).replace('<li class="post">', '<li class="post"><meta http-equiv="refresh" content="0;url=/landed">') : posts(n);
    return { body: page('Metaref ' + n, `<ul class="posts">${list}</ul>${pager('/metaref?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/rules.json') {
    // A rule list; mode=html answers like a mirror serving its error page. Slow, so a refresh takes a while.
    hits.rules++;
    if (u.searchParams.get('mode') === 'html') return { body: '<html><body><h1>502 Bad Gateway</h1></body></html>', delay: 1500 };
    if (u.searchParams.get('mode') === 'site' && req) {
      // 200 rules for other sites, and one for this server's blog.
      const host = req.headers.host.replace(/\./g, '\\.');
      const others = Array.from({ length: 200 }, (_, i) => ({ url: `^https://site${i}\\.example/`, next: 'a.n', content: '.x' }));
      return { body: JSON.stringify(others.concat({ name: 'fixture blog', url: `^http://${host}/blog`, next: '.pagination a.next', content: 'ul.posts > li.post' })), type: 'application/json' };
    }
    return { body: JSON.stringify([{ url: '^https://one\\.example/', next: 'a.n' }, { url: '^https://two\\.example/', next: 'a.n' }]), type: 'application/json', delay: 1500 };
  }
  if (u.pathname === '/spaced') {
    // Records when each page after the first was asked for.
    if (n > 1) hits.spaced.push(Date.now());
    return { body: page('Spaced ' + n, `<ul class="posts">${posts(n)}</ul>${pager('/spaced?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/spapush') {
    // A filter button swaps the list and pushes a new address, as SPAs do.
    const filtered = JSON.stringify(posts(1).replace(/Post (\d+)/g, 'Filtered $1'));
    return { body: page('SPA push ' + n, `<button id="filter">Filter</button><div id="app"><ul class="posts">${posts(n)}</ul>${pager('/spapush?page=', n, 'Next')}</div>
      <script>document.getElementById('filter').onclick = () => {
        history.pushState({}, '', '/spapush?page=1&filter=x');
        document.querySelector('#app ul.posts').innerHTML = ${filtered};
      };</script>`) };
  }
  if (u.pathname === '/emptyonce' || u.pathname.startsWith('/emptyonce3')) {
    // Page 2 (page 3 on /emptyonce3 and /emptyonce3r) comes back empty the first time only, counted per path.
    const key = u.pathname + n;
    hits.emptyonce[key] = (hits.emptyonce[key] || 0) + 1;
    const failing = u.pathname.startsWith('/emptyonce3') ? 3 : 2;
    const list = n === failing && hits.emptyonce[key] === 1 ? '' : posts(n);
    return { body: page('Empty once ' + n, `<ul class="posts">${list}</ul>${pager(u.pathname + '?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/fixedh') {
    // The list box has a fixed height, so added pages never make the page longer.
    return { body: page('Fixedh ' + n, `<ul class="posts" style="height:700px;overflow:hidden;margin:0">${posts(n)}</ul>${pager('/fixedh?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/redrawall') {
    // A framework that owns its whole root: anything added inside it, even a comment next to the list, is thrown away.
    return { body: page('Redrawall ' + n, `<main><div id="app"><ul class="posts">${posts(n)}</ul></div>${pager('/redrawall?page=', n, 'Next')}</main>
      <script>const app = document.getElementById('app'); const html = app.innerHTML;
        new MutationObserver(() => { if (app.innerHTML !== html) setTimeout(() => { if (app.innerHTML !== html) app.innerHTML = html; }, 50); })
          .observe(app, { childList: true, subtree: true });</script>`) };
  }
  if (u.pathname === '/bs3') {
    // /bs2 with a French label whose space is a narrow no-break space (U+202F).
    const last = 6;
    const item = (label, href, extra = '') => `<li class="page-item${extra}"><a class="page-link" href="${href}">${label}</a></li>`;
    const nums = [];
    for (let k = Math.max(1, n - 1); k <= Math.min(last, n + 2); k++) nums.push(item(String(k), `/bs3?page=${k}`, k === n ? ' active' : ''));
    const nav = `<nav id="pager"><ul class="pagination">${n > 1 ? item('Précédent', `/bs3?page=${n - 1}`) : ''}${nums.join('')}${n < last ? item('Suivant&#8239;»', `/bs3?page=${n + 1}`) : ''}</ul></nav>`;
    return { body: page('BS3 ' + n, `<main>${nav}<ul class="posts">${posts(n)}</ul>${nav}</main>`) };
  }
  if (u.pathname === '/latepager') {
    // Items in the HTML, but page 1 draws its pager a second after load.
    const nav = pager('/latepager?page=', n, 'Next');
    const drawn = n === 1 ? `<div id="nav"></div><script>setTimeout(() => { document.getElementById('nav').innerHTML = ${JSON.stringify(nav)}; }, 1000);</script>` : nav;
    return { body: page('Late pager ' + n, `<ul class="posts">${posts(n)}</ul>${drawn}`) };
  }
  if (u.pathname === '/shadowlist') {
    // The list lives in a web component's open shadow root, in a <ul> or (direct=1) straight in the root.
    const inner = u.searchParams.get('direct') ? posts(n) : `<ul class="inner">${posts(n)}</ul>`;
    const define = `<script>customElements.define('x-list', class extends HTMLElement {
      connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(inner)}; }
    });</script>`;
    return { body: page('Shadow list ' + n, `<x-list></x-list>${define}${pager('/shadowlist?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/lazyrepeat') {
    // The site's own lazy loader swaps src on screen; past page 2 the server sends page 1 again.
    const loader = '<script>for (const img of document.querySelectorAll("img[data-src]")) { img.src = img.dataset.src; img.removeAttribute("data-src"); }</script>';
    const k = n > 2 ? 1 : n;
    return { body: page('Lazy repeat ' + n, `<ul class="posts">${posts(k)}</ul>${pager('/lazyrepeat?page=', n, 'Next')}${loader}`) };
  }
  if (u.pathname === '/flexcol') {
    // A column flex list with a set height (its own scroller).
    return { body: page('Flexcol ' + n, `<ul class="posts" style="display:flex;flex-direction:column;height:600px;overflow-y:auto;margin:0">${posts(n)}</ul>${pager('/flexcol?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/gridlist') {
    return { body: page('Grid ' + n, `<ul class="posts" style="display:grid;grid-template-columns:repeat(5,1fr);row-gap:30px;margin:0;padding:0">${posts(n)}</ul>${pager('/gridlist?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/checkout') {
    // A paged list on a checkout page (order history, saved items): Onward stays off by default.
    return { body: page('Checkout ' + n, `<ul class="posts">${posts(n)}</ul>${pager('/checkout?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/iframeblock') {
    // Script-rendered (auto mode falls back to an iframe); pages after the
    // first then hold the parser on a script that never arrives.
    const items = JSON.stringify(Array.from({ length: PER }, (_, i) => `Card ${(n - 1) * PER + i + 1}`));
    const block = n > 1 ? '<script src="/block.js"></script>' : '';
    return { body: page('IframeBlock ' + n, `<section class="grid" id="cards"></section>${pager('/iframeblock?page=', n, 'Next')}
      <script>for (const t of ${items}) { const a = document.createElement('article'); a.className = 'card'; a.style.height = '200px'; a.textContent = t + ' with enough text to count'; document.getElementById('cards').append(a); }</script>${block}`) };
  }
  if (u.pathname === '/iframebusy') {
    // /iframeblock plus a ticker that keeps changing the page, so it never looks settled.
    const items = JSON.stringify(Array.from({ length: PER }, (_, i) => `Card ${(n - 1) * PER + i + 1}`));
    const block = n > 1 ? '<script>setInterval(() => { const t = document.getElementById(\'tick\'); if (t.children.length > 3) t.replaceChildren(); else t.append(document.createElement(\'b\')); }, 100);</script><script src="/block.js"></script>' : '';
    return { body: page('IframeBusy ' + n, `<span id="tick"></span><section class="grid" id="cards"></section>${pager('/iframebusy?page=', n, 'Next')}
      <script>for (const t of ${items}) { const a = document.createElement('article'); a.className = 'card'; a.style.height = '200px'; a.textContent = t + ' with enough text to count'; document.getElementById('cards').append(a); }</script>${block}`) };
  }
  if (u.pathname === '/block.js') return { body: '', type: 'text/javascript', delay: 1e9 };
  if (u.pathname === '/iframespaced') {
    // /spa with a log of each later page request and what asked for it (a fetch or a frame).
    if (n > 1 && req) hits.iframespaced.push({ n, t: Date.now(), dest: req.headers['sec-fetch-dest'] });
    const items = JSON.stringify(Array.from({ length: PER }, (_, i) => `Card ${(n - 1) * PER + i + 1}`));
    return { body: page('IframeSpaced ' + n, `<section class="grid" id="cards"></section>${pager('/iframespaced?page=', n, 'Next')}
      <script>for (const t of ${items}) { const a = document.createElement('article'); a.className = 'card'; a.style.height = '200px'; a.textContent = t + ' with enough text to count'; document.getElementById('cards').append(a); }</script>`) };
  }
  if (u.pathname === '/spaslow') {
    // A router that pushes the new address first and draws the new route when its data lands 500 ms later.
    const f = u.searchParams.get('filter');
    const list = f ? posts(n).replace(/Post (\d+)/g, 'Filtered $1') : posts(n);
    const base = f ? '/spaslow?filter=x&page=' : '/spaslow?page=';
    const newItems = JSON.stringify(posts(1).replace(/Post (\d+)/g, 'Filtered $1'));
    const newPager = JSON.stringify(pager('/spaslow?filter=x&page=', 1, 'Next'));
    return { body: page('SPA slow ' + n, `<button id="filter">Filter</button><div id="app"><ul class="posts">${list}</ul><div id="pg">${pager(base, n, 'Next')}</div></div>
      <script>document.getElementById('filter').onclick = () => {
        history.pushState({}, '', '/spaslow?filter=x&page=1');
        setTimeout(() => {
          const ul = document.querySelector('#app ul.posts');
          for (const li of ul.querySelectorAll(':scope > li.post')) li.remove();
          ul.insertAdjacentHTML('beforeend', ${newItems});
          document.getElementById('pg').innerHTML = ${newPager};
        }, 500);
      };</script>`) };
  }
  if (u.pathname === '/parklate') {
    // Late images (d ms) that shift the page after it lands, and a side panel that keeps the wheel to itself.
    const d = Number(u.searchParams.get('d')) || 700;
    const box = '<div id="box" style="position:fixed;right:0;top:100px;width:220px;height:300px;overflow:auto;overscroll-behavior:contain;background:#eef"><div style="height:3000px">box</div></div>';
    return { body: page('Parklate ' + n, `<div class="posts" id="list">${lateArts(n, 0, d)}</div>${pager('/parklate?d=' + d + '&page=', n, 'Next', LONG_LAST)}`).replace('<footer>footer</footer>', `<footer>footer</footer>${box}`) };
  }
  if (u.pathname === '/parkbox') {
    // /long plus a fixed side panel (a table of contents, a chat) that keeps the wheel to itself.
    const box = '<div id="box" style="position:fixed;right:0;top:100px;width:220px;height:300px;overflow:auto;overscroll-behavior:contain;background:#eef"><div style="height:3000px">box</div></div>';
    return { body: page('Parkbox ' + n, `<ul class="posts" id="list">${posts(n)}</ul>${pager('/parkbox?page=', n, 'Next', LONG_LAST)}`).replace('<footer>footer</footer>', `<footer>footer</footer>${box}`) };
  }
  if (u.pathname === '/walls') {
    // A wallpaper grid: every tile is a picture and the same Download button, no link.
    const tiles = Array.from({ length: PER }, (_, i) => `<li class="w"><img src="/img/${(n - 1) * PER + i + 1}.png" width="200" height="100" alt=""><button type="button">Download</button></li>`).join('');
    return { body: page('Walls ' + n, `<ul class="walls" id="walls">${tiles}</ul>${pager('/walls?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/jsiframe') {
    // Page 2's first post carries a javascript: frame whose scheme is split by a newline.
    const list = n > 1 ? posts(n).replace('<li class="post">', '<li class="post"><iframe src="java&#10;script:parent.__pwned=location.href"></iframe>') : posts(n);
    return { body: page('JsIframe ' + n, `<ul class="posts">${list}</ul>${pager('/jsiframe?page=', n, 'Next')}`) };
  }
  if (u.pathname === '/xmore') {
    // A "Load more" link to another origin (https on this http site), the only way on.
    const more = n === 1 ? `<a class="more" href="https://127.0.0.1:1/xmore?page=2">Load more</a>` : '';
    return { body: page('Xmore ' + n, `<ul class="posts" id="list">${posts(n)}</ul><div class="pagination">${more}</div>`) };
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
    const r = route(req.url, req);
    if (!r) { res.writeHead(404); res.end('nope'); return; }
    // Record requests the client gave up on before the answer went out.
    res.on('close', () => { if (!res.writableEnded) hits.aborted.push(req.url); });
    const send = () => {
      if (r.location) { res.writeHead(r.status || 302, { location: r.location }); res.end(); return; }
      res.writeHead(r.status || 200, { 'content-type': r.type || 'text/html; charset=utf-8' });
      res.end(r.body);
    };
    // unref: a never-answering route (/hang) must not keep the test process alive.
    if (r.delay) setTimeout(send, r.delay).unref();
    else send();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const hits = { flaky: {}, aborted: [], rules: 0, spaced: [], emptyonce: {}, iframespaced: [] };

module.exports = { start, hits, PER, LAST, LIVE_PER, LIVE_LAST };
