// The master bus: a plain WebAudio chain between Strudel's output and the speakers. It is
// independent of the songs, so everything here responds instantly.
//
//   deck A orbits → bus A ─┐ (crossfader)
//   deck B orbits → bus B ─┼→ high-pass → low-pass ─┬→ dry ─────────┐
//   anything else ─────────┘                        ├→ echo (synced)┼→ limiter → soft clip → volume ─┬→ speakers
//                                                   └→ reverb ──────┘                                ├→ analyser
//                                                                                                    └→ recorder
import { webaudio } from '../vendor/strudel.bundle.js';

// Deck B's sounds are moved to orbits (and cut groups) this far above deck A's, which keeps
// the two decks' effect buses apart and tells us which deck bus an orbit belongs on.
export const BUS_OFFSET = 1000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function impulse(context, seconds = 2.8, decay = 2.4) {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

// Transparent up to 0.7 of full scale, then bends over and never exceeds 0.92.
function softClipCurve(samples = 2049) {
  const curve = new Float32Array(samples);
  const knee = 0.7;
  const room = 0.92 - knee;
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    const a = Math.abs(x);
    curve[i] = Math.sign(x) * (a <= knee ? a : knee + room * Math.tanh((a - knee) / room));
  }
  return curve;
}

// The limiter's settings, and the gain that undoes the make-up gain the browser's
// compressor adds on its own (so quiet passages come through at their true level).
const LIMIT = { threshold: -6, knee: 3, ratio: 12, attack: 0.003, release: 0.15 };
const fullRange = Math.pow(10, (LIMIT.threshold - LIMIT.threshold / LIMIT.ratio) / 20);
const UNDO_MAKEUP = Math.pow(fullRange, 0.6);
// After limiting, peaks sit near the threshold; bring them back up towards the clip knee.
const CEILING_GAIN = 1.55;

