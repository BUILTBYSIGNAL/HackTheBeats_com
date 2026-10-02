import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { createAnalyzer } from '../../js/analyze-core.js';
import { collect, createLibrary } from '../../js/library-core.js';
import { slugify, assignSlugs, beatPath, slugFromPath, songTitle, songDescription } from '../../js/routes-core.js';

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
  assert.equal(songTitle({ title: 'Clockwork', by: 'Someone' }), 'Clockwork by Someone — Hacking the Beats');
  assert.equal(songTitle({ title: 'Amber', by: null }), 'Amber — Hacking the Beats');
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
