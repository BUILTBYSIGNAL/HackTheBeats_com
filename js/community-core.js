// The community shelf as plain logic: which shared songs may go on it, and what its public
// entry for one says. An owner offers a song (featurable), the site's editors pick it, and
// community/{shareId} holds only what the song's link already shows: never its code, its
// owner's account or the song's own id. No DOM, so it is unit-tested in Node.
import { isUuid, cleanFrom } from './songs-core.js';
import { creditLine, noteSummary } from './routes-core.js';

// how many songs the shelf holds at most (firestore.rules lists no more at once)
export const SHELF_MAX = 48;
export const BLURB_MAX = 300;

const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const tempo = (value) => (Number.isFinite(value) && value > 0 && value < 10000 ? Math.round(value) : null);
const tracks = (value) => (Number.isInteger(value) && value > 0 && value <= 1000 ? value : null);

// A remix credit, cut down to what the shelf shows: the original's title and who made it
// (its credit, or else whoever shared it).
function creditOf(from) {
  const clean = cleanFrom(from);
  if (!clean) return null;
  if (clean.by) return { title: clean.title, by: clean.by };
  if (clean.ownerName) return { title: clean.title, ownerName: clean.ownerName };
  return { title: clean.title };
}

// Whether a song can be on the shelf: shared by the link `shareId` names, offered by its
// owner, and not switched off by the site.
export function eligibleForShelf(song, shareId = song?.shareId) {
  return Boolean(song) && song.shared === true && song.featurable === true && song.blocked !== true && isUuid(shareId) && (!song.shareId || song.shareId === shareId);
}

// The public entry for a song the editors feature. `describe(song)` reads its code (title,
// by, bpm, trackCount, notes); the blurb comes from its header notes.
//   → { title, by?, ownerName?, bpm?, trackCount?, blurb?, from?, featuredAt }
export function communityEntry(song, describe, now = Date.now()) {
  const said = describe(song) || {};
  const entry = { title: text(song.title, 200) || text(said.title, 200) || 'Untitled' };
  const fields = {
    by: text(said.by, 200),
    ownerName: text(song.ownerName, 200),
    bpm: tempo(said.bpm),
    trackCount: tracks(said.trackCount),
    blurb: noteSummary(said.notes, BLURB_MAX) || null,
    from: creditOf(song.from),
  };
  for (const [key, value] of Object.entries(fields)) if (value !== null) entry[key] = value;
  entry.featuredAt = now;
  return entry;
}

// An entry as read back from the database, checked over. Null if it is not one.
export function shelfEntry(shareId, data) {
  if (!isUuid(shareId) || !data || !text(data.title, 200)) return null;
  return {
    shareId,
    title: text(data.title, 200),
    by: text(data.by, 200),
    ownerName: text(data.ownerName, 200),
    bpm: tempo(data.bpm),
    trackCount: tracks(data.trackCount),
    blurb: text(data.blurb, BLURB_MAX),
    from: creditOf(data.from),
    featuredAt: Number(data.featuredAt) || 0,
  };
}

// What the song list says under an entry's title: "by Ana · shared by Rowan · 120 bpm · remix of Paper Kite"
export function shelfLine(entry) {
  return [creditLine(entry), entry.from?.title ? `remix of ${entry.from.title}` : null].filter(Boolean).join(' · ');
}
