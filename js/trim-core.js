// Trimming a song from its arrangement strip: the parts that are plain logic. No imports, so
// it is unit-tested in Node.
//
// A song is patterns that loop, not a recording, so a trim is written into the code as a
// change to time, in plain Strudel that runs anywhere:
//
//   cutting bars     one line that plays the bars that are kept, in order:
//                    all(x => arrange([8, x.ribbon(0, 8)], [20, x.ribbon(12, 20)])) // …
//   silencing a part a mask at the end of that part's code, one step per bar:
//                    .mask("<1!8 0!4 1!20>")
//
// Bars are counted from 0 over the 32 the strip shows. A song's own bars ("source bars") and
// the bars of the trimmed song ("strip bars") differ once something has been cut.

export const BARS = 32;

const NOTE = '// bars kept, in order (trimmed on the deck)';
const LINE = /^[ \t]*all\(x => arrange\(((?:\[\d+, x\.ribbon\(\d+, \d+\)\](?:, )?)+)\)\)[ \t]*(?:\/\/[^\n]*)?$/m;
const PAIR = /\[(\d+), x\.ribbon\((\d+), (\d+)\)\]/g;
const MASK = /\.mask\("<([01](?:!\d+)?(?: [01](?:!\d+)?)*)>"\)$/;

/* ---------- cutting bars ---------- */

// Segments: [[start, length], …] in source bars, played in order and then looped.
const WHOLE = [[0, BARS]];

// The trim line in the code, if there is one: { segments, from, to } (to is the end of the line).
export function parseCut(code) {
  const match = LINE.exec(code);
  if (!match) return null;
  const segments = [];
  for (const [, length, start, again] of match[1].matchAll(PAIR)) {
    const n = Number(length);
    if (n !== Number(again) || n < 1 || Number(start) + n > BARS) return null;
    segments.push([Number(start), n]);
  }
  return segments.length ? { segments, from: match.index, to: match.index + match[0].length } : null;
}

export const cutLine = (segments) => `all(x => arrange(${segments.map(([start, n]) => `[${n}, x.ribbon(${start}, ${n})]`).join(', ')})) ${NOTE}`;

export const loopLength = (segments) => (segments ?? WHOLE).reduce((sum, [, n]) => sum + n, 0);

// The source bars of the trimmed song, in the order they play.
function order(segments) {
  return (segments ?? WHOLE).flatMap(([start, n]) => Array.from({ length: n }, (_, i) => start + i));
}

// Runs of consecutive source bars back into segments.
function toSegments(bars) {
  const segments = [];
  for (const bar of bars) {
    const last = segments[segments.length - 1];
    if (last && last[0] + last[1] === bar) last[1]++;
    else segments.push([bar, 1]);
  }
  return segments;
}

// The source bar a strip bar plays (the trimmed song loops, so the strip wraps round).
export function sourceBar(segments, column) {
  const bars = order(segments);
  return bars[((column % bars.length) + bars.length) % bars.length];
}

// The positions in the trimmed song's loop that strip bars `from`…`to` cover.
function positions(segments, from, to) {
  const length = loopLength(segments);
  const set = new Set();
  for (let c = Math.min(from, to); c <= Math.max(from, to); c++) set.add(((c % length) + length) % length);
  return set;
}

const isWhole = (segments) => segments.length === 1 && segments[0][0] === 0 && segments[0][1] === BARS;

// Segments without strip bars `from`…`to`; null when nothing would be left.
export function cutBars(segments, from, to) {
  const gone = positions(segments, from, to);
  const kept = order(segments).filter((_, i) => !gone.has(i));
  return kept.length ? toSegments(kept) : null;
}

// Segments with only strip bars `from`…`to`, in the order they play.
export function keepBars(segments, from, to) {
  const keep = positions(segments, from, to);
  const kept = order(segments).filter((_, i) => keep.has(i));
  return kept.length ? toSegments(kept) : null;
}

// The bars picked, within the loop: [first, last], or null when they run past its end.
function within(segments, from, to) {
  const [a, b] = [Math.min(from, to), Math.max(from, to)];
  return a >= 0 && b < loopLength(segments) ? [a, b] : null;
}

// The song's own bars that strip bars `from`…`to` play, in order: what Copy takes.
export function copyBars(segments, from, to) {
  const span = within(segments, from, to);
  return span ? order(segments).slice(span[0], span[1] + 1) : null;
}

// Segments with strip bars `from`…`to` moved `by` bars (−1 earlier, 1 later); null at either end.
export function moveBars(segments, from, to, by) {
  const span = within(segments, from, to);
  if (!span) return null;
  const bars = order(segments);
  if (span[0] + by < 0 || span[1] + by >= bars.length) return null;
  const picked = bars.splice(span[0], span[1] - span[0] + 1);
  bars.splice(span[0] + by, 0, ...picked);
  return toSegments(bars);
}

// Segments with copied bars (song bars, from copyBars) put in at strip bar `at`: inserted
// there, or written over the bars from there on (`over`). Null past the strip's 32 bars.
export function pasteBars(segments, at, clip, over = false) {
  const bars = order(segments);
  if (at < 0 || at > bars.length) return null;
  bars.splice(at, over ? Math.min(clip.length, bars.length - at) : 0, ...clip);
  return bars.length <= BARS ? toSegments(bars) : null;
}

