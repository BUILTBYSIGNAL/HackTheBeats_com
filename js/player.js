// One deck: its own Strudel editor and scheduler, its song, mixer, stage and camera.
// Two of these run side by side; the shared runtime keeps their evaluations apart.
import { S, runtime, steadyTimers } from './runtime.js';
import { createMixer } from './mixer.js';
import { Stage } from './stage.js';
import { Camera } from './camera.js';
import { master, BUS_OFFSET } from './master.js';
import { analyze, applySaved, sliderText, shapeOf } from './analyze.js';
import { computeArrangement } from './arrangement.js';
import { persist } from './persist.js';
import { nextBar, loopPhase, sounds } from './snapshots-core.js';
import { parseCut, loopLength } from './trim-core.js';

const { core, draw, webaudio, codemirror, transpilerPkg } = S;

const DRAW_TIME = [-2, 2];
const DEFAULT_CPS = 0.5;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Moves a deck's sounds onto its own set of orbits and cut groups (see master.js).
function moveToBus(value, offset) {
  if (!value || typeof value !== 'object') return value;
  const shift = (n) => (Number.isFinite(Number(n)) ? Number(n) + offset : n);
  const moved = { ...value, orbit: shift(value.orbit ?? 1) };
  if (value.cut != null) moved.cut = shift(value.cut);
  if (value.duckorbit != null) moved.duckorbit = Array.isArray(value.duckorbit) ? value.duckorbit.map(shift) : shift(value.duckorbit);
  return moved;
}

export class Player {
  constructor(id, { editor, pane }) {
    this.id = id;
    this.busOffset = id === 'B' ? BUS_OFFSET : 0;
    this.handlers = new Map();

    // A song is { id, source, title, code, … }. `source` is 'beats' for the built-in
    // collection, 'mine' for the listener's own songs, 'shared' for someone else's.
    this.song = null;
    this.sliders = [];
    this.switches = [];
    this.sliderIds = [];
    this.sliderStore = {};
    this.ready = false;
    this.busy = false;
    this.wantPlay = false;
    // a failure stops the deck; a problem is a mistake in edited code while the last good
    // version carries on playing
    this.failure = null;
    this.problem = null;
    // someone else's code, shown but not yet run
    this.gated = false;
    // the code on stage differs from what is playing (beyond knob positions)
    this.dirty = false;
    this.transport = 'idle';
    this.loadToken = 0;
    this.startToken = 0;
    this.scan = null;
    this.warm = null;
    this.grid = null;
    this.cancelArrangement = null;
    // the song's trim (trim-core.js), as of its last evaluation: [[start, length], …] or null
    this.cut = null;
    this.loading = false;
    this.hot = false;
    this.evalShape = '';
    this.songShape = '';
    this.updateTimer = null;

    this.baseCps = DEFAULT_CPS;
    this.tempo = 1;
    this.lockedCps = null;
    // bars added to the scheduler's clock by seeking
    this.offset = 0;
    // a fraction of a bar that lines this deck up exactly with the one it started beside
    this.nudge = 0;
    // momentary pattern effects from the pads
    this.fx = { half: null, stutter: null, killDrums: false };
    this.basePattern = null;
    this.liveCache = { key: null, pattern: null };
    // channel snapshots looping on this deck, by id: { snap, sound, start, stopAt, pinned, track }
    this.snaps = new Map();
    this.snapVersion = 0;
    // () => another playing deck this one should start in time with, or null
    this.partner = null;

    this.mixer = createMixer(this);

    const mirror = new codemirror.StrudelMirror({
      root: editor,
      id: `hb${id}`,
      initialCode: '',
      defaultOutput: webaudio.webaudioOutput,
      getTime: () => webaudio.getAudioContext().currentTime,
      transpiler: transpilerPkg.transpiler,
      drawTime: DRAW_TIME,
      drawContext: draw.getDrawContext(),
      solo: false,
      bgFill: false,
      prebake: () => runtime.init(),
      setInterval: steadyTimers.setInterval,
      clearInterval: steadyTimers.clearInterval,
      editPattern: (pattern) => this.wrap(pattern),
      onDraw: (haps, time, painters) => {
        painters?.forEach((painter) => painter(mirror.drawContext, time, haps, DRAW_TIME));
      },
      beforeEval: () => this.mixer.beforeEval(),
      afterEval: ({ meta }) => {
        // Strudel hands out fresh slider ids on each evaluation (they come from offsets).
        this.sliderIds = (meta?.widgets || [])
          .filter((widget) => widget.type === 'slider')
          .sort((a, b) => a.from - b.from)
          .map((widget) => `slider_${widget.from}`);
        this.stage.setLocations(meta?.miniLocations);
        // where the inline visuals sit, for drawing the code elsewhere (video clips)
        this.stage.setVisuals((meta?.widgets || []).filter((widget) => widget.type !== 'slider'));
      },
      onEvalError: (error) => this.evalFailed(error),
      onToggle: (started) => this.onToggle(started),
    });
    // Strudel calls this every animation frame with the haps sounding right now.
    mirror.highlight = (haps) => this.frame(haps);
    // The editor's own keys (Ctrl+Enter, Ctrl+.) go through the deck, not straight to Strudel.
    mirror.evaluate = () => this.update();
    mirror.stop = () => this.stop();
    mirror.reconfigureExtension('isPatternHighlightingEnabled', false);
    mirror.reconfigureExtension('isFlashEnabled', false);
    mirror.reconfigureExtension('isLineWrappingEnabled', true);
    mirror.reconfigureExtension('isLineNumbersDisplayed', true);
    mirror.reconfigureExtension('isBracketClosingEnabled', false);
    // Typography is owned by our stylesheet, not by Strudel's saved editor settings.
    editor.style.fontSize = '';
    editor.style.fontFamily = '';
    const scroller = editor.querySelector('.cm-scroller');
    if (scroller) scroller.style.fontFamily = '';
    this.mirror = mirror;

    this.stage = new Stage(mirror, pane, {
      onTrack: (index) => this.mixer.setMute(index),
      onSlider: (k) => this.emit('pick-slider', k),
      onSwitch: (j) => this.emit('pick-switch', j),
      onDocChange: () => this.onDocChange(),
      onRun: () => this.update(),
      // a click in the code: whoever owns the deck decides whether that starts editing
      onWantEdit: () => this.wantEdit?.(),
    });
    this.camera = new Camera(this);

    this.mixer.onChange((reason) => {
      this.stage.setFlags(this.trackFlags());
      // a snapshot's channel is not part of the song
      if (!['configure', 'missing', 'snap', 'snaps'].includes(reason)) this.save();
      this.emit('mixer', reason);
    });
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
  }
  emit(type, ...args) {
    this.handlers.get(type)?.forEach((fn) => fn(...args));
  }

