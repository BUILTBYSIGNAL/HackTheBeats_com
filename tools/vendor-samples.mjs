// Makes the site work offline: downloads the sample files the songs in beats/ actually use
// into vendor/samples/ and writes vendor/samples/index.json, a table of
// "remote url → local path" that the engine consults before going to the network.
//
//   npm run samples                 every song in beats/
//   npm run samples -- --only amber only songs whose title or code matches "amber"
//   npm run samples -- --clean      remove everything that was downloaded
//
// Anything not in the table is still fetched from the network, so songs added later keep
// working online until the script is run again.
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { listBeats } from './beats.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'vendor/samples');
const indexFile = join(outDir, 'index.json');

const DOUGH = 'https://raw.githubusercontent.com/felixroos/dough-samples/main';
const DEFAULT_PACKS = [
  `${DOUGH}/tidal-drum-machines.json`,
  `${DOUGH}/piano.json`,
  `${DOUGH}/Dirt-Samples.json`,
  `${DOUGH}/vcsl.json`,
  `${DOUGH}/mridangam.json`,
  'https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main/strudel.json',
];
const ALIASES = 'https://raw.githubusercontent.com/todepond/samples/main/tidal-drum-machines-alias.json';
const SOUNDFONTS = 'https://felixroos.github.io/webaudiofontdata/sound';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1]?.toLowerCase() : null;

