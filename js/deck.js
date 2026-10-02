// The controls section. Song knobs (one per slider() in the code) and channel strips (one
// per track) follow the deck in focus; pads, crossfader and master act on the whole mix.
import { createKnob, createFader, createCrossfader, createPad, register } from './controls.js';
import { sliderReadout } from './analyze.js';
import { master } from './master.js';

const percent = (v) => `${Math.round(v * 100)}%`;

export const deck = {
  els: {},
  app: null,
  player: null,
  knobs: [],
  switchKnobs: [],
  strips: [],
  masterKnobs: {},
  pads: new Map(),
  crossfader: null,

  // app: { players, setTempo(multiplier), tempoTarget(), setSync(on), mix(), saveMaster() }
  init(els, app) {
    this.els = els;
    this.app = app;
    this.buildMaster();
    this.buildPads();

    els.tabs.forEach((tab) => tab.addEventListener('click', () => this.showTab(tab.dataset.tab)));
    els.reset.addEventListener('click', () => this.player?.resetSong());

    for (const player of app.players) {
      const mine = (fn) => (...args) => player === this.player && fn(...args);
      player.on('song', mine(() => this.rebuild()));
      // the code was edited and re-evaluated: its knobs and channels may have changed
      player.on('structure', mine(() => this.rebuild()));
      player.on('mixer', mine(() => this.syncMixer()));
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
    this.els.stripsEmpty.hidden = mixer.tracks.length > 0 || !player.song;

    this.strips = mixer.tracks.map((track) => {
      const el = document.createElement('div');
      el.className = 'strip';
      el.innerHTML = `
        <span class="strip__led" aria-hidden="true"></span>
        <div class="strip__slot"><span class="strip__meter" aria-hidden="true"><span></span></span></div>
        <div class="strip__buttons">
          <button type="button" class="strip__btn strip__btn--mute" aria-pressed="false">M</button>
          <button type="button" class="strip__btn strip__btn--solo" aria-pressed="false">S</button>
        </div>
        <button type="button" class="strip__name" aria-pressed="false"></button>`;
      const [mute, solo] = el.querySelectorAll('.strip__btn');
      const name = el.querySelector('.strip__name');
      name.textContent = track.name;
      name.setAttribute('aria-label', `Focus on ${track.name} in the code`);
      mute.setAttribute('aria-label', `Mute ${track.name}`);
      solo.setAttribute('aria-label', `Solo ${track.name}`);
      mute.addEventListener('click', () => mixer.setMute(track.index));
      solo.addEventListener('click', () => mixer.setSolo(track.index));
      name.addEventListener('click', () => {
        stage.setFocus(track.index);
        this.syncFocus();
      });
      register(`ch:${track.index}:mute`, mute, { press: (down) => down && mixer.setMute(track.index) });
      register(`ch:${track.index}:solo`, solo, { press: (down) => down && mixer.setSolo(track.index) });

      const fader = createFader({
        id: `ch:${track.index}:level`,
        label: `${track.name} level`,
        min: 0,
        max: 1.25,
        value: track.gain,
        defaultValue: 1,
        format: percent,
        onInput: (value) => mixer.setGain(track.index, value),
      });
      el.querySelector('.strip__slot').append(fader.el);
      host.append(el);
      return { el, mute, solo, fader, name };
    });
    this.syncMixer();
    this.syncFocus();
  },

  syncMixer() {
    const { mixer } = this.player;
    mixer.tracks.forEach((track, i) => {
      const strip = this.strips[i];
      if (!strip) return;
      strip.mute.setAttribute('aria-pressed', String(track.mute));
      strip.solo.setAttribute('aria-pressed', String(track.solo));
      strip.el.classList.toggle('is-silent', !mixer.audible(track.index));
      strip.el.classList.toggle('is-missing', track.missingSounds.length > 0);
      strip.el.title = track.missingSounds.length
        ? `Not available from the sample packs, so it stays silent: ${track.missingSounds.join(', ')}`
        : track.disabled
          ? 'Switched off in the code — unmute to bring it in'
          : '';
      strip.fader.set(track.gain);
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
    this.player.mixer.tracks.forEach((track, i) => {
      const strip = this.strips[i];
      if (!strip) return;
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
    });
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
      const pad = createPad({ id: `pad:${name}`, label, hint: `${hint} · hold, or Shift-click to latch`, keyHint: key, onChange });
      this.els.pads.append(pad.el);
      this.pads.set(key.toLowerCase(), pad);
    }
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
