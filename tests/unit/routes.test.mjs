import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { createAnalyzer } from '../../js/analyze-core.js';
import { collect, createLibrary } from '../../js/library-core.js';
import { slugify, assignSlugs, beatPath, slugFromPath, songTitle, songDescription, creditLine, remixLine, songLinkIn, sharePath, shareIdFromPath, startFromHash } from '../../js/routes-core.js';

const library = createLibrary(createAnalyzer(parse));

test('a title becomes a plain address', () => {
  assert.equal(slugify('Low Tide 2 (night mix)'), 'low-tide-2-night-mix');
  assert.equal(slugify('  Café & Crème  '), 'cafe-and-creme');
  assert.equal(slugify('!!!'), '');
});

test('no two songs share an address', () => {
  const songs = assignSlugs([{ title: 'Amber' }, { title: 'amber' }, { title: '???' }, { title: 'Amber!' }]);
  assert.deepEqual(songs.map((song) => song.slug), ['amber', 'amber-2', 'beat', 'amber-3']);
});

test('an address leads back to its song, and nothing else looks like one', () => {
  assert.equal(slugFromPath(beatPath('low-tide')), 'low-tide');
  assert.equal(slugFromPath('/beats/low-tide/'), 'low-tide');
  for (const path of ['/', '/about', '/beats/', '/beats/songs.json', '/beats/a/b', '/beats/UPPER']) assert.equal(slugFromPath(path), null, path);
});

test('a page title carries the credit', () => {
  assert.equal(songTitle({ title: 'Clockwork', by: 'Someone' }), 'Clockwork by Someone — Hack The Beats');
  assert.equal(songTitle({ title: 'Amber', by: null }), 'Amber — Hack The Beats');
});

test('a description is built from what the song says about itself', () => {
  const text = songDescription({ title: 'Low Tide', bpm: 140, trackCount: 7, notes: ['Loops every 32 cycles.', 'scene: 0 intro, 1 groove'] });
  assert.match(text, /^Low Tide: a 140 bpm live-coded beat in 7 tracks\. Loops every 32 cycles\. /);
  assert.doesNotMatch(text, /scene:/);
  // the tempo is not said twice
  assert.doesNotMatch(songDescription({ title: 'X', bpm: 140, trackCount: 1, notes: ['140 bpm, F minor.'] }), /a 140 bpm/);
  // a long header is cut at a word, not mid-way
  const long = songDescription({ title: 'X', bpm: null, trackCount: 0, notes: ['word '.repeat(80)] });
  assert.ok(long.length < 260, String(long.length));
  assert.match(long, /word… Play it/);
});

test('the same pattern exported twice is one song, the newest copy', () => {
  const older = JSON.stringify({ a: { code: '/* @title One */\ns("bd")', created_at: 1000 }, b: { code: '   ', created_at: 2000 } });
  const newer = JSON.stringify({ a: { code: '/* @title One, again */\ns("bd*2")', created_at: '2026-02-01T00:00:00Z' }, c: { code: 's("hh")', created_at: 1500 } });
  const entries = collect([
    { file: 'new.json', text: newer },
    { file: 'old.json', text: older },
    { file: 'Loose Song.strudel', text: 's("cp")' },
    { file: 'broken.json', text: '{' },
  ]);
  assert.deepEqual(entries.map((entry) => entry.id), ['file:Loose Song.strudel', 'c', 'a']);
  const songs = library.describeAll(entries, { c: { title: 'Hats', by: 'Someone' } });
  assert.deepEqual(songs.map((song) => [song.title, song.slug, song.by]), [
    ['Loose Song', 'loose-song', null],
    ['Hats', 'hats', 'Someone'],
    ['One, again', 'one-again', null],
  ]);
});

test('a credit line names who wrote it, who shared it (when someone else), and its tempo', () => {
  assert.equal(creditLine({ by: 'Ana', ownerName: 'Rowan', bpm: 120.4 }), 'by Ana · shared by Rowan · 120 bpm');
  assert.equal(creditLine({ by: 'Rowan', ownerName: 'Rowan', bpm: 90 }), 'by Rowan · 90 bpm');
  assert.equal(creditLine({ ownerName: 'Rowan' }), 'shared by Rowan');
  assert.equal(creditLine({}), '');
});

test('a remix names its original', () => {
  assert.equal(remixLine({ title: 'Glass Tide', by: 'Ana', ownerName: 'Rowan' }), 'Remix of "Glass Tide" by Ana');
  assert.equal(remixLine({ title: 'Glass Tide', ownerName: 'Rowan' }), 'Remix of "Glass Tide" by Rowan');
  assert.equal(remixLine({ title: 'Glass Tide' }), 'Remix of "Glass Tide"');
  assert.equal(remixLine(null), '');
});

test('a shared song is found in its link', () => {
  const uuid = '0b9c7a1e-4f3d-4c2b-9a8e-1d2c3b4a5f6e';
  assert.deepEqual(songLinkIn({ hash: `#song=${uuid}` }), { kind: 'song', raw: uuid, share: uuid, form: 'hash' });
  assert.deepEqual(songLinkIn({ hash: `#copy=${uuid}` }), { kind: 'copy', raw: uuid, share: uuid, form: 'hash' });
  assert.deepEqual(songLinkIn({ hash: '#song=owner1~song1' }), { kind: 'song', raw: 'owner1~song1', owner: 'owner1', id: 'song1', form: 'hash' });
  assert.deepEqual(songLinkIn({ pathname: sharePath(uuid) }), { kind: 'song', raw: uuid, share: uuid, form: 'path' });
  assert.equal(songLinkIn({ hash: '#mix=abc' }), null);
  assert.equal(songLinkIn({}), null);
});

test("a shared song's own address is /s/<uuid>, and nothing else is taken for one", () => {
  const uuid = '0b9c7a1e-4f3d-4c2b-9a8e-1d2c3b4a5f6e';
  assert.equal(sharePath(uuid), `/s/${uuid}`);
  assert.equal(shareIdFromPath(`/s/${uuid}`), uuid);
  assert.equal(shareIdFromPath(`/s/${uuid}/`), uuid);
  for (const path of ['/s/', '/s/hello', `/s/${uuid.toUpperCase()}`, `/s/${uuid}/card.png`, `/x/${uuid}`, '/']) assert.equal(shareIdFromPath(path), null, path);
});

test('an example from the guide is found in its link', () => {
  assert.equal(startFromHash('#start=techno'), 'techno');
  assert.equal(startFromHash('#x=1&start=code-becomes-controls'), 'code-becomes-controls');
  assert.equal(startFromHash('#song=abc'), null);
  assert.equal(startFromHash(''), null);
  assert.equal(startFromHash(undefined), null);
  // only plain lower-case ids: nothing else is taken for one
  assert.equal(startFromHash('#start=Techno'), null);
  assert.equal(startFromHash('#start=../x'), null);
});
