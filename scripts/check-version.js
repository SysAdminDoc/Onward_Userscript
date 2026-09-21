// Fails when the version strings across the repo disagree.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const script = read('src/onward.user.js');
const found = {
  '@version': (/@version\s+(\S+)/.exec(script) || [])[1],
  'VERSION const': (/const VERSION = '([^']+)'/.exec(script) || [])[1],
  'package.json': JSON.parse(read('package.json')).version,
  'README badge': (/badge\/version-([\d.]+)-/.exec(read('README.md')) || [])[1],
  'CHANGELOG top': (/^## \[?v?([\d.]+)/m.exec(read('CHANGELOG.md')) || [])[1],
};

const values = new Set(Object.values(found));
if (values.size !== 1 || values.has(undefined)) {
  console.error('Version mismatch:', found);
  process.exit(1);
}
console.log('version', [...values][0], 'consistent');
