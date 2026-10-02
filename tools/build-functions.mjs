// Builds the link-preview function (functions/) for deploying, or for the emulator the
// tests run: bundles its code with the site's own pure modules into functions/dist/,
// copies the player's page in as the template it fills, and writes the site's two
// addresses beside it. `npm run deploy` runs this; so does `npm run test:accounts`.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKERS } from '../js/share-page-core.js';
import { readSiteConfig } from './site-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'functions/dist');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'functions/src/index.js')],
  outfile: join(out, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // installed in functions/ itself (and, for resvg, a native binary per platform)
  external: ['firebase-admin', 'firebase-functions', '@resvg/resvg-js'],
  legalComments: 'none',
  logLevel: 'warning',
});

// The page the function answers with is the player's own, with the song written in.
const template = readFileSync(join(root, 'index.html'), 'utf8');
const missing = MARKERS.filter((marker) => !template.includes(marker));
if (missing.length) throw new Error(`index.html has lost what the link-preview function writes into: ${missing.join(', ')}`);
writeFileSync(join(out, 'player.html'), template);

// The site's addresses, so a forged Host header cannot point a page anywhere else. Not
// secret: every page of the site carries them.
const { appOrigin = '', shareOrigin = '' } = readSiteConfig(root) || {};
writeFileSync(join(out, 'site.json'), `${JSON.stringify({ appOrigin, shareOrigin })}\n`);
console.log(`✓ functions/dist/ — the link-preview function${shareOrigin ? ` for ${new URL(shareOrigin).host}` : ''}`);
