import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'acorn';
import { createAnalyzer } from '../../js/analyze-core.js';
import { outlineOf, itemsOf, kitName, soundWords, listOf } from '../../js/outline-core.js';

const analyze = createAnalyzer(parse);
const outline = (code) => outlineOf(code, analyze(code));
const item = (groups, key) => itemsOf(groups).find((entry) => entry.key === key);
const lineOf = (code, text) => code.slice(0, code.indexOf(text)).split('\n').length;

// an invented song that has a bit of everything
const SONG = `/*
  @title Paper Lanterns
  @by Test Person
  A song made up for these tests.
  tone: 0 soft, 1 bright
  @try Faster hats: \`hh*8\` -> \`hh*16\`
*/
setcps(96/60/4)
samples('github:someone/some-pack')

const tone = 0
const glow = slider(700, 100, 3000)
const wet = slider(0.2, 0, 1)   // how far away it sounds
const unused = 5

// shared by the keys and the bass
const root = ["C3:major", "C3:lydian"][tone]
const wobble = x => x.lpf(glow).room(wet)

// the beat
BEAT: s("bd*2, ~ sd, hh*8").bank("RolandTR707").gain(0.7)

KEYS: n("0 2 4 7").scale(root).s("triangle").delay(0.3)
  .crush(6)._punchcard()

_BASS: n("0 -3").scale(root).s("sawtooth").coarse(4).speed(2).hpf(80).slow(2)
  .apply(wobble)
// low and slow

// .lpf(300)
$: s("cp(3,8)").postgain(1.2).fast(2).struct("x ~ x").mask("<1 0>")
`;

test('groups the code into setup, knobs and switches, parts and helpers', () => {
  const groups = outline(SONG);
  assert.deepEqual(groups.map((group) => group.title), ['Setup', 'Knobs and switches', 'Parts', 'Helpers']);
  assert.deepEqual(groups.map((group) => group.items.map((entry) => entry.label)), [
    ['Header', 'Tempo', 'Sample pack'],
    ['tone', 'glow', 'wet'],
    ['BEAT', 'KEYS', 'BASS', 'cp'],
    ['root', 'wobble'],
  ]);
});

test('setup: the header, the tempo and the sample packs', () => {
  const groups = outline(SONG);
  const header = item(groups, 'header');
  assert.equal(header.summary, 'Paper Lanterns · by Test Person');
  assert.ok(header.details.includes('Spells out the tone switch'));
  assert.ok(header.details.includes('1 change to try (@try)'));
  assert.equal(header.line, 1);
  assert.equal(header.endLine, 7);
  const tempo = item(groups, 'tempo');
  assert.equal(tempo.summary, '96 bpm');
  assert.equal(tempo.details[0], '96 beats a minute, set by `setcps(96/60/4)`');
  assert.equal(tempo.line, 8);
  assert.equal(item(groups, 'samples').summary, 'someone/some-pack (GitHub)');
});

test('knobs and switches say what they turn and which parts they shape', () => {
  const groups = outline(SONG);
  const tone = item(groups, 'switch:0');
  assert.equal(tone.summary, 'soft / bright');
  assert.deepEqual(tone.details.slice(0, 2), ['A switch: 0 soft, 1 bright', 'Now 0 (soft). Turning it runs the song again']);
  assert.equal(tone.details[2], 'Shapes KEYS and BASS through `root`');
  const glow = item(groups, 'knob:0');
  assert.equal(glow.k, 0);
  assert.equal(glow.summary, 'filter · BASS');
  assert.equal(glow.details[0], 'A knob from 100 to 3000, now 700');
  assert.equal(glow.details[1], 'Turns the filter (`lpf`)');
  assert.equal(glow.details[2], 'Shapes BASS');
  assert.equal(glow.code, 'const glow = slider(700, 100, 3000)');
  assert.equal(glow.line, lineOf(SONG, 'const glow'));
  // a comment beside the line is the author's note
  assert.equal(item(groups, 'knob:1').note, 'how far away it sounds');
});

test('parts: their sounds, effects in plain words, knobs and state', () => {
  const groups = outline(SONG);
  const beat = item(groups, 'part:0');
  assert.equal(beat.track, 0);
  assert.equal(beat.summary, '707 kit · kick, snare, hi-hat');
  assert.equal(beat.details[0], 'Sounds: kick (bd), snare (sd) and hi-hat (hh), from the 707 kit');
  assert.equal(beat.details[1], 'Effects: volume 0.7');

  const keys = item(groups, 'part:1');
  assert.equal(keys.summary, 'notes · triangle synth');
  assert.equal(keys.details[0], 'Notes on a triangle synth');
  assert.equal(keys.details[1], 'Effects: key from `root`, echo 0.3, bit-crush 6');
  assert.ok(keys.details.includes('Switch: tone through `root`'));
  assert.ok(keys.details.includes('Draws a punchcard under its code'));

  const bass = item(groups, 'part:2');
  assert.equal(bass.disabled, true);
  assert.equal(bass.details[1], 'Effects: key from `root`, lo-fi 4, pitch 2, high-pass 80 Hz, stretch 2× slower');
  assert.ok(bass.details.includes('Knobs: glow (filter) through `wobble`, wet (reverb) through `wobble`'));
  assert.ok(bass.details.includes('Starts muted: its label is written `_BASS`'));

  const clap = item(groups, 'part:3');
  assert.equal(clap.details[1], 'Effects: volume 1.2, stretch 2× faster, rhythm, comes and goes');
});

