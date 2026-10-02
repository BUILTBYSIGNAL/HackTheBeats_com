// Page addresses: every built-in beat has one of its own (/beats/<slug>), with its own
// title and description. Shared by the site, the site build and the tests, so the three
// always agree. No imports: it runs in Node as well as the browser.

export const SITE_NAME = 'Hacking the Beats';
export const HOME_TITLE = `${SITE_NAME} — live-coded music you can watch, mix and edit`;
export const HOME_DESCRIPTION = 'Live-coded music as an art piece. Watch Strudel code play itself, mix beats on a two-deck DJ panel, and edit the code in your browser.';

// "Low Tide 2 (night mix)" → "low-tide-2-night-mix"
export const slugify = (text) =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Gives each song (in library order) a slug no other song has.
export function assignSlugs(songs) {
  const taken = new Set();
  for (const song of songs) {
    const base = slugify(song.title) || 'beat';
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    song.slug = slug;
  }
  return songs;
}

export const beatPath = (slug) => `/beats/${slug}`;
export const slugFromPath = (pathname) => /^\/beats\/([a-z0-9-]+)\/?$/.exec(pathname || '')?.[1] ?? null;

const credit = (song) => (song.by ? `${song.title} by ${song.by}` : song.title);
export const songTitle = (song) => `${credit(song)} — ${SITE_NAME}`;

// "by Ana · shared by Rowan · 120 bpm": who wrote it (from its code), who shared it (from
// their account, when that is someone else) and its tempo.
export function creditLine({ by, ownerName, bpm } = {}) {
  const sharer = ownerName && ownerName !== by ? `shared by ${ownerName}` : null;
  return [by ? `by ${by}` : null, sharer, bpm ? `${Math.round(bpm)} bpm` : null].filter(Boolean).join(' · ');
}

// Where a copy came from: 'Remix of "Glass Tide" by Rowan', or '' for an original.
export function remixLine(from) {
  if (!from?.title) return '';
  const who = from.by || from.ownerName;
  return `Remix of "${from.title}"${who ? ` by ${who}` : ''}`;
}

// A link to someone's shared song, from an address: #song=<uuid> (or, for songs shared
// before links were UUIDs, #song=<owner>~<id>). #copy= is the same song, sent over from
// the player to be changed or kept.
//   → { kind: 'song' | 'copy', raw, share } or { kind, raw, owner, id }, or null
export function songLinkIn({ hash = '' } = {}) {
  const found = /[#&](song|copy)=([^&]+)/.exec(hash);
  if (!found) return null;
  const [owner, id] = found[2].split('~').map(decodeURIComponent);
  return id ? { kind: found[1], raw: found[2], owner, id } : { kind: found[1], raw: found[2], share: owner };
}

const clip = (text, max) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[\s,;:.]+$/, '')}…`;
};

// One or two sentences about a song, from what its own code says about itself.
export function songDescription(song) {
  // lines that explain a switch ("voice: 0 none, 1 choir") are for the deck, not for a summary
  const notes = (song.notes || []).filter((line) => !/^\w+:\s*\d/.test(line));
  const said = notes.join(' ').replace(/\s+/g, ' ').trim();
  const tempo = song.bpm && !/bpm/i.test(said) ? `${Math.round(song.bpm)} bpm ` : '';
  const tracks = song.trackCount > 1 ? ` in ${song.trackCount} tracks` : '';
  const lead = `${credit(song)}: a ${tempo}live-coded beat${tracks}.`;
  const close = 'Play it, mix it and edit the code in your browser.';
  return [lead, clip(said, 130), close].filter(Boolean).join(' ');
}
