import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { createAnalyzer, parseTry, planTry, applyChanges } from '../../js/analyze-core.js';
import { templateSong, STARTERS } from '../../js/songs-core.js';

const analyze = createAnalyzer(parse);
// tap it on, then off again
const toggle = (code, item) => applyChanges(code, planTry(code, item, analyze(code)).changes);

const SONG = `/*
  @title Paper Kite
  A note about it.
  @try Busier hats: \`hh*8\` -> \`hh*16\`
  @try Both at once: \`bd*4\` -> \`bd*2\`; \`cp\` -> \`rim\`
  @try Rounder lead: \`s("square")\` -> \`s("sine")\` in LEAD
  @try Cut the knob: \`slider(800\` -> \`slider(400\`
*/
setcps(120/60/4)
const tone = slider(800, 200, 2000)

DRUMS: s("bd*4, ~ cp, hh*8").gain(0.8)
BASS: note("c2*4").s("square").lpf(tone)
LEAD: note("c5 e5").s("square")
`;

test('a suggestion line is read, and one that does not fit the form is left out', () => {
  assert.deepEqual(parseTry('Busier hats: `hh*8` -> `hh*16`'), { label: 'Busier hats', changes: [{ find: 'hh*8', replace: 'hh*16' }], track: null });
  assert.deepEqual(parseTry('Kit: 808: `a` → `b`; `c` -> `d` in _BELL'), { label: 'Kit: 808', changes: [{ find: 'a', replace: 'b' }, { find: 'c', replace: 'd' }], track: '_BELL' });
  for (const bad of ['no backticks here', 'Empty: `` -> `x`', 'Same: `a` -> `a`', 'Junk: `a` -> `b` and more', 'No label `a` -> `b`', 'Odd: `a` -> `b` in 2ND']) {
    assert.equal(parseTry(bad), null, bad);
  }
});

test('suggestions come only from the opening comment, and never become notes', () => {
  const { meta } = analyze(SONG);
  assert.deepEqual(meta.tries.map((item) => item.label), ['Busier hats', 'Both at once', 'Rounder lead', 'Cut the knob']);
  assert.deepEqual(meta.notes, ['A note about it.']);
  const later = analyze(`${SONG}\n/*\n  @try Late: \`c5\` -> \`c6\`\n*/\n`);
  assert.equal(later.meta.tries.length, 4);
});

test('a suggestion goes on and comes off again, leaving the code exactly as it was', () => {
  const { meta } = analyze(SONG);
  const [busier, both] = meta.tries;
  const on = toggle(SONG, busier);
  assert.match(on, /hh\*16/);
  assert.equal(planTry(on, busier, analyze(on)).state, 'on');
  assert.equal(toggle(on, busier), SONG);
  // several changes at once, and the header that names them is not touched
  const twice = toggle(SONG, both);
  assert.match(twice, /s\("bd\*2, ~ rim, hh\*8"\)/);
  assert.match(twice, /@try Both at once: `bd\*4` -> `bd\*2`; `cp` -> `rim`/);
  assert.equal(toggle(twice, both), SONG);
});

test('"in TRACK" keeps a change to that track', () => {
  const { meta } = analyze(SONG);
  const rounder = meta.tries[2];
  const on = toggle(SONG, rounder);
  assert.match(on, /BASS: note\("c2\*4"\)\.s\("square"\)/);
  assert.match(on, /LEAD: note\("c5 e5"\)\.s\("sine"\)/);
  assert.equal(planTry(SONG, { ...rounder, track: 'NOPE' }, analyze(SONG)).state, 'gone');
});

test('a suggestion the code has moved away from, or that would rewrite a knob, is gone', () => {
  const { meta } = analyze(SONG);
  const [busier, both, , knob] = meta.tries;
  assert.equal(planTry(SONG, knob, analyze(SONG)).state, 'gone');
  const edited = SONG.replace('cp, hh*8', 'cp, hh*12');
  assert.equal(planTry(edited, busier, analyze(edited)).state, 'gone');
  // half made by hand: neither on nor off
  const half = SONG.replace('cp,', 'rim,');
  assert.equal(planTry(half, both, analyze(half)).state, 'gone');
  const broken = SONG.replace('setcps(', 'setcps((');
  assert.equal(planTry(broken, busier, analyze(broken)).state, 'gone');
});

test('a replacement that contains its original still toggles', () => {
  const code = '/*\n  @try Longer: `"a b"` -> `"a b c"`\n*/\nX: n("a b")\n';
  const item = analyze(code).meta.tries[0];
  const on = toggle(code, item);
  assert.match(on, /n\("a b c"\)/);
  assert.equal(planTry(on, item, analyze(on)).state, 'on');
  assert.equal(toggle(on, item), code);
});

test('every suggestion in the demo beats and the starters fits its song, and runs both ways', () => {
  const songs = readdirSync('beats')
    .filter((name) => name.startsWith('demo-') && name.endsWith('.strudel'))
    .map((name) => [name, readFileSync(`beats/${name}`, 'utf8')]);
  for (const { kind } of STARTERS) songs.push([`starter ${kind}`, templateSong('Fresh start', kind)]);
  for (const [name, code] of songs) {
    const analysis = analyze(code);
    const lines = code.match(/@try /g)?.length ?? 0;
    assert.ok(lines > 0, `${name} suggests something`);
    assert.equal(analysis.meta.tries.length, lines, `${name}: every @try line reads`);
    for (const item of analysis.meta.tries) {
      const plan = planTry(code, item, analysis);
      assert.equal(plan.state, 'off', `${name}: ${item.label}`);
      const on = applyChanges(code, plan.changes);
      assert.doesNotThrow(() => parse(on, { ecmaVersion: 2022 }), `${name}: ${item.label}`);
      assert.equal(toggle(on, item), code, `${name}: ${item.label} comes off cleanly`);
    }
  }
});
