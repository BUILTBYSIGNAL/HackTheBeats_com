// Keeps the version the site shows, and the offline cache it uses, in step with
// package.json. Runs automatically as part of `npm version <x.y.z>`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

writeFileSync(resolve(root, 'js/version.js'), `// Written by tools/set-version.mjs from package.json. Do not edit by hand.\nexport const VERSION = '${version}';\n`);

// a new version gets fresh offline caches, so nobody is left running old files
const swPath = resolve(root, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const next = sw.replace(/const VERSION = '[^']*';/, `const VERSION = 'v${version}';`);
if (next === sw && !sw.includes(`const VERSION = 'v${version}';`)) throw new Error('could not find the VERSION line in sw.js');
writeFileSync(swPath, next);

console.log(`✓ version ${version} written to js/version.js and sw.js`);
