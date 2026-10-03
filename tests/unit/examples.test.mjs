// The Learn guide's examples (learn/examples/*.strudel): each one has to read as a song to the
// analyzer, carry the title the guide names, use only sounds that are always loaded, and keep
// every suggestion it makes runnable both ways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { createAnalyzer, planTry, applyChanges } from '../../js/analyze-core.js';
import { titleOf } from '../../js/songs-core.js';

const analyze = createAnalyzer(parse);
const toggle = (code, item) => applyChanges(code, planTry(code, item, analyze(code)).changes);

// id → title, and what the deck should find in it
const EXPECTED = {
  'code-becomes-controls': { title: 'Night Ferry', tracks: 3, disabled: 1, sliders: 1, switches: 0, tries: 1 },
  layers: { title: 'Four Floors', tracks: 6, disabled: 2, sliders: 1, switches: 0, tries: 0 },
  macro: { title: 'Pressure Cooker', tracks: 4, disabled: 0, sliders: 1, switches: 0, tries: 0 },
  switch: { title: 'Two Doors', tracks: 5, disabled: 0, sliders: 1, switches: 2, tries: 0 },
  'try-lines': { title: 'Spare Change', tracks: 3, disabled: 0, sliders: 1, switches: 0, tries: 4 },
  'map-notes': { title: 'Harbour Lights', tracks: 4, disabled: 0, sliders: 1, switches: 0, tries: 0 },
  visuals: { title: 'Scope and Card', tracks: 3, disabled: 0, sliders: 1, switches: 0, tries: 0 },
  form: { title: 'Thirty-Two', tracks: 4, disabled: 0, sliders: 1, switches: 0, tries: 0 },
  hook: { title: 'Loose Riff', tracks: 3, disabled: 0, sliders: 1, switches: 0, tries: 0 },
  techno: { title: 'Ballast', tracks: 6, disabled: 1, sliders: 1, switches: 0, tries: 2 },
  trap: { title: 'Half Light', tracks: 6, disabled: 1, sliders: 1, switches: 1, tries: 0 },
  house: { title: 'Paper Street', tracks: 6, disabled: 1, sliders: 1, switches: 0, tries: 2 },
  experimental: { title: 'Loose Teeth', tracks: 5, disabled: 0, sliders: 1, switches: 1, tries: 0 },
};

// Sounds that are there with no sample pack of the song's own (js/runtime.js DEFAULT_PACKS,
// the synths superdough registers, and the General MIDI soundfonts).
const DRUMS = new Set(['bd', 'sd', 'hh', 'oh', 'cp', 'rim', 'cr', 'lt', 'mt', 'ht']);
const SYNTHS = new Set(['sine', 'triangle', 'square', 'sawtooth', 'supersaw', 'white', 'pink']);
const BANKS = new Set(['RolandTR808', 'RolandTR909']);
const MAX_LINES = 40;

const examples = readdirSync('learn/examples')
  .filter((name) => name.endsWith('.strudel'))
  .sort()
  .map((name) => ({ id: name.replace(/\.strudel$/, ''), code: readFileSync(`learn/examples/${name}`, 'utf8') }));

// every string literal passed to `s()` / `sound()`, and every `.bank()` argument
function soundsIn(code) {
  const sounds = [];
  const banks = [];
  const strings = (node) => {
    const found = [];
    (function visit(n) {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'Literal' && typeof n.value === 'string') found.push(n.value);
      for (const key in n) if (key !== 'type' && typeof n[key] === 'object') visit(n[key]);
    })(node);
    return found;
  };
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  (function visit(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'CallExpression') {
      const callee = n.callee.type === 'MemberExpression' ? n.callee.property?.name : n.callee.name;
      if (callee === 's' || callee === 'sound') sounds.push(...strings(n.arguments));
      if (callee === 'bank') banks.push(...strings(n.arguments));
    }
    for (const key in n) if (typeof n[key] === 'object') visit(n[key]);
  })(ast);
  return { sounds, banks };
}
// "bd*4, [~ cp]*2" → ["bd", "cp"]; "rim(5,8)" → ["rim"]
const wordsIn = (text) => text.match(/[A-Za-z][A-Za-z0-9_]*/g) || [];

test('the guide has every example it names, and nothing else', () => {
  assert.deepEqual(
    examples.map((e) => e.id),
    Object.keys(EXPECTED).sort(),
  );
  for (const { id } of examples) assert.match(id, /^[a-z0-9-]+$/, id);
});

