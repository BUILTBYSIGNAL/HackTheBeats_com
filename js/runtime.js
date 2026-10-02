// The shared Strudel runtime. Strudel keeps a lot of state in globals (the scope songs are
// evaluated in, `Pattern.prototype.p`, slider values, sample packs), so everything that both
// decks have in common lives here, and evaluations are run one at a time.
import * as S from '../vendor/strudel.bundle.js';
import { soundKey } from './mixer.js';

export { S };
const { core, mini, tonal, draw, webaudio, soundfonts, codemirror, transpilerPkg } = S;

const DOUGH = 'https://raw.githubusercontent.com/felixroos/dough-samples/main';
const DRUMKIT = 'https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main';
const ALIASES = 'https://raw.githubusercontent.com/todepond/samples/main/tidal-drum-machines-alias.json';
const DEFAULT_PACKS = [
  `${DOUGH}/tidal-drum-machines.json`,
  `${DOUGH}/piano.json`,
  `${DOUGH}/Dirt-Samples.json`,
  `${DOUGH}/vcsl.json`,
  `${DOUGH}/mridangam.json`,
  `${DRUMKIT}/strudel.json`,
];
export const WIDGETS = ['_pianoroll', '_punchcard', '_spiral', '_scope', '_pitchwheel', '_spectrum'];

const handlers = new Map();
const emit = (type, ...args) => handlers.get(type)?.forEach((fn) => fn(...args));

/* ---------- sample packs ---------- */

