// Video clips. "Make a video clip" records a short video of the code lighting up in time with
// the music, with the song's title, credit, tempo and address, ready to post. The editor's
// page cannot be captured, so the code is drawn again on a canvas of its own; the mix is
// taken from the master bus before the volume knob; MediaRecorder writes the two into one
// file, on this device. Nothing is uploaded. The pure parts (sizes, timing, layout, which
// tokens are lit) are in clip-core.js.
import { runtime, steadyTimers } from './runtime.js';
import { master } from './master.js';
import { analyze } from './analyze.js';
import { saveBlob } from './recorder.js';
import {
  pickMimeType,
  fileExtension,
  FORMATS,
  resolutionFor,
  frameLayout,
  clipFilename,
  describeClip,
  siteAddress,
  audibleCycle,
  nextBarLine,
  clipPhase,
  lengthOptions,
  defaultBars,
  HapWindow,
  tokenizeLines,
  lineIndexAt,
  rectsFor,
  spanOf,
  fitCode,
  ClipCamera,
  viewTop,
  fitTitle,
} from './clip-core.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const FPS = 30;
// the count-in lasts at least this long, in seconds, then runs to the next bar line
const COUNT_IN = 1.2;
const until = async (test, ms) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (test()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return test();
};

function supported() {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    typeof AudioContext !== 'undefined' &&
    typeof AudioContext.prototype.createMediaStreamDestination === 'function'
  );
}

/* ---------- drawing ---------- */

// The colours of the stage (css/tokens.css), read once the page has its styles.
function palette() {
  const c = {
    bg: css('--hb-bg') || '#222222',
    deep: css('--hb-bg-deep') || '#191919',
    raise: css('--hb-raise') || '#2c2c2b',
    line: css('--hb-line') || '#3a3a38',
    ink: css('--hb-ink') || '#eceae4',
    ink2: css('--hb-ink-2') || '#c6c4bd',
    ink3: css('--hb-ink-3') || '#9d9b94',
    ink4: css('--hb-ink-4') || '#85837d',
    ink5: css('--hb-ink-5') || '#55534f',
    accent: css('--hb-accent') || '#ff6b35',
    mono: css('--hb-mono') || 'monospace',
    sans: css('--hb-sans') || 'sans-serif',
  };
  // the same inks as the stage's syntax colours (stage.js)
  c.kinds = { comment: c.ink4, string: c.ink, number: c.ink2, keyword: c.ink3, label: c.ink, name: c.ink2, property: c.ink3, punct: c.ink4 };
  return c;
}

