// Reads the beats/ folder: strudel.cc export files (JSON) and loose song files.
import { analyze } from './analyze.js';
import { collect, createLibrary } from './library-core.js';
import { lockedSong, publicEntries, orderBeats, featuredIds, audienceOf } from './beats-core.js';
import { cloud } from './cloud.js';
import { site } from './config.js';

const library = createLibrary(analyze);
// Everything the interface needs to know about a song, worked out from its code.
// `source` is 'beats' (the built-in collection), 'mine' or 'shared'.
export const describeSong = library.describeSong;

// The built-in collection. Where the site has accounts and the database holds beats, they
// come from there, and how much a visitor gets depends on whether they are signed in.
// Otherwise (a local copy, no accounts) they come from the files in beats/.
//
//   returns { songs, mode: 'database' | 'files' }
export async function loadLibrary() {
  if (cloud.available && !site.guest) {
    const catalog = await cloud.getCatalog();
    if (catalog) return { songs: await fromDatabase(catalog), mode: 'database' };
  }
  return { songs: await fromFiles(), mode: 'files' };
}

// A beat from the database as the interface sees it.
export const describeBeat = (beat) => ({
  ...library.describeSong({ id: beat.id, code: beat.code }, 'beats'),
  title: beat.title,
  untitled: false,
  by: beat.by || null,
  slug: beat.slug,
  featured: beat.featured,
  hidden: beat.hidden,
});

async function fromDatabase(catalog) {
  // the admin is given every beat, and told who else can play each
  if (cloud.user?.admin) {
    try {
      const all = orderBeats(await cloud.listBeats({ all: true }));
      const featured = featuredIds(all);
      return all.map((beat) => ({ ...describeBeat(beat), featured: featured.has(beat.id), audience: audienceOf(beat, featured) }));
    } catch (error) {
      console.warn('[library] could not read the beats', error);
    }
  }
  const listed = publicEntries(catalog).map(lockedSong);
  const playable = new Map();
  // the featured beats come with their code for anyone
  for (const beat of await Promise.all(listed.filter((song) => song.featured).map((song) => cloud.getBeat(song.id)))) {
    if (beat) playable.set(beat.id, beat);
  }
  if (cloud.user) {
    try {
      for (const open of await cloud.listBeats()) playable.set(open.id, open);
    } catch (error) {
      console.warn('[library] could not read the beats', error);
    }
  }
  // the catalog sets the order and says which beats are featured
  return listed.map((entry) => (playable.has(entry.id) ? { ...describeBeat(playable.get(entry.id)), featured: entry.featured } : entry));
}

async function fromFiles() {
  const response = await fetch('beats/index.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('beats/index.json is missing. Run `npm run beats` to generate it.');
  const { files = [], titles: hasTitles = false } = await response.json();

  // beats/titles.json names songs that have no @title of their own: { "<id>": { "title": …, "by": … } }
  const titles = hasTitles
    ? await fetch('beats/titles.json', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))
    : {};

  const texts = [];
  for (const file of files) {
    try {
      texts.push({ file, text: await fetch(`beats/${encodeURIComponent(file)}`, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : Promise.reject(r.status))) });
    } catch (error) {
      console.warn(`[library] could not read beats/${file}`, error);
    }
  }
  const songs = library.describeAll(collect(texts), titles);
  // the beats anybody may play: those marked `"featured": true`, else the newest with
  // channels and knobs to show off
  const marked = songs.filter((song) => titles[song.id]?.featured);
  const showpiece = songs.filter((song) => !song.untitled && !song.broken && song.trackCount && song.knobCount).at(-1);
  const featured = new Set(marked.length ? marked : [showpiece || songs.at(-1)]);
  for (const song of songs) song.featured = featured.has(song);
  return songs;
}

export { glyphSVG } from './library-core.js';
