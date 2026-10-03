import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELF_MAX, BLURB_MAX, eligibleForShelf, communityEntry, shelfEntry, shelfLine } from '../../js/community-core.js';

const SHARE = '00000000-0000-4000-8000-0000000000c1';
const offered = { id: 'song-id-1', owner: 'uid-1', code: 's("bd*4")', title: 'Paper Lanterns', ownerName: 'Rowan', shared: true, featurable: true, blocked: false, shareId: SHARE };
// a stand-in for the song analyser: what the code says about itself
const describe = () => ({ title: 'Paper Lanterns', by: 'Ana', bpm: 121.6, trackCount: 3, notes: ['A slow walk home.', 'mood: 0 minor, 1 major'] });

test('the shelf holds at most 48 songs', () => {
  assert.equal(SHELF_MAX, 48);
});

test('only a song its owner offered, shared and not switched off, can go on the shelf', () => {
  assert.equal(eligibleForShelf(offered), true);
  assert.equal(eligibleForShelf({ ...offered, featurable: false }), false);
  assert.equal(eligibleForShelf({ ...offered, featurable: undefined }), false);
  assert.equal(eligibleForShelf({ ...offered, shared: false }), false);
  assert.equal(eligibleForShelf({ ...offered, blocked: true }), false);
  assert.equal(eligibleForShelf({ ...offered, shareId: null }), false);
  assert.equal(eligibleForShelf(null), false);
  // by its current link only: an older link stays off the shelf
  assert.equal(eligibleForShelf(offered, SHARE), true);
  assert.equal(eligibleForShelf(offered, '00000000-0000-4000-8000-0000000000c2'), false);
  assert.equal(eligibleForShelf({ ...offered, shareId: null }, SHARE), true);
});

test("an entry says what the song's link shows, and never its code, account or id", () => {
  const entry = communityEntry(offered, describe, 1234);
  assert.deepEqual(entry, { title: 'Paper Lanterns', by: 'Ana', ownerName: 'Rowan', bpm: 122, trackCount: 3, blurb: 'A slow walk home.', featuredAt: 1234 });
  const said = JSON.stringify(entry);
  for (const secret of ['s("bd', 'uid-1', 'song-id-1', SHARE]) assert.ok(!said.includes(secret), secret);
});

test('what the code does not say is left out', () => {
  const entry = communityEntry({ shared: true, title: '', ownerName: '' }, () => ({ title: 'Untitled', notes: [] }), 5);
  assert.deepEqual(entry, { title: 'Untitled', featuredAt: 5 });
});

test(`the blurb is the header notes, at most ${BLURB_MAX} characters`, () => {
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const entry = communityEntry(offered, () => ({ notes: [long] }), 1);
  assert.ok(entry.blurb.length <= BLURB_MAX, String(entry.blurb.length));
  assert.ok(entry.blurb.endsWith('…'));
});

test('a remix credits its original by title and who made it, and nothing more', () => {
  const from = { title: 'Glass Tide', by: 'Ana', ownerName: 'Rowan', shareId: SHARE, beat: 'glass-tide' };
  assert.deepEqual(communityEntry({ ...offered, from }, describe, 1).from, { title: 'Glass Tide', by: 'Ana' });
  assert.deepEqual(communityEntry({ ...offered, from: { title: 'Glass Tide', ownerName: 'Rowan', shareId: SHARE } }, describe, 1).from, { title: 'Glass Tide', ownerName: 'Rowan' });
  assert.deepEqual(communityEntry({ ...offered, from: { title: 'Glass Tide', beat: 'glass-tide' } }, describe, 1).from, { title: 'Glass Tide' });
  assert.equal('from' in communityEntry({ ...offered, from: { by: 'no title' } }, describe, 1), false);
});

test('an entry read back from the database is checked over', () => {
  const entry = shelfEntry(SHARE, { title: 'Paper Lanterns', ownerName: 'Rowan', bpm: 120, trackCount: 2, blurb: 'x'.repeat(400), from: { title: 'Glass Tide', owner: 'uid-9' }, featuredAt: 9, code: 'nope' });
  assert.equal(entry.shareId, SHARE);
  assert.equal(entry.blurb.length, BLURB_MAX);
  assert.deepEqual(entry.from, { title: 'Glass Tide' });
  assert.equal(entry.by, null);
  assert.equal('code' in entry, false);
  assert.equal(shelfEntry('not-a-link', { title: 'x' }), null);
  assert.equal(shelfEntry(SHARE, { title: '' }), null);
});

test('the song list says who made it, who shared it, its tempo and what it is a remix of', () => {
  assert.equal(shelfLine({ by: 'Ana', ownerName: 'Rowan', bpm: 120, from: { title: 'Glass Tide', by: 'Kit' } }), 'by Ana · shared by Rowan · 120 bpm · remix of Glass Tide');
  assert.equal(shelfLine({ by: 'Rowan', ownerName: 'Rowan', bpm: null, from: null }), 'by Rowan');
  assert.equal(shelfLine({ ownerName: 'Rowan' }), 'shared by Rowan');
});
