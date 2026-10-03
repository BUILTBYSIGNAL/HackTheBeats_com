// One-time build of the vendored Strudel bundle. Run with `npm run build:vendor`.
// The output is committed, so the site itself needs no build step.
import { build } from 'esbuild';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'vendor/strudel.bundle.js');

const version = (name) => JSON.parse(readFileSync(resolve(root, 'node_modules', name, 'package.json'), 'utf8')).version;

const banner = `/*
 * Strudel (https://strudel.cc) — bundled for Hack The Beats.
 * @strudel/core ${version('@strudel/core')}, @strudel/codemirror ${version('@strudel/codemirror')}, superdough ${version('superdough')}
 * Copyright (C) Strudel contributors — https://codeberg.org/uzu/strudel
 * Licensed under the GNU Affero General Public License v3.0 or later.
 * Source: https://codeberg.org/uzu/strudel  ·  Bundle entry: tools/strudel-entry.mjs
 */`;

const result = await build({
  entryPoints: [resolve(root, 'tools/strudel-entry.mjs')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  banner: { js: banner },
  metafile: true,
  logLevel: 'info',
});

// Guard against the one failure mode that breaks Strudel silently: two copies of a core package.
const inputs = Object.keys(result.metafile.inputs);
for (const pkg of ['@strudel/core', '@codemirror/state', '@codemirror/view', 'superdough']) {
  const copies = new Set(
    inputs.filter((p) => p.includes(`node_modules/${pkg}/`)).map((p) => p.slice(0, p.indexOf(`node_modules/${pkg}/`) + `node_modules/${pkg}/`.length)),
  );
  if (copies.size !== 1) {
    console.error(`✗ expected exactly one copy of ${pkg}, found ${copies.size}:`, [...copies]);
    process.exitCode = 1;
  }
}
console.log(`✓ ${outfile} (${(statSync(outfile).size / 1024).toFixed(0)} KB)`);
