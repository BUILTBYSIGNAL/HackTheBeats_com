// Loads and plays every song in beats/ and reports what happened to each.
//
//   npm run test:songs                 every song, in chromium
//   npm run test:songs -- --offline    the same with all remote requests blocked, to prove
//                                      that the vendored samples (npm run samples) are enough
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// SONGS_PORT lets two copies of the project run this at once
const PORT = Number(process.env.SONGS_PORT) || 5198;
const URL_ = `http://localhost:${PORT}/`;
const offline = process.argv.includes('--offline');
// --built tests the site as it is published (run `npm run build` first)
const built = process.argv.includes('--built');

const server = spawn(process.execPath, [resolve(root, 'tools/serve.mjs')], { env: { ...process.env, PORT: String(PORT), ...(built ? { SERVE: 'dist' } : {}) }, stdio: 'ignore' });
process.on('exit', () => server.kill());
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(URL_)).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// a silent, virtual audio output: no noise, and no dependence on the machine's sound device
const browser = await chromium.launch({ args: ['--disable-audio-output'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
// these tests never touch the real accounts project
await context.addInitScript(() => (window.HTB_CONFIG = { firebase: null, analytics: null }));
const blocked = new Set();
if (offline) {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost') return route.continue();
    blocked.add(`${url.hostname}${url.pathname}`);
    return route.abort();
  });
}
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

await page.goto(URL_);
await page.waitForFunction(() => window.hackingTheBeats?.players.A.ready || window.hackingTheBeats?.players.A.failure, null, { timeout: 45000 });
await page.click('#curtain-play');
await page.waitForFunction(() => window.hackingTheBeats.players.A.started, null, { timeout: 45000 });

const results = await page.evaluate(async () => {
  const h = window.hackingTheBeats;
  const A = h.players.A;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [];
  for (const song of h.app.songs) {
    const began = performance.now();
    document.querySelector(`.beat[data-id="${CSS.escape(song.id)}"] .beat__deck[data-deck="A"]`).click();
    while (performance.now() - began < 40000 && !(A.song === song && (A.failure || (A.started && A.now() > 1.5)))) await sleep(100);
    let peak = 0;
    for (let i = 0; i < 50 && !A.failure; i++) {
      peak = Math.max(peak, h.master.peak());
      await sleep(40);
    }
    // every suggestion the song makes has to run, and come off again cleanly
    const original = A.code;
    const tries = [];
    for (const [index, chip] of [...document.querySelectorAll('#tries .tries__chip')].entries()) {
      const label = chip.textContent;
      if (chip.disabled) {
        tries.push(`${label} (does not fit)`);
        continue;
      }
      const chipAt = () => document.querySelectorAll('#tries .tries__chip')[index];
      chipAt().click();
      let waited = 0;
      while (waited < 8000 && (h.tries.busy || chipAt()?.getAttribute('aria-pressed') !== 'true')) {
        await sleep(100);
        waited += 100;
      }
      const ran = chipAt()?.getAttribute('aria-pressed') === 'true' && !A.problem;
      chipAt()?.click();
      waited = 0;
      while (waited < 8000 && (h.tries.busy || chipAt()?.getAttribute('aria-pressed') !== 'false')) {
        await sleep(100);
        waited += 100;
      }
      if (!ran || A.code !== original) tries.push(`${label} (${ran ? 'did not come off cleanly' : 'did not run'})`);
    }
    rows.push({
      tries: tries,
      title: song.title,
      ok: !A.failure && A.started && peak > 0.01 && tries.length === 0,
      seconds: ((performance.now() - began) / 1000 - 2).toFixed(1),
      peak: peak.toFixed(2),
      tracks: A.mixer.tracks.length,
      knobs: A.sliders.length,
      failure: A.failure ? `${A.failure.title}: ${A.failure.detail}` : '',
      silent: A.mixer.tracks.filter((track) => track.missingSounds.length).map((track) => `${track.name} (${track.missingSounds.join(', ')})`),
    });
  }
  A.stop();
  return rows;
});
await browser.close();
server.kill();

let failures = 0;
for (const row of results) {
  if (!row.ok) failures++;
  console.log(`${row.ok ? '✓' : '✗'} ${row.title.padEnd(28)} ${String(row.tracks).padStart(2)} tracks ${String(row.knobs).padStart(2)} knobs  peak ${row.peak}  ready in ${row.seconds}s${row.failure ? `  ${row.failure}` : ''}`);
  for (const note of row.silent) console.log(`    silent part: ${note}`);
  for (const note of row.tries) console.log(`    suggestion: ${note}`);
}
if (errors.length) console.log(`\npage errors:\n  ${[...new Set(errors)].slice(0, 8).join('\n  ')}`);
if (offline) {
  console.log(blocked.size ? `\nblocked remote requests (${blocked.size}):\n  ${[...blocked].slice(0, 30).join('\n  ')}` : '\nno remote requests were attempted');
}
console.log(failures ? `\n${failures} song(s) failed` : `\nall ${results.length} songs play`);
process.exit(failures ? 1 : 0);
