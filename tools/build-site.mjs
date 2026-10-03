// Builds dist/: exactly the files the public site serves, and nothing else.
//
//   npm run build               build, and list anything that should be dealt with first
//   npm run build -- --strict   the same, but fail if anything must be fixed (used by deploy)
//   npm run build -- --files    take the beats from the beats/ folder even if the site
//                               has a database (the tests use this)
//   npm run build -- --strict --seed   a first deployment: the database has no beats
//                               yet, so publish the ones in beats/ for the admin to adopt
//
// Where the beats come from:
//   - A site with accounts (config.site.json has a Firebase config) keeps its beats in the
//     database. The build reads the public catalog and the featured beats from there, and
//     publishes no song files: a beat's code is only given to people who are signed in,
//     so only the featured beats' pages carry code.
//   - Otherwise every song in beats/ is merged into one published file, the same pattern
//     exported twice kept once, except songs marked `"publish": false` in beats/titles.json.
//
// What goes in:
//   - the site itself (css/, js/, images/, sw.js, the two vendor bundles)
//   - a page for every address, so each can be found and read on its own:
//       /                 the player
//       /beats/<slug>     the player opened on one beat, with that beat's title,
//                         description and credit in the page itself
//       /about, /privacy  reading pages; /about lists every beat
//     plus sitemap.xml, robots.txt and a not-found page
//   - og/: the picture each page unfurls with when its link is shared. Every page has
//     its own; a beat's carries the beat's name (tools/og-images.mjs)
//   - source/: an archive of this project's source, which the About page links to. The
//     AGPL asks a public site to offer its source to the people using it.
// Sample audio (vendor/samples/) is never published; the hosted site streams it.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'acorn';
import { listBeats } from './beats.mjs';
import { readSiteConfig, siteConfigScript } from './site-config.mjs';
import { createAnalyzer } from '../js/analyze-core.js';
import { collect, createLibrary } from '../js/library-core.js';
import { lockedSong, publicEntries } from '../js/beats-core.js';
import { renderCards } from './og-images.mjs';
import { SITE_NAME, HOME_DESCRIPTION, beatPath, songTitle, songDescription } from '../js/routes-core.js';
import { buildLearn } from './learn.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const strict = process.argv.includes('--strict');
const fromFiles = process.argv.includes('--files');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// this site's own settings (config.site.json), which js/config.js reads as HTB_CONFIG
const settings = readSiteConfig(root);
if (settings) globalThis.HTB_CONFIG = settings;
const { config } = await import(pathToFileURL(join(root, 'js/config.js')).href);
const read = (path) => readFileSync(join(root, path), 'utf8');
const write = (path, text) => {
  mkdirSync(dirname(join(dist, path)), { recursive: true });
  writeFileSync(join(dist, path), text);
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

/* ---------- the site's own files ---------- */

for (const path of ['sw.js', 'LICENSE', 'css', 'js', 'images', 'site-config.js', 'vendor/strudel.bundle.js', 'vendor/firebase.bundle.js']) {
  cpSync(join(root, path), join(dist, path), { recursive: true });
}
// the published site carries its settings; the source (and the source archive) does not
if (settings) write('site-config.js', siteConfigScript(settings));

/* ---------- the songs ---------- */

const mustFix = [];
const notes = [];
let songs = [];
let beatFiles = [];
let heldBack = [];
let unseeded = false;

// Firestore's REST answers wrap every value in its type.
const plain = (value) => {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(plain);
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, inner]) => [key, plain(inner)]));
  return null;
};
// A document as anyone on the internet may read it (no credentials), or null.
async function publicDocument(path) {
  const { projectId, apiKey } = config.firebase;
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?key=${apiKey}`);
  return response.ok ? plain({ mapValue: await response.json() }) : null;
}

// From the database: the catalog, and the beats anyone may play.
async function songsFromDatabase() {
  const catalog = await publicDocument('catalog/public').catch(() => null);
  if (!catalog?.beats?.length) return null;
  // only what people other than the admin may know about gets a page
  const listed = publicEntries(catalog).map(lockedSong);
  // Anyone can read the catalog itself, so it must not say more than that. One written
  // before a beat was taken back still does, until an admin's visit to the site rewrites it.
  const unlisted = catalog.beats.length - listed.length;
  if (unlisted) mustFix.push(`The public catalog still names ${unlisted} beat(s) that are not public (title and notes, not code). Sign in on the site as an admin, which rewrites it, then build again.`);
  for (const featured of listed.filter((song) => song.featured)) {
    const beat = await publicDocument(`beats/${featured.id}`);
    if (beat?.code) Object.assign(featured, { code: beat.code, locked: false });
  }
  return listed;
}

// From the beats/ folder: one merged file, published with the site.
function songsFromFiles() {
  const beatsDir = join(root, 'beats');
  const titles = existsSync(join(beatsDir, 'titles.json')) ? JSON.parse(read('beats/titles.json')) : {};
  const held = (id) => titles[id]?.publish === false;
  const published = {};
  const loose = [];
  for (const { id, file, code, created_at, fallbackTitle } of collect(listBeats(beatsDir).files.map((file) => ({ file, text: read(`beats/${file}`) })))) {
    if (held(id)) heldBack.push(titles[id]?.title || fallbackTitle || id);
    else if (fallbackTitle) loose.push(file);
    else published[id] = { code, created_at };
  }
  const publicTitles = Object.fromEntries(Object.entries(titles).filter(([, entry]) => entry?.publish !== false));
  beatFiles = ['songs.json', ...loose];
  write('beats/songs.json', JSON.stringify(published));
  for (const file of loose) cpSync(join(beatsDir, file), join(dist, 'beats', file));
  write('beats/titles.json', JSON.stringify(publicTitles, null, 2) + '\n');
  write('beats/index.json', JSON.stringify({ files: beatFiles, titles: Object.keys(publicTitles).length > 0 }) + '\n');
  // Described from the files just written, the same way the site will read them, so the
  // addresses made here are the ones the site works out for itself.
  const library = createLibrary(createAnalyzer(parse));
  return library.describeAll(collect(beatFiles.map((file) => ({ file, text: readFileSync(join(dist, 'beats', file), 'utf8') }))), publicTitles);
}

const accounts = Boolean(config.firebase);
let database = accounts && !fromFiles;
if (database) {
  songs = await songsFromDatabase();
  if (!songs) {
    // nothing published yet: the site plays the beats in its files until an admin
    // publishes them from the Admin sheet
    database = false;
    notes.push('The database holds no beats yet, so the beats/ files are published. Sign in as the admin, press "Publish the site\'s own beats" in the Admin sheet, then build and deploy again.');
    unseeded = true;
  }
}
if (!database) songs = songsFromFiles();

/* ---------- the pages ---------- */

const origin = (config.appOrigin || '').replace(/\/$/, '');
const archiveName = `hack-the-beats-${version}`;
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const replaceOnce = (html, from, to, what) => {
  if (!html.includes(from)) throw new Error(`build: could not find ${what} in the page template`);
  return html.replace(from, () => to);
};

// The tags that tell a search engine or a link preview what a page is.
function headTags({ title, description, path, data, image }) {
  const picture = image && origin && pictures.has(image) ? `${origin}/og/${image}` : null;
  const tags = [
    `<meta property="og:site_name" content="${esc(SITE_NAME)}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta name="twitter:card" content="${picture ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
  ];
  if (picture) {
    tags.push(
      `<meta property="og:image" content="${esc(picture)}" />`,
      '<meta property="og:image:type" content="image/png" />',
      '<meta property="og:image:width" content="1200" />',
      '<meta property="og:image:height" content="630" />',
      `<meta property="og:image:alt" content="${esc(title)}" />`,
      `<meta name="twitter:image" content="${esc(picture)}" />`,
    );
  }
  if (origin) {
    tags.unshift(`<link rel="canonical" href="${esc(origin + path)}" />`);
    tags.push(`<meta property="og:url" content="${esc(origin + path)}" />`);
  }
  if (data && origin) tags.push(`<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...data }).replace(/</g, '\\u003c')}</script>`);
  return tags.join('\n    ');
}

