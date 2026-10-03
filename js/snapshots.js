// Channel snapshots: a few bars of one channel's sound, captured from a deck as it plays,
// kept in eight slots, and played back from the pads or as a channel in the mixer.
//
// Capturing. Every channel already sends its sound into an analyser of its own for the
// level meter (mixer.js gate()). An analyser passes its input straight through, so a
// recorder hung off it hears that channel alone, after its synth, filters, fader and pan,
// while what you hear is untouched. The recorder keeps an exact window of audio frames,
// from one bar line to another (snapshots-core.js captureWindow), so the loop is seamless.
//
// Keeping. A snapshot lives in this browser (IndexedDB: localStorage is too small for
// audio) and, for someone signed in, in their account as well (cloud.js), so it follows
// them between devices.
//
// Playing. A snapshot is registered with Strudel as a sample and looped on a deck by the
// deck itself (player.js snapPattern), so it keeps to the deck's bars and tempo and goes
// through its bus, the crossfader and the master like everything else.
import { webaudio } from '../vendor/strudel.bundle.js';
import { cloud } from './cloud.js';
import { loadWorklet, recordWindow, saveBlob } from './recorder.js';
import { SLOTS, SLOT_KEYS, newSnapId, barTime, longestFit, captureWindow, arrange, firstFree, cleanName, cleanSnapshot, chunkCount, toChunks, fromChunks, describe, barsLabel } from './snapshots-core.js';

/* ---------- this browser's copy (IndexedDB) ---------- */

const DB_NAME = 'hacking-the-beats';
const STORE = 'snapshots';
let opening = null;
function openDb() {
  if (!opening) {
    opening = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        // storage unavailable (a private window, blocked site data): snapshots last the visit
        resolve(null);
      }
    });
  }
  return opening;
}
async function inStore(mode, fn) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE, mode);
      const request = fn(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request?.result ?? true);
      transaction.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
const local = {
  all: () => inStore('readonly', (store) => store.getAll()),
  put: (record) => inStore('readwrite', (store) => store.put(record)),
  remove: (id) => inStore('readwrite', (store) => store.delete(id)),
};

/* ---------- the bank ---------- */

// id → the record (snapshots-core.js) plus { owner, synced, chunksUp, wav }:
// whose it is, whether the account has this version, whether the account has the
// recording, and the recording (a WAV blob, or null while it is still being fetched).
const records = new Map();
// id → { name, url }: the sample each recording is registered as
const sounds = new Map();
const listeners = new Set();

const whose = () => cloud.user?.uid ?? null;
// The parts of a record that are stored in the account.
const recordOf = (record) => cleanSnapshot(record);

