import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { titleOf, withTitle, uniqueTitle, mergeSongs, toExport, fromImport, templateSong, STARTERS, newId, newUuid, isUuid, cleanFrom, fromOf, isLive } from '../../js/songs-core.js';

test('reads a title from the code', () => {
  assert.equal(titleOf('/*\n  @title Amber\n*/\ns("bd")'), 'Amber');
  assert.equal(titleOf('// "coastline" @by eddyflux\ns("bd")'), 'coastline');
  assert.equal(titleOf('s("bd")'), null);
});

test('renaming rewrites or adds the @title line', () => {
  assert.equal(withTitle('/*\n  @title Amber\n  notes\n*/\ns("bd")', 'Crystal'), '/*\n  @title Crystal\n  notes\n*/\ns("bd")');
  assert.equal(withTitle('// "coastline" @by eddyflux\ns("bd")', 'shore'), '// "shore" @by eddyflux\ns("bd")');
  assert.equal(titleOf(withTitle('/*\n  some notes\n*/\ns("bd")', 'Named')), 'Named');
  assert.equal(titleOf(withTitle('s("bd")', 'Named')), 'Named');
  // a title cannot break out of its comment, and "$" is taken literally
  assert.equal(titleOf(withTitle('s("bd")', 'a */ b $1')), 'a  b $1');
});

test('finds a free title', () => {
  assert.equal(uniqueTitle('Amber', ['Other']), 'Amber');
  assert.equal(uniqueTitle('Amber', ['Amber']), 'Amber 2');
  assert.equal(uniqueTitle('Amber', ['Amber', 'Amber 2']), 'Amber 3');
});

test('the starter song carries its title', () => {
  assert.equal(titleOf(templateSong('New song')), 'New song');
});

test('every starter is a song that parses, with its title and a tempo', () => {
  assert.deepEqual(STARTERS.map((starter) => starter.kind), ['loop', 'full']);
  for (const { kind, label, blurb } of STARTERS) {
    const code = templateSong('Fresh start', kind);
    assert.ok(label && blurb, kind);
    assert.equal(titleOf(code), 'Fresh start', kind);
    assert.match(code, /setcps\(/, kind);
    assert.doesNotThrow(() => parse(code, { ecmaVersion: 2022 }), kind);
  }
  // the full song is still what New made before there was a choice
  assert.equal(templateSong('Fresh start'), templateSong('Fresh start', 'full'));
});

test('ids are long and varied', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newId()));
  assert.equal(ids.size, 200);
  assert.match(newId(), /^[A-Za-z0-9]{12}$/);
});

const song = (id, updatedAt, extra = {}) => ({ id, code: `// ${id}`, updatedAt, ...extra });

test('signing in: songs made while signed out join the account', () => {
  const { songs, upload, dropped } = mergeSongs([song('a', 5)], [], 'me');
  assert.deepEqual(songs.map((s) => [s.id, s.owner, s.synced]), [['a', 'me', false]]);
  assert.deepEqual(upload.map((s) => s.id), ['a']);
  assert.deepEqual(dropped, []);
});

test("signing in: the account's songs arrive in the browser", () => {
  const { songs, upload } = mergeSongs([], [song('r', 9)], 'me');
  assert.deepEqual(songs.map((s) => [s.id, s.owner, s.synced]), [['r', 'me', true]]);
  assert.deepEqual(upload, []);
});

test('signing in: the newer copy of a song wins', () => {
  const local = [song('x', 10, { code: 'local', owner: 'me', synced: false }), song('y', 1, { code: 'old', owner: 'me', synced: true })];
  const remote = [song('x', 4, { code: 'remote' }), song('y', 8, { code: 'newer' })];
  const { songs, upload } = mergeSongs(local, remote, 'me');
  assert.equal(songs.find((s) => s.id === 'x').code, 'local');
  assert.equal(songs.find((s) => s.id === 'y').code, 'newer');
  assert.deepEqual(upload.map((s) => s.id), ['x']);
});