  /* ---------- state ---------- */

  get scheduler() {
    return this.mirror.repl.scheduler;
  }
  get started() {
    return this.scheduler.started;
  }
  get cps() {
    return this.scheduler.cps;
  }
  get bpm() {
    return this.cps * 240;
  }
  get code() {
    return this.mirror.code;
  }
  // one of the listener's own songs
  get own() {
    return this.song?.source === 'mine';
  }
  // The code on stage differs from the song as it was last saved by more than knob and
  // switch positions: there is something to save (or to throw away).
  get edited() {
    return Boolean(this.song) && shapeOf(this.code, this.stage.numberRanges()) !== this.songShape;
  }
  // The scheduler's clock in cycles (one cycle = one bar of 4/4 in these songs).
  now() {
    return this.started ? this.scheduler.now() : 0;
  }
  // Where in the song we are, which differs from the clock after a seek.
  position() {
    return this.now() + this.offset;
  }

  trackFlags() {
    return this.mixer.tracks.map((track) => ({ muted: !this.mixer.audible(track.index), solo: track.solo }));
  }

  setTransport(state) {
    if (this.transport === state) return;
    this.transport = state;
    this.emit('transport', state);
  }

  status(message, options) {
    this.emit('status', message, options);
  }

  fail(title, detail) {
    this.failure = { title, detail };
    this.wantPlay = false;
    this.setTransport('idle');
    this.emit('error');
  }

  setProblem(problem) {
    this.problem = problem;
    this.emit('error');
  }

  evalFailed(error) {
    const detail = error?.message || String(error);
    if (this.hot) this.setProblem({ title: 'That edit did not run — the last version is still playing', detail });
    else this.fail('This beat did not compile', detail);
  }

  /* ---------- the pattern that actually plays ---------- */

