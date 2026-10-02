import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepsFor, normalize, markDone, progress, isReturning, forVisitor, shouldAutoOpen, VERSION } from '../../js/onboarding-core.js';

test('signed out the steps end with signing in; with an account, with keeping and sharing', () => {
  assert.deepEqual(stepsFor({ access: 'preview', hasTries: true }), ['play', 'knob', 'mute', 'tweak', 'signin']);
  assert.deepEqual(stepsFor({ access: 'preview', hasTries: false }), ['play', 'knob', 'mute', 'signin']);
  assert.deepEqual(stepsFor({ access: 'full', hasTries: false }), ['play', 'knob', 'mute', 'tweak', 'save', 'share']);
});

test('anything stored that is not a state of this version starts afresh', () => {
  for (const junk of [null, undefined, 'x', 3, {}, { v: 0, done: { play: 1 } }]) {
    assert.deepEqual(normalize(junk), { v: VERSION, done: {}, open: null, never: false, finished: false });
  }
  assert.deepEqual(normalize({ v: VERSION, done: { play: 5, knob: 'soon' }, open: 'yes', never: true }), { v: VERSION, done: { play: 5 }, open: null, never: true, finished: false });
});

test('the first time a step is done is kept', () => {
  const once = markDone(normalize(null), 'play', 10);
  const twice = markDone(once, 'play', 20);
  assert.equal(twice.done.play, 10);
  assert.equal(twice, once);
});

test('progress names the next step and says when the list is done', () => {
  const ids = stepsFor({ access: 'full' });
  let state = normalize(null);
  assert.deepEqual(progress(state, ids), { done: 0, total: 6, next: 'play', complete: false });
  state = markDone(markDone(state, 'play'), 'mute');
  assert.equal(progress(state, ids).next, 'knob');
  for (const id of ids) state = markDone(state, id);
  assert.deepEqual(progress(state, ids), { done: 6, total: 6, next: null, complete: true });
});

test('a returning visitor starts with the list closed and play ticked; a new one with nothing', () => {
  assert.equal(isReturning({ lastSong: 'abc' }), true);
  assert.equal(isReturning({ signedIn: true }), true);
  assert.equal(isReturning({}), false);
  const back = forVisitor(null, { lastSong: 'abc' }, 7);
  assert.equal(back.done.play, 7);
  assert.equal(back.open, false);
  assert.equal(shouldAutoOpen(back), false);
  const first = forVisitor(null, {});
  assert.deepEqual(first.done, {});
  assert.equal(shouldAutoOpen(first), true);
  // what was stored wins over the guess
  assert.equal(forVisitor({ v: VERSION, done: {}, open: true }, { lastSong: 'abc' }).open, true);
});

test('it opens by itself only once, and never after "don\'t show these again"', () => {
  assert.equal(shouldAutoOpen({ ...normalize(null), open: false }), false);
  assert.equal(shouldAutoOpen({ ...normalize(null), never: true }), false);
  assert.equal(shouldAutoOpen({ ...normalize(null), finished: true }), false);
});
