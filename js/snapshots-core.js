// The parts of channel snapshots that are plain logic: bar lines on the audio clock, what a
// capture may hold, slots, and the chunks a recording is stored in. No imports, so it is
// unit-tested in Node.
//
// A snapshot is a few bars of one channel's sound, captured from the deck as it plays and
// kept in one of eight slots. Its record:
//   { id, name, track, songTitle, bars, cps, sampleRate, frames, slot, pinned, createdAt, updatedAt, chunks }

export const SLOTS = 8;
export const BAR_CHOICES = [1, 2, 4, 8];
export const DEFAULT_BARS = 4;
// the keys that fire the snapshot pads, slot by slot
export const SLOT_KEYS = ['t', 'y', 'u', 'i', 'h', 'j', 'k', 'l'];
export const MAX_SECONDS = 30;
// A recording is stored in pieces small enough for one database document each.
export const CHUNK_BYTES = 900000;
export const MAX_CHUNKS = 8;
const WAV_HEADER = 44;
// 16-bit stereo
const BYTES_PER_FRAME = 4;

export function newSnapId() {
  const bytes = new Uint8Array(10);
  (globalThis.crypto || { getRandomValues: (a) => a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 256))) }).getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// The audio-clock time a bar (a cycle) starts at, by the scheduler's own sum: Strudel's
// cyclist plays a hap that begins at cycle c at
//   (c - cycles at the last tempo change) / cps + seconds at that change + latency.
export function barTime({ cps, cyclesAtChange, secondsAtChange, latency }, bar) {
  return (bar - cyclesAtChange) / cps + secondsAtChange + latency;
}

// The first bar line the scheduler has not handed out yet. `lastEnd` is the end of what it
// last queried, in cycles; a bar exactly there has not been played.
export const nextBar = (lastEnd) => Math.ceil(lastEnd - 1e-9);

// Whether a capture of `bars` at this tempo stays within the length and size limits.
export function fits(bars, cps, sampleRate) {
  if (!(cps > 0) || !(sampleRate > 0)) return false;
  const seconds = bars / cps;
  const bytes = Math.ceil(seconds * sampleRate) * BYTES_PER_FRAME + WAV_HEADER;
  return seconds <= MAX_SECONDS && bytes <= CHUNK_BYTES * MAX_CHUNKS;
}

// The longest of the bar choices that fits, at most `wanted`; 0 when none does.
export function longestFit(wanted, cps, sampleRate) {
  return [...BAR_CHOICES].reverse().find((bars) => bars <= wanted && fits(bars, cps, sampleRate)) ?? 0;
}

// The audio frames a capture keeps: from the bar line at `bar` for `bars` bars.
export function captureWindow(clock, bar, bars, sampleRate) {
  const startTime = barTime(clock, bar);
  const endTime = barTime(clock, bar + bars);
  const startFrame = Math.round(startTime * sampleRate);
  const endFrame = Math.round(endTime * sampleRate);
  return { startTime, endTime, startFrame, endFrame, frames: endFrame - startFrame };
}

// Where a snapshot's loop is within its own bars at a given bar: a loop that started at
// bar 6 and lasts 4 bars is at its first bar on bars 6, 10, 14 …
export const loopPhase = (start, bars) => ((start % bars) + bars) % bars;

// Whether a slice of a loop that begins at `begin` (in cycles) sounds: on from the bar it
// started at, until the bar it stops at (if any).
export const sounds = (begin, { start, stopAt = null }) => begin >= start - 1e-9 && (stopAt === null || begin < stopAt - 1e-9);

/* ---------- slots ---------- */

// The slot each snapshot sits in, as an array of SLOTS ids (null where empty). A snapshot
// whose slot is taken by a newer one moves to the first free slot; any that do not fit are
// returned as `left` (kept, but not on a pad).
export function arrange(list) {
  const slots = Array(SLOTS).fill(null);
  const left = [];
  const sorted = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const later = [];
  for (const snap of sorted) {
    if (Number.isInteger(snap.slot) && snap.slot >= 0 && snap.slot < SLOTS && !slots[snap.slot]) slots[snap.slot] = snap.id;
    else later.push(snap);
  }
  for (const snap of later) {
    const free = slots.indexOf(null);
    if (free < 0) left.push(snap.id);
    else slots[free] = snap.id;
  }
  return { slots, left };
}

export const firstFree = (slots) => slots.indexOf(null);

/* ---------- names ---------- */

const NAME_MAX = 60;
export const cleanName = (name) =>
  String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);

export const barsLabel = (bars) => `${bars} ${bars === 1 ? 'bar' : 'bars'}`;
export const describe = (snap) => `${snap.name} · ${barsLabel(snap.bars)}`;

/* ---------- storing a recording ---------- */

// Bytes → pieces of at most `size` bytes, and back.
export function toChunks(bytes, size = CHUNK_BYTES) {
  const chunks = [];
  for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
  return chunks;
}
export function fromChunks(chunks) {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/* ---------- a snapshot record ---------- */

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

// A snapshot's record as it may be stored, or null if it is not one.
export function cleanSnapshot(data) {
  if (!data || typeof data !== 'object') return null;
  const { id, bars, cps, sampleRate, frames, slot, chunks } = data;
  if (typeof id !== 'string' || !/^[0-9a-f]{8,40}$/.test(id)) return null;
  if (!BAR_CHOICES.includes(bars)) return null;
  if (!isNumber(cps) || cps <= 0 || cps > 10) return null;
  if (!isInt(sampleRate, 8000, 192000)) return null;
  if (!isInt(frames, 1, Math.ceil(MAX_SECONDS * sampleRate) + 1)) return null;
  if (!isInt(chunks, 1, MAX_CHUNKS)) return null;
  const name = cleanName(data.name);
  return {
    id,
    name: name || 'Snapshot',
    track: cleanName(data.track),
    songTitle: text(data.songTitle, 200),
    bars,
    cps,
    sampleRate,
    frames,
    slot: isInt(slot, 0, SLOTS - 1) ? slot : null,
    pinned: data.pinned === 'A' || data.pinned === 'B' ? data.pinned : null,
    createdAt: isNumber(data.createdAt) ? data.createdAt : 0,
    updatedAt: isNumber(data.updatedAt) ? data.updatedAt : 0,
    chunks,
  };
}

// The number of chunks a WAV of `bytes` bytes is stored in.
export const chunkCount = (bytes) => Math.max(1, Math.ceil(bytes / CHUNK_BYTES));
