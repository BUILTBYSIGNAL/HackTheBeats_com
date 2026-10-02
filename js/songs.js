// "My songs": the listener's own songs. They live in the browser; when someone is signed
// in they are also kept in that person's account and follow them between devices.
import { describeSong } from './library.js';
import { cloud } from './cloud.js';
import { config, site } from './config.js';
import { newId, newUuid, titleOf, withTitle, uniqueTitle, templateSong, mergeSongs, toExport, fromImport, fromOf, cleanFrom } from './songs-core.js';
import { sharePath } from './routes-core.js';

const KEY = 'hacking-the-beats:songs';
const UPLOAD_DELAY = 1500;

// id → { id, code, createdAt, updatedAt, mixer, shared, shareId, owner, synced, blocked, from, featurable }
const records = new Map();
const described = new Map();
const listeners = new Set();
const uploads = new Map();
let statusListener = () => {};
// resolves when the last sign-in or sign-out has been dealt with
let syncing = Promise.resolve();

function read() {
  try {
    for (const record of JSON.parse(localStorage.getItem(KEY)) || []) if (record?.id && typeof record.code === 'string') records.set(record.id, record);
  } catch {
    /* nothing saved, or storage unavailable */
  }
}
function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...records.values()]));
    return true;
  } catch {
    statusListener('This browser would not save the song (storage is full or blocked).');
    return false;
  }
}
const changed = (reason, id) => listeners.forEach((fn) => fn(reason, id));

async function upload(id) {
  clearTimeout(uploads.get(id));
  uploads.delete(id);
  const record = records.get(id);
  if (!record || !cloud.user || record.owner !== cloud.user.uid) return;
  try {
    await cloud.saveSong({ ...record, title: titleOf(record.code) || 'Untitled' });
    // a shared song's link has to lead somewhere
    if (record.shared && record.shareId) await cloud.saveShare(record.shareId, id);
    if (records.get(id)?.updatedAt === record.updatedAt) {
      records.set(id, { ...records.get(id), synced: true });
      described.delete(id);
      write();
    }
    changed('synced', id);
  } catch (error) {
    // The account may have refused because the site switched this song's sharing off
    // since this browser last looked. Take that on board and send the song again.
    if (error?.code === 'permission-denied' && !record.blocked && (await adoptBlock(id))) return upload(id);
    console.warn('[songs] could not save to the account', error);
    statusListener('Could not save to your account just now. The song is safe in this browser and will be sent next time.');
  }
}

async function adoptBlock(id) {
  const remote = await cloud.getOwn(id).catch(() => null);
  const record = records.get(id);
  if (!remote?.blocked || !record) return false;
  records.set(id, { ...record, shared: false, blocked: true, featurable: false });
  described.delete(id);
  write();
  changed('updated', id);
  statusListener(`Sharing for "${titleOf(record.code) || 'Untitled'}" was switched off by the site.`);
  return true;
}

// Close a song's link. Its entry on the community shelf goes first: the owner's right to
// remove that comes from the link's own record (firestore.rules).
function closeLink(record) {
  const withdrawn = record.featurable ? cloud.unfeature(record.shareId).catch((error) => console.warn('[songs] could not withdraw it from the shelf', error)) : Promise.resolve();
  return withdrawn.then(() => cloud.deleteShare(record.shareId));
}

// Write one song to the account a moment after its last change.
function queueUpload(id) {
  if (!cloud.user) return;
  clearTimeout(uploads.get(id));
  uploads.set(id, setTimeout(() => upload(id), UPLOAD_DELAY));
}

read();

// The address of a shared song. Where the site has a separate player address, the link
// goes straight there.
// A link is a UUID made when sharing is switched on (and a new one each time), so it
// cannot be guessed and says nothing about whose song it is. Songs shared before links
// were UUIDs are still reached by their owner and id.
// With link previews on, a link is the player's own address for the song (/s/<uuid>), which
// unfurls with the song's title and picture.
const shareOrigin = () => (site.split ? config.shareOrigin : location.origin);
export const linkToShare = (shareId) => (config.linkPreviews ? `${shareOrigin()}${sharePath(shareId)}` : `${shareOrigin()}/#song=${shareId}`);
export const linkToShared = (owner, id) => `${shareOrigin()}/#song=${owner}~${id}`;
export const linkToSong = (song) => (song.shareId ? linkToShare(song.shareId) : linkToShared(song.owner, song.id));

