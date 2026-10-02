// One-time build of the vendored Firebase bundle. Run with `npm run build:firebase`.
import { build } from 'esbuild';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'vendor/firebase.bundle.js');
const version = JSON.parse(readFileSync(resolve(root, 'node_modules/firebase/package.json'), 'utf8')).version;

await build({
  entryPoints: [resolve(root, 'tools/firebase-entry.mjs')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  banner: { js: `/* Firebase JS SDK ${version} (app, auth, firestore/lite) — Apache-2.0, https://github.com/firebase/firebase-js-sdk */` },
  logLevel: 'info',
});
console.log(`✓ ${outfile} (${(statSync(outfile).size / 1024).toFixed(0)} KB)`);