export const snapshots = {
  slots: Array(SLOTS).fill(null),
  // a capture armed or under way: { player, index, name, bars, state, bar, startTime, endTime, job }
  capture: null,
  // a capture waiting for a slot while all eight are full: { meta, wav }
  pending: null,
  players: [],
  focused: () => null,
  status: () => {},

  // what this browser holds, once read
  loaded: null,

  // options: { players, focused(), status(message, options) }
  init(options) {
    this.loaded ??= this.load(options);
    return this.loaded;
  },
  async load({ players, focused, status }) {
    this.players = players;
    this.focused = focused;
    this.status = status;
    for (const player of players) {
      // a capture is of bars at one tempo: stopping or changing tempo ends it
      player.on('toggle', (started) => !started && this.capture?.player === player && this.cancel(`Deck ${player.id} stopped, so the capture was let go.`));
      player.on('tempo', () => {
        const capture = this.capture;
        if (capture?.player === player && capture.cps !== player.cps) this.cancel('The tempo changed during the capture, so it was let go. Try again.');
      });
    }
    for (const record of (await local.all()) || []) {
      const clean = recordOf(record);
      if (clean && record.wav instanceof Blob) records.set(clean.id, { ...clean, owner: record.owner ?? null, synced: Boolean(record.synced), chunksUp: Boolean(record.chunksUp), wav: record.wav });
    }
    this.refresh();
  },

  on(fn) {
    listeners.add(fn);
  },
  emit(reason) {
    listeners.forEach((fn) => fn(reason));
  },

  get(id) {
    return records.get(id) ?? null;
  },
  at(slot) {
    return this.get(this.slots[slot]);
  },
  // the snapshots of whoever is here (nobody's, where the site has no accounts)
  mine() {
    const owner = whose();
    return [...records.values()].filter((record) => record.owner === owner);
  },
  keyFor: (slot) => SLOT_KEYS[slot].toUpperCase(),
  describe,

  // Slots, pins and pads, after any change.
  refresh(reason = 'change') {
    this.slots = arrange(this.mine()).slots;
    this.applyPins();
    this.emit(reason);
  },

  /* ---------- the account ---------- */

  // Someone signed in or out: bring this browser and their account into step. The records
  // come first; recordings this browser does not have yet follow, one by one.
  async setUser(user) {
    await this.loaded;
    this.cancel();
    this.pending = null;
    if (!user) {
      // signing out takes the account's snapshots with it; anything not yet saved there stays
      for (const record of [...records.values()]) if (record.owner && record.synced && record.chunksUp) this.forget(record.id);
      return this.refresh();
    }
    let remote;
    try {
      remote = (await cloud.listSnapshots()).map(recordOf).filter(Boolean);
    } catch (error) {
      console.warn('[snapshots] could not read the account', error);
      return this.refresh();
    }
    if (whose() !== user.uid) return;
    const there = new Map(remote.map((record) => [record.id, record]));
    const fetch = [];
    for (const record of remote) {
      const here = records.get(record.id);
      if (here && here.updatedAt >= record.updatedAt) continue;
      // the same recording with a new name, slot or pin keeps the audio it has
      const wav = here?.frames === record.frames ? here.wav : null;
      records.set(record.id, { ...record, owner: user.uid, synced: true, chunksUp: true, wav });
      if (wav) local.put(records.get(record.id));
      else fetch.push(record.id);
    }
    for (const record of this.mine()) {
      if (there.has(record.id) && (record.synced || there.get(record.id).updatedAt >= record.updatedAt)) continue;
      // in the account once, and gone from it since: deleted on another device
      if (!there.has(record.id) && record.synced && record.chunksUp) this.forget(record.id);
      else {
        // not in the account at all: its recording has to go too
        if (!there.has(record.id)) records.set(record.id, { ...record, chunksUp: false });
        this.upload(record.id);
      }
    }
    this.refresh();
    for (const id of fetch) await this.fetchRecording(id);
  },

  async fetchRecording(id) {
    const record = records.get(id);
    if (!record || record.wav || record.owner !== whose()) return;
    try {
      const bytes = fromChunks(await cloud.readSnapshotChunks(id, record.chunks));
      const now = records.get(id);
      if (!now) return;
      records.set(id, { ...now, wav: new Blob([bytes], { type: 'audio/wav' }) });
      local.put(records.get(id));
      this.refresh();
    } catch (error) {
      console.warn('[snapshots] could not fetch a recording', id, error);
    }
  },

  async upload(id) {
    const record = records.get(id);
    if (!record || !cloud.user || record.owner !== cloud.user.uid || !record.wav) return;
    try {
      const chunks = record.chunksUp ? null : toChunks(new Uint8Array(await record.wav.arrayBuffer()));
      await cloud.saveSnapshot(recordOf(record), chunks);
      const now = records.get(id);
      if (!now) return;
      records.set(id, { ...now, chunksUp: true, synced: now.updatedAt === record.updatedAt });
      local.put(records.get(id));
    } catch (error) {
      console.warn('[snapshots] could not save to the account', error);
      this.status('Could not save the snapshot to your account just now. It is safe in this browser and will be sent next time.');
    }
  },

  /* ---------- capturing ---------- */

  // Capture `bars` bars of channel `index` of `player`, from its next bar line. Pressing the
  // same channel's ● again lets an armed or running capture go.
  async arm(player, index, bars) {
    if (this.capture) {
      const same = this.capture.player === player && this.capture.index === index;
      this.cancel();
      if (same) return;
    }
    const track = player.mixer.tracks[index];
    if (!track) return;
    if (!player.started) return this.status(`Play deck ${player.id}, then capture ${track.name}: it records from the next bar.`);
    if (!player.mixer.audible(index)) return this.status(`${track.name} is silent. Unmute it to capture it.`);
    const context = webaudio.getAudioContext();
    const fit = longestFit(bars, player.cps, context.sampleRate);
    if (!fit) return this.status('At this tempo even one bar is longer than a snapshot can be (30 seconds).');

    const capture = { player, index, name: track.name, bars: fit, cps: player.cps, state: 'armed', job: null };
    this.capture = capture;
    this.emit('capture');
    try {
      await loadWorklet(context);
    } catch (error) {
      console.warn('[snapshots] the recorder could not start', error);
      return this.cancel('This browser cannot capture audio here.');
    }
    const clock = player.barClock();
    if (this.capture !== capture) return;
    if (!clock) return this.cancel(`Play deck ${player.id}, then capture ${track.name}.`);
    // the recorder needs a moment to be in place before its bar line
    let bar = player.nextBar();
    while (barTime(clock, bar) - context.currentTime < 0.06) bar++;
    const window = captureWindow(clock, bar, fit, context.sampleRate);
    Object.assign(capture, { bar, startTime: window.startTime, endTime: window.endTime, songTitle: player.song?.title || '' });
    capture.job = recordWindow(this.source(track, context), window.startFrame, window.endFrame);
    if (fit < bars) this.status(`Capturing ${barsLabel(fit)}: ${bars} would be longer than 30 seconds at this tempo.`);
    this.emit('capture');

    const wav = await capture.job.done;
    if (this.capture !== capture) return;
    this.capture = null;
    this.emit('capture');
    const frames = wav ? (wav.size - 44) / 4 : 0;
    if (frames !== window.frames) return this.status('That capture did not come out whole. Try it again.');
    const now = Date.now();
    const name = cleanName(track.name) || 'Snapshot';
    const meta = {
      id: newSnapId(),
      name,
      track: name,
      songTitle: capture.songTitle,
      bars: fit,
      cps: capture.cps,
      sampleRate: context.sampleRate,
      frames,
      slot: null,
      pinned: null,
      createdAt: now,
      updatedAt: now,
      chunks: chunkCount(wav.size),
    };
    const free = firstFree(this.slots);
    if (free >= 0) return this.keep(meta, wav, free);
    this.pending = { meta, wav };
    this.status(`All eight slots are full. Tap a snapshot pad to put ${describe(meta)} there, or press Esc to let it go.`, { hold: 0 });
    this.emit('pending');
  },

  // The channel's analyser, which every voice of the channel is sent into.
  source(track, context) {
    const id = track.meterSource || track.meterId;
    const existing = webaudio.analysers?.[id];
    return existing && existing.context === context ? existing : webaudio.getAnalyserById(id, 2048);
  },

  // Where a capture is: { state: 'armed' | 'recording', barsLeft } for the channel strip.
  progress() {
    const capture = this.capture;
    if (!capture?.job) return capture ? { state: 'armed', barsLeft: capture.bars } : null;
    const now = webaudio.getAudioContext().currentTime;
    if (now < capture.startTime) return { state: 'armed', barsLeft: capture.bars };
    const done = (now - capture.startTime) / (capture.endTime - capture.startTime);
    return { state: 'recording', barsLeft: Math.max(1, Math.ceil(capture.bars * (1 - done))) };
  },

  // Let go of a capture under way, or one waiting for a slot.
  cancel(message) {
    const had = this.capture || this.pending;
    if (this.capture) {
      this.capture.job?.cancel();
      this.capture = null;
      this.emit('capture');
    }
    if (this.pending) {
      this.pending = null;
      this.emit('pending');
    }
    if (had && message) this.status(message);
    return Boolean(had);
  },

  /* ---------- keeping ---------- */

  async keep(meta, wav, slot) {
    const old = this.at(slot);
    if (old) this.remove(old.id, { quiet: true });
    const record = { ...meta, slot, owner: whose(), synced: false, chunksUp: false, wav };
    records.set(record.id, record);
    this.pending = null;
    this.refresh('kept');
    this.emit('pending');
    const saved = await local.put(record);
    this.status(`Kept ${describe(record)} on pad ${this.keyFor(slot)}.${saved ? '' : ' This browser would not store it, so it lasts until you leave.'} Tap the pad to bring it in on the next bar.`, { hold: 9000 });
    if (cloud.user) this.upload(record.id);
  },

  // Change a snapshot's name, slot or pin.
  update(id, changes) {
    const record = records.get(id);
    if (!record) return null;
    const next = { ...record, ...changes, updatedAt: Date.now(), synced: false };
    records.set(id, next);
    local.put(next);
    if (cloud.user) this.upload(id);
    for (const player of this.players) player.renameSnap(next);
    this.refresh();
    return next;
  },

  rename(id, name) {
    const clean = cleanName(name);
    if (clean) this.update(id, { name: clean });
  },

  // Pin a snapshot to a deck's mixer ('A' or 'B'), or unpin it (null).
  pin(id, deckId) {
    this.update(id, { pinned: deckId });
  },

  // Gone from every deck, this browser and the account.
  remove(id, { quiet = false } = {}) {
    const record = records.get(id);
    if (!record) return;
    for (const player of this.players) player.removeSnap(id, { now: true });
    this.forget(id);
    if (cloud.user && record.owner === cloud.user.uid && record.chunksUp) {
      cloud.deleteSnapshot(id, record.chunks).catch((error) => console.warn('[snapshots] could not delete from the account', error));
    }
    if (!quiet) this.refresh();
  },

  // Gone from this browser only.
  forget(id) {
    records.delete(id);
    local.remove(id);
    const sound = sounds.get(id);
    if (sound) URL.revokeObjectURL(sound.url);
    sounds.delete(id);
  },

  download(id) {
    const record = records.get(id);
    if (!record?.wav) return;
    const name = `${record.name} ${barsLabel(record.bars)}`.replace(/[^\w\- ]+/g, '').trim() || 'snapshot';
    saveBlob(record.wav, `hack-the-beats ${name}.wav`);
  },

  /* ---------- playing ---------- */

  // The sample a snapshot's recording plays as, registered (and decoded) on first use.
  soundFor(record) {
    let sound = sounds.get(record.id);
    if (!sound) {
      const name = `snap_${record.id}`;
      const url = URL.createObjectURL(record.wav);
      webaudio.samples({ [name]: [url] });
      webaudio.loadBuffer(url, webaudio.getAudioContext(), name, 0).catch((error) => console.warn('[snapshots] could not decode', record.id, error));
      sound = { name, url };
      sounds.set(record.id, sound);
    }
    return sound.name;
  },

  // Each deck's mixer holds the snapshots pinned to it, and nothing that was unpinned.
  applyPins() {
    for (const player of this.players) {
      for (const [id, entry] of player.snaps) {
        const record = records.get(id);
        if (entry.pinned && (!record || record.pinned !== player.id || record.owner !== whose())) player.removeSnap(id);
      }
      for (const record of this.mine()) {
        if (record.pinned === player.id && record.wav && !player.snaps.get(record.id)?.pinned) player.addSnap(record, this.soundFor(record), { pinned: true });
      }
    }
  },

  // The deck a snapshot is on (about to stop or not), if any.
  deckOf(id) {
    return this.players.find((player) => player.snaps.has(id) && player.snaps.get(id).stopAt === null) ?? null;
  },

  // Whether a slot's snapshot is sounding on a deck: what lights its pad.
  lit(slot) {
    const id = this.slots[slot];
    return Boolean(id) && this.players.some((player) => player.snapPlaying(id));
  },

  // A snapshot pad was pressed. `once`: play it through once.
  press(slot, { once = false } = {}) {
    if (this.pending) return this.keep(this.pending.meta, this.pending.wav, slot);
    const record = this.at(slot);
    if (!record) return this.status('An empty slot. Capture a channel into it with ● in the Mixer.');
    if (!record.wav) {
      this.fetchRecording(record.id);
      return this.status('That snapshot is still on its way from your account.');
    }
    const on = this.deckOf(record.id);
    if (on) {
      // pinned: in and out; muted in the mixer: back in; otherwise it stops at the next bar
      const entry = on.snaps.get(record.id);
      if (entry.pinned || entry.track.mute) on.mixer.setMute(record.id);
      else on.removeSnap(record.id);
      return;
    }
    const focused = this.focused();
    const target = [focused, ...this.players.filter((player) => player !== focused)].find((player) => player?.started);
    if (!target) return this.status('Start a deck, then fire a snapshot: it comes in on the next bar.');
    target.addSnap(record, this.soundFor(record), { once });
  },
};
