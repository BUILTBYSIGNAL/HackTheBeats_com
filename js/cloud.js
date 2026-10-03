// Accounts: Google sign-in and each person's songs, kept in Firebase. Everything here is
// optional — without a Firebase config (js/config.js) the site works as before and songs
// stay in the browser. The SDK is only loaded when accounts are configured.
//
// Layout in Firestore (see firestore.rules for who may read and write what):
//   users/{uid}/songs/{songId}   { code, title, createdAt, updatedAt, shared, mixer, ownerName, blocked?, shareId?, from?, featurable? }
//       private to its owner unless `shared`; an admin can switch sharing off (`blocked`)
//   users/{uid}/snapshots/{id}   a channel snapshot's record (snapshots-core.js), its owner's alone
//       …/chunks/{n}             { n, data }: the snapshot's WAV, in pieces under a megabyte
//   shares/{uuid}                what a share link points at: { owner, song }
//   community/{uuid}             a shared song the site features (community-core.js), no code
//   beats/{id}                   the site's beats (beats-core.js)
//   catalog/public               the beats' titles and descriptions, without their code
//   roles/admin                  not a document but a question: only an admin may ask for it
import { config, site } from './config.js';
import { cleanFrom } from './songs-core.js';
import { SHELF_MAX, shelfEntry } from './community-core.js';

let fb = null;
let auth = null;
let db = null;
const listeners = new Set();

// `name` is what the person themselves is shown; `displayName` is what goes next to a song
// they share, so it never falls back to their address.
const profile = (user) =>
  user ? { uid: user.uid, name: user.displayName || user.email || 'You', displayName: (user.displayName || '').slice(0, 200), email: user.email || '', photo: user.photoURL || '' } : null;

const fromDoc = (id, data) => ({
  id,
  code: typeof data.code === 'string' ? data.code : '',
  createdAt: Number(data.createdAt) || 0,
  updatedAt: Number(data.updatedAt) || 0,
  shared: data.shared === true,
  mixer: Array.isArray(data.mixer) ? data.mixer : null,
  ownerName: typeof data.ownerName === 'string' ? data.ownerName : '',
  blocked: data.blocked === true,
  shareId: typeof data.shareId === 'string' ? data.shareId : null,
  from: cleanFrom(data.from),
  featurable: data.featurable === true,
});

// The database said no (or there is nothing there), as opposed to not answering at all.
const refused = (error) => ['permission-denied', 'not-found', 'invalid-argument'].includes(error?.code);

const beatFromDoc = (id, data) => ({
  id,
  code: typeof data.code === 'string' ? data.code : '',
  title: typeof data.title === 'string' ? data.title : 'Untitled',
  by: typeof data.by === 'string' && data.by ? data.by : null,
  slug: typeof data.slug === 'string' ? data.slug : id,
  order: Number(data.order) || 0,
  featured: data.featured === true,
  members: data.members === true && data.hidden !== true,
  hidden: data.hidden === true,
  song: typeof data.song === 'string' && data.song ? data.song : null,
  createdAt: Number(data.createdAt) || 0,
  updatedAt: Number(data.updatedAt) || 0,
});
const beatToDoc = ({ id, by, song, ...beat }) => ({ ...beat, ...(by ? { by } : {}), ...(song ? { song } : {}) });