export const songs = {
  onChange(fn) {
    listeners.add(fn);
  },
  onStatus(fn) {
    statusListener = fn;
  },

  // Songs as the rest of the app sees them, most recently changed first.
  list() {
    const uid = cloud.user?.uid ?? null;
    return [...records.values()]
      .filter((record) => !record.owner || record.owner === uid)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map((record) => this.describe(record));
  },
  get(id) {
    const record = records.get(id);
    return record ? this.describe(record) : null;
  },
  describe(record) {
    const cached = described.get(record.id);
    if (cached && cached.record === record) return cached.song;
    const song = { ...describeSong(record, 'mine'), mixer: record.mixer || null, shared: Boolean(record.shared), shareId: record.shareId || null, blocked: Boolean(record.blocked), featurable: Boolean(record.featurable), synced: Boolean(record.synced), owner: record.owner || null, from: cleanFrom(record.from), createdAt: record.createdAt, updatedAt: record.updatedAt };
    described.set(record.id, { record, song });
    return song;
  },

  put(record, reason) {
    records.set(record.id, record);
    write();
    queueUpload(record.id);
    changed(reason, record.id);
    return this.describe(record);
  },

  // `from` credits the song a copy was made from (songs-core.js fromOf).
  create({ code, mixer = null, createdAt = Date.now(), from = null }) {
    const uid = cloud.user?.uid ?? null;
    const credit = cleanFrom(from);
    return this.put({ id: newId(), code, mixer, createdAt, updatedAt: Date.now(), shared: false, owner: uid, synced: false, ...(credit ? { from: credit } : {}) }, 'created');
  },

  // A new song from one of the starters (songs-core.js STARTERS).
  createBlank(kind = 'full') {
    const title = uniqueTitle('New song', this.list().map((song) => song.title));
    return this.create({ code: templateSong(title, kind) });
  },

  // One's own copy of any song (a built-in beat, a shared song, or another of one's own).
  copyOf(song, code = song.code) {
    const title = uniqueTitle(song.source === 'mine' ? `${song.title} copy` : song.title, this.list().map((entry) => entry.title));
    return this.create({ code: withTitle(code, title), mixer: song.mixer || null, from: fromOf(song) });
  },

  update(id, patch) {
    const record = records.get(id);
    if (!record) return null;
    const next = { ...record, ...patch, updatedAt: Date.now(), synced: false };
    const same = (key) => JSON.stringify(next[key]) === JSON.stringify(record[key]);
    if (['code', 'mixer', 'shared', 'shareId', 'from', 'featurable'].every(same)) return this.describe(record);
    return this.put(next, 'updated');
  },

  rename(id, title) {
    const record = records.get(id);
    return record ? this.update(id, { code: withTitle(record.code, title) }) : null;
  },

  remove(id) {
    const record = records.get(id);
    if (!record) return;
    clearTimeout(uploads.get(id));
    uploads.delete(id);
    records.delete(id);
    described.delete(id);
    write();
    if (cloud.user && record.owner === cloud.user.uid) {
      if (record.shareId) closeLink(record).catch(() => {});
      cloud.deleteSong(id).catch((error) => {
        console.warn('[songs] could not delete from the account', error);
        statusListener('Could not delete the song from your account just now.');
      });
    }
    changed('removed', id);
  },

  // Sharing needs an account: the link points at the copy held there.
  setShared(id, shared) {
    if (!cloud.user) return null;
    if (shared && records.get(id)?.blocked) {
      statusListener('Sharing for this song was switched off by the site.');
      return null;
    }
    const record = records.get(id);
    if (!record) return null;
    if (shared) return this.update(id, { shared: true, shareId: record.shareId || newUuid() });
    // switching off forgets the link for good: sharing again makes a new one. It also
    // withdraws the song from the community shelf.
    if (record.shareId) closeLink(record).catch((error) => console.warn('[songs] could not remove the link', error));
    return this.update(id, { shared: false, shareId: null, featurable: false });
  },
  // Offer a shared song to the site's community shelf, or withdraw it. Only while it is
  // shared and the site has not switched it off; the editors decide whether to feature it.
  setFeaturable(id, on) {
    const record = records.get(id);
    if (!cloud.user || !record) return null;
    if (on && (!record.shared || !record.shareId || record.blocked)) return null;
    if (Boolean(record.featurable) === Boolean(on)) return this.describe(record);
    if (!on && record.shareId) cloud.unfeature(record.shareId).catch((error) => console.warn('[songs] could not withdraw it from the shelf', error));
    return this.update(id, { featurable: Boolean(on) });
  },
  shareLink(id) {
    const record = records.get(id);
    if (!record?.shared || !record.owner) return null;
    return linkToSong(record);
  },

  importText(text, filename) {
    const found = fromImport(text, filename);
    found.forEach(({ code, createdAt }) => this.create({ code, createdAt }));
    return found.length;
  },
  exportText() {
    return JSON.stringify(toExport(this.list()), null, 2);
  },

  // Send anything still waiting to the account now (before signing out, say).
  async flush() {
    await syncing;
    await Promise.all([...uploads.keys()].map((id) => upload(id)));
  },

  // Someone signed in or out.
  setUser(user) {
    syncing = syncing.then(() => this.follow(user)).catch((error) => console.warn('[songs] sync failed', error));
    return syncing;
  },

  async follow(user) {
    if (!user) {
      // signing out takes the account's songs with it; anything not yet saved there stays
      for (const record of [...records.values()]) {
        if (record.owner && record.synced) {
          records.delete(record.id);
          described.delete(record.id);
        }
      }
      write();
      changed('signed-out');
      return;
    }
    let remote;
    try {
      remote = await cloud.listSongs();
    } catch (error) {
      console.warn('[songs] could not read the account', error);
      statusListener('Could not reach your account. Your songs in this browser are still here.');
      changed('signed-in');
      return;
    }
    const merged = mergeSongs([...records.values()], remote, user.uid);
    records.clear();
    described.clear();
    for (const record of merged.songs) records.set(record.id, record);
    write();
    merged.upload.forEach((record) => queueUpload(record.id));
    // A song is saved with its owner's name beside it. One saved under another (an address
    // once stood in for a missing name) is written again, so its link shows today's.
    for (const song of remote) if (song.ownerName !== user.displayName && records.has(song.id)) queueUpload(song.id);
    changed('signed-in');
    if (merged.upload.length) statusListener(`${merged.upload.length} ${merged.upload.length === 1 ? 'song' : 'songs'} from this browser added to your account.`);
  },
};
