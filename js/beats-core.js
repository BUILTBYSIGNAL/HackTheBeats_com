// The public beats as the database holds them, and the catalog made from them. Plain
// logic with no browser in it: the site, the site build and the tests all use it.
//
//   beats/{id}       { code, title, by?, slug, order, featured, members?, hidden, song?, createdAt, updatedAt }
//                    (`song` is the id of the admin's own song it was published from)
//   catalog/public   { beats: [entry…], updatedAt }: the beats other people may know
//                    about, in order, without their code.
//
// Who may play a beat:
//   'everyone'   a featured beat (at least one, at most MAX_FEATURED): anyone, signed in or not
//   'members'    a beat the admin has opened to members: anyone who is signed in
//   'admin'      every other beat: only the site's admin. This is what a beat is until
//                the admin says otherwise.
// (`hidden` is from an earlier version; a hidden beat is simply the admin's own.)
import { slugify, songDescription } from './routes-core.js';
import { hash } from './library-core.js';

export const orderBeats = (beats) => [...beats].sort((a, b) => a.order - b.order || (a.createdAt || 0) - (b.createdAt || 0));

// An address no other beat has. A beat keeps its slug for life, so links to it keep working.
export function freshSlug(title, taken) {
  const used = new Set(taken);
  const base = slugify(title) || 'beat';
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

// How many beats can be featured at once: each is a chip on the stage for visitors.
export const MAX_FEATURED = 6;

// A new beat, placed after the ones already there. The first beat is featured; any other
// starts as the admin's own.
export function newBeat({ id, code, title, by = null, song = null, createdAt }, beats, now = Date.now()) {
  const beat = {
    id,
    code,
    title: (title || 'Untitled').slice(0, 200),
    slug: freshSlug(title, beats.map((other) => other.slug)),
    order: beats.reduce((most, other) => Math.max(most, other.order), 0) + 1,
    featured: !beats.some((other) => other.featured),
    members: false,
    hidden: false,
    createdAt: createdAt || now,
    updatedAt: now,
  };
  if (by) beat.by = by;
  if (song) beat.song = song;
  return beat;
}

// The featured beats, the ones anybody may play, in order. There is always at least one:
// with none marked, the first beat is.
export function featuredBeats(beats) {
  const ordered = orderBeats(beats);
  const marked = ordered.filter((beat) => beat.featured);
  return marked.length ? marked : ordered.slice(0, 1);
}
// The first of them: the one the front door opens.
export const featuredOf = (beats) => featuredBeats(beats)[0] || null;
export const featuredIds = (beats) => new Set(featuredBeats(beats).map((beat) => beat.id));

// `featured` is featuredIds() of all the beats.
export const audienceOf = (beat, featured) => (featured.has(beat.id) ? 'everyone' : beat.members === true && !beat.hidden ? 'members' : 'admin');

// `describe(beat)` works out what the code says about itself: { bpm, notes, trackCount, knobCount }.
export function buildCatalog(beats, describe, now = Date.now()) {
  const featured = featuredIds(beats);
  return {
    beats: orderBeats(beats)
      .filter((beat) => audienceOf(beat, featured) !== 'admin')
      .map((beat) => {
        const said = describe(beat);
        const entry = {
          id: beat.id,
          slug: beat.slug,
          title: beat.title,
          by: beat.by || null,
          bpm: said.bpm ?? null,
          trackCount: said.trackCount || 0,
          knobCount: said.knobCount || 0,
          notes: (said.notes || []).slice(0, 12).map((note) => String(note).slice(0, 300)),
          featured: featured.has(beat.id),
          members: !featured.has(beat.id),
        };
        entry.description = songDescription(entry);
        return entry;
      }),
    updatedAt: now,
  };
}

// The catalog entries people other than the admin are shown. (A catalog written before
// beats could be the admin's own lists them all; those without a say-so are left out.)
export const publicEntries = (catalog) => (catalog?.beats || []).filter((entry) => entry.featured || entry.members === true);

// A catalog entry as the interface sees a beat it may list but not play.
export const lockedSong = (entry) => ({
  id: entry.id,
  source: 'beats',
  slug: entry.slug,
  title: entry.title,
  untitled: false,
  by: entry.by || null,
  bpm: entry.bpm ?? null,
  notes: entry.notes || [],
  trackCount: entry.trackCount || 0,
  knobCount: entry.knobCount || 0,
  description: entry.description || '',
  featured: Boolean(entry.featured),
  seed: hash(entry.id),
  code: '',
  locked: true,
  broken: false,
});

// Beats from a strudel.cc export (or this site's own seed file), ready to publish.
// An entry may carry `title` and `by` for a song whose code does not name itself.
export function beatsFromExport(text, existing, describe, now = Date.now()) {
  const data = JSON.parse(text);
  const entries = Array.isArray(data) ? data : Object.entries(data).map(([key, value]) => ({ id: key, ...value }));
  const known = new Set(existing.map((beat) => beat.id));
  const beats = [...existing];
  const added = [];
  for (const entry of entries.sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0))) {
    if (!entry || typeof entry.code !== 'string' || !entry.code.trim() || !entry.id || known.has(String(entry.id))) continue;
    const said = describe({ code: entry.code });
    const beat = newBeat({ id: String(entry.id), code: entry.code, title: entry.title || said.title, by: entry.by || said.by, createdAt: Number(entry.created_at) || now }, beats, now);
    known.add(beat.id);
    beats.push(beat);
    added.push(beat);
  }
  return added;
}