  // Strudel hands us the song's final pattern; we return one that is looked up afresh on
  // every query, so seeking and the pads take effect without re-evaluating anything.
  wrap(pattern) {
    const offset = this.busOffset;
    this.basePattern = offset ? pattern.withValue((value) => moveToBus(value, offset)) : pattern;
    this.liveCache = { key: null, pattern: null };
    return new core.Pattern((state) => this.livePattern().query(state));
  }

  livePattern() {
    const { half, stutter } = this.fx;
    const shift = this.offset + this.nudge;
    const key = `${shift}|${half ?? ''}|${stutter ? `${stutter.at}:${stutter.length}` : ''}|${this.snapVersion}`;
    if (key !== this.liveCache.key) {
      let pattern = this.basePattern;
      if (shift) pattern = pattern.early(shift);
      // half-time: from the moment the pad went down, time runs at half speed
      if (half !== null) pattern = pattern.early(half).slow(2).late(half);
      // stutter: loop the slice of time the pad was pressed in
      if (stutter) pattern = pattern.ribbon(stutter.at, stutter.length);
      // snapshots keep to the scheduler's own bars, whatever the song is doing
      if (this.snaps.size) pattern = core.stack(pattern, ...[...this.snaps.values()].map((entry) => this.snapPattern(entry)));
      this.liveCache = { key, pattern };
    }
    return this.liveCache.pattern;
  }

  /* ---------- channel snapshots ---------- */

  // A snapshot as it loops: its recording cut into bars, stretched to the tempo (so its pitch
  // follows the tempo, like a record), its first bar on the bar it started at. When it plays
  // and stops is read at query time, so stopping it needs no new pattern.
  snapPattern(entry) {
    const { bars } = entry.snap;
    let pattern = core
      .pure({ s: entry.sound })
      .loopAt(bars)
      .chop(bars)
      .late(loopPhase(entry.start, bars))
      .filterHaps((hap) => Boolean(hap.whole) && sounds(hap.whole.begin.valueOf(), entry))
      .withHap((hap) => hap.setContext({ ...hap.context, snap: entry.snap.id }));
    pattern = this.mixer.gate(entry.track, pattern);
    return this.busOffset ? pattern.withValue((value) => moveToBus(value, this.busOffset)) : pattern;
  }

  // The bar line this deck has not played up to yet (0 while stopped).
  nextBar() {
    return this.started ? nextBar(this.scheduler.lastEnd) : 0;
  }

  // What snapshots.js needs to find a bar line on the audio clock (see barTime there).
  barClock() {
    const { scheduler } = this;
    if (!this.started || !Number.isFinite(scheduler.seconds_at_cps_change)) return null;
    return { cps: scheduler.cps, cyclesAtChange: scheduler.num_cycles_at_cps_change, secondsAtChange: scheduler.seconds_at_cps_change, latency: scheduler.latency };
  }

  // Bring a snapshot in on the next bar. `sound` is the name it is registered under.
  // `pinned`: it stays in this deck's mixer, looping, until unpinned (it comes in muted).
  // `once`: it plays through once and leaves.
  addSnap(snap, sound, { pinned = false, once = false } = {}) {
    const existing = this.snaps.get(snap.id);
    if (existing && existing.stopAt === null) {
      existing.pinned = existing.pinned || pinned;
      return existing;
    }
    const start = this.nextBar();
    const entry = {
      snap,
      sound,
      start,
      stopAt: once ? start + snap.bars : null,
      pinned,
      track: this.mixer.addSnap(snap, { muted: pinned && !existing }),
    };
    this.snaps.set(snap.id, entry);
    this.snapVersion++;
    this.emit('snaps');
    return entry;
  }

  // Stop a snapshot at the next bar (or straight away), and take it out of the mixer.
  removeSnap(id, { now = false } = {}) {
    const entry = this.snaps.get(id);
    if (!entry) return;
    if (now || !this.started) {
      this.snaps.delete(id);
      this.mixer.removeSnap(id);
      this.snapVersion++;
    } else {
      entry.stopAt = this.nextBar();
      entry.pinned = false;
    }
    this.emit('snaps');
  }

  // A snapshot's record changed (its name, say): the channel shows the new one.
  renameSnap(snap) {
    const entry = this.snaps.get(snap.id);
    if (!entry) return;
    entry.snap = snap;
    entry.track.name = snap.name;
    this.emit('snaps');
  }

  // Whether a snapshot is sounding (or about to) on this deck.
  snapPlaying(id) {
    const entry = this.snaps.get(id);
    return Boolean(entry) && entry.stopAt === null && this.mixer.audible(id);
  }

