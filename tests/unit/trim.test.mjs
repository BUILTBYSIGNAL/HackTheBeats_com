import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { createAnalyzer, applyChanges } from '../../js/analyze-core.js';
import { ARRANGEMENT_BARS } from '../../js/arrangement.js';
import { BARS, parseCut, cutLine, loopLength, sourceBar, cutBars, keepBars, parseMask, maskText, maskOf, silenced, planTrim, barsText, copyBars, moveBars, pasteBars } from '../../js/trim-core.js';

const analyze = createAnalyzer(parse);

const SONG = `/*
  @title Invented Trim Song
*/
setcps(0.5)

DRUMS: s("bd*4")
  .gain(0.8)

KEYS: note("<c3 e3 g3 b3>").s("triangle");
`;

const run = (code, action) => {
  const plan = planTrim(code, analyze(code).tracks, action);
  assert.ok(!plan.error, plan.error);
  return applyChanges(code, plan.changes);
};
const parses = (code) => assert.doesNotThrow(() => parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));

test('the strip and the trim count the same bars', () => {
  assert.equal(BARS, ARRANGEMENT_BARS);
});

test('cutting bars keeps the rest in order and loops at the new length', () => {
  const segments = cutBars(null, 8, 11);
  assert.deepEqual(segments, [
    [0, 8],
    [12, 20],
  ]);
  assert.equal(loopLength(segments), 28);
  assert.equal(sourceBar(segments, 7), 7);
  assert.equal(sourceBar(segments, 8), 12);
  assert.equal(sourceBar(segments, 27), 31);
  // the strip wraps round: bar 29 of the strip is the song's first bar again
  assert.equal(sourceBar(segments, 28), 0);
  // a second cut is made in strip bars, on top of the first
  assert.deepEqual(cutBars(segments, 8, 9), [
    [0, 8],
    [14, 18],
  ]);
  // selected backwards, or across the wrap
  assert.deepEqual(cutBars(null, 11, 8), segments);
  assert.deepEqual(cutBars(segments, 28, 28), [
    [1, 7],
    [12, 20],
  ]);
  assert.equal(cutBars(null, 0, 31), null);
});

test('keeping only some bars', () => {
  assert.deepEqual(keepBars(null, 4, 7), [[4, 4]]);
  assert.deepEqual(keepBars(cutBars(null, 8, 11), 6, 9), [
    [6, 2],
    [12, 2],
  ]);
});

test('the trim line reads back as it was written', () => {
  const segments = [
    [0, 8],
    [12, 20],
  ];
  const line = cutLine(segments);
  assert.equal(line.split(' //')[0], 'all(x => arrange([8, x.ribbon(0, 8)], [20, x.ribbon(12, 20)]))');
  parses(line);
  const code = `setcps(1)\n${line}\nA: s("bd")\n`;
  const cut = parseCut(code);
  assert.deepEqual(cut.segments, segments);
  assert.equal(code.slice(cut.from, cut.to), line);
  assert.equal(parseCut('all(x => x.fast(2))'), null);
  assert.equal(parseCut('all(x => arrange([8, x.ribbon(0, 4)]))'), null);
});

test('a mask is one step per bar', () => {
  const bits = Array(BARS).fill(1);
  bits.fill(0, 8, 12);
  const text = maskText(bits);
  assert.equal(text, '.mask("<1!8 0!4 1!20>")');
  assert.deepEqual(parseMask('1!8 0!4 1!20'), bits);
  assert.equal(maskText([0, ...Array(BARS - 1).fill(1)]), '.mask("<0 1!31>")');
  assert.equal(parseMask('1!4 0'), null);
});