test('the comment just before or just after a part is its note; commented-out code is not', () => {
  const groups = outline(SONG);
  assert.equal(item(groups, 'part:0').note, 'the beat');
  assert.equal(item(groups, 'part:1').note, null);
  assert.equal(item(groups, 'part:2').note, 'low and slow');
  assert.equal(item(groups, 'part:3').note, null);
  assert.equal(item(groups, 'helper:root').note, 'shared by the keys and the bass');
});

test('line numbers point at each section', () => {
  const groups = outline(SONG);
  const keys = item(groups, 'part:1');
  assert.equal(keys.line, lineOf(SONG, 'KEYS:'));
  assert.equal(keys.endLine, lineOf(SONG, '.crush(6)'));
  assert.equal(SONG.slice(keys.from, keys.from + 5), 'KEYS:');
  assert.equal(item(groups, 'helper:wobble').line, lineOf(SONG, 'const wobble'));
});

test('helpers: what they are and which parts use them; unused ones are left out', () => {
  const groups = outline(SONG);
  const root = item(groups, 'helper:root');
  assert.equal(root.summary, 'used by 2 parts');
  assert.equal(root.details[0], 'One of 2 choices, picked by the tone switch');
  assert.equal(root.details.at(-1), 'Used by KEYS and BASS');
  const wobble = item(groups, 'helper:wobble');
  assert.equal(wobble.summary, 'used by BASS');
  assert.deepEqual(wobble.details, ['A function of `x`', 'Effects: filter on the glow knob, reverb on the wet knob', 'Uses the glow knob and the wet knob', 'Used by BASS']);
  assert.equal(item(groups, 'helper:unused'), undefined);
});

test('a helper used through another helper counts for the parts that use that one', () => {
  const code = 'const notes = "0 2 4"\nconst tune = x => x.n(notes)\nLEAD: s("square").apply(tune)\nPAD: s("sine")';
  const groups = outline(code);
  assert.equal(item(groups, 'helper:notes').summary, 'used by LEAD');
  assert.ok(item(groups, 'helper:notes').details.includes('Used by LEAD (some through other helpers)'));
  assert.equal(item(groups, 'helper:tune').summary, 'used by LEAD');
});

test('a song with no labels has one part: the pattern it ends on', () => {
  const code = 'setcpm(110/4)\nconst p = "bd sd"\ns(p).gain(0.5)';
  const groups = outline(code);
  assert.equal(item(groups, 'tempo').summary, '110 bpm');
  const part = item(groups, 'pattern');
  assert.equal(part.label, 'The pattern');
  assert.equal(part.track, null);
  assert.equal(part.line, 3);
  assert.equal(item(groups, 'helper:p').summary, 'used by the pattern');
});

test('an inline slider is a knob of its part', () => {
  const code = 'LEAD: note("c4 e4").s("sine").lpf(slider(900, 300, 2000))';
  const groups = outline(code);
  assert.equal(item(groups, 'knob:0').label, 'LEAD');
  assert.equal(item(groups, 'knob:0').summary, 'filter · LEAD');
  assert.ok(item(groups, 'part:0').details.includes('Effects: filter on the LEAD knob'));
  assert.ok(item(groups, 'part:0').details.includes('Knob: LEAD (filter)'));
});

test('code with a mistake has no map', () => {
  assert.deepEqual(outline('LEAD: s("bd"'), []);
});

test('words for kits and sounds', () => {
  assert.equal(kitName('RolandTR909'), '909 kit');
  assert.equal(kitName('RolandTR808'), '808 kit');
  assert.equal(kitName('LinnDrum'), 'Linn Drum kit');
  assert.deepEqual(soundWords('bd(3,8), [~ cp]*2, <hh oh:2>'), ['bd', 'cp', 'hh', 'oh']);
  assert.equal(listOf(['a']), 'a');
  assert.equal(listOf(['a', 'b', 'c']), 'a, b and c');
});

test('every demo beat is mapped: each track a part, each slider and switch a control', () => {
  const dir = new URL('../../beats/', import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.startsWith('demo-'))) {
    const code = readFileSync(new URL(file, dir), 'utf8');
    const analysis = analyze(code);
    const groups = outlineOf(code, analysis);
    const parts = groups.find((group) => group.id === 'parts').items;
    assert.deepEqual(parts.map((entry) => entry.label), analysis.tracks.map((track) => track.name), file);
    assert.equal(groups.find((group) => group.id === 'controls').items.length, analysis.sliders.length + analysis.switches.length, file);
    for (const entry of itemsOf(groups)) {
      assert.ok(entry.line >= 1 && entry.endLine >= entry.line && entry.from < entry.to, `${file}: ${entry.key}`);
      assert.ok(entry.details.length > 0, `${file}: ${entry.key} has a description`);
    }
  }
});