/* ---------- silencing a part ---------- */

// A part's own mask: one bit per source bar (1 plays), or null if it has none of ours.
export function parseMask(text) {
  const bits = [];
  for (const token of text.split(' ')) {
    const [bit, times = '1'] = token.split('!');
    for (let i = 0; i < Number(times); i++) bits.push(bit === '1' ? 1 : 0);
  }
  return bits.length === BARS ? bits : null;
}

export function maskText(bits) {
  const runs = [];
  for (const bit of bits) {
    const last = runs[runs.length - 1];
    if (last && last[0] === bit) last[1]++;
    else runs.push([bit, 1]);
  }
  return `.mask("<${runs.map(([bit, n]) => (n === 1 ? String(bit) : `${bit}!${n}`)).join(' ')}>")`;
}

// The mask at the end of a part's code, if it is one of ours: { bits, from, to }.
export function maskOf(code, track) {
  const end = track.exprTo ?? track.to;
  const text = code.slice(track.from, end);
  const match = MASK.exec(text);
  if (!match) return null;
  const bits = parseMask(match[1]);
  return bits ? { bits, from: track.from + match.index, to: end } : null;
}

// Whether a part is silenced over every source bar that strip bars `from`…`to` play.
export function silenced(code, track, segments, from, to) {
  const bits = maskOf(code, track)?.bits;
  if (!bits) return false;
  for (let c = Math.min(from, to); c <= Math.max(from, to); c++) if (bits[sourceBar(segments, c)]) return false;
  return true;
}

/* ---------- the edit ---------- */

// What a trim changes in the code, as edits for the stage: { changes: [{ from, to, insert }],
// segments } or { error }. `tracks` are the song's parts (analyze-core.js).
//   { kind: 'cut' | 'keep', from, to }                 strip bars
//   { kind: 'move', from, to, by }                     by: −1 one bar earlier, 1 later
//   { kind: 'paste', at, bars, over }                  bars: song bars, from copyBars
//   { kind: 'silence', track, from, to, on }            on: false silences, true brings back
export function planTrim(code, tracks, action) {
  if (!tracks.length) return { error: 'This beat is a single pattern, so there is nothing to trim.' };
  const cut = parseCut(code);
  const segments = cut?.segments ?? null;

  const arranged = {
    cut: () => cutBars(segments, action.from, action.to) ?? { error: 'That would cut every bar. Leave at least one.' },
    keep: () => keepBars(segments, action.from, action.to) ?? { error: 'That would cut every bar. Leave at least one.' },
    move: () =>
      !within(segments, action.from, action.to)
        ? { error: 'Pick bars before the loop starts again.' }
        : (moveBars(segments, action.from, action.to, action.by) ?? { error: `Those bars are already at the ${action.by < 0 ? 'start' : 'end'}.` }),
    paste: () =>
      action.at > loopLength(segments)
        ? { error: 'Pick bars before the loop starts again.' }
        : (pasteBars(segments, action.at, action.bars, action.over) ?? { error: `The strip holds ${BARS} bars. Paste over some, or cut some to make room.` }),
  }[action.kind];
  if (arranged) {
    const next = arranged();
    if (next.error) return next;
    if (isWhole(next)) {
      // back to the whole song: the line goes, with the line breaks it was written with
      if (!cut) return { changes: [], segments: null };
      const end = code.startsWith('\n\n', cut.to) ? cut.to + 2 : code[cut.to] === '\n' ? cut.to + 1 : cut.to;
      return { changes: [{ from: cut.from, to: end, insert: '' }], segments: null };
    }
    if (cut) return { changes: [{ from: cut.from, to: cut.to, insert: cutLine(next) }], segments: next };
    // before the first part, so it is never the song's last expression (which is what plays)
    const first = Math.min(...tracks.map((track) => track.from));
    const lineStart = code.lastIndexOf('\n', first - 1) + 1;
    return { changes: [{ from: lineStart, to: lineStart, insert: `${cutLine(next)}\n\n` }], segments: next };
  }

  if (action.kind === 'silence') {
    const track = tracks[action.track];
    if (!track) return { error: 'That part is no longer in the code.' };
    const mask = maskOf(code, track);
    const bits = mask ? [...mask.bits] : Array(BARS).fill(1);
    for (let c = Math.min(action.from, action.to); c <= Math.max(action.from, action.to); c++) bits[sourceBar(segments, c)] = action.on ? 1 : 0;
    const insert = bits.every(Boolean) ? '' : maskText(bits);
    if (mask) return { changes: [{ from: mask.from, to: mask.to, insert }], segments };
    const end = track.exprTo ?? track.to;
    return { changes: insert ? [{ from: end, to: end, insert }] : [], segments };
  }
  return { error: 'Nothing to do.' };
}

// "bars 9–12" (strip bars, counted from 1 as on screen)
export const barsText = (from, to) => {
  const [a, b] = [Math.min(from, to) + 1, Math.max(from, to) + 1];
  return a === b ? `bar ${a}` : `bars ${a}–${b}`;
};
