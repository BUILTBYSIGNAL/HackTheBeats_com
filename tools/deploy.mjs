// Publishes the site: hosting and the database rules, and the link-preview function when
// the site uses it (`linkPreviews` in config.site.json). A function needs Firebase's Blaze
// plan; a site without it leaves `linkPreviews` off and its share links stay #song= links.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSiteConfig } from './site-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const settings = readSiteConfig(root) || {};
const parts = ['hosting', 'firestore'];
if (settings.linkPreviews) {
  // the CLI loads the function's code to learn what it is deploying
  if (!existsSync(join(root, 'functions/node_modules'))) {
    console.error('✗ linkPreviews is on, but the function has no packages yet: run `npm --prefix functions ci` first.');
    process.exit(1);
  }
  parts.push('functions');
}
console.log(`→ firebase deploy --only ${parts.join(',')}`);
const run = spawnSync('firebase', ['deploy', '--only', parts.join(',')], { cwd: root, stdio: 'inherit' });
process.exit(run.status ?? 1);
