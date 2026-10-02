import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { createAnalyzer, sliderText, sliderReadout, applySliderValues, applySaved, shapeOf } from '../../js/analyze-core.js';

const analyze = createAnalyzer(parse);

const SONG = `/*
  @title Test Song
  @by Someone
  A note about it.
*/
setcps(140/60/4)
const bright = slider(2400, 200, 4000)
const voice = slider(3, 0, 7, 1)

DRUMS: s("bd*4").bank("RolandTR909").lpf(bright)
SUB: note("c1").s("sine").gain(pick([1, 2], voice))
_LEAD: note("c5").lpf(slider(900, 300, 1200))
$: sound("hh*8")
$: sound("~ cp")
`;

test('reads the header', () => {
  const { meta } = analyze(SONG);
  assert.equal(meta.title, 'Test Song');
  assert.equal(meta.by, 'Someone');
  assert.equal(meta.bpm, 140);
  assert.deepEqual(meta.notes, ['A note about it.']);
});

test("reads Strudel's line-comment shorthand", () => {
  const { meta } = analyze('// "coastline" @by eddyflux\n// @version 1.0\nsetcps(.75)\ns("bd")');
  assert.equal(meta.title, 'coastline');
  assert.equal(meta.by, 'eddyflux');
  assert.equal(meta.bpm, 180);
});

test('finds tracks, including ones switched off with an underscore', () => {
  const { tracks } = analyze(SONG);
  assert.deepEqual(tracks.map((t) => t.name), ['DRUMS', 'SUB', 'LEAD', 'hh', 'cp']);
  assert.deepEqual(tracks.map((t) => t.disabled), [false, false, true, false, false]);
  assert.equal(SONG.slice(tracks[0].labelFrom, tracks[0].labelTo), 'DRUMS:');
});

test('numbers anonymous tracks that share a sound', () => {
  const { tracks } = analyze('$: note("c").sound("supersaw")\n$: note("e").sound("supersaw")');
  assert.deepEqual(tracks.map((t) => t.name), ['supersaw', 'supersaw 2']);
});

test('names sliders from the code around them', () => {
  const { sliders } = analyze(SONG);
  assert.deepEqual(sliders.map((s) => [s.title, s.sub]), [['bright', 'lpf'], ['voice', 'pick'], ['LEAD', 'lpf']]);
  assert.equal(sliders[0].taper, 'log');
  assert.equal(sliders[1].step, 1);
  assert.equal(SONG.slice(sliders[0].from, sliders[0].to), '2400');
});

test('a slider with no visible use shows its range', () => {
  const { sliders } = analyze('const x = slider(1, 0, 4)\ns("bd")');
  assert.equal(sliders[0].sub, '0–4');
});

test('writes numbers at a precision that suits the range', () => {
  const [bright, voice] = analyze(SONG).sliders;
  assert.equal(sliderText(bright, 1234.56), '1235');
  assert.equal(sliderText(voice, 4), '4');
  assert.equal(sliderText({ min: 0, max: 1 }, 0.47712), '0.477');
  assert.equal(sliderReadout(bright, 2468), '2.47 kHz');
  assert.equal(sliderReadout(bright, 440), '440 Hz');
});

test('writes saved values back into the code, clamped to each range', () => {
  const { sliders } = analyze(SONG);
  const code = applySliderValues(SONG, sliders, [99999, 5, 600]);
  assert.match(code, /slider\(4000, 200, 4000\)/);
  assert.match(code, /slider\(5, 0, 7, 1\)/);
  assert.match(code, /slider\(600, 300, 1200\)/);
  // a saved state from a different version of the song is ignored
  assert.equal(applySliderValues(SONG, sliders, [1, 2]), SONG);
});

test('reports a syntax error instead of throwing', () => {
  const result = analyze('DRUMS: s("bd"');
  assert.ok(result.error);
  assert.deepEqual(result.tracks, []);
});

const SWITCHED = `/*
  @title Selector
  voice: 0 choir, 1 organ, 2 bells,
         3 strings
  take: which recording of it to use
*/
const voice = 2
const beat = 0
// 0-2  (flip this)
const plain = 5
const cut = slider(700, 100, 900)
VOX: s("sawtooth").lpf(cut)
`;

test('finds switches: plain numbers the song explains', () => {
  const { switches } = analyze(SWITCHED);
  assert.deepEqual(switches.map((s) => [s.name, s.value, s.min, s.max]), [['voice', 2, 0, 3], ['beat', 0, 0, 2]]);
  assert.deepEqual(switches[0].options.map((o) => o.label), ['choir', 'organ', 'bells', 'strings']);
  assert.equal(SWITCHED.slice(switches[0].from, switches[0].to), '2');
});

test('writes saved knob and switch positions into the code', () => {
  const analysis = analyze(SWITCHED);
  const code = applySaved(SWITCHED, analysis, { sliders: [250], switches: [3, 1] });
  assert.match(code, /const voice = 3\n/);
  assert.match(code, /const beat = 1\n/);
  assert.match(code, /slider\(250, 100, 900\)/);
  // a position the switch does not have is ignored
  assert.match(applySaved(SWITCHED, analysis, { switches: [9, 0] }), /const voice = 2\n/);
  assert.equal(applySaved(SWITCHED, analysis, null), SWITCHED);
});

test('two versions that differ only in knob positions have the same shape', () => {
  const a = analyze(SWITCHED);
  const moved = applySaved(SWITCHED, a, { sliders: [123] });
  assert.equal(shapeOf(SWITCHED, a.sliders), shapeOf(moved, analyze(moved).sliders));
  const edited = SWITCHED.replace('"sawtooth"', '"bd"');
  assert.notEqual(shapeOf(SWITCHED, a.sliders), shapeOf(edited, analyze(edited).sliders));
});

test('changed lines are the ones the saved version does not have, in order', async () => {
  const { changedLines } = await import('../../js/analyze-core.js');
  const saved = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(changedLines(saved, saved), []);
  assert.deepEqual(changedLines(saved, ['a', 'b', 'X', 'd', 'e']), [3]);
  assert.deepEqual(changedLines(saved, ['new', 'a', 'b', 'c', 'd', 'e']), [1]);
  assert.deepEqual(changedLines(saved, ['a', 'b', 'c', 'd', 'e', 'new', 'newer']), [6, 7]);
  assert.deepEqual(changedLines(saved, ['a', 'e']), []);
  assert.deepEqual(changedLines(saved, ['a', 'c', 'B', 'e', 'd']), [3, 5]);
  assert.deepEqual(changedLines([], ['x']), [1]);
  // a line that moved past others counts as changed where it lands
  assert.deepEqual(changedLines(['a', 'b', 'c'], ['b', 'c', 'a']), [3]);
});
