// Per-track mute / solo / level and metering for one deck, applied from outside the code.
//
// Strudel turns `label: pattern` into `pattern.p('label')` and re-installs `Pattern.prototype.p`
// on every evaluation. Each deck wraps it right after (in beforeEval) so every labelled track
// passes through a gate that is read at query time: moving a control never re-evaluates.
import { core, webaudio } from '../vendor/strudel.bundle.js';

const { Pattern } = core;

// The key superdough looks a sound up by: `bank_s`, lower-cased.
export function soundKey(value) {
  if (!value || typeof value !== 'object' || typeof value.s !== 'string') return null;
  if (['-', '~', '_'].includes(value.s)) return null;
  return (value.bank ? `${value.bank}_${value.s}` : value.s).toLowerCase().replace(/\s+/g, '_');
}

// A specific sample of a sound: "piano:0".
const sampleKey = (key, value) => `${key}:${Math.floor(Number(value.n) || 0)}`;

const DRUM_NAME = /drum|kick|\bbd\b|hat|\bhh\b|\boh\b|clap|\bcp\b|snare|\bsd\b|perc|break|click|\brim\b|cymbal|\btom\b/i;
const DRUM_SOUND = /(^|_)(bd|sd|hh|oh|cp|rim|cr|rd|lt|mt|ht|sh|cb|tb|perc|click|clap|kick|snare|hat)$|^breaks|^tech$|^drum/;

// Decides whether a track is percussion, from its name or from the sounds it plays.
export function looksLikeDrums(name, sounds) {
  if (DRUM_NAME.test(name)) return true;
  if (!sounds || !sounds.size) return false;
  let total = 0;
  let drums = 0;
  for (const [key, count] of sounds) {
    total += count;
    if (DRUM_SOUND.test(key)) drums += count;
  }
  return drums / total > 0.6;
}

