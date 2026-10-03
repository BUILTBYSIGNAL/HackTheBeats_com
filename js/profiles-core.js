// A person's profile: what the admin's People list says about an account, and no more.
// Plain logic with no browser in it: the site and the tests both use it.
//
//   users/{uid}   { name, joinedAt, seenAt, songs, shared }
//
// `songs` is how many songs the account holds and `shared` how many of them are shared.
// Of a person's songs the admin only ever reads the shared ones (firestore.rules); the
// rest are a number here.

// A visit is noted at most once a day, so a profile is rarely written.
export const SEEN_EVERY = 24 * 60 * 60 * 1000;

// The profile for `name`, holding `mine` (their songs), from the one saved before (or null).
export function profileFrom(name, mine, previous, now = Date.now()) {
  return {
    name: String(name || '').slice(0, 200),
    joinedAt: previous?.joinedAt || now,
    seenAt: previous?.seenAt && now - previous.seenAt < SEEN_EVERY ? previous.seenAt : now,
    songs: mine.length,
    shared: mine.filter((song) => song.shared).length,
  };
}

export const sameProfile = (a, b) => Boolean(a && b) && ['name', 'joinedAt', 'seenAt', 'songs', 'shared'].every((key) => a[key] === b[key]);

// A profile as the database holds it, made safe to show.
export const cleanProfile = (uid, data) => ({
  uid,
  name: typeof data?.name === 'string' ? data.name : '',
  joinedAt: Number(data?.joinedAt) || 0,
  seenAt: Number(data?.seenAt) || 0,
  songs: Math.max(0, Number(data?.songs) || 0),
  shared: Math.max(0, Number(data?.shared) || 0),
});

// Everyone the People list shows, the most recent visit first: each profile, with the
// songs that person shares. Someone who shares a song but has not been back since profiles
// began has no profile yet, and is listed by the name on their songs.
export function peopleFrom(profiles, shared) {
  const byOwner = new Map();
  for (const song of shared) {
    if (!byOwner.has(song.owner)) byOwner.set(song.owner, []);
    byOwner.get(song.owner).push(song);
  }
  const people = profiles.map((profile) => ({ ...profile, profiled: true, sharedSongs: byOwner.get(profile.uid) || [] }));
  const known = new Set(profiles.map((profile) => profile.uid));
  for (const [uid, songs] of byOwner) {
    if (known.has(uid)) continue;
    people.push({ uid, name: songs.find((song) => song.ownerName)?.ownerName || '', joinedAt: 0, seenAt: 0, songs: songs.length, shared: songs.length, profiled: false, sharedSongs: songs });
  }
  for (const person of people) person.sharedSongs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return people.sort((a, b) => b.seenAt - a.seenAt || (b.sharedSongs[0]?.updatedAt || 0) - (a.sharedSongs[0]?.updatedAt || 0));
}

// How many of a person's songs the admin cannot see.
export const privateCount = (person) => Math.max(0, person.songs - person.shared);