export const master = {
  attached: false,
  analyser: null,
  state: { volume: 0.85, filter: 0, echo: 0, reverb: 0, crossfade: 0 },
  // momentary effects held on the pads
  held: { echo: false, drop: false, wash: false },
  nodes: null,
  tapped: null,
  cps: 0.5,

  // Call after the AudioContext exists (first Play). Safe to call again: it re-taps if
  // Strudel rebuilt its output node.
  attach() {
    const context = webaudio.getAudioContext();
    const controller = webaudio.getSuperdoughAudioController();
    const source = controller.output?.destinationGain;
    if (!source) return false;

    if (!this.nodes || this.nodes.context !== context) {
      const stereo = { channelCount: 2, channelCountMode: 'explicit' };
      const busA = new GainNode(context, stereo);
      const busB = new GainNode(context, stereo);
      const input = new GainNode(context, stereo);
      const highpass = new BiquadFilterNode(context, { type: 'highpass', frequency: 10, Q: 0.7 });
      const lowpass = new BiquadFilterNode(context, { type: 'lowpass', frequency: 22000, Q: 0.7 });
      const dry = new GainNode(context);
      const sum = new GainNode(context);

      const echoSend = new GainNode(context, { gain: 0 });
      const echoDelay = new DelayNode(context, { maxDelayTime: 3, delayTime: 0.375 });
      const echoFeedback = new GainNode(context, { gain: 0.45 });
      const echoTone = new BiquadFilterNode(context, { type: 'lowpass', frequency: 3200 });

      const reverbSend = new GainNode(context, { gain: 0 });
      const reverb = new ConvolverNode(context, { buffer: impulse(context) });

      const limiter = new DynamicsCompressorNode(context, LIMIT);
      const ceiling = new GainNode(context, { gain: UNDO_MAKEUP * CEILING_GAIN });
      const clip = new WaveShaperNode(context, { curve: softClipCurve(), oversample: '2x' });
      const volume = new GainNode(context, { gain: 0 });
      const analyser = new AnalyserNode(context, { fftSize: 2048, smoothingTimeConstant: 0.78 });

      busA.connect(input);
      busB.connect(input);
      input.connect(highpass).connect(lowpass);
      lowpass.connect(dry).connect(sum);
      lowpass.connect(echoSend).connect(echoDelay).connect(echoTone).connect(sum);
      echoTone.connect(echoFeedback).connect(echoDelay);
      lowpass.connect(reverbSend).connect(reverb).connect(sum);
      sum.connect(limiter).connect(ceiling).connect(clip).connect(volume);
      volume.connect(context.destination);
      volume.connect(analyser);

      this.nodes = { context, busA, busB, input, highpass, lowpass, dry, echoSend, echoDelay, echoFeedback, reverbSend, limiter, volume };
      this.analyser = analyser;
      this.time = new Float32Array(analyser.fftSize);
      this.freq = new Uint8Array(analyser.frequencyBinCount);
      this.tapped = null;
    }

    // Each orbit Strudel creates is connected to its deck's bus instead of straight to the
    // output, which is what lets the crossfader blend two songs.
    if (!controller.hbRouted) {
      const getOrbit = controller.getOrbit.bind(controller);
      let creating = null;
      controller.getOrbit = (orbit, channels) => {
        creating = orbit;
        try {
          return getOrbit(orbit, channels);
        } finally {
          creating = null;
        }
      };
      controller.output.connectToDestination = (node) => {
        const nodes = this.nodes;
        node.connect(creating === null ? nodes.input : Number(creating) >= BUS_OFFSET ? nodes.busB : nodes.busA);
      };
      controller.hbRouted = true;
    }

    // Anything that still reaches Strudel's own output node is folded in as well.
    if (this.tapped !== source) {
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      source.connect(this.nodes.input);
      this.tapped = source;
    }
    this.attached = true;
    this.apply();
    return true;
  },

  // The node at the very end of the chain (what you hear), for the recorder.
  get output() {
    return this.nodes?.volume ?? null;
  },

  apply() {
    this.setVolume(this.state.volume);
    this.setFilter(this.state.filter);
    this.setEcho(this.state.echo);
    this.setReverb(this.state.reverb);
    this.setCrossfade(this.state.crossfade);
    this.setTempo(this.cps);
  },

  ramp(param, value, time = 0.03) {
    const { context } = this.nodes;
    param.cancelScheduledValues(context.currentTime);
    param.setTargetAtTime(value, context.currentTime, time);
  },

  setVolume(value) {
    this.state.volume = clamp(value, 0, 1);
    // squared for a more even feel across the knob's travel; unity at the default 85%
    if (this.nodes) this.ramp(this.nodes.volume.gain, this.state.volume ** 2 / 0.85 ** 2);
  },

  // One knob: centre is open, left closes a low-pass, right opens a high-pass.
  // While the Drop pad is held the low-pass falls to the floor instead.
  setFilter(value = this.state.filter) {
    this.state.filter = clamp(value, -1, 1);
    if (!this.nodes) return;
    const { lowpass, highpass } = this.nodes;
    if (this.held.drop) {
      const beat = 1 / (this.cps * 4);
      this.ramp(lowpass.frequency, 140, beat * 0.45);
      this.ramp(lowpass.Q, 5, 0.05);
      return;
    }
    const v = Math.abs(this.state.filter) < 0.03 ? 0 : this.state.filter;
    const low = v < 0 ? 22000 * Math.pow(90 / 22000, -v) : 22000;
    const high = v > 0 ? 10 * Math.pow(7000 / 10, v) : 10;
    const q = 0.7 + Math.abs(v) * 3.2;
    this.ramp(lowpass.frequency, low);
    this.ramp(highpass.frequency, high);
    this.ramp(lowpass.Q, v < 0 ? q : 0.7);
    this.ramp(highpass.Q, v > 0 ? q : 0.7);
  },

  setEcho(value = this.state.echo) {
    this.state.echo = clamp(value, 0, 1);
    if (!this.nodes) return;
    const amount = this.held.echo ? 1 : this.state.echo;
    this.ramp(this.nodes.echoSend.gain, amount * 0.8, 0.015);
    this.ramp(this.nodes.echoFeedback.gain, this.held.echo ? 0.74 : 0.3 + this.state.echo * 0.38);
  },

  setReverb(value = this.state.reverb) {
    this.state.reverb = clamp(value, 0, 1);
    if (!this.nodes) return;
    this.ramp(this.nodes.reverbSend.gain, (this.held.wash ? 1 : this.state.reverb) * 0.9, 0.02);
    this.ramp(this.nodes.dry.gain, this.held.wash ? 0.45 : 1, 0.05);
  },

  // 0 is deck A alone, 1 is deck B alone; equal-power in between.
  setCrossfade(value = this.state.crossfade) {
    this.state.crossfade = clamp(value, 0, 1);
    if (!this.nodes) return;
    this.ramp(this.nodes.busA.gain, Math.cos((this.state.crossfade * Math.PI) / 2), 0.015);
    this.ramp(this.nodes.busB.gain, Math.sin((this.state.crossfade * Math.PI) / 2), 0.015);
  },

  // Momentary effects from the pads: 'echo', 'drop', 'wash'.
  hold(name, on) {
    if (!(name in this.held) || this.held[name] === on) return;
    this.held[name] = on;
    if (name === 'echo') this.setEcho();
    else if (name === 'drop') this.setFilter();
    else this.setReverb();
  },

  // Echo repeats on dotted eighths of the current tempo (one cycle = four beats).
  setTempo(cps) {
    if (!(cps > 0)) return;
    this.cps = cps;
    if (!this.nodes) return;
    const beat = 1 / (cps * 4);
    this.ramp(this.nodes.echoDelay.delayTime, clamp(beat * 0.75, 0.02, 2.9), 0.08);
  },

  waveform() {
    if (!this.analyser) return null;
    this.analyser.getFloatTimeDomainData(this.time);
    return this.time;
  },
  spectrum() {
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  },
  // 0..1 peak of the current waveform buffer
  peak(data = this.waveform()) {
    if (!data) return 0;
    let peak = 0;
    for (let i = 0; i < data.length; i += 2) peak = Math.max(peak, Math.abs(data[i]));
    return Math.min(1, peak);
  },
  // How hard the limiter is working right now, in dB (0 = not at all).
  reduction() {
    return this.nodes ? Math.abs(this.nodes.limiter.reduction) : 0;
  },
};