  // Snapshots that have played out leave the mixer.
  pruneSnaps() {
    if (!this.snaps.size) return;
    const now = this.now();
    let gone = false;
    for (const [id, entry] of this.snaps) {
      if (entry.stopAt === null || now < entry.stopAt) continue;
      this.snaps.delete(id);
      this.mixer.removeSnap(id);
      gone = true;
    }
    if (!gone) return;
    this.snapVersion++;
    this.emit('snaps');
  }

  // name: 'half' | 'stutter' | 'killDrums'
  setFx(name, on) {
    const now = this.now();
    if (name === 'half') this.fx.half = on && this.started ? now : null;
    else if (name === 'stutter') this.fx.stutter = on && this.started ? { at: Math.floor(now * 8) / 8, length: 1 / 8 } : null;
    else if (name === 'killDrums') {
      this.fx.killDrums = on;
      this.stage.setFlags(this.trackFlags());
      this.emit('mixer', 'fx');
    }
  }

  // Jump to a bar of the song, keeping the place within the bar so the beat carries on.
  seek(bar) {
    this.offset += bar - Math.floor(this.position());
    if (this.started) this.mirror.drawer.invalidate(this.scheduler);
    this.emit('seek');
  }

  /* ---------- loading ---------- */

  // `shared` is the state from a mix link; otherwise the last positions are restored.
  // `trust: false` shows the code without running it until run() is called.
  async load(song, { autoplay = false, shared = null, trust = true } = {}) {
    const token = ++this.loadToken;
    const resume = autoplay || this.started || this.wantPlay;
    this.stop();
    clearTimeout(this.updateTimer);
    this.failure = null;
    this.problem = null;
    this.song = song;
    this.ready = false;
    this.gated = false;
    this.dirty = false;
    this.scan = null;
    this.warm = null;
    this.grid = null;
    this.cancelArrangement?.();
    this.camera.reset();

    // A built-in song gets its saved knob and switch positions written into the code
    // before it is shown. The listener's own song is simply its code.
    const original = analyze(song.code);
    const saved = shared ?? (this.own ? { mixer: song.mixer } : persist.song(song.id));
    const code = this.own ? song.code : applySaved(song.code, original, saved);
    const analysis = code === song.code ? original : analyze(code);
    analysis.sliders.forEach((slider, k) => (slider.defaultValue = original.sliders[k]?.value ?? slider.value));
    analysis.switches.forEach((item, j) => (item.defaultValue = original.switches[j]?.value ?? item.value));

    this.sliders = analysis.sliders;
    this.switches = analysis.switches;
    this.sliderIds = [];
    this.songShape = shapeOf(song.code, [...original.sliders, ...original.switches]);
    this.evalShape = shapeOf(code, analysis.sliders);
    this.tempo = Number.isFinite(shared?.tempo) ? shared.tempo : 1;
    this.lockedCps = null;
    this.mixer.configure(analysis.tracks, saved?.mixer);
    this.stage.clearLevels();
    this.loading = true;
    this.stage.load(code, analysis, this.trackFlags());
    this.stage.setBaseline(this.songShape);
    this.loading = false;
    this.unsaved = false;
    this.emit('song');

    if (analysis.error) {
      this.fail('This beat has a syntax error', analysis.error.message);
      return;
    }
    if (!trust) {
      this.gated = true;
      this.emit('gate');
      return;
    }
    await this.prepare(token, resume);
  }

  // Run a song that was loaded with `trust: false`.
  async run() {
    if (!this.gated) return;
    this.gated = false;
    this.emit('gate');
    await this.prepare(this.loadToken, false);
  }

  async prepare(token, resume) {
    await runtime.init();
    if (token !== this.loadToken) return;
    const ok = await this.evaluate(false);
    if (token !== this.loadToken || !ok) return;
    this.ready = true;
    this.emit('ready');
    this.prepareSounds();
    this.refreshArrangement();
    if (resume) this.play();
  }

  refreshArrangement() {
    this.cancelArrangement?.();
    this.cut = parseCut(this.code)?.segments ?? null;
    this.cancelArrangement = computeArrangement(
      this.mixer.tracks,
      (grid) => {
        this.grid = grid;
        this.emit('grid');
      },
      this.cut,
    );
  }