test('cutting writes one line before the first part, and a second cut rewrites it', () => {
  const once = run(SONG, { kind: 'cut', from: 8, to: 11 });
  parses(once);
  assert.match(once, /setcps\(0\.5\)\n\nall\(x => arrange\(\[8, x\.ribbon\(0, 8\)\], \[20, x\.ribbon\(12, 20\)\]\)\) \/\/[^\n]*\n\nDRUMS:/);
  const twice = run(once, { kind: 'cut', from: 0, to: 3 });
  assert.equal(twice.match(/all\(x => arrange/g).length, 1);
  assert.deepEqual(parseCut(twice).segments, [
    [4, 4],
    [12, 20],
  ]);
  // keeping every bar again takes the line away altogether
  const back = run(SONG, { kind: 'keep', from: 0, to: 31 });
  assert.equal(back, SONG);
  assert.equal(planTrim(SONG, analyze(SONG).tracks, { kind: 'cut', from: 0, to: 40 }).error.includes('every bar'), true);
});

test('silencing a part adds a mask after its whole chain, and bringing it back removes it', () => {
  const quiet = run(SONG, { kind: 'silence', track: 0, from: 0, to: 3, on: false });
  parses(quiet);
  assert.match(quiet, /DRUMS: s\("bd\*4"\)\n {2}\.gain\(0\.8\)\.mask\("<0!4 1!28>"\)\n/);
  // the part before the `;` on the other line
  const keys = run(SONG, { kind: 'silence', track: 1, from: 31, to: 31, on: false });
  assert.match(keys, /\.s\("triangle"\)\.mask\("<1!31 0>"\);/);

  const tracks = analyze(quiet).tracks;
  assert.deepEqual(maskOf(quiet, tracks[0]).bits.slice(0, 5), [0, 0, 0, 0, 1]);
  assert.equal(silenced(quiet, tracks[0], null, 1, 2), true);
  assert.equal(silenced(quiet, tracks[0], null, 3, 4), false);
  // more silence goes into the same mask
  const more = run(quiet, { kind: 'silence', track: 0, from: 8, to: 9, on: false });
  assert.equal(more.match(/\.mask\(/g).length, 1);
  assert.match(more, /\.mask\("<0!4 1!4 0!2 1!22>"\)/);
  assert.equal(run(quiet, { kind: 'silence', track: 0, from: 0, to: 3, on: true }), SONG);
});

test('after a cut, the strip bars of a part are its own bars in the trimmed song', () => {
  const cut = run(SONG, { kind: 'cut', from: 8, to: 11 });
  // strip bar 9 now plays the song's bar 13
  const quiet = run(cut, { kind: 'silence', track: 1, from: 8, to: 8, on: false });
  const bits = maskOf(quiet, analyze(quiet).tracks[1]).bits;
  assert.equal(bits[12], 0);
  assert.equal(bits.filter((bit) => !bit).length, 1);
});

test('nothing to trim in a single pattern', () => {
  assert.match(planTrim('s("bd*4")', [], { kind: 'cut', from: 0, to: 1 }).error, /single pattern/);
});

test('bars are counted from 1 on screen', () => {
  assert.equal(barsText(8, 11), 'bars 9–12');
  assert.equal(barsText(11, 8), 'bars 9–12');
  assert.equal(barsText(0, 0), 'bar 1');
});

test('copying bars takes the song bars they play, in order', () => {
  assert.deepEqual(copyBars(null, 1, 2), [1, 2]);
  assert.deepEqual(copyBars(cutBars(null, 8, 11), 7, 8), [7, 12]);
  // past the end of a trimmed loop there is nothing of its own to copy
  assert.equal(copyBars(cutBars(null, 8, 11), 27, 28), null);
});

test('moving bars a bar earlier or later, but not past either end', () => {
  assert.deepEqual(moveBars(null, 1, 2, -1), [
    [1, 2],
    [0, 1],
    [3, 29],
  ]);
  assert.deepEqual(moveBars(null, 1, 2, 1), [
    [0, 1],
    [3, 1],
    [1, 2],
    [4, 28],
  ]);
  assert.equal(moveBars(null, 0, 3, -1), null);
  assert.equal(moveBars(null, 30, 31, 1), null);
  // moved there and back is the whole song again
  assert.deepEqual(moveBars(moveBars(null, 4, 7, 1), 5, 8, -1), [[0, BARS]]);
});

test('pasting bars in after others, or over them, within the 32 bars of the strip', () => {
  const short = keepBars(null, 0, 7);
  assert.deepEqual(pasteBars(short, 8, [0, 1, 2, 3]), [
    [0, 8],
    [0, 4],
  ]);
  assert.deepEqual(pasteBars(short, 2, [6, 7]), [
    [0, 2],
    [6, 2],
    [2, 6],
  ]);
  // over: the bars from there on are replaced, and the loop keeps its length
  assert.deepEqual(pasteBars(null, 4, [0, 1, 2, 3], true), [
    [0, 4],
    [0, 4],
    [8, 24],
  ]);
  // over, running past the end: the loop grows to fit
  assert.equal(loopLength(pasteBars(short, 6, [0, 1, 2, 3], true)), 10);
  // the strip is full: inserting has no room
  assert.equal(pasteBars(null, 4, [0]), null);
});

test('moving and pasting write the same one line, and read back', () => {
  const moved = run(SONG, { kind: 'move', from: 0, to: 3, by: 1 });
  parses(moved);
  assert.deepEqual(parseCut(moved).segments, [
    [4, 1],
    [0, 4],
    [5, 27],
  ]);
  assert.equal(run(moved, { kind: 'move', from: 1, to: 4, by: -1 }), SONG);
  const pasted = run(SONG, { kind: 'paste', at: 0, bars: [8, 9], over: true });
  assert.deepEqual(parseCut(pasted).segments, [
    [8, 2],
    [2, 30],
  ]);
  const plan = (action) => planTrim(SONG, analyze(SONG).tracks, action);
  assert.match(plan({ kind: 'move', from: 0, to: 1, by: -1 }).error, /already at the start/);
  assert.match(plan({ kind: 'paste', at: 2, bars: [0], over: false }).error, /holds 32 bars/);
});
