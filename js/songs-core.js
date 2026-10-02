// The parts of "My songs" that are plain logic: titles, merging a browser's copy with an
// account's, and strudel.cc's export format. No imports, so it is unit-tested in Node.

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newId(length = 12) {
  const bytes = new Uint8Array(length);
  (globalThis.crypto || { getRandomValues: (a) => a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 256))) }).getRandomValues(bytes);
  return Array.from(bytes, (byte) => ID_CHARS[byte % ID_CHARS.length]).join('');
}

// A shared song's link carries one of these, and nothing else: unguessable, and unique.
export function newUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  (globalThis.crypto || { getRandomValues: (a) => a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 256))) }).getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const isUuid = (text) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(text));

// Where a copy came from, kept with the copy so it can credit its original. Only what was
// already public about the original: never its owner's account or the song's own id.
//   { title, by?, ownerName?, shareId?, beat? }
const LIMITS = { title: 200, by: 200, ownerName: 200, shareId: 64, beat: 120 };
export function cleanFrom(from) {
  if (!from || typeof from !== 'object' || typeof from.title !== 'string' || !from.title.trim()) return null;
  const clean = {};
  for (const [key, max] of Object.entries(LIMITS)) {
    const value = from[key];
    if (typeof value === 'string' && value.trim()) clean[key] = value.trim().slice(0, max);
  }
  return clean;
}

// The `from` of a copy of `song`: a shared song credits its sharer, a built-in beat its
// page, and a copy of one's own copy keeps crediting the same original.
export function fromOf(song) {
  if (!song) return null;
  if (song.source === 'shared') return cleanFrom({ title: song.title, by: song.by, ownerName: song.ownerName, shareId: song.shareId });
  if (song.source === 'beats') return cleanFrom({ title: song.title, by: song.by, beat: song.slug });
  return cleanFrom(song.from);
}

// Whether a shared song is still shared by the link that led to it. Switching sharing off
// and on again makes a new link; the old one must stay closed even if its record lingers.
export const isLive = (song, shareId = null) => Boolean(song) && song.shared === true && song.blocked !== true && (!shareId || !song.shareId || song.shareId === shareId);

// The title a song gives itself: `@title Name` in a comment, or `// "Name" @by someone`.
export function titleOf(code) {
  const tagged = code.match(/@title[ \t]+(.+)/);
  if (tagged) return tagged[1].trim();
  const shorthand = code.match(/^\s*\/\/\s*"([^"]+)"\s+@by\b/m);
  return shorthand ? shorthand[1].trim() : null;
}

// Rename a song by rewriting (or adding) its @title line: the code is the only record.
export function withTitle(code, title) {
  const clean = title.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '').trim() || 'Untitled';
  if (/@title[ \t]+.+/.test(code)) return code.replace(/@title[ \t]+.+/, () => `@title ${clean}`);
  const shorthand = code.match(/^(\s*\/\/\s*")([^"]+)("\s+@by\b)/m);
  if (shorthand) return code.replace(shorthand[0], () => `${shorthand[1]}${clean}${shorthand[3]}`);
  if (/^\s*\/\*/.test(code)) return code.replace(/\/\*[ \t]*\n?/, () => `/*\n  @title ${clean}\n`);
  return `/*\n  @title ${clean}\n*/\n\n${code}`;
}

// A title that is not taken yet: "Amber", "Amber 2", "Amber 3"…
export function uniqueTitle(wanted, taken) {
  const names = new Set(taken);
  if (!names.has(wanted)) return wanted;
  const stem = wanted.replace(/ \d+$/, '');
  for (let n = 2; ; n++) if (!names.has(`${stem} ${n}`)) return `${stem} ${n}`;
}

// The starting points a new song can be made from, smallest first.
export const STARTERS = [
  { kind: 'loop', label: 'Drum loop', blurb: 'One track of drums and one knob. Room to add your own.' },
  { kind: 'full', label: 'Full song', blurb: 'Drums, bass and a lead, with three knobs.' },
];

