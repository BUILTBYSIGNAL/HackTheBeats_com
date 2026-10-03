// Loads and plays every song in beats/ and reports what happened to each.
//
//   npm run test:songs                 every song, in chromium
//   npm run test:songs -- --offline    the same with all remote requests blocked, to prove
//                                      that the vendored samples (npm run samples) are enough
//   npm run test:songs -- --examples   the Learn guide's examples (learn/examples/) instead
//                                      of the beats; combines with --offline and an engine
//                                      name (chromium, firefox or webkit)
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as playwright from 'playwright';
import { parse } from 'acorn';
import { createAnalyzer } from '../../js/analyze-core.js';
import { titleOf } from '../../js/songs-core.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// SONGS_PORT lets two copies of the project run this at once
const PORT = Number(process.env.SONGS_PORT) || 5198;
const URL_ = `http://localhost:${PORT}/`;
const offline = process.argv.includes('--offline');
// --built tests the site as it is published (run `npm run build` first)
const built = process.argv.includes('--built');
// --examples plays the Learn guide's examples instead of the beats
const examplesMode = process.argv.includes('--examples');
const engineName = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || 'chromium';
const engine = playwright[engineName];
if (!engine) {
  console.log(`${engineName}: unknown engine`);
  process.exit(1);
}

// The examples, described the way the library describes a song (library-core.js), so the
// deck can load them without the player's own example loader.
const analyze = createAnalyzer(parse);
const examples = examplesMode
  ? readdirSync(resolve(root, 'learn/examples'))
      .filter((name) => name.endsWith('.strudel'))
      .sort()
      .map((name) => {
        const id = name.replace(/\.strudel$/, '');
        const code = readFileSync(resolve(root, 'learn/examples', name), 'utf8');
        const { meta, tracks, sliders, switches } = analyze(code);
        return { id, title: titleOf(code) || id, by: meta.by, bpm: meta.bpm, notes: meta.notes, trackCount: tracks.length, knobCount: sliders.length + switches.length };
      })
  : [];

const server = spawn(process.execPath, [resolve(root, 'tools/serve.mjs')], { env: { ...process.env, PORT: String(PORT), ...(built ? { SERVE: 'dist' } : {}) }, stdio: 'ignore' });
process.on('exit', () => server.kill());
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(URL_)).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Chromium renders to a silent, virtual output: no noise, and no dependence on the machine's
// sound device. Firefox and WebKit have no such switch and play out loud.
const options = {
  chromium: { args: ['--disable-audio-output'] },
  firefox: { firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } },
};
const browser = await engine.launch(options[engineName] || {});
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

const results = await page.evaluate(async ({ examples }) => {
  const h = window.hackingTheBeats;
  const A = h.players.A;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [];

  // The songs to play, each with the way it goes on deck A: a beat by its button in the
  // library, an example by its file, loaded as a song object the way the library loads one.
  const queue = examples.length
    ? examples.map((example) => async () => {
        const response = await fetch(`/learn/examples/${example.id}.strudel`);
        if (!response.ok) throw new Error(`${response.status} for ${example.id}`);
        const song = { ...example, id: `example:${example.id}`, source: 'example', code: await response.text() };
        A.load(song, { autoplay: true });
        return song;
      })
    : h.app.songs.map((song) => async () => {
        document.querySelector(`.beat[data-id="${CSS.escape(song.id)}"] .beat__deck[data-deck="A"]`).click();
        return song;
      });

  for (const start of queue) {
    const began = performance.now();
    let song;
    try {
      song = await start();
    } catch (error) {
      rows.push({ title: String(error.message), ok: false, seconds: '0.0', peak: '0.00', tracks: 0, knobs: 0, failure: 'could not load', silent: [], tries: [] });
      continue;
    }
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
      ok: !A.failure && A.started && peak > 0.01 && tries.length === 0 && !A.mixer.tracks.some((track) => track.missingSounds.length),
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
}, { examples });
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
const what = examplesMode ? 'example' : 'song';
console.log(failures ? `\n${failures} ${what}(s) failed` : `\nall ${results.length} ${what}s play`);
process.exit(failures ? 1 : 0);