// #rrggbb → [r, g, b]
const rgb = (hex) => {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((d) => d + d).join('') : value;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
};
// a mix of two colours, like CSS color-mix: `t` of b in a
const mix = (a, b, t) => {
  const [x, y] = [rgb(a), rgb(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * Math.min(1, Math.max(0, t)))).join(',')})`;
};
const alpha = (hex, a) => `rgba(${rgb(hex).join(',')},${a})`;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

// The site's mark: five squares, the middle one lit.
function drawMark(ctx, x, y, size, c) {
  const u = size / 20;
  const squares = [
    [1, 2, 1],
    [14, 2, 0.45],
    [1, 14, 0.45],
    [14, 14, 1],
  ];
  ctx.fillStyle = c.ink;
  for (const [sx, sy, a] of squares) {
    ctx.globalAlpha = a;
    ctx.fillRect(x + sx * u, y + sy * u, 5 * u, 4 * u);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = c.accent;
  ctx.fillRect(x + 7.5 * u, y + 8 * u, 5 * u, 4 * u);
}

/* ---------- the clip maker ---------- */

export const clip = {
  els: null,
  hooks: {},
  type: null,
  format: '9:16',
  // the length chosen in the sheet; null until someone picks one
  bars: null,
  // the deck whose code is drawn
  player: null,
  // the clip being made: counting in, recording, or finishing
  take: null,
  // the finished clip, until it is downloaded, shared or discarded
  result: null,
  timer: null,
  canvas: null,
  ctx: null,
  colors: null,
  view: null,
  hits: new HapWindow(),
  camera: new ClipCamera(),
  lastCycle: null,
  lastFrame: 0,
  taps: null,

  get supported() {
    return Boolean(this.type);
  },
  // counting in or recording
  get active() {
    return Boolean(this.take) && !this.take.done;
  },
  get recording() {
    return this.active;
  },
  get open() {
    return Boolean(this.els?.dialog.open);
  },
  // something to put away when the visitor loses access
  get busy() {
    return this.active || this.open || Boolean(this.result);
  },

  // hooks: {
  //   players                the two decks
  //   source()               the deck to film when none is given: the one being heard
  //   canUse()               may this visitor make clips (signed in, on the main site)
  //   status(message)        say something on the stage
  //   event(name, params)    analytics
  // }
  init(hooks) {
    this.hooks = hooks;
    const els = {
      dialog: $('clip'),
      close: $('clip-close'),
      frame: $('clip-frame'),
      video: $('clip-video'),
      setup: $('clip-setup'),
      formats: [...document.querySelectorAll('[data-clip-format]')],
      lengths: $('clip-lengths'),
      note: $('clip-note'),
      problem: $('clip-problem'),
      record: $('clip-record'),
      done: $('clip-done'),
      info: $('clip-info'),
      share: $('clip-share'),
      download: $('clip-download'),
      again: $('clip-again'),
      discard: $('clip-discard'),
      hud: $('clip-hud'),
      hudThumb: $('clip-hud-thumb'),
      hudText: $('clip-hud-text'),
      hudMeter: $('clip-hud-meter'),
      hudStop: $('clip-hud-stop'),
      hudCancel: $('clip-hud-cancel'),
    };
    this.els = els;
    this.type = supported() ? pickMimeType((type) => MediaRecorder.isTypeSupported(type)) : null;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'clip__canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Preview of the clip');
    this.ctx = this.canvas.getContext('2d');
    els.frame.prepend(this.canvas);

    els.close.addEventListener('click', () => els.dialog.close());
    els.dialog.addEventListener('click', (event) => event.target === els.dialog && els.dialog.close());
    els.dialog.addEventListener('close', () => this.onSheetClosed());
    for (const button of els.formats) button.addEventListener('click', () => this.setFormat(button.dataset.clipFormat));
    els.record.addEventListener('click', () => this.record());
    els.share.addEventListener('click', () => this.share());
    els.download.addEventListener('click', () => this.download());
    els.again.addEventListener('click', () => {
      this.discard();
      this.showSetup();
    });
    els.discard.addEventListener('click', () => {
      this.discard();
      els.dialog.close();
    });
    els.hudStop.addEventListener('click', () => this.stop());
    els.hudCancel.addEventListener('click', () => this.cancel());

    // the deck being filmed: a new song on it, or the music stopping, ends the clip
    for (const player of hooks.players || []) {
      // (a clip that is already being finished is kept)
      const filming = () => this.active && this.take.player === player && this.take.state !== 'finishing';
      const changed = 'The song changed, so the clip was cancelled.';
      player.on('song', () => filming() && this.cancel(changed));
      // (a deck stops before it loads another song)
      player.on('toggle', (started) => !started && filming() && (player.loadToken !== this.take.loadToken ? this.cancel(changed) : this.musicStopped()));
    }
    // leaving the page while a clip records: the browser asks first
    window.addEventListener('beforeunload', (event) => {
      if (!this.active) return;
      event.preventDefault();
      event.returnValue = '';
    });
  },

  /* ---------- the sheet ---------- */

  // Open the clip maker for a deck (or the one being heard). A finished clip is shown again
  // until it is put away.
  open(player = null) {
    if (!this.hooks.canUse?.()) return;
    if (this.active) return this.hooks.status?.('A clip is being recorded. Press Stop to keep it, or Cancel.');
    this.player = player || this.hooks.source?.() || null;
    if (this.result) this.showDone();
    else this.showSetup();
    if (!this.els.dialog.open) this.els.dialog.showModal();
  },

  close() {
    if (this.els?.dialog.open) this.els.dialog.close();
  },

  onSheetClosed() {
    this.els.video.pause();
    if (!this.active) this.stopLoop();
  },

  showSetup() {
    const { els } = this;
    els.setup.hidden = false;
    els.done.hidden = true;
    els.video.hidden = true;
    els.video.removeAttribute('src');
    this.canvas.hidden = false;
    if (this.canvas.parentNode !== els.frame) els.frame.prepend(this.canvas);
    els.dialog.classList.remove('is-done');
    this.renderChoices();
    this.size();
    this.startLoop();
  },

  // Shape and length: the chips in the sheet.
  renderChoices() {
    const { els } = this;
    for (const button of els.formats) button.setAttribute('aria-pressed', String(button.dataset.clipFormat === this.format));
    const options = lengthOptions(this.cps());
    if (!options.some((option) => option.bars === this.bars)) this.bars = null;
    const chosen = this.bars ?? defaultBars(this.cps(), options);
    els.lengths.replaceChildren(
      ...options.map(({ bars, seconds }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chipbtn';
        button.textContent = `${bars} bars · ${Math.round(seconds)} s`;
        button.setAttribute('aria-pressed', String(bars === chosen));
        button.addEventListener('click', () => {
          this.bars = bars;
          this.renderChoices();
        });
        return button;
      }),
    );
    const problem = this.problem(this.player);
    if (els.problem.textContent !== problem) els.problem.textContent = problem;
    els.problem.hidden = !problem;
    els.record.disabled = Boolean(problem);
  },

  // Why a clip of this deck cannot be made now ('' when it can).
  problem(player) {
    if (!this.supported) return 'This browser cannot record video here. Chrome, Edge, Firefox and Safari can.';
    if (!player?.song) return 'Load a beat first.';
    if (player.gated) return 'Run the song first.';
    // a song that did not compile never starts (one with a mistake in an edit plays on)
    if (player.failure && !player.ready) return 'This song did not run. Fix the code first.';
    return '';
  },

  setFormat(format) {
    if (!FORMATS[format]) return;
    this.format = format;
    this.renderChoices();
    this.size();
  },

  // The tempo the clip's length is worked out from.
  cps() {
    const player = this.player;
    if (player?.ready && player.cps > 0) return player.cps;
    if (player?.song?.bpm) return player.song.bpm / 240;
    return 0.5;
  },

  // Size the canvas for the chosen shape (and file type).
  size(format = this.format) {
    const { width, height, scale } = resolutionFor(format, this.type);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.view = { format, scale, box: frameLayout(format), code: null, title: null };
    this.colors ??= palette();
    this.camera.reset();
    this.hits.reset();
    this.lastCycle = null;
  },

  /* ---------- recording ---------- */

  // Record a clip: start the music if need be, count in to the next bar line, record `bars`
  // bars. Resolves to { blob, type, width, height, seconds } (null if it was cancelled).
  // With `save: false` (for tests) the result is only returned, not shown in the sheet.
  async record({ bars = null, format = this.format, save = true } = {}) {
    if (this.active || !this.hooks.canUse?.()) return null;
    const player = this.player || this.hooks.source?.();
    if (this.problem(player)) {
      this.renderChoices();
      return null;
    }
    this.player = player;
    this.format = FORMATS[format] ? format : '9:16';
    const length = bars ?? this.bars ?? defaultBars(this.cps());
    // still inside the click: the browser lets the music start
    const playing = player.started ? true : player.play();
    this.discard();
    this.close();
    this.size();
    const take = { player, bars: length, format: this.format, type: this.type, save, state: 'starting', chunks: [], done: false, loadToken: player.loadToken };
    this.take = take;
    this.showHud();
    this.startLoop();
    const result = new Promise((resolve) => (take.resolve = resolve));

    const going = () => player.started || take.done;
    if (!(await Promise.resolve(playing).catch(() => false)) && !going()) {
      // a song still loading does not start by itself: start it once it is ready (the click
      // has already asked for the sound)
      await until(() => player.ready || player.failure || going(), 30000);
      if (!going() && player.ready && !player.busy) player.play().catch(() => {});
      await until(() => going() || (player.failure && !player.ready), 15000);
    }
    if (take.done) return result;
    if (!player.started) {
      this.cancel('The music did not start, so nothing was recorded.');
      return result;
    }
    try {
      this.begin(take);
    } catch (error) {
      console.warn('[clip] could not start recording', error);
      this.cancel('This browser could not record the clip.');
    }
    return result;
  },

  // Wire the canvas and the mix into a MediaRecorder and work out the first bar line. It
  // starts writing when the bar line is heard (see tick).
  begin(take) {
    const context = runtime.audioContext;
    master.attach();
    const source = master.mix;
    if (!source || context.state !== 'running' || !this.tap()) throw new Error('the audio is not running');
    this.taps.destination ??= context.createMediaStreamDestination();
    source.connect(this.taps.destination);
    take.source = source;
    take.context = context;
    take.onState = () => context.state !== 'running' && take.state !== 'finishing' && this.cancel('The sound stopped, so the clip was cancelled.');
    context.addEventListener('statechange', take.onState);

    const { width, height } = this.canvas;
    take.width = width;
    take.height = height;
    take.video = this.canvas.captureStream(FPS);
    const stream = new MediaStream([...take.video.getVideoTracks(), ...this.taps.destination.stream.getAudioTracks()]);
    const recorder = new MediaRecorder(stream, { mimeType: take.type, videoBitsPerSecond: width >= 1080 ? 8_000_000 : 5_000_000, audioBitsPerSecond: 160_000 });
    recorder.ondataavailable = (event) => event.data?.size && take.chunks.push(event.data);
    recorder.onerror = (event) => {
      console.warn('[clip] the recorder failed', event.error || event);
      this.cancel('The clip could not be recorded here.');
    };
    take.recorder = recorder;

    const player = take.player;
    const cps = player.cps;
    take.start = nextBarLine(this.audible(player), { shift: player.offset + player.nudge, lead: COUNT_IN * cps });
    take.end = take.start + take.bars;
    take.state = 'counting';
  },

  // The clip's own view of the mix, before the volume knob: an analyser for the scope (left
  // connected), and a stream for the recorder (connected only while recording).
  tap() {
    const source = master.mix;
    if (!source) return null;
    if (this.taps?.source !== source) {
      const analyser = new AnalyserNode(source.context, { fftSize: 2048, smoothingTimeConstant: 0.6 });
      source.connect(analyser);
      this.taps = { source, analyser, wave: new Float32Array(analyser.fftSize), destination: null };
    }
    return this.taps;
  },

  // The cycle being heard on a deck right now (null when it is not playing).
  audible(player) {
    if (!player?.started) return null;
    const scheduler = player.scheduler;
    return audibleCycle({ now: scheduler.now(), cps: scheduler.cps, latency: scheduler.latency ?? 0.1, tick: scheduler.clock?.duration ?? 0.05 });
  },

  // Stop: keep what has been recorded, but always at least one bar.
  stop() {
    const take = this.take;
    if (!take || take.done) return;
    if (take.state !== 'recording') return this.cancel();
    const now = this.audible(take.player);
    take.end = now === null ? take.end : Math.max(take.start + 1, Math.min(take.end, now));
    if (now === null || now >= take.end) this.finish();
  },

  // The deck being filmed stopped: keep the clip if a bar or more was recorded.
  musicStopped() {
    const take = this.take;
    if (take.state === 'recording' && take.lastCycle - take.start >= 1) this.finish();
    else this.cancel('The music stopped before a whole bar was recorded.');
  },

  finish() {
    const take = this.take;
    if (!take || take.done || take.state === 'finishing') return;
    take.state = 'finishing';
    const recorder = take.recorder;
    if (!recorder || recorder.state === 'inactive') return this.cancel();
    take.seconds = (Math.min(take.lastCycle, take.end) - take.start) / Math.max(1e-6, take.player.cps);
    recorder.onstop = () => {
      const blob = new Blob(take.chunks, { type: take.type });
      const result = { blob, type: take.type, width: take.width, height: take.height, seconds: take.seconds, bars: take.bars, format: take.format };
      this.end(take);
      if (take.save) this.keep(result, take);
      take.resolve(result);
    };
    try {
      recorder.stop();
    } catch {
      this.cancel('The clip could not be finished.');
    }
  },

  // Throw away the clip being made (with a word about why, if there is one).
  cancel(message = '') {
    const take = this.take;
    if (take && !take.done) {
      if (take.recorder) {
        take.recorder.ondataavailable = null;
        take.recorder.onstop = null;
        take.recorder.onerror = null;
        if (take.recorder.state !== 'inactive') {
          try {
            take.recorder.stop();
          } catch {
            /* already stopped */
          }
        }
      }
      this.end(take);
      take.resolve(null);
      if (message) this.hooks.status?.(message);
    } else if (!take) {
      // nothing recording: put the sheet and any finished clip away
      this.discard();
      this.close();
    }
  },

  // Let go of everything a take holds.
  end(take) {
    take.done = true;
    take.video?.getTracks().forEach((track) => track.stop());
    if (take.source && this.taps?.destination) {
      try {
        take.source.disconnect(this.taps.destination);
      } catch {
        /* already disconnected */
      }
    }
    if (take.onState) take.context.removeEventListener('statechange', take.onState);
    if (this.take === take) this.take = null;
    this.hideHud();
    if (!this.open) this.stopLoop();
  },

  /* ---------- the finished clip ---------- */

  keep(result, take) {
    const song = take.player.song;
    const name = clipFilename({ title: song?.title, type: result.type });
    // made now, not when Share is pressed: a phone only shares from inside the tap
    const file = new File([result.blob], name, { type: result.type.split(';')[0] });
    this.result = { ...result, name, title: song?.title || 'Hack The Beats', file, url: URL.createObjectURL(result.blob), shareable: this.canShareFile(file) };
    this.showDone();
    if (!this.els.dialog.open) this.els.dialog.showModal();
  },

  canShareFile(file) {
    try {
      return typeof navigator.share === 'function' && Boolean(navigator.canShare?.({ files: [file] }));
    } catch {
      return false;
    }
  },

  showDone() {
    const { els, result } = this;
    if (!result) return this.showSetup();
    els.setup.hidden = true;
    els.done.hidden = false;
    this.canvas.hidden = true;
    els.video.hidden = false;
    if (els.video.src !== result.url) els.video.src = result.url;
    els.video.play?.().catch(() => {});
    els.dialog.classList.add('is-done');
    els.info.textContent = describeClip({ type: result.type, width: result.width, height: result.height, size: result.blob.size, seconds: result.seconds });
    els.share.hidden = !result.shareable;
    els.download.classList.toggle('pillbtn--go', !result.shareable);
    this.stopLoop();
  },

  share() {
    const result = this.result;
    if (!result?.shareable) return;
    navigator
      .share({ files: [result.file], title: result.title })
      .then(() => this.exported('share'))
      .catch((error) => error?.name !== 'AbortError' && this.hooks.status?.('That did not work here: download the clip instead.'));
  },

  download() {
    const result = this.result;
    if (!result) return;
    saveBlob(result.blob, result.name);
    this.exported('download');
    this.hooks.status?.(`Saved ${result.name}`);
  },

  exported(method) {
    const result = this.result;
    this.hooks.event?.('clip_export', { method, format: result.format, bars: result.bars, file_type: fileExtension(result.type) });
  },

  discard() {
    if (!this.result) return;
    this.els.video.pause();
    this.els.video.removeAttribute('src');
    // (lets the browser drop the decoded video too)
    this.els.video.load();
    URL.revokeObjectURL(this.result.url);
    this.result = null;
  },

  /* ---------- the pill on the stage while a clip records ---------- */

  showHud() {
    const { els } = this;
    this.canvas.hidden = false;
    els.hudThumb.append(this.canvas);
    els.hud.hidden = false;
    this.renderHud(null);
  },

  hideHud() {
    const { els } = this;
    els.hud.hidden = true;
    if (this.canvas.parentNode !== els.frame) els.frame.prepend(this.canvas);
  },

  renderHud(now) {
    const take = this.take;
    if (!take) return;
    const { els } = this;
    let text = 'Starting the music…';
    let progress = 0;
    if (take.start !== undefined && now !== null) {
      const phase = clipPhase({ now, start: take.start, bars: take.bars });
      text = phase.phase === 'count-in' ? `Starting in ${phase.beats}` : `Bar ${Math.min(phase.bar, take.bars)} of ${take.bars}`;
      progress = phase.progress;
    }
    if (take.state === 'finishing') text = 'Finishing…';
    if (els.hudText.textContent !== text) els.hudText.textContent = text;
    els.hudMeter.style.setProperty('--progress', progress.toFixed(3));
    els.hudStop.disabled = take.state !== 'recording';
    els.hud.classList.toggle('is-live', take.state === 'recording');
  },

  /* ---------- the frame loop ---------- */

  // Frames are drawn from the worker timers the scheduler uses, so they carry on in a
  // background tab.
  startLoop() {
    if (this.timer) return;
    this.timer = steadyTimers.setInterval(() => this.tick(), 1000 / FPS);
  },
  stopLoop() {
    if (!this.timer) return;
    steadyTimers.clearInterval(this.timer);
    this.timer = null;
  },

  tick() {
    const take = this.take;
    const player = take?.player ?? this.player;
    const now = this.audible(player);
    try {
      this.draw(player, now);
    } catch (error) {
      if (!this.drawFailed) console.warn('[clip] a frame could not be drawn', error);
      this.drawFailed = true;
    }
    if (!take || take.done) return;
    if (now !== null) take.lastCycle = now;
    if (take.state === 'counting' && now !== null && now >= take.start - player.cps / FPS) {
      // the bar line is within a frame: start writing
      try {
        take.recorder.start();
      } catch (error) {
        console.warn('[clip] could not start recording', error);
        return this.cancel('This browser could not record the clip.');
      }
      take.state = 'recording';
    } else if (take.state === 'recording' && now !== null && now >= take.end) {
      this.finish();
    }
    this.renderHud(now);
  },

  /* ---------- one frame ---------- */

  draw(player, now) {
    if (!this.view) this.size();
    const { ctx, canvas, colors: c, view } = this;
    const S = view.scale;
    const box = view.box;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(S, 0, 0, S, 0, 0);
    const song = player?.song;
    if (!song) return;

    const cps = player.cps > 0 ? player.cps : 0.5;
    const code = this.codeLayout(player);
    // what is lit: everything the pattern holds since the last frame
    let lit = new Set();
    if (now !== null) {
      const from = this.lastCycle !== null && this.lastCycle <= now ? Math.max(this.lastCycle, now - 1) : now - 0.05;
      lit = this.hits.update(this.query(player, from, now), now, cps);
    } else if (this.lastCycle !== null) {
      this.hits.reset();
      this.camera.reset();
    }
    this.lastCycle = now;
    const dt = Math.min(0.25, (performance.now() - (this.lastFrame || performance.now())) / 1000);
    this.lastFrame = performance.now();

    this.drawCode(player, code, lit, now, cps, dt);
    this.drawHeader(player, now);
    this.drawScope(box.scope, now !== null);
    this.drawFooter(song);
  },

  query(player, from, to) {
    const pattern = player.scheduler?.pattern;
    if (!pattern || !(to > from)) return [];
    let haps;
    try {
      haps = pattern.queryArc(from, to);
    } catch {
      return [];
    }
    const out = [];
    for (const hap of haps) {
      if (!hap.whole) continue;
      out.push({ begin: hap.whole.begin.valueOf(), end: hap.whole.end.valueOf(), ids: (hap.context?.locations || []).map(({ start, end }) => `${start}:${end}`), track: hap.context?.track });
    }
    return out;
  },

  // The code laid out for this shape, worked out again only when it changes.
  codeLayout(player) {
    const view = this.view;
    const stage = player.stage;
    const doc = stage.view.state.doc;
    const spots = stage.visuals();
    const visualsKey = spots.map((spot) => {
      const canvas = runtime.visualCanvas(spot.id);
      return `${spot.id}@${spot.pos}:${canvas?.width || 0}x${canvas?.height || 0}`;
    }).join('|');
    const take = this.take;
    const locked = take && !take.done && take.size ? take.size : null;
    const cached = view.code;
    if (cached && cached.doc === doc && cached.visualsKey === visualsKey && cached.locked === locked) return cached;

    const ctx = this.ctx;
    ctx.font = `400 100px ${this.colors.mono}`;
    const charRatio = ctx.measureText('M').width / 100 || 0.6;
    const text = doc.toString();
    const lines = tokenizeLines(text);
    const visuals = [];
    for (const spot of spots) {
      const canvas = runtime.visualCanvas(spot.id);
      if (!canvas?.width || !canvas.height) continue;
      visuals.push({ line: lineIndexAt(lines, spot.pos), id: spot.id, aspect: canvas.height / canvas.width, pos: spot.pos });
    }
    const box = view.box.code;
    const sizes = locked ? { sizes: [locked], fallback: locked } : { sizes: box.sizes, fallback: box.fallback };
    const fit = fitCode(lines, { width: box.w - 24, height: box.h, charRatio, lineRatio: 1.6, visuals, ...sizes });
    if (take && !take.done && !take.size) take.size = fit.size;
    // which lines and visuals each track covers
    const tracks = stage.state.tracks
      .filter((track) => track.from < track.to && track.to <= text.length)
      .map((track) => ({ ...track, first: lineIndexAt(lines, track.from), last: lineIndexAt(lines, Math.max(track.from, track.to - 1)) }));
    for (const track of tracks) track.span = spanOf(fit.layout, track.first, track.last);
    const trackOf = (pos) => tracks.find((track) => pos >= track.from && pos <= track.to)?.index ?? null;
    const visualTrack = new Map(visuals.map((visual) => [visual.id, trackOf(visual.pos)]));
    view.code = { doc, visualsKey, locked, lines, fit, tracks, visualTrack, text };
    return view.code;
  },

  drawCode(player, code, lit, now, cps, dt) {
    const { ctx, colors: c, view } = this;
    const box = view.box.code;
    const { fit, lines, tracks } = code;
    const { lineHeight: lh, charWidth: cw, size } = fit;
    const x0 = box.x + 24;
    const total = fit.layout.height;
    const visibleRows = box.h / lh;

    // follow the music when the code does not fit
    let top = 0;
    if (!fit.fits && now !== null) {
      const heard = tracks.filter((track) => player.mixer.audible(track.index) && this.hits.onsets.get(track.index) >= now - 1.25).map((track) => track.index);
      const focus = this.camera.pick(now + player.offset, heard);
      const span = tracks.find((track) => track.index === focus)?.span;
      top = this.camera.glide(viewTop({ top: span ? span.top : 0, view: visibleRows, total }), dt);
    } else if (!fit.fits) {
      top = this.camera.top ?? 0;
    }
    const yOf = (row) => box.y + (row - top) * lh;
    const shown = (y, h) => y + h > box.y - lh && y < box.y + box.h + lh;

    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x - 8, box.y - 4, box.w + 8, box.h + 8);
    ctx.clip();

    // track bars down the left, pulsing with each note; muted tracks recede
    const muted = new Set(tracks.filter((track) => !player.mixer.audible(track.index)).map((track) => track.index));
    for (const track of tracks) {
      if (!track.span) continue;
      const level = now === null ? 0 : this.hits.level(track.index, now, cps);
      const y = yOf(track.span.top);
      const h = (track.span.bottom - track.span.top) * lh;
      if (!shown(y, h)) continue;
      ctx.globalAlpha = muted.has(track.index) ? 0.3 : 1;
      ctx.fillStyle = mix(c.line, c.accent, level);
      ctx.fillRect(box.x, y + lh * 0.12, 4, h - lh * 0.24);
      // the label, lit like the stage's .hb-label
      for (const rect of rectsFor(fit.layout, track.labelFrom, track.labelTo)) {
        ctx.fillStyle = mix(c.raise, c.accent, level * 0.55);
        roundRect(ctx, x0 + rect.x * cw - 4, yOf(rect.y) + lh * 0.14, rect.w * cw + 8, lh * 0.72, 5);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // the tokens sounding now: orange boxes, as on the stage
    const where = player.stage.locations();
    const litRects = [];
    for (const id of lit) {
      const range = where.get(id);
      if (!range) continue;
      for (const rect of rectsFor(fit.layout, range[0], range[1])) litRects.push(rect);
    }
    ctx.lineWidth = 2;
    for (const rect of litRects) {
      const y = yOf(rect.y);
      if (!shown(y, lh)) continue;
      roundRect(ctx, x0 + rect.x * cw - 2, y + lh * 0.16, rect.w * cw + 4, lh * 0.68, 3);
      ctx.fillStyle = alpha(c.accent, 0.26);
      ctx.fill();
      ctx.strokeStyle = c.accent;
      ctx.stroke();
    }

    // the text
    const numbers = [...player.stage.state.sliders, ...player.stage.state.switches].filter(({ from, to }) => from < to);
    const isNumber = (from, to) => numbers.some((range) => from >= range.from && to <= range.to);
    const trackOfLine = (line) => tracks.find((track) => line >= track.first && line <= track.last)?.index;
    ctx.textBaseline = 'middle';
    const fonts = {
      normal: `400 ${size}px ${c.mono}`,
      italic: `italic 400 ${size}px ${c.mono}`,
      bold: `600 ${size}px ${c.mono}`,
    };
    let font = '';
    const setFont = (name) => {
      if (font !== name) ctx.font = fonts[(font = name)];
    };
    for (const row of fit.layout.rows) {
      const y = yOf(row.y);
      if (!shown(y, row.kind === 'visual' ? row.height * lh : lh)) continue;
      if (row.kind === 'visual') {
        const canvas = runtime.visualCanvas(row.id);
        const drawn = fit.visuals.get(row.id);
        if (!canvas?.width || !drawn) continue;
        const track = code.visualTrack.get(row.id);
        ctx.globalAlpha = track !== null && muted.has(track) ? 0.18 : 1;
        ctx.drawImage(canvas, x0, y + lh * 0.2, drawn.width, drawn.height);
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.globalAlpha = muted.has(trackOfLine(row.line)) ? 0.3 : 1;
      const mid = y + lh / 2;
      for (const token of lines[row.line].tokens) {
        if (token.to <= row.from || token.from >= row.to) continue;
        const from = Math.max(token.from, row.from);
        const to = Math.min(token.to, row.to);
        const x = x0 + (row.indent + from - row.from) * cw;
        const number = token.kind === 'number' && isNumber(from, to);
        setFont(token.kind === 'comment' ? 'italic' : token.kind === 'label' ? 'bold' : 'normal');
        ctx.fillStyle = number ? c.accent : c.kinds[token.kind] || c.ink2;
        ctx.fillText(code.text.slice(from, to), x, mid);
        if (number) {
          // the stage's dashed underline under a number the deck owns
          ctx.fillStyle = alpha(c.accent, 0.7);
          for (let dash = x; dash < x + (to - from) * cw; dash += 8) ctx.fillRect(dash, mid + size * 0.62, 4, 1.5);
        }
      }
    }
    ctx.globalAlpha = 1;
    // lit tokens read white, over their box
    setFont('normal');
    ctx.fillStyle = '#ffffff';
    for (const id of lit) {
      const range = where.get(id);
      if (!range) continue;
      for (const rect of rectsFor(fit.layout, range[0], range[1])) {
        const y = yOf(rect.y);
        if (!shown(y, lh)) continue;
        const row = fit.layout.code.find((entry) => entry.y === rect.y);
        if (!row) continue;
        const from = row.from + rect.x - row.indent;
        ctx.fillText(code.text.slice(from, from + rect.w), x0 + rect.x * cw, y + lh / 2);
      }
    }
    ctx.restore();

    // code that runs on past the box fades out at its edges
    const fade = lh * 1.2;
    if (top > 0.01) {
      const gradient = ctx.createLinearGradient(0, box.y - 4, 0, box.y + fade);
      gradient.addColorStop(0, c.bg);
      gradient.addColorStop(1, alpha(c.bg, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(box.x - 8, box.y - 4, box.w + 8, fade + 4);
    }
    if ((total - top) * lh > box.h + 1) {
      const gradient = ctx.createLinearGradient(0, box.y + box.h - fade, 0, box.y + box.h + 4);
      gradient.addColorStop(0, alpha(c.bg, 0));
      gradient.addColorStop(1, c.bg);
      ctx.fillStyle = gradient;
      ctx.fillRect(box.x - 8, box.y + box.h - fade, box.w + 8, fade + 4);
    }
  },

  // Title, credit and tempo, and a bar for each bar of the clip.
  drawHeader(player, now) {
    const { ctx, colors: c, view } = this;
    const box = view.box.header;
    const song = player.song;
    const code = view.code;
    // the credit is the song's own @by, never an account's name
    if (!code.meta || code.meta.text !== code.text) code.meta = { text: code.text, by: analyze(code.text).meta?.by || null };
    const title = song.title || 'Untitled';
    if (view.title?.text !== title) {
      const font = (size) => `300 ${size}px ${c.sans}`;
      const measure = (text, size) => {
        ctx.font = font(size);
        return ctx.measureText(text).width;
      };
      view.title = { text: title, fit: fitTitle(title, box.w, measure, box.title), font };
    }
    const { fit, font } = view.title;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = c.ink;
    ctx.font = font(fit.size);
    ctx.fillText(fit.text, box.x - fit.size * 0.04, box.y + fit.size * 0.86);

    const bpm = player.ready ? Math.round(player.bpm) : song.bpm ? Math.round(song.bpm) : null;
    const credit = [code.meta.by ? `by ${code.meta.by}` : null, bpm ? `${bpm} BPM` : null].filter(Boolean).join('  ·  ');
    ctx.font = `400 28px ${c.mono}`;
    ctx.fillStyle = c.ink3;
    let shown = credit;
    while (shown.length > 4 && ctx.measureText(shown).width > box.w) shown = `${shown.slice(0, -2)}…`;
    ctx.fillText(shown, box.x, box.y + box.creditY);

    // the bars of the clip: done ones lit, the one playing filling up
    const take = this.take;
    const bars = take?.bars ?? this.bars ?? defaultBars(this.cps());
    const phase = take?.start !== undefined && now !== null ? clipPhase({ now, start: take.start, bars }) : null;
    const done = phase ? (phase.phase === 'recording' ? (now - take.start) : phase.phase === 'done' ? bars : 0) : 0;
    const gap = bars > 16 ? 4 : 8;
    const w = (box.w - gap * (bars - 1)) / bars;
    const y = box.y + box.barsY;
    for (let k = 0; k < bars; k++) {
      const x = box.x + k * (w + gap);
      ctx.fillStyle = c.line;
      ctx.fillRect(x, y, w, 8);
      const filled = Math.min(1, Math.max(0, done - k));
      if (filled > 0) {
        ctx.fillStyle = c.accent;
        ctx.fillRect(x, y, w * filled, 8);
      }
    }
  },

  // A scope of the whole mix, from the clip's own analyser.
  drawScope(box, playing) {
    const { ctx, colors: c } = this;
    const taps = playing ? this.tap() : null;
    const wave = taps ? (taps.analyser.getFloatTimeDomainData(taps.wave), taps.wave) : null;
    const mid = box.y + box.h / 2;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = wave ? alpha(c.ink, 0.55) : c.ink5;
    ctx.beginPath();
    if (!wave) {
      ctx.moveTo(box.x, mid);
      ctx.lineTo(box.x + box.w, mid);
    } else {
      // start on a rising zero crossing so the trace stands still
      let offset = 0;
      for (let i = 1; i < wave.length / 2; i++) {
        if (wave[i - 1] < 0 && wave[i] >= 0) {
          offset = i;
          break;
        }
      }
      const span = wave.length / 2;
      for (let x = 0; x <= box.w; x += 3) {
        const sample = wave[offset + Math.floor((x / box.w) * span)] || 0;
        const y = mid - Math.max(-1, Math.min(1, sample)) * box.h * 0.46;
        x === 0 ? ctx.moveTo(box.x + x, y) : ctx.lineTo(box.x + x, y);
      }
    }
    ctx.stroke();
  },

  // The site's mark and the address: the beat's own page, or the site.
  drawFooter(song) {
    const { ctx, colors: c, view } = this;
    const box = view.box.footer;
    const origin = this.hooks.origin?.() || location.origin;
    const address = siteAddress(origin, song.source === 'beats' ? song.slug : null);
    drawMark(ctx, box.x, box.y + 2, 36, c);
    ctx.textBaseline = 'middle';
    ctx.font = `400 30px ${c.mono}`;
    ctx.fillStyle = c.ink2;
    ctx.fillText(address, box.x + 54, box.y + box.h / 2);
  },
};
