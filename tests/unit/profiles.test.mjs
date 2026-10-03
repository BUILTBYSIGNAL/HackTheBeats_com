import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEEN_EVERY, profileFrom, sameProfile, cleanProfile, peopleFrom, privateCount } from '../../js/profiles-core.js';

const DAY = SEEN_EVERY;

test('a profile counts the songs and how many are shared, and notes a visit once a day', () => {
  const mine = [{ shared: true }, { shared: false }, { shared: false }];
  const first = profileFrom('Ada Example', mine, null, 1000);
  assert.deepEqual(first, { name: 'Ada Example', joinedAt: 1000, seenAt: 1000, songs: 3, shared: 1 });
  // later the same day: nothing new to say
  const again = profileFrom('Ada Example', mine, first, 1000 + DAY / 2);
  assert.equal(sameProfile(first, again), true);
  // a song more: the counts change, the visit does not
  const more = profileFrom('Ada Example', [...mine, { shared: true }], first, 1000 + DAY / 2);
  assert.deepEqual([more.songs, more.shared, more.seenAt, more.joinedAt], [4, 2, 1000, 1000]);
  // a day on, the visit is noted; when they joined never changes
  const next = profileFrom('Ada Example', mine, first, 1000 + DAY);
  assert.deepEqual([next.seenAt, next.joinedAt, sameProfile(first, next)], [1000 + DAY, 1000, false]);
  assert.equal(profileFrom('', [], null, 5).name, '');
  assert.equal(profileFrom('x'.repeat(300), [], null, 5).name.length, 200);
  assert.equal(sameProfile(null, first), false);
});

test('a profile read back is made safe to show', () => {
  assert.deepEqual(cleanProfile('u1', { name: 7, joinedAt: '12', seenAt: null, songs: -3, shared: 2 }), { uid: 'u1', name: '', joinedAt: 12, seenAt: 0, songs: 0, shared: 2 });
  assert.deepEqual(cleanProfile('u2', undefined), { uid: 'u2', name: '', joinedAt: 0, seenAt: 0, songs: 0, shared: 0 });
});

test('people are listed by their last visit, each with the songs they share', () => {
  const profiles = [cleanProfile('a', { name: 'Ada', joinedAt: 1, seenAt: 50, songs: 5, shared: 2 }), cleanProfile('b', { name: 'Bo', joinedAt: 2, seenAt: 90, songs: 0, shared: 0 })];
  const shared = [
    { id: 's1', owner: 'a', ownerName: 'Ada', updatedAt: 10 },
    { id: 's2', owner: 'a', ownerName: 'Ada', updatedAt: 30 },
    // someone who has not been back since profiles began
    { id: 's3', owner: 'c', ownerName: 'Cy', updatedAt: 20 },
  ];
  const people = peopleFrom(profiles, shared);
  assert.deepEqual(people.map((person) => [person.uid, person.profiled, person.sharedSongs.map((song) => song.id).join()]), [
    ['b', true, ''],
    ['a', true, 's2,s1'],
    ['c', false, 's3'],
  ]);
  assert.deepEqual(people.map(privateCount), [0, 3, 0]);
  assert.equal(people[2].name, 'Cy');
});
