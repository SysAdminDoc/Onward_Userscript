// What a wedata-sized rule list costs Onward: how much it stores, and what a page pays to use it.
//   npm run bench -- path/to/items_all.json
// Get the list from http://wedata.net/databases/AutoPagerize/items_all.json (about 2.4 MB).
// Exits non-zero if the stored list is 350 KB or more, or an unmatched address takes 0.5 ms or more.
const fs = require('fs');
const O = require('../src/onward.user.js');

const file = process.argv[2] || 'items_all.json';
if (!fs.existsSync(file)) {
  console.error(`No rule list at ${file}.\nDownload http://wedata.net/databases/AutoPagerize/items_all.json and pass its path:\n  npm run bench -- path/to/items_all.json`);
  process.exit(2);
}

const now = () => Number(process.hrtime.bigint()) / 1e6;
async function timed(fn, runs) {
  await fn();
  const t0 = now();
  for (let i = 0; i < runs; i++) await fn();
  return (now() - t0) / runs;
}

(async () => {
  const rules = O.normalizeRules(JSON.parse(fs.readFileSync(file, 'utf8')), { fromList: true });
  const flat = JSON.stringify(rules).length;
  const entry = await O.buildListEntry(rules, Date.now());
  const stored = JSON.stringify(entry).length;
  const cache = { [file]: entry };
  const hostLines = entry.hosts.split('\n').filter(Boolean);
  const hosted = new Set(hostLines.flatMap((l) => l.split(' ')[1].split(','))).size;

  const unmatched = 'https://unmatched.example.org/some/page?x=1';
  const someHost = hostLines[0].split(' ')[0];
  const matched = `https://${someHost}/`;
  // A page's first use pays for unpacking; later uses on the same page (a
  // retry, a route change) find it unpacked.
  const cold = (href) => timed(async () => { O.forgetListRules(); O.matchingRules(await O.listRulesFor(cache, href), href); }, 20);
  const warm = (href) => timed(async () => { O.matchingRules(await O.listRulesFor(cache, href), href); }, 200);
  const oldWay = await timed(async () => O.matchingRules(rules, unmatched), 20);

  const rows = [
    ['rules', rules.length],
    ['indexed by host', `${hosted} (${hostLines.length} hosts); ${entry.generic.length} others, ${entry.generic.filter((g) => !g[1]).length} with no required text; ${rules.length - hosted - entry.generic.length} catch-alls left out`],
    ['stored, flattened JSON (before)', `${(flat / 1024).toFixed(0)} KB`],
    ['stored, packed (now)', `${(stored / 1024).toFixed(0)} KB`],
    ['unmatched address, first use on a page', `${(await cold(unmatched)).toFixed(2)} ms`],
    ['unmatched address, matching', `${(await warm(unmatched)).toFixed(3)} ms`],
    [`matched address (${someHost}), first use`, `${(await cold(matched)).toFixed(2)} ms`],
    ['every rule tested, the old way', `${oldWay.toFixed(2)} ms`],
  ];
  for (const [k, v] of rows) console.log(k.padEnd(40), v);
  const matchMs = await warm(unmatched);
  const ok = stored < 350 * 1024 && matchMs < 0.5;
  console.log(ok ? '\nWithin budget: under 350 KB stored, under 0.5 ms to match an unmatched address.' : '\nOver budget.');
  process.exit(ok ? 0 : 1);
})();
