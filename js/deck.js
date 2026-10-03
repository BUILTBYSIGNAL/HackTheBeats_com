// The controls section. Song knobs (one per slider() in the code) and channel strips (one
// per track, then one per snapshot playing on the deck) follow the deck in focus; pads,
// snapshot pads, crossfader and master act on the whole mix.
import { createKnob, createFader, createCrossfader, createPad, register } from './controls.js';
import { sliderReadout } from './analyze.js';
import { master } from './master.js';
import { persist } from './persist.js';
import { snapshots } from './snapshots.js';
import { SLOTS, BAR_CHOICES, DEFAULT_BARS, barsLabel } from './snapshots-core.js';

const percent = (v) => `${Math.round(v * 100)}%`;

export const deck = {
  els: {},
  app: null,
  player: null,
  knobs: [],
  switchKnobs: [],
  strips: [],
  snapStrips: [],
  snapPads: [],
  // how many bars ● captures
  captureBars: DEFAULT_BARS,
  // the snapshot the menu is open for
  menuFor: null,
  masterKnobs: {},
  pads: new Map(),
  // pads stay on until pressed again
  latch: false,
  crossfader: null,

  // app: { players, setTempo(multiplier), tempoTarget(), setSync(on), mix(), saveMaster(), capture(player, index, bars) }
  init(els, app) {
    this.els = els;
    this.app = app;
    this.buildMaster();
    this.buildPads();
    this.buildSnapPads();
    this.buildCaptureLength();
    this.buildSnapMenu();
    els.padTabs.forEach((tab) => tab.addEventListener('click', () => this.showBank(tab.dataset.bank)));
    snapshots.on((reason) => {
      this.syncSnapPads();
      // a new snapshot, or one waiting for a slot: show where it goes
      if (reason === 'kept' || (reason === 'pending' && snapshots.pending)) this.showBank('snaps');
      if (reason === 'capture') this.syncCapture();
      if (reason === 'change' && this.menuFor && !snapshots.get(this.menuFor)) this.els.snapSheet.close();
    });

    els.tabs.forEach((tab) => tab.addEventListener('click', () => this.showTab(tab.dataset.tab)));
    els.latch.addEventListener('click', () => this.setLatch(!this.latch));
    els.reset.addEventListener('click', () => this.player?.resetSong());

    for (const player of app.players) {
      const mine = (fn) => (...args) => player === this.player && fn(...args);
      player.on('song', mine(() => this.rebuild()));
      // the code was edited and re-evaluated: its knobs and channels may have changed
      player.on('structure', mine(() => this.rebuild()));
      player.on('mixer', mine(() => this.syncMixer()));
      // a snapshot came in or left: its channel strip, and every deck's pads
      player.on('snaps', mine(() => this.buildStrips()));
      player.on('snaps', () => this.syncSnapPads());
      player.on('mixer', () => this.syncSnapPads());
      player.on('slider', mine((k) => this.knobs[k]?.set(player.sliders[k].value)));
      player.on('switch', mine((j) => this.switchKnobs[j]?.set(player.switches[j].value)));
      player.on('pick-slider', mine((k) => this.focusKnob(this.knobs[k])));
      player.on('pick-switch', mine((j) => this.focusKnob(this.switchKnobs[j])));
      player.on('tempo', () => this.syncTempo());
    }
  },

  // Show the knobs and channels of this deck.
  bind(player) {
    this.player = player;
    this.els.deck.dataset.deck = player.id;
    this.rebuild();
  },

  rebuild() {
    this.buildKnobs();
    this.buildStrips();
    this.syncTempo();
  },

  /* ---------- song knobs ---------- */

  buildKnobs() {
    const { player } = this;
    const host = this.els.knobs;
    const { sliders, switches } = player;
    const count = sliders.length + switches.length;
    const size = count > 4 ? 'sm' : 'md';
    host.replaceChildren();
    host.classList.toggle('knobs--many', count > 4);
    this.els.knobsEmpty.hidden = count > 0 || !player.song;
    this.els.knobsIdle.hidden = Boolean(player.song);
    const { stage } = player;
    const lightUp = (knob, key) => {
      knob.el.addEventListener('pointerenter', () => stage.spotlight(key));
      knob.el.addEventListener('pointerleave', () => {
        if (!knob.dial.classList.contains('is-grabbed') && document.activeElement !== knob.dial) stage.spotlight(null);
      });
    };

    // Switches first: a plain number in the code that picks between named options.
    this.switchKnobs = switches.map((item) => {
      const label = (value) => item.options.find((option) => option.value === Math.round(value))?.label ?? String(value);
      const knob = createKnob({
        id: `switch:${item.j}`,
        size,
        label: item.title,
        sub: 'switch',
        hint: `${item.options.map((option) => `${option.value} ${option.label}`).join(' · ')} — turning it re-runs the song`,
        min: item.min,
        max: item.max,
        step: 1,
        value: item.value,
        defaultValue: item.defaultValue,
        format: label,
        onInput: (value) => player.setSwitch(item.j, value),
        onGrab: () => stage.spotlight(`s${item.j}`, { scroll: true }),
        onRelease: () => stage.spotlight(null),
      });
      knob.el.classList.add('knob--switch');
      lightUp(knob, `s${item.j}`);
      host.append(knob.el);
      return knob;
    });

    this.knobs = sliders.map((slider) => {
      const knob = createKnob({
        id: `knob:${slider.k}`,
        size,
        label: slider.title,
        sub: slider.sub,
        hint: `${slider.hint} · drag, scroll or use arrow keys · double-click to reset`,
        min: slider.min,
        max: slider.max,
        value: slider.value,
        defaultValue: slider.defaultValue,
        taper: slider.taper,
        step: slider.step,
        format: (value) => sliderReadout(slider, value),
        onInput: (value) => player.moveSlider(slider.k, value),
        onGrab: () => stage.spotlight(slider.k, { scroll: true }),
        onRelease: () => stage.spotlight(null),
      });
      lightUp(knob, slider.k);
      host.append(knob.el);
      return knob;
    });
  },

  focusKnob(knob) {
    if (!knob) return;
    this.showTab('knobs');
    knob.dial.focus();
    knob.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  },

  // Where the deck is not wide enough for both, the effect pads or the snapshot pads.
  showBank(name) {
    this.els.padbank.dataset.bank = name;
    this.els.padTabs.forEach((tab) => tab.setAttribute('aria-pressed', String(tab.dataset.bank === name)));
  },

  showTab(name) {
    this.els.deck.dataset.tab = name;
    this.els.tabs.forEach((tab) => tab.setAttribute('aria-pressed', String(tab.dataset.tab === name)));
  },

  /* ---------- channel strips ---------- */

  buildStrips() {
    const { player } = this;
    const { mixer, stage } = player;
    const host = this.els.strips;
    host.replaceChildren();
    this.els.stripsEmpty.hidden = mixer.tracks.length + mixer.snaps.length > 0 || !player.song;

    this.strips = mixer.tracks.map((track) => {
      const strip = this.makeStrip(track, track.index, `ch:${track.index}`);
      strip.name.setAttribute('aria-label', `Focus on ${track.name} in the code`);
      strip.name.addEventListener('click', () => {
        stage.setFocus(track.index);
        this.syncFocus();
      });
      strip.action.textContent = '●';
      strip.action.addEventListener('click', () => this.app.capture?.(player, track.index, this.captureBars));
      return strip;
    });
    // snapshots playing on this deck, after the song's own channels
    this.snapStrips = mixer.snaps.map((track) => {
      const strip = this.makeStrip(track, track.id, `snap:${track.id}`);
      strip.el.classList.add('strip--snap');
      strip.name.setAttribute('aria-label', `${track.name}: rename, pin or clear this snapshot`);
      strip.name.addEventListener('click', () => this.openSnapMenu(track.id));
      strip.action.textContent = '×';
      strip.action.addEventListener('click', () => {
        const entry = player.snaps.get(track.id);
        if (entry?.pinned) snapshots.pin(track.id, null);
        else player.removeSnap(track.id);
      });
      return strip;
    });
    this.syncMixer();
    this.syncFocus();
    this.syncCapture();
  },

  // One channel strip. `key` is what the mixer knows the channel by: a code track's
  // position, or a snapshot's id.
  makeStrip(track, key, id) {
    const { mixer } = this.player;
    const el = document.createElement('div');
    el.className = 'strip';
    el.innerHTML = `
      <div class="strip__top">
        <span class="strip__led" aria-hidden="true"></span>
        <button type="button" class="strip__action"></button>
      </div>
      <div class="strip__slot"><span class="strip__meter" aria-hidden="true"><span></span></span></div>
      <div class="strip__buttons">
        <button type="button" class="strip__btn strip__btn--mute" aria-pressed="false">M</button>
        <button type="button" class="strip__btn strip__btn--solo" aria-pressed="false">S</button>
      </div>
      <button type="button" class="strip__name" aria-pressed="false"></button>`;
    const [mute, solo] = el.querySelectorAll('.strip__btn');
    const name = el.querySelector('.strip__name');
    const action = el.querySelector('.strip__action');
    name.textContent = track.name;
    mute.setAttribute('aria-label', `Mute ${track.name}`);
    solo.setAttribute('aria-label', `Solo ${track.name}`);
    mute.addEventListener('click', () => mixer.setMute(key));
    solo.addEventListener('click', () => mixer.setSolo(key));
    register(`${id}:mute`, mute, { press: (down) => down && mixer.setMute(key) });
    register(`${id}:solo`, solo, { press: (down) => down && mixer.setSolo(key) });

    const fader = createFader({
      id: `${id}:level`,
      label: `${track.name} level`,
      min: 0,
      max: 1.25,
      value: track.gain,
      defaultValue: 1,
      format: percent,
      onInput: (value) => mixer.setGain(key, value),
    });
    el.querySelector('.strip__slot').append(fader.el);
    this.els.strips.append(el);
    return { el, mute, solo, fader, name, action, track };
  },

  // every strip on the deck, with the channel each one is for
  allStrips() {
    const { mixer } = this.player;
    return [...mixer.tracks.map((track, i) => [track, this.strips[i]]), ...mixer.snaps.map((track, i) => [track, this.snapStrips[i]])].filter(([track, strip]) => strip?.track === track);
  },

  syncMixer() {
    const { mixer } = this.player;
    for (const [track, strip] of this.allStrips()) {
      strip.mute.setAttribute('aria-pressed', String(track.mute));
      strip.solo.setAttribute('aria-pressed', String(track.solo));
      strip.el.classList.toggle('is-silent', !mixer.audible(track.isSnap ? track.id : track.index));
      strip.el.classList.toggle('is-missing', track.missingSounds.length > 0);
      strip.el.title = track.missingSounds.length
        ? `Not available from the sample packs, so it stays silent: ${track.missingSounds.join(', ')}`
        : track.disabled
          ? 'Switched off in the code — unmute to bring it in'
          : track.isSnap
            ? 'A snapshot playing on this deck'
            : '';
      strip.fader.set(track.gain);
    }
    if (this.snapStrips.length) {
      for (const strip of this.snapStrips) {
        const pinned = this.player.snaps.get(strip.track.id)?.pinned;
        strip.action.setAttribute('aria-label', pinned ? `Unpin ${strip.track.name} from this deck` : `Stop ${strip.track.name}`);
        strip.action.dataset.tip = pinned ? 'Unpin' : 'Stop at the next bar';
      }
    }
  },

  // The ● on each strip: ready, armed for the next bar line, or counting down the bars.
  syncCapture() {
    const capture = snapshots.capture;
    const progress = capture?.player === this.player ? snapshots.progress() : null;
    this.strips.forEach((strip, i) => {
      const mine = progress && capture.index === i;
      const state = mine ? progress.state : '';
      const text = mine ? String(progress.barsLeft) : '●';
      if (strip.capState === `${state}${text}`) return;
      strip.capState = `${state}${text}`;
      strip.action.dataset.state = state;
      strip.action.textContent = text;
      strip.action.setAttribute('aria-pressed', String(Boolean(mine)));
      strip.action.setAttribute(
        'aria-label',
        mine
          ? state === 'armed'
            ? `Capturing ${strip.track.name} from the next bar. Press again to let it go.`
            : `Capturing ${strip.track.name}: ${barsLabel(progress.barsLeft)} to go. Press again to let it go.`
          : `Capture ${barsLabel(this.captureBars)} of ${strip.track.name} into a snapshot pad`,
      );
    });
  },

  syncFocus() {
    const focus = this.player.stage.focus;
    this.strips.forEach((strip, i) => {
      strip.name.setAttribute('aria-pressed', String(focus === i));
      strip.el.classList.toggle('is-focus', focus === i);
    });
  },

  // Called every frame while the deck in focus plays.
  setLevels() {
    if (snapshots.capture) this.syncCapture();
    for (const [track, strip] of this.allStrips()) {
      const level = Math.round(track.level * 20) / 20;
      // the meter is drawn on a square-root scale so quiet parts still register
      const meter = Math.round(Math.sqrt(track.meter) * 40) / 40;
      if (strip.level !== level) {
        strip.level = level;
        strip.el.style.setProperty('--lv', String(level));
      }
      if (strip.meter !== meter) {
        strip.meter = meter;
        strip.el.style.setProperty('--m', String(meter));
      }
    }
  },

  /* ---------- pads ---------- */

  buildPads() {
    const { players } = this.app;
    const each = (name) => (on) => players.forEach((player) => player.setFx(name, on));
    const pads = [
      { name: 'echo', label: 'Echo', key: 'Q', hint: 'Throw the whole mix into the echo', onChange: (on) => master.hold('echo', on) },
      { name: 'drop', label: 'Drop', key: 'W', hint: 'The filter falls away; let go and everything slams back', onChange: (on) => master.hold('drop', on) },
      { name: 'wash', label: 'Wash', key: 'E', hint: 'Drown the mix in reverb', onChange: (on) => master.hold('wash', on) },
      { name: 'half', label: 'Half', key: 'A', hint: 'Half-time for as long as you hold it', onChange: each('half') },
      { name: 'stutter', label: 'Stutter', key: 'S', hint: 'Repeat the eighth of a bar you pressed it in', onChange: each('stutter') },
      { name: 'drums', label: 'No drums', key: 'D', hint: 'Pull the drums out', onChange: each('killDrums') },
    ];
    for (const { name, label, key, hint, onChange } of pads) {
      const pad = createPad({ id: `pad:${name}`, label, hint: `${hint} · hold, or Shift-click to latch`, keyHint: key, onChange, latchMode: () => this.latch });
      this.els.pads.append(pad.el);
      this.pads.set(key.toLowerCase(), pad);
    }
  },

  /* ---------- snapshots ---------- */

  // Eight pads, one per slot. A tap brings the snapshot in on the next bar (or stops it at
  // the next bar), Shift-tap plays it once, and a right-click or long press opens its menu.
  buildSnapPads() {
    const host = this.els.snaps;
    this.snapPads = Array.from({ length: SLOTS }, (_, slot) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'pad snap';
      el.setAttribute('aria-pressed', 'false');
      el.innerHTML = '<kbd class="pad__key"></kbd><span class="snap__name"></span><span class="snap__bars"></span>';
      el.querySelector('.pad__key').textContent = snapshots.keyFor(slot);
      let held = null;
      let menuShown = false;
      const menu = () => {
        menuShown = true;
        const record = snapshots.at(slot);
        if (record) this.openSnapMenu(record.id);
      };
      el.addEventListener('pointerdown', (event) => {
        menuShown = false;
        clearTimeout(held);
        if (event.pointerType !== 'mouse') held = setTimeout(menu, 550);
      });
      const letGo = () => clearTimeout(held);
      el.addEventListener('pointerup', letGo);
      el.addEventListener('pointercancel', letGo);
      el.addEventListener('pointerleave', letGo);
      el.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (!menuShown) menu();
      });
      el.addEventListener('click', (event) => {
        if (menuShown) return;
        snapshots.press(slot, { once: event.shiftKey });
      });
      register(`snap:${slot}`, el, { press: (down) => down && snapshots.press(slot) });
      host.append(el);
      return el;
    });
    this.syncSnapPads();
  },

  syncSnapPads() {
    const waiting = Boolean(snapshots.pending);
    this.els.snaps.classList.toggle('is-waiting', waiting);
    this.snapPads.forEach((el, slot) => {
      const record = snapshots.at(slot);
      const key = snapshots.keyFor(slot);
      el.classList.toggle('is-empty', !record);
      el.classList.toggle('is-pinned', Boolean(record?.pinned));
      el.classList.toggle('is-loading', Boolean(record) && !record.wav);
      el.setAttribute('aria-pressed', String(snapshots.lit(slot)));
      el.querySelector('.snap__name').textContent = record ? record.name : '';
      el.querySelector('.snap__bars').textContent = record ? barsLabel(record.bars) : '';
      el.title = waiting
        ? `Put the new snapshot in slot ${slot + 1}${record ? `, in place of ${snapshots.describe(record)}` : ''}`
        : record
          ? `${snapshots.describe(record)}${record.songTitle ? `, from ${record.songTitle}` : ''}${record.pinned ? ` · pinned to deck ${record.pinned}` : ''} · tap to bring it in or stop it, Shift-tap to play it once (${key}) · right-click for more`
          : `Empty: capture a channel into it with ● in the Mixer (${key})`;
      el.setAttribute('aria-label', record ? `Snapshot ${slot + 1}: ${snapshots.describe(record)}` : `Snapshot ${slot + 1}: empty`);
    });
  },

  buildCaptureLength() {
    const buttons = [...this.els.capLength.querySelectorAll('button')];
    const set = (bars) => {
      this.captureBars = BAR_CHOICES.includes(bars) ? bars : DEFAULT_BARS;
      buttons.forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.bars) === this.captureBars)));
      this.strips.forEach((strip) => (strip.capState = null));
      this.syncCapture();
    };
    buttons.forEach((button) =>
      button.addEventListener('click', () => {
        set(Number(button.dataset.bars));
        persist.set('captureBars', this.captureBars);
      }),
    );
    set(persist.get('captureBars', DEFAULT_BARS));
  },

  // The menu for one snapshot: rename, pin to the deck in focus, download, clear.
  buildSnapMenu() {
    const { snapSheet, snapRename, snapName, snapPin, snapDownload, snapClear, snapClose } = this.els;
    snapRename.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.menuFor) snapshots.rename(this.menuFor, snapName.value);
      this.renderSnapMenu();
    });
    snapPin.addEventListener('click', () => {
      const record = snapshots.get(this.menuFor);
      if (!record) return;
      snapshots.pin(record.id, record.pinned === this.player.id ? null : this.player.id);
      this.renderSnapMenu();
    });
    snapDownload.addEventListener('click', () => snapshots.download(this.menuFor));
    snapClear.addEventListener('click', () => {
      const id = this.menuFor;
      snapSheet.close();
      snapshots.remove(id);
    });
    snapClose.addEventListener('click', () => snapSheet.close());
    snapSheet.addEventListener('close', () => (this.menuFor = null));
  },

  openSnapMenu(id) {
    if (!snapshots.get(id)) return;
    this.menuFor = id;
    this.renderSnapMenu();
    if (!this.els.snapSheet.open) this.els.snapSheet.showModal();
  },

  renderSnapMenu() {
    const record = snapshots.get(this.menuFor);
    if (!record) return;
    const { snapName, snapAbout, snapPin, snapTitle } = this.els;
    const here = this.player.id;
    snapTitle.textContent = `Snapshot ${record.slot + 1}`;
    snapName.value = record.name;
    const seconds = record.frames / record.sampleRate;
    snapAbout.textContent = `${barsLabel(record.bars)} of ${record.track || record.name}${record.songTitle ? ` from ${record.songTitle}` : ''}, captured at ${Math.round(record.cps * 240)} bpm (${seconds.toFixed(1)} s). It follows the deck's tempo, and its pitch moves with it.`;
    snapPin.setAttribute('aria-pressed', String(record.pinned === here));
    snapPin.textContent = record.pinned === here ? `Unpin from deck ${here}` : record.pinned ? `Pin to deck ${here} instead of ${record.pinned}` : `Pin to deck ${here}'s mixer`;
  },

  // With latch off again, any pad left on is let go.
  setLatch(on) {
    this.latch = on;
    this.els.latch.setAttribute('aria-pressed', String(on));
    this.els.latchNote.textContent = on ? 'tap on, tap off' : 'hold';
    if (!on) for (const pad of this.pads.values()) if (pad.isOn()) pad.release();
  },

  /* ---------- master ---------- */

  buildMaster() {
    const { app } = this;
    const host = this.els.master;
    const add = (key, options) => {
      const knob = createKnob({ id: `master:${key}`, size: 'sm', ...options });
      host.append(knob.el);
      this.masterKnobs[key] = knob;
    };
    const saved = (setter) => (value) => {
      setter(value);
      app.saveMaster();
    };
    add('filter', {
      label: 'Filter',
      sub: 'lp · hp',
      hint: 'Left closes a low-pass, right opens a high-pass, centre is open',
      min: -1,
      max: 1,
      value: master.state.filter,
      defaultValue: 0,
      bipolar: true,
      format: (v) => (Math.abs(v) < 0.03 ? 'open' : v < 0 ? `lp ${Math.round(-v * 100)}` : `hp ${Math.round(v * 100)}`),
      onInput: saved((v) => master.setFilter(v)),
    });
    add('echo', {
      label: 'Echo',
      sub: 'tempo sync',
      hint: 'Dotted-eighth echo locked to the tempo',
      value: master.state.echo,
      defaultValue: 0,
      format: percent,
      onInput: saved((v) => master.setEcho(v)),
    });
    add('reverb', {
      label: 'Space',
      sub: 'reverb',
      hint: 'Reverb on the whole mix',
      value: master.state.reverb,
      defaultValue: 0,
      format: percent,
      onInput: saved((v) => master.setReverb(v)),
    });
    add('tempo', {
      label: 'Tempo',
      sub: 'bpm',
      hint: 'Speeds the song up or down around its own tempo',
      min: 0.75,
      max: 1.25,
      value: 1,
      defaultValue: 1,
      bipolar: true,
      format: (v) => `${Math.round(app.tempoTarget().baseCps * 240 * v)}`,
      onInput: (v) => app.setTempo(v),
    });
    add('volume', {
      label: 'Volume',
      sub: 'master',
      hint: 'Master volume',
      value: master.state.volume,
      defaultValue: 0.85,
      format: percent,
      onInput: saved((v) => master.setVolume(v)),
    });

    this.crossfader = createCrossfader({
      id: 'xfade',
      label: 'Crossfader',
      value: master.state.crossfade,
      format: (v) => (v < 0.02 ? 'Deck A' : v > 0.98 ? 'Deck B' : `${Math.round((1 - v) * 100)}% A, ${Math.round(v * 100)}% B`),
      onInput: (v) => {
        master.setCrossfade(v);
        app.onCrossfade?.(v);
      },
    });
    this.els.crossfader.append(this.crossfader.el);

    this.els.sync.addEventListener('click', () => app.setSync(this.els.sync.getAttribute('aria-pressed') !== 'true'));
    this.els.mix.addEventListener('click', () => app.mix());
    register('mix', this.els.mix, { press: (down) => down && app.mix() });
  },

  // The tempo knob shows the deck that sets the tempo (the leader when two are locked).
  syncTempo() {
    const knob = this.masterKnobs.tempo;
    if (!knob || !this.app) return;
    knob.set(this.app.tempoTarget().tempo);
    knob.refresh();
  },
};