// A page from its template: its own title and description, the head tags, and the
// things every page shares (the source link, the contact address).
function page(template, { title, description, path, data, image }) {
  let html = template;
  if (title) html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>`);
  if (description) html = html.replace(/<meta name="description" content="[^"]*" \/>/, () => `<meta name="description" content="${esc(description)}" />`);
  const found = { title: /<title>([^<]*)<\/title>/.exec(html)[1], description: /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '' };
  html = replaceOnce(html, '<!--seo-->', headTags({ title: found.title, description: found.description, path, data, image }), 'the <!--seo--> marker');
  html = html.replace('href="source/"', `href="source/${archiveName}.tar.gz"`);
  html = html.replace('<span id="version"></span>', `<span id="version">v${version}</span>`);
  if (config.contact) html = html.replace(/<a data-contact>[^<]*<\/a>/g, () => `<a data-contact href="mailto:${esc(config.contact)}">${esc(config.contact)}</a>`);
  return html;
}

// The Learn guide (tools/learn.mjs): its pages, its search index, and anything to fix first.
const learn = buildLearn(root);
mustFix.push(...learn.problems);

// The pictures links unfurl with: one for each page, drawn before the pages that name them.
const cardDetail = (song) => [song.by ? `by ${song.by}` : null, song.bpm ? `${Math.round(song.bpm)} bpm` : null, song.trackCount > 1 ? `${song.trackCount} tracks` : null].filter(Boolean).join(' · ');
const pictures = new Set(
  await renderCards(
    [
      { file: 'home.png', kicker: 'Live-coded music', title: 'Watch it. Mix it. Change the code.', detail: 'Music made by code, running live in your browser' },
      { file: 'about.png', kicker: 'About', title: 'Music made by code', detail: 'What it is, how to play with it, and who made it' },
      { file: 'privacy.png', kicker: 'Privacy', title: 'What we keep, and what we do not', detail: '' },
      { file: 'learn.png', kicker: 'Learn', title: 'How to play, mix, remix and write beats', detail: 'The guide, with screenshots, examples and a glossary' },
      ...learn.areas.map((area) => ({ file: `learn/${area.slug}.png`, kicker: `Learn · ${area.group}`, title: area.title, detail: area.description })),
      ...songs.map((song) => ({ file: `beats/${song.slug}.png`, kicker: 'A live-coded beat', title: song.title, detail: cardDetail(song), seed: song.seed })),
    ],
    join(dist, 'og'),
  ),
);
if (!pictures.size) notes.push('No link pictures were drawn (Playwright\'s browser is not installed: npx playwright install chromium).');

const website = { '@type': 'WebSite', name: SITE_NAME, url: `${origin}/` };
const facts = (song) => [song.by ? `by ${song.by}` : null, song.bpm ? `${Math.round(song.bpm)} bpm` : null].filter(Boolean).join(' · ');
const credit = (song) => (song.by ? `${song.title} — ${song.by}` : song.title);

// The player. Every copy carries the list of beats as plain links (the song list fills
// itself in over them), so each beat's page can be reached from any other.
const beatLinks = songs.map((song) => `<li><a href="${esc(beatPath(song.slug).slice(1))}">${esc(song.title)}</a>${facts(song) ? ` <span>${esc(facts(song))}</span>` : ''}</li>`).join('\n          ');
let player = replaceOnce(read('index.html'), '<ol class="drawer__list" id="crate-list"></ol>', `<ol class="drawer__list" id="crate-list">\n          ${beatLinks}\n        </ol>`, 'the song list');
// With accounts, a visitor is signed out until the page learns otherwise: start as the
// small player so the full deck never flashes up first.
const BODY = '<body data-transport="idle" data-focus="A">';
if (accounts && !fromFiles) player = replaceOnce(player, BODY, '<body class="is-preview" data-transport="idle" data-focus="A">', 'the body tag');

write(
  'index.html',
  page(replaceOnce(player, '<!--prerender-->', '', 'the code placeholder'), {
    path: '/',
    image: 'home.png',
    data: {
      '@type': 'WebApplication',
      name: SITE_NAME,
      url: `${origin}/`,
      description: HOME_DESCRIPTION,
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Any',
      browserRequirements: 'Requires JavaScript and Web Audio',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    },
  }),
);

// One page per beat: the player, already showing that beat. A beat whose code is only for
// people with an account gets its title, credit, description and notes instead.
for (const song of songs) {
  let html = player;
  html = replaceOnce(html, '<h1 class="visually-hidden">Hack The Beats</h1>', `<h1 class="visually-hidden">${esc(credit(song))} · ${esc(SITE_NAME)}</h1>`, 'the page heading');
  html = replaceOnce(
    html,
    '<section class="sheet__song" id="about-song"></section>',
    `<section class="sheet__song" id="about-song"><h3>${esc(credit(song))}</h3>${song.notes.map((note) => `<p>${esc(note)}</p>`).join('')}</section>`,
    'the About panel',
  );
  const description = song.description || songDescription(song);
  if (song.code) {
    html = replaceOnce(html, '<p class="curtain__title" id="curtain-title">&nbsp;</p>', `<p class="curtain__title" id="curtain-title">${esc(song.title)}</p>`, 'the curtain title');
    html = replaceOnce(html, '<p class="curtain__by" id="curtain-by"></p>', `<p class="curtain__by" id="curtain-by">${esc(facts(song))}</p>`, 'the curtain credit');
    html = replaceOnce(html, '<!--prerender-->', `<pre class="prerender" id="prerender">${esc(song.code)}</pre>`, 'the code placeholder');
  } else {
    html = replaceOnce(html, '<!--prerender-->', '', 'the code placeholder');
    html = replaceOnce(html, '<body class="is-preview"', '<body class="is-preview is-locked"', 'the body tag');
    html = replaceOnce(html, '<div class="gate locked" id="locked" hidden>', '<div class="gate locked" id="locked">', 'the locked panel');
    html = replaceOnce(html, '<p class="gate__title" id="locked-title"></p>', `<p class="gate__title" id="locked-title">${esc(song.title)}</p>`, 'the locked title');
    html = replaceOnce(html, '<p class="gate__by" id="locked-by"></p>', `<p class="gate__by" id="locked-by">${esc(facts(song))}</p>`, 'the locked credit');
    html = replaceOnce(html, '<p class="gate__text" id="locked-text"></p>', `<p class="gate__text" id="locked-text">${esc(description)}</p>`, 'the locked text');
    html = replaceOnce(html, '<div class="locked__notes" id="locked-notes"></div>', `<div class="locked__notes" id="locked-notes">${song.notes.map((note) => `<p>${esc(note)}</p>`).join('')}</div>`, 'the locked notes');
  }
  const path = beatPath(song.slug);
  write(
    `${path.slice(1)}.html`,
    page(html, {
      title: songTitle(song),
      description,
      path,
      image: `beats/${song.slug}.png`,
      data: { '@type': 'MusicComposition', name: song.title, url: origin + path, description, ...(song.by ? { composer: { '@type': 'Person', name: song.by } } : {}), isPartOf: website },
    }),
  );
}

write('about.html', page(replaceOnce(read('about.html'), '<!--beats-->', beatLinks, 'the list of beats'), { path: '/about', image: 'about.png', data: { '@type': 'AboutPage', name: `About ${SITE_NAME}`, url: `${origin}/about`, isPartOf: website } }));
write('privacy.html', page(read('privacy.html'), { path: '/privacy', image: 'privacy.png' }));
for (const entry of learn.pages) {
  const data =
    entry.kind === 'landing'
      ? { '@type': 'CollectionPage', name: `Learn ${SITE_NAME}`, url: `${origin}${entry.path}`, isPartOf: website }
      : { '@type': 'TechArticle', headline: entry.title, description: entry.description, url: `${origin}${entry.path}`, isPartOf: website };
  write(entry.file, page(entry.html, { path: entry.path, image: entry.kind === 'landing' ? 'learn.png' : `learn/${entry.slug}.png`, data }));
}
write('learn/search.json', JSON.stringify(learn.search));
cpSync(join(root, 'learn/examples'), join(dist, 'learn/examples'), { recursive: true });
cpSync(join(root, '404.html'), join(dist, '404.html'));

const paths = ['/', '/about', ...learn.pages.map((entry) => entry.path), ...songs.map((song) => beatPath(song.slug)), '/privacy'];
if (origin) {
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((path) => `  <url><loc>${esc(origin + path)}</loc></url>`).join('\n')}\n</urlset>\n`);
}
write('robots.txt', `User-agent: *\nAllow: /\n${origin ? `\nSitemap: ${origin}/sitemap.xml\n` : ''}`);

