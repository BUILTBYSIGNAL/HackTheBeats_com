// MIDI controller support. Any knob, fader, pad or button on the deck can be bound to a
// control on a hardware controller: turn "learn" on, click the on-screen control, then move
// the hardware one. Bindings are remembered in the browser.
import { registry } from './controls.js';
import { persist } from './persist.js';

// A MIDI message → the key a binding is stored under, plus what it carries.
export function readMessage(data) {
  const [status, number, value = 0] = data;
  const type = status & 0xf0;
  const channel = status & 0x0f;
  if (type === 0xb0) return { key: `cc:${channel}:${number}`, kind: 'cc', value: value / 127 };
  if (type === 0x90 && value > 0) return { key: `note:${channel}:${number}`, kind: 'note', down: true };
  if (type === 0x80 || type === 0x90) return { key: `note:${channel}:${number}`, kind: 'note', down: false };
  return null;
}

export const midi = {
  access: null,
  learning: false,
  target: null,
  bindings: persist.get('midi', {}),
  onChange: null,

  get supported() {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  },
  get inputs() {
    return this.access ? [...this.access.inputs.values()].map((input) => input.name || 'MIDI input') : [];
  },
  get count() {
    return Object.keys(this.bindings).length;
  },

  // Asks the browser for MIDI access (the browser shows its own permission prompt).
  async connect() {
    if (!this.supported) return false;
    if (!this.access) {
      this.access = await navigator.requestMIDIAccess();
      const listen = () => {
        for (const input of this.access.inputs.values()) input.onmidimessage = (event) => this.handle(event.data);
        this.onChange?.();
      };
      this.access.onstatechange = listen;
      listen();
    }
    return true;
  },

  setLearning(on) {
    this.learning = on;
    this.setTarget(null);
    document.body.classList.toggle('is-learning', on);
    this.onChange?.();
  },

  setTarget(id) {
    document.querySelector('.is-midi-target')?.classList.remove('is-midi-target');
    this.target = id;
    if (id) registry.get(id)?.el.classList.add('is-midi-target');
  },

  // In learn mode a click on a control picks it as the thing to bind, instead of using it.
  pickFromEvent(event) {
    if (!this.learning) return false;
    const el = event.target.closest?.('[data-midi]');
    if (!el) return false;
    event.preventDefault();
    event.stopPropagation();
    this.setTarget(el.dataset.midi);
    this.onChange?.();
    return true;
  },

  handle(data) {
    const message = readMessage(data);
    if (!message) return;
    if (this.learning && this.target) {
      // one hardware control drives one thing: rebinding replaces what was there
      if (message.kind === 'note' && !message.down) return;
      for (const [key, id] of Object.entries(this.bindings)) if (id === this.target) delete this.bindings[key];
      this.bindings[message.key] = this.target;
      persist.set('midi', this.bindings);
      this.setTarget(null);
      this.onChange?.(message.key);
      return;
    }
    const control = registry.get(this.bindings[message.key]);
    if (!control) return;
    if (message.kind === 'cc') {
      if (control.setPosition) control.setPosition(message.value);
      else control.press?.(message.value > 0.5);
    } else if (control.press) {
      control.press(message.down);
    } else if (message.down) {
      control.setPosition?.(1);
    }
  },

  clear() {
    this.bindings = {};
    persist.set('midi', this.bindings);
    this.onChange?.();
  },
};
