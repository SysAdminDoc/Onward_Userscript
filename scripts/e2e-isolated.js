// The e2e suite with the script in an isolated world, as userscript managers run it.
const { spawnSync } = require('child_process');
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=60000', 'test/e2e/pager.e2e.js'], {
  stdio: 'inherit',
  env: Object.assign({}, process.env, { ONWARD_WORLD: 'isolated' }),
});
process.exit(r.status === null ? 1 : r.status);
