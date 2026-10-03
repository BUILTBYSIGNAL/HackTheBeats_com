// Records audio to a WAV file. Samples are captured on the audio thread by a small worklet
// and kept as 16-bit PCM, so a recording costs about 10 MB a minute. The master recorder
// takes everything from the moment it starts; a channel snapshot (snapshots.js) takes an
// exact window of frames, from one bar line to another.

const WORKLET = `
class HbRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 4096;
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.filled = 0;
    this.active = true;
    // a window of frames on the audio clock: [from, to), or everything
    this.from = -Infinity;
    this.to = Infinity;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') this.active = false;
      else if (data && typeof data === 'object') {
        this.from = data.from;
        this.to = data.to;
      }
    };
  }
  flush() {
    if (!this.filled) return;
    this.port.postMessage({ left: this.left.slice(0, this.filled), right: this.right.slice(0, this.filled) });
    this.filled = 0;
  }
  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0];
    const l = input && input[0];
    const r = (input && input[1]) || l;
    // the master recorder skips what has no signal at all, as it always has
    if (!l && this.from === -Infinity) return true;
    const length = l ? l.length : 128;
    for (let i = 0; i < length; i++) {
      const frame = currentFrame + i;
      if (frame < this.from) continue;
      if (frame >= this.to) {
        this.flush();
        this.port.postMessage({ done: true });
        this.active = false;
        return false;
      }
      // silence counts too: a window keeps its exact length
      this.left[this.filled] = l ? l[i] : 0;
      this.right[this.filled] = r ? r[i] : 0;
      if (++this.filled === this.size) this.flush();
    }
    return true;
  }
}
registerProcessor('hb-recorder', HbRecorder);
`;

const loaded = new WeakSet();
// Safe to call again; resolves once the worklet can be used on this context.
export async function loadWorklet(context) {
  if (loaded.has(context)) return;
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  loaded.add(context);
}

const MAX_SECONDS = 20 * 60;

function interleave16(left, right) {
  const out = new Int16Array(left.length * 2);
  for (let i = 0; i < left.length; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    out[i * 2] = l < 0 ? l * 0x8000 : l * 0x7fff;
    out[i * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
  }
  return out;
}

// 16-bit stereo PCM chunks → a WAV file
export function encodeWav(chunks, sampleRate) {
  const dataBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset, value) => [...value].forEach((char, i) => header.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF');
  header.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 2, true); // stereo
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 4, true);
  header.setUint16(32, 4, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, dataBytes, true);
  return new Blob([header, ...chunks], { type: 'audio/wav' });
}

export const recorder = {
  active: false,
  startedAt: 0,
  node: null,
  chunks: [],
  frames: 0,
  onAutoStop: null,

  get supported() {
    return typeof AudioWorkletNode !== 'undefined';
  },
  get seconds() {
    return this.active ? (performance.now() - this.startedAt) / 1000 : 0;
  },

  // `source` is the last node of the master bus.
  async start(source) {
    if (this.active || !source) return false;
    const context = source.context;
    await loadWorklet(context);
    this.chunks = [];
    this.frames = 0;
    this.sampleRate = context.sampleRate;
    this.node = new AudioWorkletNode(context, 'hb-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    this.node.port.onmessage = ({ data }) => {
      if (!data.left) return;
      this.chunks.push(interleave16(data.left, data.right));
      this.frames += data.left.length;
      if (this.frames / this.sampleRate >= MAX_SECONDS) this.onAutoStop?.();
    };
    this.source = source;
    source.connect(this.node);
    this.active = true;
    this.startedAt = performance.now();
    return true;
  },

  // Stops and returns the recording as a WAV blob (null if nothing was captured).
  stop() {
    if (!this.active) return null;
    this.active = false;
    this.node.port.postMessage('stop');
    try {
      this.source.disconnect(this.node);
    } catch {
      /* already gone */
    }
    this.node.port.onmessage = null;
    this.node = null;
    const chunks = this.chunks;
    this.chunks = [];
    return chunks.length ? encodeWav(chunks, this.sampleRate) : null;
  },
};

// Records `source` from audio frame `from` up to (not including) frame `to`, and resolves
// to the WAV, or to null if it was cancelled first. Nothing is heard: the worklet has no
// output. Returns { done, cancel() }.
export function recordWindow(source, from, to) {
  const context = source.context;
  let node = null;
  let cancelled = false;
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  const close = () => {
    if (!node) return;
    node.port.onmessage = null;
    node.port.postMessage('stop');
    try {
      source.disconnect(node);
    } catch {
      /* already gone */
    }
    node = null;
  };
  loadWorklet(context).then(
    () => {
      if (cancelled) return;
      const chunks = [];
      node = new AudioWorkletNode(context, 'hb-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
      node.port.onmessage = ({ data }) => {
        if (data.left) chunks.push(interleave16(data.left, data.right));
        if (!data.done) return;
        close();
        finish(chunks.length ? encodeWav(chunks, context.sampleRate) : null);
      };
      node.port.postMessage({ from, to });
      source.connect(node);
    },
    (error) => {
      console.warn('[recorder] the worklet could not load', error);
      finish(null);
    },
  );
  return {
    done,
    cancel() {
      cancelled = true;
      close();
      finish(null);
    },
  };
}

// Hand a blob to the browser as a download.
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
