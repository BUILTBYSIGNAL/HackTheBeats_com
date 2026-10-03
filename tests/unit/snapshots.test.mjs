import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOTS,
  SLOT_KEYS,
  CHUNK_BYTES,
  barTime,
  nextBar,
  fits,
  longestFit,
  captureWindow,
  loopPhase,
  sounds,
  arrange,
  firstFree,
  cleanName,
  describe,
  toChunks,
  fromChunks,
  cleanSnapshot,
  chunkCount,
  newSnapId,
} from '../../js/snapshots-core.js';

const clock = { cps: 0.5, cyclesAtChange: 0, secondsAtChange: 10, latency: 0.1 };

test('finds a bar line on the audio clock the way the scheduler does', () => {
  assert.equal(barTime(clock, 0), 10.1);
  assert.equal(barTime(clock, 3), 16.1);
  // after a tempo change the sum starts from where the change was
  assert.equal(barTime({ cps: 1, cyclesAtChange: 8, secondsAtChange: 20, latency: 0 }, 10), 22);
});

test('the next bar is the first one not handed out yet', () => {
  assert.equal(nextBar(4.2), 5);
  assert.equal(nextBar(4), 4);
  assert.equal(nextBar(4.0000000001), 4);
});

test('a capture window is exactly the bars asked for, in frames', () => {
  const window = captureWindow(clock, 2, 4, 48000);
  assert.equal(window.startTime, 14.1);
  assert.equal(window.endTime, 22.1);
  assert.equal(window.frames, 8 * 48000);
  assert.equal(window.startFrame, Math.round(14.1 * 48000));
});

test('keeps captures within thirty seconds and the stored size', () => {
  // 120 bpm: a bar is two seconds
  assert.equal(fits(8, 0.5, 48000), true);
  // 60 bpm: eight bars is 32 seconds
  assert.equal(fits(8, 0.25, 48000), false);
  assert.equal(longestFit(8, 0.25, 48000), 4);
  // a 96 kHz device fills the chunks sooner
  assert.equal(fits(8, 0.5, 96000), true);
  assert.equal(fits(8, 0.4, 96000), false);
  assert.equal(longestFit(2, 0.5, 48000), 2);
  assert.equal(longestFit(1, 0.01, 48000), 0);
});

test('a loop keeps its phase from the bar it started on', () => {
  assert.equal(loopPhase(6, 4), 2);
  assert.equal(loopPhase(0, 4), 0);
  assert.equal(loopPhase(-1, 4), 3);
  assert.equal(sounds(5.9, { start: 6 }), false);
  assert.equal(sounds(6, { start: 6 }), true);
  assert.equal(sounds(9, { start: 6, stopAt: 10 }), true);
  assert.equal(sounds(10, { start: 6, stopAt: 10 }), false);
});

test('puts snapshots in their slots, newest first when two want the same one', () => {
  const list = [
    { id: 'aa', slot: 0, updatedAt: 1 },
    { id: 'bb', slot: 0, updatedAt: 2 },
    { id: 'cc', slot: 3, updatedAt: 3 },
    { id: 'dd', slot: null, updatedAt: 4 },
  ];
  const { slots, left } = arrange(list);
  assert.equal(slots.length, SLOTS);
  assert.equal(slots[0], 'bb');
  assert.equal(slots[3], 'cc');
  assert.deepEqual(slots.filter(Boolean).sort(), ['aa', 'bb', 'cc', 'dd']);
  assert.deepEqual(left, []);
  assert.equal(firstFree(slots), 4);

  const full = Array.from({ length: SLOTS + 1 }, (_, i) => ({ id: `s${i}`, slot: i % SLOTS, updatedAt: i }));
  const crowded = arrange(full);
  assert.equal(crowded.left.length, 1);
  assert.equal(firstFree(crowded.slots), -1);
});

test('names and keys', () => {
  assert.equal(cleanName('  Low   end \n'), 'Low end');
  assert.equal(cleanName('x'.repeat(100)).length, 60);
  assert.equal(describe({ name: 'Chords', bars: 1 }), 'Chords · 1 bar');
  assert.equal(describe({ name: 'Chords', bars: 4 }), 'Chords · 4 bars');
  assert.equal(SLOT_KEYS.length, SLOTS);
  assert.equal(new Set(SLOT_KEYS).size, SLOTS);
  // none of the keys the deck already uses
  for (const key of SLOT_KEYS) assert.ok(!'qweasdxmfgrvb[]? '.includes(key), key);
});

test('splits a recording into chunks and puts it back together', () => {
  const bytes = new Uint8Array(CHUNK_BYTES * 2 + 5).map((_, i) => i % 251);
  const chunks = toChunks(bytes);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.length, chunkCount(bytes.length));
  assert.equal(chunks[2].length, 5);
  assert.deepEqual(fromChunks(chunks), bytes);
  assert.equal(chunkCount(10), 1);
});

test('accepts a snapshot record only in its own shape', () => {
  const good = {
    id: newSnapId(),
    name: '  Night bass ',
    track: 'BASS',
    songTitle: 'Invented Song',
    bars: 4,
    cps: 0.5,
    sampleRate: 48000,
    frames: 384000,
    slot: 2,
    pinned: 'A',
    createdAt: 1,
    updatedAt: 2,
    chunks: 2,
    extra: 'dropped',
  };
  const clean = cleanSnapshot(good);
  assert.equal(clean.name, 'Night bass');
  assert.equal(clean.pinned, 'A');
  assert.equal('extra' in clean, false);
  assert.match(good.id, /^[0-9a-f]{20}$/);

  assert.equal(cleanSnapshot({ ...good, bars: 3 }), null);
  assert.equal(cleanSnapshot({ ...good, id: '../x' }), null);
  assert.equal(cleanSnapshot({ ...good, frames: 48000 * 31 }), null);
  assert.equal(cleanSnapshot({ ...good, chunks: 9 }), null);
  assert.equal(cleanSnapshot({ ...good, slot: 8 }).slot, null);
  assert.equal(cleanSnapshot({ ...good, pinned: 'C' }).pinned, null);
  assert.equal(cleanSnapshot({ ...good, name: '' }).name, 'Snapshot');
});