// A starting point for a new song, on a plain 4/4 grid, using only sounds that are always
// loaded. Each one carries a couple of suggested changes to try (@try lines).
export function templateSong(title, kind = 'full') {
  if (kind === 'loop') {
    return `/*
  @title ${title}
  A drum loop to build on, 120 bpm.
  @try Busier hats: \`hh*8\` -> \`hh*16\`
  @try Skip a kick: \`bd*4\` -> \`bd(3,8)\`
*/

setcps(120/60/4)

const space = slider(0.2, 0, 1)

DRUMS: stack(
  s("bd*4").gain(0.9),
  s("~ sd ~ sd").gain(0.6),
  s("hh*8").gain(0.3),
)
.bank("RolandTR808")
.room(space)
._punchcard({ height: 90, width: 640 })
`;
  }
  return `/*
  @title ${title}
  A minor, 132 bpm.
  @try Half-time lead: \`.fast(2)\` -> \`.fast(1)\`
  @try Open hats on 2 and 4: \`~ ~ oh ~\` -> \`~ oh ~ oh\`
*/

setcps(132/60/4)

const cut = slider(1800, 200, 8000)
const bassCut = slider(420, 80, 1600)
const space = slider(0.3, 0, 1.2)

DRUMS: stack(
  s("bd*4").bank("RolandTR909").gain(0.9),
  s("~ cp ~ cp").bank("RolandTR909").gain(0.55),
  s("hh*8").bank("RolandTR909").gain("{0.28 0.12}*4"),
  s("~ ~ oh ~").bank("RolandTR909").gain(0.22),
)
.postgain(0.85)
._punchcard({ height: 90, width: 640 })

BASS: note("<a1 a1 f1 g1>")
  .struct("x ~ x x ~ x ~ x")
  .s("sawtooth")
  .decay(0.16).sustain(0.1)
  .lpf(bassCut).lpq(6)
  .gain(0.6)
  ._punchcard({ height: 70, width: 640 })

LEAD: note("a4 c5 e5 c5 d5 c5 a4 e4".fast(2))
  .s("square")
  .attack(0.005).decay(0.12).sustain(0)
  .lpf(cut).lpq(6)
  .room(space)
  .gain(0.3)
  ._punchcard({ height: 70, width: 640 })
  ._scope({ width: 640, height: 60 })
`;
}

// Bring a browser's songs and an account's songs together when someone signs in.
//
//   local, remote: [{ id, updatedAt, owner?, synced?, … }]
//   returns { songs, upload, dropped }
//     songs    what the browser should hold afterwards
//     upload   records to write to the account
//     dropped  ids removed from the browser because they were deleted from the account
export function mergeSongs(local, remote, uid) {
  const remoteById = new Map(remote.map((song) => [song.id, song]));
  const songs = [];
  const upload = [];
  const dropped = [];

  for (const mine of local) {
    const theirs = remoteById.get(mine.id);
    if (theirs) {
      remoteById.delete(mine.id);
      if ((mine.updatedAt || 0) > (theirs.updatedAt || 0)) {
        // edited here since it was last saved to the account (offline, say)
        const record = { ...mine, owner: uid, synced: false };
        songs.push(record);
        upload.push(record);
      } else {
        songs.push({ ...theirs, owner: uid, synced: true });
      }
    } else if (mine.owner === uid && mine.synced) {
      // it was in the account and no longer is: deleted on another device
      dropped.push(mine.id);
    } else if (!mine.owner || mine.owner === uid) {
      // made while signed out, or never reached the account: it joins it now
      const record = { ...mine, owner: uid, synced: false };
      songs.push(record);
      upload.push(record);
    } else {
      // belongs to a different account that used this browser: leave it alone
      songs.push(mine);
    }
  }
  for (const theirs of remoteById.values()) songs.push({ ...theirs, owner: uid, synced: true });
  return { songs, upload, dropped };
}

// strudel.cc's "export patterns" format: { id: { id, code, created_at, collection } }
export function toExport(songs) {
  return Object.fromEntries(songs.map((song) => [song.id, { id: song.id, code: song.code, created_at: song.createdAt, collection: 'user' }]));
}

// A strudel.cc export, or a single song as text → [{ code, createdAt }]
export function fromImport(text, filename = '') {
  if (/\.json$/i.test(filename) || /^\s*[{[]/.test(text)) {
    try {
      const data = JSON.parse(text);
      const entries = Array.isArray(data) ? data : Object.values(data);
      const found = entries
        .filter((entry) => entry && typeof entry.code === 'string' && entry.code.trim())
        .map((entry) => ({ code: entry.code, createdAt: Number(entry.created_at) || Date.now() }));
      if (found.length || /\.json$/i.test(filename)) return found;
    } catch {
      if (/\.json$/i.test(filename)) return [];
    }
  }
  return text.trim() ? [{ code: text, createdAt: Date.now() }] : [];
}