for (const { id, code } of examples) {
  const want = EXPECTED[id];

  test(`${id}: reads as a song with the expected parts`, () => {
    assert.doesNotThrow(() => parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
    const analysis = analyze(code);
    assert.equal(analysis.error, undefined, analysis.error?.message);
    assert.equal(titleOf(code), want.title);
    assert.equal(analysis.meta.title, want.title);
    assert.ok(Number.isFinite(analysis.meta.bpm) && analysis.meta.bpm > 0, 'has a tempo');
    assert.ok(analysis.meta.notes.length >= 1, 'says what it is for');
    assert.equal(analysis.tracks.length, want.tracks, 'tracks');
    assert.equal(analysis.tracks.filter((t) => t.disabled).length, want.disabled, 'muted layers');
    assert.equal(analysis.sliders.length, want.sliders, 'knobs');
    assert.equal(analysis.switches.length, want.switches, 'switches');
    assert.equal(analysis.meta.tries.length, want.tries, 'suggestions');
    assert.equal(code.match(/@try /g)?.length ?? 0, want.tries, 'every @try line reads');
    assert.ok(code.trimEnd().split('\n').length <= MAX_LINES, `at most ${MAX_LINES} lines`);
  });

  test(`${id}: every knob is a const with a plain range, and is used in a chain`, () => {
    const { sliders } = analyze(code);
    for (const slider of sliders) {
      assert.ok(slider.constName, 'declared as const');
      assert.ok(slider.min >= 0 && slider.max > slider.min, `${slider.constName}: range ${slider.min}–${slider.max}`);
      assert.ok(slider.value >= slider.min && slider.value <= slider.max, `${slider.constName}: starts inside its range`);
      assert.ok(slider.params.size > 0, `${slider.constName} feeds something`);
      assert.ok(slider.tracks.size > 0, `${slider.constName} shapes a track`);
    }
  });

  test(`${id}: uses only sounds that are always loaded`, () => {
    assert.ok(!/\bsamples\s*\(/.test(code), 'no samples() line');
    const { sounds, banks } = soundsIn(code);
    assert.ok(sounds.length > 0, 'plays something');
    for (const text of sounds) {
      for (const word of wordsIn(text)) {
        assert.ok(DRUMS.has(word) || SYNTHS.has(word) || /^gm_/.test(word), `${word} is not always loaded`);
      }
    }
    for (const bank of banks) assert.ok(BANKS.has(bank), `${bank} is not a built-in kit`);
  });

  test(`${id}: has at least one drum part No drums can find, and a visual`, () => {
    const { tracks } = analyze(code);
    assert.ok(tracks.some((t) => /drum|kick|hat|clap|snare|perc/i.test(t.name)), 'a plainly named drum part');
    const visuals = code.match(/\._(punchcard|scope|pianoroll|spiral|pitchwheel)\(\)/g) || [];
    assert.ok(visuals.length >= 1 && visuals.length <= 3, `${visuals.length} visuals`);
  });

  if (want.tries) {
    test(`${id}: every suggestion goes on and comes off again`, () => {
      const analysis = analyze(code);
      for (const item of analysis.meta.tries) {
        const plan = planTry(code, item, analysis);
        assert.equal(plan.state, 'off', item.label);
        const on = applyChanges(code, plan.changes);
        assert.notEqual(on, code, item.label);
        assert.doesNotThrow(() => parse(on, { ecmaVersion: 'latest', sourceType: 'module' }), item.label);
        assert.equal(analyze(on).error, undefined, item.label);
        assert.equal(planTry(on, item, analyze(on)).state, 'on', item.label);
        assert.equal(toggle(on, item), code, `${item.label} comes off cleanly`);
      }
    });
  }
}

test('map-notes: a note in words sits directly above every part and the knob', () => {
  const { code } = examples.find((e) => e.id === 'map-notes');
  const lines = code.split('\n');
  const lineOf = (at) => code.slice(0, at).split('\n').length;
  const { tracks, sliders } = analyze(code);
  const isNote = (text) => /^\/\/\s*\p{L}/u.test(text.trim()) && !/^\/\/\s*[.\w$]+\(/.test(text.trim());
  for (const track of tracks) {
    const above = lines[lineOf(track.from) - 2];
    assert.ok(isNote(above), `${track.name}: "${above}"`);
  }
  for (const slider of sliders) {
    const above = lines[lineOf(code.indexOf(`const ${slider.constName}`)) - 2];
    assert.ok(isNote(above), `${slider.constName}: "${above}"`);
  }
  const helper = code.indexOf('const duck');
  assert.ok(helper >= 0 && isNote(lines[lineOf(helper) - 2]), 'the helper has a note too');
  assert.equal((code.match(/\bduck\b/g) || []).length, 3, 'the helper is used by two parts');
});

test('switch: every part answers to the section switch, and the mood switch picks a scale', () => {
  const { code } = examples.find((e) => e.id === 'switch');
  const { tracks, switches } = analyze(code);
  assert.deepEqual(switches.map((s) => [s.name, s.options.length]), [['section', 3], ['mood', 2]]);
  for (const track of tracks) assert.ok(code.slice(track.from, track.to).includes('[section]'), `${track.name} indexes by section`);
  assert.match(code, /\[mood\]/);
});

test('form, techno and house: the arrangement is in masks the strip can read, last in the chain', () => {
  for (const id of ['form', 'techno', 'house']) {
    const { code } = examples.find((e) => e.id === id);
    const { tracks } = analyze(code);
    const masked = tracks.filter((track) => /\.mask\("<[01!\d ]+>"\)$/.test(code.slice(track.from, track.exprTo)));
    assert.ok(masked.length >= 2, `${id}: ${masked.length} parts come and go`);
    for (const track of masked) {
      const bars = code.slice(track.from, track.exprTo).match(/\.mask\("<([01!\d ]+)>"\)$/)[1];
      const total = bars.split(' ').reduce((n, token) => n + Number(token.split('!')[1] ?? 1), 0);
      assert.equal(total, 32, `${id}: ${track.name} covers 32 bars`);
    }
  }
});
