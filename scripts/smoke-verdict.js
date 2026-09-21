// What a smoke run on one site means, kept apart from the browser work so it can be tested.

/** The last page Onward added, from its bars: only finished page bars ("Page 3"), not "Page 3 failed". */
function lastPage(bars) {
  const pages = bars.filter((b) => b.kind === '' && /^Page \d+$/.test(b.label)).map((b) => Number(b.label.slice(5)));
  return pages.length ? Math.max(...pages) : 1;
}

/**
 * The verdict for a site with an expected result, or '' without one.
 * r: { error, botCheck, active, onwardErrors: [message], bars: [{ kind, label }], refused }
 */
function verdict(site, r) {
  if (!site.expect) return '';
  if (r.error) return 'NOT CHECKED (the page did not load: ' + r.error + ')';
  if (r.botCheck) return 'NOT CHECKED (the site showed a bot check to the headless browser)';
  if (r.onwardErrors && r.onwardErrors.length) return 'MISMATCH (Onward threw: ' + r.onwardErrors[0] + ')';
  const pages = lastPage(r.bars);
  if (site.expect === 'inactive') return !r.active && pages === 1 ? 'OK' : 'MISMATCH (expected inactive)';
  const want = site.minPages || 2;
  if (pages >= want) return 'OK';
  if (r.refused) return `NOT CHECKED (the site refused Onward's request: ${r.refused})`;
  return `MISMATCH (expected active, at least page ${want})`;
}

/** The run's exit code: a mismatch fails it, and so does a run that could check nothing. */
function exitCode(tally) {
  if (tally.MISMATCH) return 1;
  return tally.OK ? 0 : 2;
}

module.exports = { lastPage, verdict, exitCode };
