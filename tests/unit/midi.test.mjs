import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMessage } from '../../js/midi.js';

test('control change', () => {
  assert.deepEqual(readMessage([0xb0, 21, 127]), { key: 'cc:0:21', kind: 'cc', value: 1 });
  assert.deepEqual(readMessage([0xb3, 7, 0]), { key: 'cc:3:7', kind: 'cc', value: 0 });
});

test('note on and off', () => {
  assert.deepEqual(readMessage([0x90, 36, 100]), { key: 'note:0:36', kind: 'note', down: true });
  assert.deepEqual(readMessage([0x80, 36, 0]), { key: 'note:0:36', kind: 'note', down: false });
  // many controllers send note-on with velocity 0 instead of note-off
  assert.deepEqual(readMessage([0x91, 40, 0]), { key: 'note:1:40', kind: 'note', down: false });
});

test('other messages are ignored', () => {
  assert.equal(readMessage([0xe0, 0, 64]), null);
  assert.equal(readMessage([0xf8]), null);
});