test('signing in: a song deleted on another device is dropped here', () => {
  const { songs, dropped } = mergeSongs([song('gone', 3, { owner: 'me', synced: true })], [], 'me');
  assert.deepEqual(songs, []);
  assert.deepEqual(dropped, ['gone']);
});

test("signing in: another account's leftovers are not taken over", () => {
  const { songs, upload } = mergeSongs([song('theirs', 3, { owner: 'someone-else', synced: false })], [], 'me');
  assert.deepEqual(songs.map((s) => s.owner), ['someone-else']);
  assert.deepEqual(upload, []);
});

test('exports in strudel.cc format and reads it back', () => {
  const exported = toExport([{ id: 'abc', code: 's("bd")', createdAt: 123 }]);
  assert.deepEqual(exported, { abc: { id: 'abc', code: 's("bd")', created_at: 123, collection: 'user' } });
  assert.deepEqual(fromImport(JSON.stringify(exported), 'songs.json'), [{ code: 's("bd")', createdAt: 123 }]);
});

test('imports a single song as text, and skips empty patterns', () => {
  assert.equal(fromImport('s("bd*4")', 'beat.strudel').length, 1);
  assert.equal(fromImport('', 'beat.strudel').length, 0);
  assert.equal(fromImport(JSON.stringify({ a: { code: '' }, b: { code: 's("hh")' } }), 'x.json').length, 1);
  assert.deepEqual(fromImport('{ not json', 'x.json'), []);
});

test('a share link id is a UUID, different every time', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newUuid()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.ok(isUuid(id), id);
  assert.equal(isUuid('jo8RMFi2fB80t4ayPry5rT3pi9M3~VMpOXxe5Rv3B'), false);
  assert.equal(isUuid('3f2b8c1e-9a4d-4c7b-8e21-0a1b2c3d4e5f'), true);
});

test('a copy remembers where it came from, and nothing private about it', () => {
  const uuid = '0b9c7a1e-4f3d-4c2b-9a8e-1d2c3b4a5f6e';
  assert.deepEqual(fromOf({ source: 'shared', title: 'Glass Tide', by: 'Ana', ownerName: 'Rowan', shareId: uuid, owner: 'uid-1', id: 'song-1' }), { title: 'Glass Tide', by: 'Ana', ownerName: 'Rowan', shareId: uuid });
  assert.deepEqual(fromOf({ source: 'beats', title: 'Amber', by: 'SIGNAL', slug: 'amber', id: 'beat-1' }), { title: 'Amber', by: 'SIGNAL', beat: 'amber' });
  // a copy of my own remix still credits the original
  assert.deepEqual(fromOf({ source: 'mine', title: 'Glass Tide 2', from: { title: 'Glass Tide', ownerName: 'Rowan' } }), { title: 'Glass Tide', ownerName: 'Rowan' });
  assert.equal(fromOf({ source: 'mine', title: 'Mine' }), null);
});

test('where a copy came from is trimmed to what the rules allow', () => {
  assert.deepEqual(cleanFrom({ title: '  Glass Tide ', owner: 'uid-1', id: 'x', extra: 1, by: '' }), { title: 'Glass Tide' });
  assert.equal(cleanFrom({ title: 'x'.repeat(500) }).title.length, 200);
  for (const junk of [null, 'Glass Tide', {}, { title: '   ' }, { title: 3 }]) assert.equal(cleanFrom(junk), null);
});

test('a shared song is live only while it is shared by the link that led to it', () => {
  assert.equal(isLive({ shared: true, shareId: 'a' }, 'a'), true);
  assert.equal(isLive({ shared: true }, 'a'), true);
  assert.equal(isLive({ shared: true, shareId: 'b' }, 'a'), false);
  assert.equal(isLive({ shared: false, shareId: 'a' }, 'a'), false);
  assert.equal(isLive({ shared: true, blocked: true }, null), false);
  assert.equal(isLive(null), false);
});
