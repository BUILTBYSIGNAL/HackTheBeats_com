import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { createAnalyzer } from '../../js/analyze-core.js';
import { createLibrary } from '../../js/library-core.js';
import { orderBeats, freshSlug, newBeat, featuredBeats, featuredOf, featuredIds, audienceOf, publicEntries, buildCatalog, lockedSong, beatsFromExport } from '../../js/beats-core.js';

const library = createLibrary(createAnalyzer(parse));
const describe = (beat) => library.describeSong({ id: beat.id || 'x', code: beat.code }, 'beats');
const song = (title, extra = '') => `/*\n  @title ${title}\n  ${extra}\n*/\nsetcps(120/60/4)\nconst cut = slider(800, 200, 4000)\nDRUMS: s("bd*4").lpf(cut)\nBASS: note("a1").s("sawtooth")`;

test('a new beat gets its own address and goes last', () => {
  assert.equal(freshSlug('Amber', ['amber', 'amber-2']), 'amber-3');
  assert.equal(freshSlug('???', []), 'beat');
  const first = newBeat({ id: 'a', code: song('Amber'), title: 'Amber' }, [], 1000);
  assert.deepEqual([first.slug, first.order, first.featured, first.hidden, 'by' in first], ['amber', 1, true, false, false]);
  const second = newBeat({ id: 'b', code: song('Amber'), title: 'Amber', by: 'Someone' }, [first], 2000);
  assert.deepEqual([second.slug, second.order, second.featured, second.by], ['amber-2', 2, false, 'Someone']);
  // one published from the admin's own song remembers which
  const third = newBeat({ id: 'c', code: song('Cobalt'), title: 'Cobalt', song: 'song-1' }, [first, second], 3000);
  assert.deepEqual([third.song, 'song' in second], ['song-1', false]);
});

test('at least one beat is featured; a beat is the admin\'s own until it is opened to members', () => {
  const beats = [
    { id: 'a', order: 2, featured: false, hidden: false },
    { id: 'b', order: 1, featured: false, hidden: false, members: true },
    { id: 'c', order: 3, featured: true, hidden: false },
    { id: 'd', order: 4, featured: false, hidden: true, members: true },
  ];
  assert.equal(featuredOf(beats).id, 'c');
  assert.equal(featuredOf(beats.map((beat) => ({ ...beat, featured: false }))).id, 'b');
  assert.equal(featuredOf([]), null);
  assert.deepEqual(featuredBeats([]), []);
  assert.deepEqual(orderBeats(beats).map((beat) => beat.id), ['b', 'a', 'c', 'd']);
  assert.deepEqual(beats.map((beat) => audienceOf(beat, featuredIds(beats))), ['admin', 'members', 'everyone', 'admin']);
  // with none marked, the first beat is the featured one
  const none = beats.map((beat) => ({ ...beat, featured: false }));
  assert.deepEqual([...featuredIds(none)], ['b']);
});

test('several beats can be featured, in their order, and anyone may play each', () => {
  const beats = [
    { id: 'a', order: 3, featured: true, hidden: false },
    { id: 'b', order: 1, featured: false, hidden: false, members: true },
    { id: 'c', order: 2, featured: true, hidden: false, members: true },
  ];
  assert.deepEqual(featuredBeats(beats).map((beat) => beat.id), ['c', 'a']);
  assert.equal(featuredOf(beats).id, 'c');
  assert.deepEqual(beats.map((beat) => audienceOf(beat, featuredIds(beats))), ['everyone', 'members', 'everyone']);
  const catalog = buildCatalog(beats.map((beat) => ({ ...beat, code: song(beat.id), title: beat.id, slug: beat.id })), describe, 1);
  assert.deepEqual(catalog.beats.map((entry) => [entry.id, entry.featured, entry.members]), [['b', false, true], ['c', true, false], ['a', true, false]]);
  assert.deepEqual(publicEntries(catalog).map((entry) => entry.id), ['b', 'c', 'a']);
});

test('the catalog lists only what other people may play, in order, without any code', () => {
  const beats = [];
  for (const [id, title, extra] of [['a', 'Amber', 'F minor.'], ['b', 'Mine alone', ''], ['c', 'Relay', 'voice: 0 none, 1 vox']]) {
    beats.push(newBeat({ id, code: song(title, extra), title }, beats, 1000));
  }
  assert.deepEqual(beats.map((beat) => [beat.featured, beat.members]), [[true, false], [false, false], [false, false]]);
  beats[2].members = true;
  const catalog = buildCatalog(beats, describe, 5000);
  assert.deepEqual(catalog.beats.map((entry) => [entry.id, entry.slug, entry.featured, entry.members]), [['a', 'amber', true, false], ['c', 'relay', false, true]]);
  assert.equal(catalog.updatedAt, 5000);
  assert.equal(JSON.stringify(catalog).includes('setcps'), false);
  const [amber] = catalog.beats;
  assert.deepEqual([amber.bpm, amber.trackCount, amber.knobCount, amber.by], [120, 2, 1, null]);
  assert.match(amber.description, /^Amber: a 120 bpm live-coded beat in 2 tracks\. F minor\./);

  const locked = lockedSong(catalog.beats[1]);
  assert.deepEqual([locked.locked, locked.code, locked.title, locked.source, locked.slug], [true, '', 'Relay', 'beats', 'relay']);

  // a catalog from before beats could be the admin's own lists them without a say-so
  const old = { beats: [{ id: 'a', featured: true }, { id: 'b', featured: false }, { id: 'c', featured: false, members: true }] };
  assert.deepEqual(publicEntries(old).map((entry) => entry.id), ['a', 'c']);
  assert.deepEqual(publicEntries(null), []);
});

test('an export file becomes beats, skipping what is already published and empty patterns', () => {
  const existing = [newBeat({ id: 'a', code: song('Amber'), title: 'Amber' }, [], 1000)];
  const file = JSON.stringify({
    a: { code: song('Amber again'), created_at: 5 },
    late: { code: song('Later'), created_at: 300 },
    early: { code: 's("bd")', created_at: 100, title: 'First Sketch', by: 'Someone' },
    empty: { code: '   ', created_at: 200 },
  });
  const added = beatsFromExport(file, existing, describe, 9000);
  assert.deepEqual(added.map((beat) => [beat.id, beat.title, beat.slug, beat.order, beat.featured, beat.by]), [
    ['early', 'First Sketch', 'first-sketch', 2, false, 'Someone'],
    ['late', 'Later', 'later', 3, false, undefined],
  ]);
});