/* ---------- the source archive ---------- */

// Everything in the project that is not ignored, whether or not it has been committed
// yet, so the archive always matches the site being published.
function gitFiles(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}
function sourceFiles() {
  const known = gitFiles('ls-files', '-co', '--exclude-standard', '-z');
  if (known) return known;
  // not a git checkout (built from the archive itself, say): walk the folder instead,
  // leaving out what git would have ignored
  const skip = new Set(['node_modules', 'dist', '.git', '.firebase', '.DS_Store', '.claude', 'config.site.json', '.firebaserc', '.private-terms']);
  const walk = (dir) =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (skip.has(entry.name) || path === 'vendor/samples') return [];
      return entry.isDirectory() ? walk(path) : [path];
    });
  return walk('');
}

const stage = join(dist, '.stage');
// In beats/, git only knows the songs that are part of the project (the rest are ignored),
// and those belong in the archive. Any others go in only as published (below), so a song
// held back stays out of the archive too.
const ownBeats = new Set(gitFiles('ls-files', '-co', '--exclude-standard', '-z', '--', 'beats') ?? []);
for (const path of sourceFiles()) {
  if ((path.startsWith('beats/') && !ownBeats.has(path)) || path.startsWith('dist/') || !existsSync(join(root, path))) continue;
  cpSync(join(root, path), join(stage, archiveName, path));
}
// (with the beats in a database there are no song files to include)
for (const file of beatFiles.length ? ['index.json', 'titles.json', ...beatFiles] : []) cpSync(join(dist, 'beats', file), join(stage, archiveName, 'beats', file));
mkdirSync(join(dist, 'source'));
const archive = join(dist, 'source', `${archiveName}.tar.gz`);
// tar would write down the account and group that built the archive, and on a Mac the
// attributes the system keeps on each file; every entry is made nobody's instead, with
// nothing attached. (GNU tar and bsdtar spell the first part differently.)
const gnuTar = execFileSync('tar', ['--version'], { encoding: 'utf8' }).includes('GNU tar');
const nobody = gnuTar ? ['--owner=0', '--group=0', '--numeric-owner'] : ['--uid', '0', '--gid', '0', '--uname', '', '--gname', ''];
execFileSync('tar', ['-czf', archive, ...nobody, '--no-xattrs', '-C', stage, archiveName], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
rmSync(stage, { recursive: true, force: true });

/* ---------- checks ---------- */

if (!read('sw.js').includes(`const VERSION = 'v${version}'`) || !read('js/version.js').includes(`'${version}'`)) {
  mustFix.push(`The version shown on the site does not match package.json (${version}). Run: node tools/set-version.mjs`);
}
if (read('privacy.html').includes('id="draft-note"')) mustFix.push('privacy.html still carries its draft notice. Read it through, then delete that paragraph.');
// a site with accounts publishes song files only when asked to, never by falling back
if (unseeded && !process.argv.includes('--seed')) {
  mustFix.push('The database holds no beats, so this build publishes every song file in beats/. If that is what you want (a first deployment), add --seed.');
}
if (config.firebase && !config.contact) mustFix.push('Accounts are on but config.site.json has no `contact` address for the privacy notice.');
if (!config.firebase) notes.push('Accounts are off: there is no Firebase config (config.site.json). The site will run without sign-in.');
if (!origin) notes.push('No appOrigin in config.site.json: pages have no canonical address and there is no sitemap.');
if (config.firebase && !(config.appOrigin && config.shareOrigin)) {
  notes.push('No separate address for shared songs (appOrigin / shareOrigin in config.site.json): they will open on the main site behind a "run this?" question.');
}
if (!config.contact) notes.push('No contact address in config.site.json: the About page will not say where to write about credits or removal.');
if (heldBack.length) notes.push(`Held back from the public site: ${heldBack.join(', ')}.`);
if (database && songs.length) {
  const withCode = songs.filter((song) => song.code).map((song) => `"${song.title}"`);
  notes.push(`Beats come from the database: only ${withCode.length ? withCode.join(', ') : 'no beat'} ${withCode.length > 1 ? 'are' : 'is'} published with code.`);
}

const megabytes = (path) => `${(statSync(path).size / 1048576).toFixed(1)} MB`;
console.log(`✓ dist/ — version ${version}, ${songs.length} songs, ${paths.length} pages (${learn.pages.length} of the Learn guide), source archive ${megabytes(archive)}`);
for (const note of notes) console.log(`  · ${note}`);
for (const problem of mustFix) console.log(`  ✗ ${problem}`);
if (mustFix.length && strict) {
  console.error('\nNot ready to publish. Fix the items marked ✗ and run this again.');
  process.exit(1);
}