// vendor/samples/index.json is a table of "remote url → local path", filled by
// `npm run samples`. Anything listed is served from the project folder, so vendored songs
// play offline; anything else still goes to the network.
async function useLocalMirror() {
  const mirror = await fetch('vendor/samples/index.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const files = mirror?.files;
  if (!files || !Object.keys(files).length) return;
  const remoteFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => remoteFetch(typeof input === 'string' && files[input] ? files[input] : input, init);
}

// Loads a sample pack without ever throwing or stalling: the transpiler awaits every
// `samples()` call, so a pack that is unreachable or slow must not hold the song up.
// Packs are remembered, so pressing Play does not fetch them a second time.
const PACK_PATIENCE = 7000;
const packs = new Map();
// One allowance of patience per evaluation, shared by all the packs a song asks for.
let patienceFrom = 0;
const packName = (source) => (typeof source === 'string' ? source.replace(/^https:\/\/raw\.githubusercontent\.com\//, '') : 'inline map');

async function safeSamples(source, ...rest) {
  const key = typeof source === 'string' && !rest.length ? source : null;
  let pack = key && packs.get(key);
  if (!pack) {
    pack = { done: false, load: webaudio.samples(source, ...rest) };
    pack.load.then(
      () => (pack.done = true),
      () => key && packs.delete(key),
    );
    if (key) packs.set(key, pack);
  }
  // already loaded, or already known to be slow: do not wait for it again
  if (pack.done || pack.slow) return;
  const remaining = Math.max(0, PACK_PATIENCE - (patienceFrom ? performance.now() - patienceFrom : 0));
  let timer;
  const patience = new Promise((resolve) => (timer = setTimeout(() => resolve('slow'), remaining)));
  try {
    if ((await Promise.race([pack.load, patience])) === 'slow') {
      pack.slow = true;
      emit('log', `Still waiting for sample pack ${packName(source)} — playing without it for now`);
      // when it does arrive, let the decks look again for sounds they had marked as missing
      pack.load.then(() => emit('packs'), () => {});
    }
  } catch (error) {
    emit('log', `Sample pack unavailable: ${packName(source)}`);
    console.warn('[runtime] sample pack failed', source, error);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- evaluation scope ---------- */

// The deck whose code is being evaluated right now. slider() calls land in its own store,
// so two songs with a slider at the same place in their source never share a value.
let evalTarget = null;
const scratch = {};

function installGlobals() {
  globalThis.samples = safeSamples;
  globalThis.sliderWithID = (id, value) => {
    const store = evalTarget?.sliderStore ?? scratch;
    store[id] = value;
    return core.ref(() => store[id]);
  };
  // Inline visuals get one consistent default width; explicit widths in a song are kept
  // (the stylesheet clamps anything wider than the column).
  for (const type of WIDGETS) {
    const original = core.Pattern.prototype[type];
    if (!original || original.hbWrapped) continue;
    const sized = type === '_punchcard' || type === '_pianoroll' || type === '_scope';
    const wrapped = function (id, options = {}) {
      return original.call(this, id, sized ? { width: 640, ...options } : options);
    };
    wrapped.hbWrapped = true;
    core.Pattern.prototype[type] = wrapped;
  }
}

// Strudel puts everything it exports on the global object, which is how a song can call
// `stack(…)` or `note(…)` by name. A few of those names already belong to the browser:
// `frames` (window.frames) and `SyntaxError` among them. Other code on the page relies on
// the browser's own: Google's sign-in library finds the frame it reports back to through
// window.frames, and with Strudel's function there instead, signing in never completes.
// So the browser's are put back afterwards. Two stay Strudel's because songs call them
// as plain functions and nothing on the page needs the browser's: `when` and `focus`.
const STRUDEL_KEEPS = new Set(['when', 'focus']);
async function loadScope(...modules) {
  const browsers = new Map();
  for (const module of modules) {
    for (const name of Object.keys(module)) {
      if (name in globalThis && !STRUDEL_KEEPS.has(name) && !browsers.has(name)) browsers.set(name, globalThis[name]);
    }
  }
  await core.evalScope(...modules);
  for (const [name, value] of browsers) globalThis[name] = value;
}

let ready = null;
async function prebake() {
  await loadScope(core, draw, mini, tonal, webaudio, codemirror, soundfonts);
  installGlobals();
  await useLocalMirror();
  await Promise.all([
    webaudio.registerSynthSounds(),
    webaudio.registerZZFXSounds(),
    soundfonts.registerSoundfonts(),
    ...DEFAULT_PACKS.map((url) => safeSamples(url)),
  ]);
  await webaudio.aliasBank(ALIASES).catch((error) => console.warn('[runtime] bank aliases failed', error));
}

// One evaluation at a time: evaluating rebinds Strudel's globals to the deck doing it.
let queue = Promise.resolve();
function exclusive(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/* ---------- timers that keep running in a background tab ---------- */

// Browsers throttle setInterval to once a second in hidden tabs, which would starve the
// scheduler. A worker's timers are not throttled, so the scheduler ticks from there.
let timerWorker;
const timerCallbacks = new Map();
let timerId = 1;
function ensureTimerWorker() {
  if (timerWorker !== undefined) return timerWorker;
  try {
    const source = 'const t={};onmessage=(e)=>{const{id,ms,stop}=e.data;if(stop){clearInterval(t[id]);delete t[id]}else{t[id]=setInterval(()=>postMessage(id),ms)}}';
    timerWorker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    timerWorker.onmessage = (event) => timerCallbacks.get(event.data)?.();
  } catch {
    timerWorker = null;
  }
  return timerWorker;
}
export const steadyTimers = {
  setInterval(fn, ms) {
    if (!ensureTimerWorker()) return globalThis.setInterval(fn, ms);
    const id = `w${timerId++}`;
    timerCallbacks.set(id, fn);
    timerWorker.postMessage({ id, ms });
    return id;
  },
  clearInterval(id) {
    if (typeof id !== 'string') return globalThis.clearInterval(id);
    timerCallbacks.delete(id);
    timerWorker.postMessage({ id, stop: true });
  },
};

/* ---------- public API ---------- */

let audioInit = null;

export const runtime = {
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
  },

  // Loads Strudel's scope, synths and default sample packs. Safe to call many times.
  init() {
    if (!ready) ready = prebake();
    return ready;
  },

  exclusive,

  // Called by a deck at the start of each of its evaluations.
  beginEvaluation(target) {
    evalTarget = target;
    patienceFrom = performance.now();
  },

  get audioContext() {
    return webaudio.getAudioContext();
  },

  // Must be called synchronously from a click or key handler: resume() is requested before
  // anything is awaited so the browser still counts it as part of the user's gesture.
  async ensureAudio() {
    const context = webaudio.getAudioContext();
    const resumed = context.state === 'running' ? null : context.resume();
    if (!audioInit) audioInit = webaudio.initAudio();
    await Promise.all([resumed, audioInit]);
    return context;
  },

  // Looks at the opening cycles of each track and reports the sample files it will need,
  // the soundfonts it uses, which sounds each track plays, and any sound no pack provides.
  scan(tracks, cycles = 8) {
    const urls = new Map();
    const fonts = new Map();
    const missing = new Set();
    const missingByTrack = new Map();
    const soundsByTrack = new Map();
    for (const track of tracks) {
      if (!track.pattern) continue;
      let haps = [];
      try {
        haps = track.pattern.queryArc(0, cycles);
      } catch (error) {
        console.warn(`[runtime] could not scan track ${track.name}`, error);
      }
      const sounds = new Map();
      soundsByTrack.set(track.index, sounds);
      for (const hap of haps) {
        const key = soundKey(hap.value);
        if (!key) continue;
        sounds.set(key, (sounds.get(key) || 0) + 1);
        const sound = webaudio.getSound(key);
        if (!sound) {
          missing.add(key);
          const list = missingByTrack.get(track.index) || [];
          if (!list.includes(key)) list.push(key);
          missingByTrack.set(track.index, list);
          continue;
        }
        const { type, samples } = sound.data || {};
        if (type === 'sample' && Array.isArray(samples) && samples.length) {
          const n = Math.floor(Number(hap.value.n) || 0);
          const url = samples[((n % samples.length) + samples.length) % samples.length];
          if (!urls.has(url)) urls.set(url, { s: key, n, tracks: new Set() });
          urls.get(url).tracks.add(track.index);
        } else if (type === 'soundfont' && !fonts.has(key)) {
          fonts.set(key, hap.value.note ?? hap.value.n ?? 60);
        }
      }
    }
    return { urls, fonts, missing, missingByTrack, soundsByTrack };
  },

  // Fetches and decodes the sample files ahead of the first bar so nothing is dropped.
  // Decoding works on a suspended AudioContext, so this can start before the first click.
  // Resolves to the files that could not be loaded or decoded.
  warmSamples({ urls }, onProgress) {
    const context = webaudio.getAudioContext();
    let done = 0;
    const total = urls.size;
    const failed = [];
    onProgress?.(done, total);
    const jobs = [...urls].map(([url, { s, n, tracks }]) =>
      webaudio
        .loadBuffer(url, context, s, n)
        .catch((error) => {
          console.warn('[runtime] sample failed', url, error);
          failed.push({ url, s, n, tracks });
        })
        .finally(() => onProgress?.(++done, total)),
    );
    return Promise.all(jobs).then(() => failed);
  },

  // Soundfonts only load when first triggered, so trigger each once, inaudibly.
  warmFonts(scan) {
    if (!scan) return Promise.resolve();
    const context = webaudio.getAudioContext();
    const jobs = [...scan.fonts].map(([s, note]) =>
      webaudio.superdough({ s, note, gain: 0.0001, release: 0.01 }, context.currentTime + 1, 0.05).catch(() => {}),
    );
    return Promise.all(jobs);
  },

  // Evaluates a song without playing it or touching either deck, and returns one pattern
  // per track. Used to draw the miniature punchcards in the beats list. Everything a song
  // could do to the outside world (tempo, sample loading, drawing) is stubbed out meanwhile.
  probe(code) {
    return exclusive(async () => {
      await this.init();
      const proto = core.Pattern.prototype;
      const collected = [];
      const quiet = () => core.silence;
      const stubs = {
        setcps: quiet,
        setCps: quiet,
        setcpm: quiet,
        setCpm: quiet,
        hush: quiet,
        all: quiet,
        each: quiet,
        samples: async () => {},
      };
      const savedGlobals = Object.fromEntries(Object.keys(stubs).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
      const savedProto = Object.fromEntries(['p', 'draw', ...WIDGETS].map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)]));
      const savedTarget = evalTarget;

      Object.assign(globalThis, stubs);
      proto.p = function (id) {
        if (typeof id === 'string' && (id.startsWith('_') || id.endsWith('_'))) return core.silence;
        collected.push(this);
        return this;
      };
      const passthrough = function () {
        return this;
      };
      proto.draw = passthrough;
      for (const type of WIDGETS) proto[type] = passthrough;
      evalTarget = { sliderStore: {} };

      try {
        const { pattern } = await core.evaluate(code, transpilerPkg.transpiler, { id: 'probe' });
        return collected.length ? collected : core.isPattern(pattern) ? [pattern] : [];
      } finally {
        evalTarget = savedTarget;
        for (const [name, descriptor] of Object.entries(savedGlobals)) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else delete globalThis[name];
        }
        for (const [name, descriptor] of Object.entries(savedProto)) {
          if (descriptor) Object.defineProperty(proto, name, descriptor);
          else delete proto[name];
        }
      }
    });
  },
};