if (args.includes('--clean')) {
  for (const entry of existsSync(outDir) ? readdirSync(outDir) : []) rmSync(join(outDir, entry), { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(indexFile, JSON.stringify({ files: {} }, null, 2) + '\n');
  console.log('✓ vendor/samples cleared — samples will stream from the network');
  process.exit(0);
}

/* ---------- which songs ---------- */

function readSongs() {
  const beatsDir = join(root, 'beats');
  const byId = new Map();
  for (const file of listBeats(beatsDir).files) {
    const text = readFileSync(join(beatsDir, file), 'utf8');
    if (!/\.json$/i.test(file)) {
      byId.set(file, text);
      continue;
    }
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : Object.entries(data).map(([id, value]) => ({ id, ...value }));
      for (const entry of list) if (typeof entry?.code === 'string' && entry.code.trim()) byId.set(String(entry.id), entry.code);
    } catch {
      console.warn(`! ${file} is not valid JSON, skipped`);
    }
  }
  return [...byId.values()].filter((code) => !only || code.toLowerCase().includes(only));
}

/* ---------- what they use ---------- */

const NAME = /[A-Za-z][A-Za-z0-9_]*/g;

function usage(songs) {
  const sounds = new Set();
  const banks = new Set();
  const fonts = new Set();
  const packs = new Set();
  for (const code of songs) {
    for (const [, text] of code.matchAll(/\b(?:s|sound)\(\s*["'`]([^"'`]*)["'`]/g)) for (const name of text.match(NAME) || []) sounds.add(name.toLowerCase());
    for (const [, text] of code.matchAll(/\.bank\(\s*["'`]([^"'`]*)["'`]/g)) for (const name of text.match(NAME) || []) banks.add(name.toLowerCase());
    for (const [name] of code.matchAll(/\bgm_[a-z0-9_]+/g)) fonts.add(name);
    for (const [, source] of code.matchAll(/\bsamples\(\s*['"]([^'"]+)['"]/g)) packs.add(source);
  }
  return { sounds, banks, fonts, packs };
}

// Mirrors superdough's fetchSampleMap(): the URL a pack name is actually fetched from.
function packUrl(source) {
  if (source.startsWith('shabda/speech')) {
    // spoken words, e.g. shabda/speech/en-US/f:one,two — the stray quote is superdough's own
    const path = source.split('shabda/speech')[1].replace(/^\//, '');
    const [params, words] = path.split(':');
    const [language = 'en-GB', gender = 'f'] = params ? params.split('/') : [];
    return `https://shabda.ndre.gr/speech/${words}.json?gender=${gender}&language=${language}&strudel=1'`;
  }
  if (source.startsWith('shabda:')) return `https://shabda.ndre.gr/${source.split('shabda:')[1]}.json?strudel=1`;
  if (!source.startsWith('github:')) return source;
  let path = source.slice('github:'.length).replace(/\/$/, '');
  const [user, repo = 'samples', branch = 'main', ...rest] = path.split('/');
  return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${[...rest, 'strudel.json'].join('/')}`;
}
function resolveBase(base) {
  if (!base.startsWith('github:')) return base;
  const [user, repo = 'samples', branch = 'main', ...rest] = base.slice('github:'.length).replace(/\/$/, '').split('/');
  return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${[...rest, ''].join('/')}`;
}

/* ---------- downloading ---------- */

const table = {};
let bytes = 0;
let fetched = 0;
let reused = 0;
const failures = [];

function localPath(url) {
  const { hostname, pathname, search } = new URL(url);
  const segments = pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  // keep files apart when only the query string differs
  if (search) segments[segments.length - 1] = segments.at(-1).replace(/(\.[^.]+)?$/, `~${search.replace(/[^A-Za-z0-9]+/g, '-')}$1`);
  return { disk: join(outDir, hostname, ...segments), web: ['vendor/samples', hostname, ...segments].map((part, i) => (i < 2 ? part : encodeURIComponent(part))).join('/') };
}

async function download(url, { text = false } = {}) {
  const { disk, web } = localPath(url);
  table[url] = web;
  if (existsSync(disk)) {
    reused++;
    bytes += statSync(disk).size;
    return text ? readFileSync(disk, 'utf8') : null;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(disk), { recursive: true });
  writeFileSync(disk, buffer);
  fetched++;
  bytes += buffer.length;
  return text ? buffer.toString('utf8') : null;
}

async function pool(urls, size = 6) {
  const queue = [...urls];
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        await download(url);
      } catch (error) {
        delete table[url];
        failures.push(error.message);
      }
      if (++done % 25 === 0 || done === urls.length) process.stdout.write(`\r  ${done}/${urls.length} files`);
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  if (urls.length) process.stdout.write('\n');
}

/* ---------- run ---------- */

const songs = readSongs();
if (!songs.length) {
  console.error(only ? `No song in beats/ matches "${only}".` : 'No songs found in beats/.');
  process.exit(1);
}
const used = usage(songs);
console.log(`${songs.length} song(s): ${used.sounds.size} sound names, ${used.banks.size} banks, ${used.fonts.size} soundfonts, ${used.packs.size} extra pack(s)`);

// bank aliases, e.g. "dmx" → "OberheimDMX"
let aliasOf = new Map();
try {
  const aliases = JSON.parse(await download(ALIASES, { text: true }));
  for (const [bank, value] of Object.entries(aliases)) for (const alias of [value].flat()) aliasOf.set(String(alias).toLowerCase(), bank.toLowerCase());
} catch (error) {
  failures.push(error.message);
}
const banks = new Set([...used.banks].flatMap((bank) => [bank, aliasOf.get(bank)].filter(Boolean)));
const wanted = new Set([...used.sounds]);
for (const bank of banks) for (const sound of used.sounds) wanted.add(`${bank}_${sound}`);

const sampleUrls = new Set();
for (const source of [...DEFAULT_PACKS, ...used.packs]) {
  const url = packUrl(source);
  if (!/^https?:/.test(url)) {
    console.log(`  ${source}: skipped (not a pack that can be mirrored)`);
    continue;
  }
  // a pack of spoken words is made for the song that asks for it: take all of it
  const takeAll = source.startsWith('shabda');
  let map;
  try {
    map = JSON.parse(await download(url, { text: true }));
  } catch (error) {
    failures.push(error.message);
    continue;
  }
  let base = resolveBase(map._base || new URL('.', url).href.replace(/\/$/, ''));
  let count = 0;
  for (const [key, value] of Object.entries(map)) {
    if (key === '_base' || !(takeAll || wanted.has(key.toLowerCase()))) continue;
    const entryBase = resolveBase((typeof value === 'object' && !Array.isArray(value) && value._base) || base);
    const paths = typeof value === 'string' ? [value] : Array.isArray(value) ? value : Object.entries(value).filter(([note]) => !note.startsWith('_')).flatMap(([, files]) => files);
    for (const path of paths) {
      sampleUrls.add((entryBase + path).replace('#', '%23'));
      count++;
    }
  }
  console.log(`  ${source.replace('https://raw.githubusercontent.com/', '')}: ${count} file(s)`);
}

if (used.fonts.size) {
  const { default: gm } = await import('../node_modules/@strudel/soundfonts/gm.mjs').catch(() => ({ default: null }));
  if (!gm) console.warn('! soundfont list not found (run `npm install`), soundfonts were skipped');
  for (const name of used.fonts) for (const font of gm?.[name] || []) sampleUrls.add(`${SOUNDFONTS}/${font}.js`);
}

await pool([...sampleUrls]);
writeFileSync(indexFile, JSON.stringify({ generated: new Date().toISOString(), files: table }, null, 2) + '\n');

console.log(`✓ ${Object.keys(table).length} files in vendor/samples (${(bytes / 1048576).toFixed(1)} MB; ${fetched} downloaded, ${reused} already there)`);
if (failures.length) {
  console.log(`! ${failures.length} could not be downloaded (they will be fetched from the network when online):`);
  for (const message of failures.slice(0, 10)) console.log(`    ${message}`);
}