  // How many bars the song loops over, as far as the strip can tell: 32, or fewer once trimmed.
  loopLength() {
    return loopLength(this.cut);
  }

  // Evaluates the code on stage. Resolves to true when the song produced a pattern.
  // `hot` is a re-evaluation of a song that may be playing: the tempo is left alone unless
  // the code sets it, and a mistake is reported without stopping anything.
  evaluate(autostart, { hot = false } = {}) {
    return runtime.exclusive(async () => {
      const code = this.code;
      // Songs without their own setcps() would otherwise inherit the previous song's tempo.
      if (!hot) this.scheduler.setCps(DEFAULT_CPS);
      this.sliderStore = {};
      this.hot = hot;
      runtime.beginEvaluation(this);
      let pattern;
      try {
        pattern = await this.mirror.repl.evaluate(code, autostart);
      } catch (error) {
        this.evalFailed(error);
        return false;
      } finally {
        this.hot = false;
      }
      if (pattern === undefined) return false;
      if (!hot || /\bset[Cc]p[sm]\s*\(/.test(code)) this.baseCps = this.scheduler.cps;
      this.applyTempo();
      return true;
    });
  }

  // The code on stage has been edited (or a switch turned): analyse and evaluate it again
  // without stopping. A mistake leaves the last good version playing.
  async update() {
    clearTimeout(this.updateTimer);
    if (!this.song || this.gated || this.loading) return false;
    const code = this.code;
    const analysis = analyze(code);
    if (analysis.error) {
      this.setProblem({ title: 'Syntax error — the last version is still playing', detail: analysis.error.message });
      return false;
    }
    await runtime.init();
    this.mixer.prepare(analysis.tracks);
    const ok = await this.evaluate(false, { hot: this.ready });
    if (!ok) {
      this.mixer.discard();
      return false;
    }
    this.mixer.commit();

    // keep each control's reset value where its name still matches
    const defaults = new Map(this.sliders.map((slider) => [slider.constName || `${slider.title}/${slider.sub}`, slider.defaultValue]));
    analysis.sliders.forEach((slider) => (slider.defaultValue = defaults.get(slider.constName || `${slider.title}/${slider.sub}`) ?? slider.value));
    const switchDefaults = new Map(this.switches.map((item) => [item.name, item.defaultValue]));
    analysis.switches.forEach((item) => (item.defaultValue = switchDefaults.get(item.name) ?? item.value));
    this.sliders = analysis.sliders;
    this.switches = analysis.switches;
    this.evalShape = shapeOf(code, analysis.sliders);
    this.stage.setStructure(analysis, this.trackFlags());

    this.failure = null;
    this.problem = null;
    this.ready = true;
    this.setDirty();
    this.emit('error');
    this.emit('structure');
    this.prepareSounds();
    this.refreshArrangement();
    this.save();
    this.noteEdits();
    this.emit('updated');
    return true;
  }

  // Find the sample files the opening bars need and start fetching them straight away, so
  // the first Play starts clean. Runs again if a slow sample pack turns up late.
  prepareSounds() {
    if (!this.ready) return;
    const token = this.loadToken;
    const targets = this.mixer.tracks.length ? this.mixer.tracks : [{ index: -1, name: this.song.title, pattern: this.basePattern }];
    const scan = runtime.scan(targets);
    this.scan = scan;
    this.mixer.applyScan(scan);
    if (scan.missing.size) {
      this.status(`Not in the loaded sample packs: ${[...scan.missing].join(', ')}. Those parts stay silent.`, { hold: 9000 });
    }
    this.warm = runtime
      .warmSamples(scan, (done, total) => {
        if (this.transport === 'loading') this.status(`Loading samples ${done}/${total}`, { hold: 0, progress: true });
      })
      .then((failed) => {
        if (token !== this.loadToken || !failed.length) return;
        this.mixer.markDead(failed);
        const names = failed.map(({ s, n }) => `${s}:${n}`).join(', ');
        this.status(`Could not load ${names} from its sample pack. That part stays silent.`, { hold: 9000 });
      });
  }

  /* ---------- transport ---------- */

  // Returns true once the deck is playing.
  async play() {
    if (!this.song || this.busy || this.started) return false;
    if (this.gated) {
      this.emit('gate');
      return false;
    }
    // Ask for audio first, while we are still inside the click/key handler.
    const audio = runtime.ensureAudio();
    if (!this.ready) {
      // still loading or evaluating: load() will call back in when it is done
      this.wantPlay = !this.failure;
      if (this.wantPlay) this.setTransport('loading');
      audio.catch(() => {});
      return false;
    }
    this.wantPlay = false;
    this.busy = true;
    const token = ++this.startToken;
    this.setTransport('loading');
    try {
      await audio;
      master.attach();
      // wait for the samples, but not forever: after six seconds start anyway and let
      // late files join in when they arrive
      await Promise.race([Promise.all([this.warm, runtime.warmFonts(this.scan)]), delay(6000)]);
      if (token !== this.startToken) return false;

      // Start from the version that last evaluated cleanly, even if the code on stage has
      // unfinished edits. (Evaluating again restarts the inline visuals.)
      const partner = this.partner?.();
      if (partner?.started) {
        // Come in on the other deck's bar line, at its tempo.
        if (!this.dirty && !(await this.evaluate(false))) return false;
        this.lockTo(partner.cps);
        await this.waitForBar(partner);
        if (token !== this.startToken) return false;
        await this.scheduler.start();
        this.alignWith(partner, token);
      } else if (this.dirty) {
        await this.scheduler.start();
      } else if (!(await this.evaluate(true))) {
        return false;
      }
      this.status('', { progress: true });
      return this.started;
    } catch (error) {
      console.error(error);
      this.fail('Audio could not start', error.message);
      return false;
    } finally {
      this.busy = false;
      this.setTransport(this.started ? 'playing' : 'idle');
    }
  }

  // Resolves at the moment this deck must start for its bar 1 to land on the partner's next
  // bar line. Both schedulers add the same latency, so only the clock's own lead matters.
  async waitForBar(partner) {
    const cps = partner.cps;
    const lead = 0.06 * cps;
    const now = partner.scheduler.now();
    const bar = Math.ceil(now + lead + 0.12 * cps);
    const seconds = (bar - lead - now) / cps;
    const due = performance.now() + seconds * 1000;
    await delay(Math.max(0, seconds * 1000 - 25));
    // spin through the last few milliseconds: timers alone are too coarse for a tight start
    while (performance.now() < due) {
      /* wait */
    }
  }

  // Timers put the start within a few milliseconds of the bar line; this measures what is
  // left once both clocks are running and shifts this deck's pattern by that much.
  async alignWith(partner, token) {
    await delay(350);
    const errors = [];
    for (let i = 0; i < 5; i++) {
      const difference = (((partner.scheduler.now() - this.scheduler.now()) % 1) + 1) % 1;
      errors.push(difference > 0.5 ? difference - 1 : difference);
      await delay(30);
    }
    if (token !== this.startToken || !this.started || !partner.started) return;
    const error = errors.sort((a, b) => a - b)[2];
    const ms = Math.abs(error / this.cps) * 1000;
    if (ms > 1 && ms < 80) this.nudge = error;
  }

  stop() {
    this.wantPlay = false;
    this.startToken++;
    if (this.started) this.mirror.repl.stop();
    this.offset = 0;
    this.nudge = 0;
    this.fx.half = null;
    this.fx.stutter = null;
    // Snapshots go with the music, except pinned ones: they wait in the mixer, ready to
    // loop from the first bar.
    if (this.snaps.size) {
      for (const [id, entry] of this.snaps) {
        if (entry.pinned) Object.assign(entry, { start: 0, stopAt: null });
        else {
          this.snaps.delete(id);
          this.mixer.removeSnap(id);
        }
      }
      this.snapVersion++;
      this.emit('snaps');
    }
    if (!this.busy) this.setTransport('idle');
  }

  toggle() {
    return this.started || this.transport === 'loading' ? this.stop() : this.play();
  }

  onToggle(started) {
    if (!this.busy) this.setTransport(started ? 'playing' : 'idle');
    if (!started) {
      this.stage.clearHighlight();
      this.mixer.clearLevels();
      this.stage.setLevels(this.mixer.tracks);
      this.camera.reset();
    }
    this.emit('toggle', started);
  }

  frame(haps) {
    this.pruneSnaps();
    this.stage.highlight(haps);
    this.mixer.updateLevels(haps);
    this.mixer.readMeters();
    this.stage.setLevels(this.mixer.tracks);
    this.camera.tick();
    this.emit('frame');
  }

  /* ---------- tempo ---------- */

  applyTempo() {
    this.scheduler.setCps(this.lockedCps ?? this.baseCps * this.tempo);
    this.emit('tempo');
  }
  // multiplier around the song's own tempo
  setTempo(multiplier) {
    this.tempo = multiplier;
    this.applyTempo();
  }
  // hold this deck at another deck's tempo (null releases it)
  lockTo(cps) {
    if (this.lockedCps === cps) return;
    this.lockedCps = cps;
    this.applyTempo();
  }

  /* ---------- editing ---------- */

  // `at`: where the caret goes (a position in the code), or null for where the reader is
  setEditable(on, at = null) {
    this.stage.setEditable(on, at);
    this.emit('editable', on);
  }

  // The code on stage has just been saved as `song` (a new song of one's own, or the
  // same one again): from here on, that is what it is compared with.
  adopt(song) {
    this.song = song;
    this.songShape = shapeOf(this.code, this.stage.numberRanges());
    this.stage.setBaseline(this.songShape);
    this.emit('adopted');
    this.noteEdits();
  }

  // The changes on stage are not going to be saved: stop counting them as unsaved (the
  // deck is about to be given another song).
  forget() {
    this.songShape = shapeOf(this.code, this.stage.numberRanges());
    this.noteEdits();
  }

  // Throw the changes away: back to the song as it was last saved. (A song still waiting
  // behind the "run this?" question keeps waiting.)
  revert() {
    return this.load(this.song, { autoplay: this.started, trust: !this.gated });
  }

  // Tell whoever is listening when there starts or stops being something to save.
  noteEdits() {
    const unsaved = this.edited;
    if (unsaved === this.unsaved) return;
    this.unsaved = unsaved;
    this.emit('unsaved', unsaved);
  }

  setDirty() {
    const dirty = this.ready && shapeOf(this.code, this.stage.sliderRanges()) !== this.evalShape;
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    this.emit('dirty', dirty);
  }

  // Every change to the code on stage ends up here: typing, an inline slider, a deck knob.
  onDocChange() {
    if (this.loading || !this.song) return;
    // numbers changed in the code itself take effect straight away
    const text = this.stage.readNumbers().sliders;
    this.sliders.forEach((slider, k) => {
      const value = Number(text[k]);
      if (!text[k] || !Number.isFinite(value) || value === slider.value) return;
      slider.value = value;
      const id = this.sliderIds[k];
      if (id) this.sliderStore[id] = value;
      this.emit('slider', k);
    });
    this.setDirty();
    this.noteEdits();
    this.save();
  }

  /* ---------- knobs and switches ---------- */

  // A deck knob moved: rewrite the number in the code and change what plays.
  moveSlider(k, value) {
    const slider = this.sliders[k];
    if (!slider) return;
    const text = sliderText(slider, Math.min(slider.max, Math.max(slider.min, value)));
    slider.value = Number(text);
    // what is written in the code is exactly what plays
    const id = this.sliderIds[k];
    if (id) this.sliderStore[id] = slider.value;
    this.stage.writeSlider(k, text);
    this.save();
    this.emit('slider', k);
  }

  // A deck switch turned: rewrite the number, then re-evaluate (a switch is a plain number
  // in the code, so nothing changes until the song runs again).
  setSwitch(j, value) {
    const item = this.switches[j];
    if (!item || !item.options.some((option) => option.value === value)) return;
    item.value = value;
    this.stage.writeSwitch(j, String(value));
    this.emit('switch', j);
    clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => this.update(), 180);
  }

  snapshot() {
    return {
      sliders: this.sliders.map((slider) => slider.value),
      switches: this.switches.map((item) => item.value),
      mixer: this.mixer.snapshot(),
    };
  }

  // Knob, switch and channel positions are kept without asking: a built-in song's in the
  // browser, one's own song's with the song (by whoever is listening for 'changed').
  // Changes to the code itself wait for the listener to save them.
  save() {
    if (!this.song || this.loading || this.edited) return;
    if (this.own) this.emit('changed');
    else if (this.song.source === 'beats') persist.saveSong(this.song.id, this.snapshot());
  }

  // Back to the positions the song started with.
  resetSong() {
    this.sliders.forEach((slider, k) => this.moveSlider(k, slider.defaultValue));
    this.switches.forEach((item, j) => item.value !== item.defaultValue && this.setSwitch(j, item.defaultValue));
    this.mixer.reset();
    this.setTempo(1);
    this.save();
  }
}
