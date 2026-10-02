import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from '../../js/recorder.js';

test('writes a valid 16-bit stereo WAV header', async () => {
  const chunks = [new Int16Array([0, 0, 1000, -1000]), new Int16Array([32767, -32768])];
  const blob = encodeWav(chunks, 48000);
  assert.equal(blob.type, 'audio/wav');
  const view = new DataView(await blob.arrayBuffer());
  const text = (offset) => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(offset + i)));
  assert.equal(text(0), 'RIFF');
  assert.equal(text(8), 'WAVE');
  assert.equal(text(36), 'data');
  assert.equal(view.getUint32(4, true), 36 + 12);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(28, true), 48000 * 4);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 12);
  assert.equal(view.byteLength, 44 + 12);
  assert.equal(view.getInt16(44 + 4, true), 1000);
  assert.equal(view.getInt16(44 + 10, true), -32768);
});
