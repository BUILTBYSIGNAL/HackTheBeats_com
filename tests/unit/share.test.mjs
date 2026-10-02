import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMix, decodeMix, mixFromHash, linkForMix } from '../../js/share.js';

const mix = {
  song: 'w0fFekG7i-NN',
  sliders: [2166.4, 0.5, 7],
  switches: [],
  mixer: [
    { gain: 1, mute: false, solo: false },
    { gain: 0.5, mute: true, solo: false },
    { gain: 1.25, mute: false, solo: true },
  ],
  tempo: 1.08,
};

test('a mix survives the round trip through a link', () => {
  const link = linkForMix(mix, 'https://example.org/beats/?x=1#old');
  assert.ok(link.startsWith('https://example.org/beats/?x=1#mix='));
  assert.deepEqual(mixFromHash(new URL(link).hash), mix);
});

test('switch positions travel too, and older links without them still open', () => {
  const withSwitches = { ...mix, switches: [1, 0, 2] };
  assert.deepEqual(decodeMix(encodeMix(withSwitches)), withSwitches);
  const older = btoa(JSON.stringify({ s: 'a', k: [1], m: [], t: 1 }));
  assert.deepEqual(decodeMix(older).switches, []);
  assert.deepEqual(decodeMix(btoa(JSON.stringify({ s: 'a', w: [1, 'x', 2.5, 3] }))).switches, [1, 3]);
});

test('the encoded form is safe to put in a URL', () => {
  assert.match(encodeMix({ ...mix, song: 'file:ünïcode beat.strudel' }), /^[A-Za-z0-9_-]+$/);
  assert.equal(decodeMix(encodeMix({ ...mix, song: 'file:ünïcode beat.strudel' })).song, 'file:ünïcode beat.strudel');
});

test('values outside the controls are clamped', () => {
  const decoded = decodeMix(encodeMix({ song: 'a', sliders: [], mixer: [{ gain: 9, mute: false, solo: false }], tempo: 3 }));
  assert.equal(decoded.mixer[0].gain, 1.25);
  assert.equal(decoded.tempo, 1.25);
});

test('rubbish is rejected', () => {
  assert.equal(decodeMix('not-base64!!'), null);
  assert.equal(decodeMix(btoa('{"k":[1]}')), null);
  assert.equal(mixFromHash('#something-else'), null);
  assert.equal(mixFromHash(''), null);
});