// `owner` is the deck: { id, fx: { killDrums } }.
export function createMixer(owner) {
  const listeners = new Set();

  return {
    tracks: [],
    // channel snapshots playing on this deck (snapshots.js): channels that are not in the
    // code, kept apart from `tracks`, whose positions match the code's labels
    snaps: [],
    missing: new Set(),
    dead: new Set(),

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(reason) {
      listeners.forEach((fn) => fn(reason));
    },

    // the tracks of code that is being evaluated but is not playing yet
    next: null,

    makeTrack(track, state) {
      return {
        index: track.index,
        label: track.label,
        name: track.name,
        disabled: track.disabled,
        mute: state ? Boolean(state.mute) : track.disabled,
        solo: state ? Boolean(state.solo) : false,
        gain: state && Number.isFinite(state.gain) ? state.gain : 1,
        pattern: null,
        missingSounds: [],
        isDrum: DRUM_NAME.test(track.name),
        // activity: 1 on each onset, then decaying. Drives the lights in the code.
        level: 0,
        lastOnset: -1,
        // audio level from a real analyser on this track's signal
        meterId: `meter-${owner.id}-${track.index}`,
        meterSource: null,
        meter: 0,
      };
    },

    // A new song. `saved` is [{ mute, solo, gain }] from a previous visit or a shared
    // link, matched by position.
    configure(analysed, saved) {
      const usable = Array.isArray(saved) && saved.length === analysed.length;
      this.missing = new Set();
      this.dead = new Set();
      this.next = null;
      this.tracks = analysed.map((track, i) => this.makeTrack(track, usable ? saved[i] : null));
      this.emit('configure');
    },

    // The same song after an edit. The new tracks are set aside until the code has
    // evaluated (commit), so a mistake leaves what is playing untouched (discard).
    // Mute, solo and level carry over to tracks that keep their label.
    prepare(analysed) {
      const kept = new Map();
      for (const track of this.tracks) {
        if (!kept.has(track.label)) kept.set(track.label, []);
        kept.get(track.label).push(track);
      }
      this.next = analysed.map((track) => this.makeTrack(track, kept.get(track.label)?.shift() ?? null));
    },
    commit() {
      if (!this.next) return;
      this.tracks = this.next;
      this.next = null;
      this.emit('configure');
    },
    discard() {
      this.next = null;
    },

    snapshot() {
      return this.tracks.map(({ mute, solo, gain }) => ({ mute, solo, gain }));
    },

    // A code track by its position, or a snapshot's channel by the snapshot's id.
    trackAt(key) {
      return typeof key === 'string' ? this.snaps.find((track) => track.id === key) : this.tracks[key];
    },

    // A channel for a snapshot. `muted`: it comes in muted, ready to bring in.
    addSnap(snap, { muted = false } = {}) {
      let track = this.trackAt(snap.id);
      if (!track) {
        track = {
          ...this.makeTrack({ index: -1, label: null, name: snap.name, disabled: false }, null),
          id: snap.id,
          isSnap: true,
          isDrum: DRUM_NAME.test(snap.track || snap.name),
          meterId: `meter-${owner.id}-snap-${snap.id}`,
        };
        this.snaps.push(track);
      }
      track.name = snap.name;
      track.mute = muted;
      this.emit('snaps');
      return track;
    },
    removeSnap(id) {
      const before = this.snaps.length;
      this.snaps = this.snaps.filter((track) => track.id !== id);
      if (this.snaps.length !== before) this.emit('snaps');
    },

    reset() {
      for (const track of this.tracks) {
        track.mute = track.disabled;
        track.solo = false;
        track.gain = 1;
      }
      this.emit('reset');
    },

    anySolo() {
      return this.tracks.some((t) => t.solo) || this.snaps.some((t) => t.solo);
    },
    // What the mix controls say, ignoring momentary pads.
    selected(index) {
      const track = this.tracks[index];
      if (!track) return true;
      return this.anySolo() ? track.solo : !track.mute;
    },
    audible(index) {
      const track = this.trackAt(index);
      return track ? this.sounding(track) : true;
    },
    // the same question for a track object, which is what a playing pattern holds on to
    sounding(track) {
      if (owner.fx.killDrums && track.isDrum) return false;
      return this.anySolo() ? track.solo : !track.mute;
    },

    // `index` is a code track's position, or a snapshot's id (which is not kept with the song)
    setMute(index, mute) {
      const track = this.trackAt(index);
      if (!track) return;
      track.mute = mute ?? !track.mute;
      this.emit(track.isSnap ? 'snap' : 'mute');
    },
    setSolo(index, solo) {
      const track = this.trackAt(index);
      if (!track) return;
      track.solo = solo ?? !track.solo;
      this.emit(track.isSnap ? 'snap' : 'solo');
    },
    setGain(index, gain) {
      const track = this.trackAt(index);
      if (!track) return;
      track.gain = gain;
      this.emit(track.isSnap ? 'snap' : 'gain');
    },

    // From a scan of the opening bars: which sounds no pack provides (their haps are dropped
    // so the scheduler does not throw on every trigger) and which tracks are percussion.
    applyScan({ missing, missingByTrack, soundsByTrack }) {
      this.missing = missing;
      for (const track of this.tracks) {
        track.missingSounds = missingByTrack.get(track.index) || [];
        track.isDrum = looksLikeDrums(track.name, soundsByTrack.get(track.index));
      }
      this.emit('missing');
    },

    // Sample files that exist in a pack but could not be fetched or decoded.
    markDead(failed) {
      if (!failed?.length) return;
      for (const { s, n, tracks } of failed) {
        this.dead.add(`${s}:${n}`);
        for (const index of tracks) {
          const track = this.tracks[index];
          if (track && !track.missingSounds.includes(`${s}:${n}`)) track.missingSounds.push(`${s}:${n}`);
        }
      }
      this.emit('missing');
    },

    playable(value) {
      const key = soundKey(value);
      if (!key) return true;
      return !this.missing.has(key) && !(this.dead.size && this.dead.has(sampleKey(key, value)));
    },

    // Called from the deck's beforeEval: Strudel has just installed its own `.p`.
    beforeEval() {
      const nativeP = Pattern.prototype.p;
      const self = this;
      const queue = new Map();
      for (const track of this.next ?? this.tracks) {
        track.pattern = null;
        track.meterSource = null;
        if (!queue.has(track.label)) queue.set(track.label, []);
        queue.get(track.label).push(track);
      }

      Pattern.prototype.p = function (id) {
        const track = queue.get(String(id))?.shift();
        // Not one of the song's top-level labels: leave Strudel's behaviour alone.
        if (!track) return nativeP.call(this, id);
        const index = track.index;

        const tagged = this.withHap((hap) => hap.setContext({ ...hap.context, track: index }));
        track.pattern = tagged;
        const gated = self.gate(track, tagged);

        // A neutral id: Strudel mutes ids that start or end with "_" and solos ids that start
        // with a capital "S" (so `SUB:` would silence everything else). The deck owns both.
        return nativeP.call(gated, `ch${index}`);
      };
    },

    // A track's pattern as it plays: mute, solo and the drums pad decide whether it sounds,
    // its fader sets its level, and its signal is tapped for the level meter. All of it is
    // read at query time, so moving a control never re-evaluates.
    gate(track, pattern) {
      return pattern
        .filterHaps((hap) => this.sounding(track) && this.playable(hap.value))
        .withHap((hap) => {
          const value = hap.value;
          if (typeof value !== 'object' || value === null) return hap;
          let next = value;
          // Tap the track's signal into its own analyser for the level meter. A track
          // that already feeds a scope keeps that analyser and the meter reads it too.
          // (A channel snapshot is captured from the same analyser.)
          if (value.analyze == null) next = { ...next, analyze: track.meterId, fft: 6 };
          else track.meterSource = value.analyze;
          if (track.gain !== 1) next = { ...next, postgain: (value.postgain ?? 1) * track.gain };
          return next === value ? hap : hap.withValue(() => next);
        });
    },

    // One step of the activity envelope, from the haps sounding in this frame.
    updateLevels(activeHaps) {
      for (const track of this.tracks) track.level = track.level < 0.01 ? 0 : track.level * 0.86;
      for (const track of this.snaps) track.level = track.level < 0.01 ? 0 : track.level * 0.86;
      for (const hap of activeHaps) {
        const track = hap.context?.snap ? this.trackAt(hap.context.snap) : this.tracks[hap.context?.track];
        if (!track || !hap.whole) continue;
        const begin = hap.whole.begin.valueOf();
        if (begin !== track.lastOnset) {
          track.lastOnset = begin;
          track.level = 1;
        }
      }
    },

    // Peak of each track's analyser, with a slow fall so the meter is readable.
    readMeters() {
      for (const track of [...this.tracks, ...this.snaps]) {
        const data = webaudio.getAnalyzerData('time', track.meterSource || track.meterId);
        let peak = 0;
        if (data) {
          for (let i = 0; i < data.length; i += 2) {
            const v = data[i] < 0 ? -data[i] : data[i];
            if (v > peak) peak = v;
          }
        }
        track.meter = Math.max(Math.min(1, peak), track.meter * 0.9);
        if (track.meter < 0.004) track.meter = 0;
      }
    },

    clearLevels() {
      for (const track of [...this.tracks, ...this.snaps]) {
        track.level = 0;
        track.lastOnset = -1;
        track.meter = 0;
      }
    },
  };
}
