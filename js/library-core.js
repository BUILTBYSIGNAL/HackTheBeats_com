// The parts of the song library that need no browser: reading export files, keeping one
// copy of each pattern, and working out what the interface needs to know about a song.
// Used by library.js on the site and by the site build in Node.
import { assignSlugs } from './routes-core.js';

export const hash = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export function entriesOf(file, text) {
  if (!/\.json$/i.test(file)) {
    return [{ id: `file:${file}`, code: text, created_at: 0, fallbackTitle: file.replace(/\.[^.]+$/, '') }];
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn(`[library] ${file} is not valid JSON, skipped`);
    return [];
  }
  const list = Array.isArray(data) ? data : Object.entries(data).map(([key, value]) => ({ id: key, ...value }));
  return list.filter((entry) => entry && typeof entry.code === 'string');
}

// strudel.cc writes `created_at` as a number of milliseconds; a date string works too
const when = ({ created_at: at }) => (typeof at === 'string' && Number.isNaN(Number(at)) ? Date.parse(at) : Number(at)) || 0;

// One list of songs from the text of every file in beats/, oldest first. The same pattern
// exported twice is kept once: the newer export wins, later files break ties.
export function collect(files) {
  const byId = new Map();
  for (const { file, text } of files) {
    for (const entry of entriesOf(file, text)) {
      if (!entry.code.trim()) continue;
      const id = String(entry.id ?? `${file}:${hash(entry.code)}`);
      const previous = byId.get(id);
      if (previous && when(previous) > when(entry)) continue;
      byId.set(id, { ...entry, id, file });
    }
  }
  return [...byId.values()].sort((a, b) => when(a) - when(b));
}

// `analyze` is the song analyser (analyze-core.js bound to a parser).
export function createLibrary(analyze) {
  // Everything the interface needs to know about a song, worked out from its code.
  // `source` is 'beats' (the built-in collection), 'mine' or 'shared'.
  function describeSong(entry, source, named = {}) {
    const { meta, tracks, sliders, switches, error } = analyze(entry.code);
    const known = meta.title || named.title || entry.fallbackTitle;
    return {
      id: entry.id,
      source,
      file: entry.file,
      code: entry.code,
      title: known || 'Untitled',
      untitled: !known,
      by: meta.by || named.by || null,
      bpm: meta.bpm,
      notes: meta.notes,
      trackCount: tracks.length,
      knobCount: sliders.length + switches.length,
      seed: hash(entry.id + entry.code),
      broken: Boolean(error),
    };
  }

  // The built-in collection: described, numbered where untitled, each with its own address.
  // `titles` is beats/titles.json: { "<id>": { "title": …, "by": … } }.
  function describeAll(entries, titles = {}) {
    let untitled = 0;
    const songs = entries.map((entry) => {
      const song = describeSong(entry, 'beats', titles[entry.id] || {});
      if (song.untitled) song.title = ++untitled > 1 ? `Untitled ${untitled}` : 'Untitled';
      return song;
    });
    return assignSlugs(songs);
  }

  return { describeSong, describeAll };
}

// A small deterministic punchcard for each song: four rows of sixteen steps drawn from its hash.
export function glyphSVG(seed, { cols = 16, rows = 4 } = {}) {
  let state = seed || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const cell = 6;
  const gap = 2;
  let rects = '';
  for (let r = 0; r < rows; r++) {
    const density = 0.25 + next() * 0.55;
    const every = [1, 2, 2, 4, 4, 8][Math.floor(next() * 6)];
    for (let c = 0; c < cols; c++) {
      const on = c % every === 0 ? next() < density + 0.3 : next() < density * 0.35;
      if (!on) continue;
      const opacity = (0.35 + next() * 0.65).toFixed(2);
      rects += `<rect x="${c * (cell + gap)}" y="${r * (cell + gap)}" width="${cell}" height="${cell}" opacity="${opacity}"/>`;
    }
  }
  const w = cols * (cell + gap) - gap;
  const h = rows * (cell + gap) - gap;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="currentColor" aria-hidden="true">${rects}</svg>`;
}