export const cloud = {
  // shared songs can be read
  available: Boolean(config.firebase?.apiKey),
  // people can sign in here (never on the shared-song player's address)
  accounts: Boolean(config.firebase?.apiKey) && !site.guest,
  ready: null,
  user: null,

  // Loads the SDK and resolves once we know whether someone is already signed in.
  init() {
    if (!this.available) return Promise.resolve(null);
    if (!this.ready) {
      this.ready = (async () => {
        fb = await import('../vendor/firebase.bundle.js');
        const app = fb.initializeApp(config.firebase);
        db = fb.getFirestore(app);
        if (config.emulators?.firestore) fb.connectFirestoreEmulator(db, ...config.emulators.firestore);
        // the player only ever reads shared songs, as nobody
        if (!this.accounts) return null;
        auth = fb.getAuth(app);
        if (config.emulators?.auth) fb.connectAuthEmulator(auth, config.emulators.auth, { disableWarnings: true });
        await new Promise((resolve) => {
          fb.onAuthStateChanged(auth, async (user) => {
            const next = profile(user);
            if (next) next.admin = await this.isAdmin(next.uid);
            this.user = next;
            listeners.forEach((fn) => fn(this.user));
            resolve();
          });
        });
        return this.user;
      })();
    }
    return this.ready;
  },

  // Called with the signed-in person (or null) now and on every change.
  onUser(fn) {
    listeners.add(fn);
  },

  // Whether the person signed in is an admin. The rules decide (firestore.rules names the
  // admin); the site finds out by asking for something only an admin is allowed to read.
  async isAdmin() {
    try {
      await fb.getDoc(fb.doc(db, 'roles', 'admin'));
      return true;
    } catch {
      return false;
    }
  },

  // Must be called from a click: it opens Google's sign-in window. Resolves to
  // { isNew } once Google has answered; `onUser` listeners hear about the person.
  async signIn() {
    if (!this.accounts) throw new Error('accounts are not available here');
    // no waiting once the SDK is loaded: browsers only allow the pop-up straight from the click
    if (!auth) await this.init();
    const provider = new fb.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await fb.signInWithPopup(auth, provider);
    return { isNew: Boolean(fb.getAdditionalUserInfo(result)?.isNewUser) };
  },

  // For the emulator-backed tests only: signs in as a made-up Google account.
  async signInForTest(claims) {
    if (!config.emulators?.auth || !this.accounts) throw new Error('test sign-in needs the auth emulator');
    await this.init();
    await fb.signInWithCredential(auth, fb.GoogleAuthProvider.credential(JSON.stringify(claims)));
    return this.user;
  },

  async signOut() {
    if (auth) await fb.signOut(auth);
  },

  songDoc(uid, id) {
    return fb.doc(db, 'users', uid, 'songs', id);
  },

  async listSongs() {
    const snapshot = await fb.getDocs(fb.collection(db, 'users', this.user.uid, 'songs'));
    return snapshot.docs.map((entry) => fromDoc(entry.id, entry.data()));
  },

  async saveSong(song) {
    await fb.setDoc(this.songDoc(this.user.uid, song.id), {
      code: song.code,
      title: song.title || 'Untitled',
      createdAt: song.createdAt,
      updatedAt: song.updatedAt,
      shared: Boolean(song.shared),
      mixer: Array.isArray(song.mixer) ? song.mixer : [],
      ownerName: this.user.displayName,
      // only ever sent back as it was read: the rules do not let an owner change it
      ...(song.blocked ? { blocked: true } : {}),
      ...(song.shareId ? { shareId: song.shareId } : {}),
      ...(cleanFrom(song.from) ? { from: cleanFrom(song.from) } : {}),
      // offered to the community shelf (only while shared)
      ...(song.featurable ? { featurable: true } : {}),
    });
  },

  /* ---------- channel snapshots ---------- */

  // A snapshot is a record (snapshots-core.js) and its recording, a WAV, in chunks of under a
  // megabyte each: users/{uid}/snapshots/{id} and users/{uid}/snapshots/{id}/chunks/{n}.
  snapshotDoc(id) {
    return fb.doc(db, 'users', this.user.uid, 'snapshots', id);
  },

  async listSnapshots() {
    const snapshot = await fb.getDocs(fb.collection(db, 'users', this.user.uid, 'snapshots'));
    return snapshot.docs.map((entry) => ({ ...entry.data(), id: entry.id }));
  },

  // The recording goes first and the record last, so a record always has its chunks.
  async saveSnapshot(record, chunks) {
    if (chunks) {
      const batch = fb.writeBatch(db);
      chunks.forEach((bytes, n) => batch.set(fb.doc(db, 'users', this.user.uid, 'snapshots', record.id, 'chunks', String(n)), { n, data: fb.Bytes.fromUint8Array(bytes) }));
      await batch.commit();
    }
    await fb.setDoc(this.snapshotDoc(record.id), record);
  },

  async readSnapshotChunks(id, count) {
    const docs = await Promise.all(Array.from({ length: count }, (_, n) => fb.getDoc(fb.doc(db, 'users', this.user.uid, 'snapshots', id, 'chunks', String(n)))));
    return docs.map((entry) => {
      if (!entry.exists()) throw new Error(`snapshot ${id} is missing part ${entry.id}`);
      return entry.data().data.toUint8Array();
    });
  },

  // The record first: without it the chunks are never read.
  async deleteSnapshot(id, count) {
    await fb.deleteDoc(this.snapshotDoc(id));
    const batch = fb.writeBatch(db);
    for (let n = 0; n < count; n++) batch.delete(fb.doc(db, 'users', this.user.uid, 'snapshots', id, 'chunks', String(n)));
    await batch.commit();
  },

  /* ---------- share links ---------- */

  // A share link is a UUID. shares/{uuid} says whose song it is and which; the song
  // itself can only be read while its owner has sharing switched on.
  async saveShare(shareId, songId) {
    await fb.setDoc(fb.doc(db, 'shares', shareId), { owner: this.user.uid, song: songId, createdAt: Date.now() });
  },
  async deleteShare(shareId) {
    await fb.deleteDoc(fb.doc(db, 'shares', shareId));
  },
  // Resolves to { owner, song }, or null if the link is not (or no longer) one. Throws if
  // the database could not be reached, which is not the same as a closed link.
  async getShare(shareId) {
    await this.init();
    try {
      const snapshot = await fb.getDoc(fb.doc(db, 'shares', shareId));
      return snapshot.exists() ? { owner: snapshot.data().owner, song: snapshot.data().song } : null;
    } catch (error) {
      if (refused(error)) return null;
      throw error;
    }
  },

  // One of the signed-in person's own songs as the account holds it now.
  async getOwn(id) {
    const snapshot = await fb.getDoc(this.songDoc(this.user.uid, id));
    return snapshot.exists() ? fromDoc(id, snapshot.data()) : null;
  },

  async deleteSong(id) {
    await fb.deleteDoc(this.songDoc(this.user.uid, id));
  },

  // Someone else's shared song, by its link. Resolves to null if it does not exist or is
  // not shared (the rules refuse the read); throws if the database could not be reached.
  async getShared(uid, id) {
    await this.init();
    try {
      const snapshot = await fb.getDoc(this.songDoc(uid, id));
      return snapshot.exists() ? { ...fromDoc(id, snapshot.data()), owner: uid } : null;
    } catch (error) {
      if (refused(error)) return null;
      throw error;
    }
  },

  /* ---------- the public beats ---------- */

  // The list of beats without their code, or null if the database holds none yet.
  async getCatalog() {
    try {
      await this.init();
      const snapshot = await fb.getDoc(fb.doc(db, 'catalog', 'public'));
      const data = snapshot.exists() ? snapshot.data() : null;
      return Array.isArray(data?.beats) && data.beats.length ? data : null;
    } catch {
      return null;
    }
  },

  // One beat with its code, if the rules allow this visitor to have it.
  async getBeat(id) {
    try {
      const snapshot = await fb.getDoc(fb.doc(db, 'beats', id));
      return snapshot.exists() ? beatFromDoc(id, snapshot.data()) : null;
    } catch {
      return null;
    }
  },

  // The beats the admin has opened to members; with `all`, every beat (admin only).
  async listBeats({ all = false } = {}) {
    const beats = fb.collection(db, 'beats');
    const snapshot = await fb.getDocs(all ? beats : fb.query(beats, fb.where('members', '==', true)));
    return snapshot.docs.map((entry) => beatFromDoc(entry.id, entry.data()));
  },

  // Admin: write changed beats, remove others, and replace the catalog, all at once.
  async saveBeats({ save = [], remove = [], catalog }) {
    const batch = fb.writeBatch(db);
    for (const beat of save) batch.set(fb.doc(db, 'beats', beat.id), beatToDoc(beat));
    for (const id of remove) batch.delete(fb.doc(db, 'beats', id));
    batch.set(fb.doc(db, 'catalog', 'public'), catalog);
    await batch.commit();
  },

  /* ---------- admin: what people have shared ---------- */

  async listShared() {
    const snapshot = await fb.getDocs(fb.query(fb.collectionGroup(db, 'songs'), fb.where('shared', '==', true)));
    return snapshot.docs.map((entry) => ({ ...fromDoc(entry.id, entry.data()), title: entry.data().title || 'Untitled', owner: entry.ref.parent.parent.id }));
  },

  // Switch a shared song's sharing off. Its owner cannot switch it back on. It leaves the
  // community shelf too (before its link's record, as everywhere).
  async takeDown(owner, id, shareId = null) {
    await fb.updateDoc(this.songDoc(owner, id), { shared: false, blocked: true });
    if (shareId) await this.unfeature(shareId).catch(() => {});
    if (shareId) await this.deleteShare(shareId).catch(() => {});
  },

  /* ---------- the community shelf ---------- */

  // Admin: put a shared song on the shelf. `entry` is community-core.js communityEntry().
  async feature(shareId, entry) {
    await fb.setDoc(fb.doc(db, 'community', shareId), entry);
  },
  // Take a song off the shelf: the admin, or its owner while its link's record exists.
  async unfeature(shareId) {
    await fb.deleteDoc(fb.doc(db, 'community', shareId));
  },
  // The songs on the shelf, most recently featured first. Anyone can read them.
  async listCommunity({ max = SHELF_MAX } = {}) {
    await this.init();
    const snapshot = await fb.getDocs(fb.query(fb.collection(db, 'community'), fb.orderBy('featuredAt', 'desc'), fb.limit(Math.min(max, SHELF_MAX))));
    return snapshot.docs.map((entry) => shelfEntry(entry.id, entry.data())).filter(Boolean);
  },
};
