// Deck controls: rotary knob, vertical fader, crossfader and hold-pads. Sliders are real
// sliders to assistive tech (role="slider"), work with pointer, touch, wheel and keyboard,
// and reset on double-click. Every control can also be driven by a MIDI controller: it
// registers itself here under a stable id.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const KNOB_ARC = 'M13.615 50.385 A26 26 0 1 1 50.385 50.385';

// id → { el, setPosition(0..1), press(down) }. Rebuilt controls simply replace their entry.
export const registry = new Map();

export function register(id, el, api) {
  if (!id) return;
  el.dataset.midi = id;
  registry.set(id, { el, ...api });
}

function createControl({
  element,
  id,
  min = 0,
  max = 1,
  value = min,
  defaultValue = value,
  taper = 'linear',
  step,
  travel = { pixels: 180, horizontal: 1, vertical: 1 },
  format = (v) => v.toFixed(2),
  label,
  onInput,
  onGrab,
  onRelease,
  render,
}) {
  const log = taper === 'log' && min > 0 && max > min;
  const toPosition = (v) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min || 1));
  const toValue = (p) => (log ? min * Math.pow(max / min, p) : min + p * (max - min));

  let current = clamp(value, min, max);
  let fallback = clamp(defaultValue, min, max);

  element.setAttribute('role', 'slider');
  element.tabIndex = 0;
  element.setAttribute('aria-valuemin', String(min));
  element.setAttribute('aria-valuemax', String(max));
  if (label) element.setAttribute('aria-label', label);

  const paint = () => {
    const position = clamp(toPosition(current), 0, 1);
    element.setAttribute('aria-valuenow', String(Number(current.toFixed(4))));
    element.setAttribute('aria-valuetext', format(current));
    render(position, current, format(current));
  };

  // sliders declared with a step (e.g. slider(2, 0, 5, 1)) only ever land on whole steps
  const snap = (v) => (step > 0 ? Number((min + Math.round((v - min) / step) * step).toFixed(6)) : v);

  const commit = (next, silent) => {
    next = clamp(snap(clamp(next, min, max)), min, max);
    if (next === current) return;
    current = next;
    paint();
    if (!silent) onInput?.(current);
  };
  const nudge = (delta) => {
    if (step > 0) {
      const steps = Math.max(1, Math.round((Math.abs(delta) * (max - min)) / step));
      return commit(current + Math.sign(delta) * steps * step);
    }
    commit(toValue(clamp(toPosition(current) + delta, 0, 1)));
  };

  let drag = null;
  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    element.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, position: toPosition(current) };
    element.classList.add('is-grabbed');
    element.focus({ preventScroll: true });
    onGrab?.();
    event.preventDefault();
  });
  element.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const fine = event.shiftKey ? 0.2 : 1;
    const across = (event.clientX - drag.x) * (travel.horizontal ?? 1);
    const up = (drag.y - event.clientY) * (travel.vertical ?? 1);
    commit(toValue(clamp(drag.position + ((across + up) / travel.pixels) * fine, 0, 1)));
  });
  const release = () => {
    if (!drag) return;
    drag = null;
    element.classList.remove('is-grabbed');
    onRelease?.();
  };
  element.addEventListener('pointerup', release);
  element.addEventListener('pointercancel', release);
  element.addEventListener('dblclick', () => commit(fallback));
  element.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      nudge((event.deltaY < 0 ? 1 : -1) * (event.shiftKey ? 0.004 : 0.02));
    },
    { passive: false },
  );
  element.addEventListener('keydown', (event) => {
    const amount = event.shiftKey ? 0.002 : 0.01;
    const keys = {
      ArrowUp: () => nudge(amount),
      ArrowRight: () => nudge(amount),
      ArrowDown: () => nudge(-amount),
      ArrowLeft: () => nudge(-amount),
      PageUp: () => nudge(0.1),
      PageDown: () => nudge(-0.1),
      Home: () => commit(min),
      End: () => commit(max),
      Enter: () => commit(fallback),
      Backspace: () => commit(fallback),
      Delete: () => commit(fallback),
    };
    if (!keys[event.key]) return;
    keys[event.key]();
    event.preventDefault();
    event.stopPropagation();
  });
  element.addEventListener('focus', () => onGrab?.());
  element.addEventListener('blur', () => onRelease?.());

  register(id, element, { setPosition: (p) => commit(toValue(clamp(p, 0, 1))) });

  paint();
  return {
    get: () => current,
    set: (next, { silent = true } = {}) => commit(next, silent),
    setDefault: (next) => (fallback = clamp(next, min, max)),
    reset: () => commit(fallback),
    refresh: paint,
  };
}

/**
 * Rotary knob.
 * options: { id, label, sub, hint, min, max, value, defaultValue, taper, step, bipolar, format, onInput, onGrab, onRelease, size }
 */
export function createKnob(options) {
  const { label, sub, hint, bipolar = false, size = 'md' } = options;
  const el = document.createElement('div');
  el.className = `knob knob--${size}`;
  if (hint) el.title = hint;
  el.innerHTML = `
    <div class="knob__dial">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path class="knob__track" d="${KNOB_ARC}" pathLength="100"/>
        <path class="knob__arc" d="${KNOB_ARC}" pathLength="100"/>
        <g class="knob__hand"><circle class="knob__cap" cx="32" cy="32" r="17"/><line class="knob__needle" x1="32" y1="19" x2="32" y2="27"/></g>
      </svg>
    </div>
    <div class="knob__text">
      <span class="knob__label"></span>
      <span class="knob__sub"></span>
      <output class="knob__value"></output>
    </div>`;
  el.querySelector('.knob__label').textContent = label;
  el.querySelector('.knob__sub').textContent = sub || '';
  const dial = el.querySelector('.knob__dial');
  const arc = el.querySelector('.knob__arc');
  const hand = el.querySelector('.knob__hand');
  const readout = el.querySelector('.knob__value');

  const control = createControl({
    ...options,
    element: dial,
    label: sub ? `${label}, ${sub}` : label,
    render(position, _value, text) {
      if (bipolar) {
        const span = Math.abs(position - 0.5) * 100;
        arc.style.strokeDasharray = `${span} 100`;
        arc.style.strokeDashoffset = String(-Math.min(position, 0.5) * 100);
      } else {
        arc.style.strokeDasharray = `${position * 100} 100`;
      }
      hand.style.transform = `rotate(${-135 + position * 270}deg)`;
      readout.textContent = text;
    },
  });
  return { el, dial, ...control };
}

/**
 * Vertical fader.
 * options: { id, label, min, max, value, defaultValue, format, onInput }
 */
export function createFader(options) {
  const el = document.createElement('div');
  el.className = 'fader';
  el.setAttribute('aria-orientation', 'vertical');
  el.innerHTML = '<div class="fader__rail"><div class="fader__fill"></div><div class="fader__cap"></div></div>';
  const control = createControl({
    ...options,
    element: el,
    travel: { pixels: 110, horizontal: 0, vertical: 1 },
    render(position) {
      el.style.setProperty('--p', position.toFixed(4));
    },
  });
  return { el, ...control };
}

/**
 * Horizontal crossfader between two decks.
 * options: { id, label, value, onInput, format }
 */
export function createCrossfader(options) {
  const el = document.createElement('div');
  el.className = 'xfader';
  el.setAttribute('aria-orientation', 'horizontal');
  el.innerHTML = '<div class="xfader__rail"><div class="xfader__cap"></div></div>';
  const control = createControl({
    min: 0,
    max: 1,
    defaultValue: 0.5,
    ...options,
    element: el,
    travel: { pixels: 150, horizontal: 1, vertical: 0 },
    render(position) {
      el.style.setProperty('--p', position.toFixed(4));
    },
  });
  return { el, ...control };
}

/**
 * A pad that is on for as long as it is held. Shift-click (or Shift with its key) latches it,
 * and so does every press while latchMode() says so (a touch screen has no Shift).
 * options: { id, label, hint, keyHint, onChange(on), latchMode() }
 */
export function createPad({ id, label, hint, keyHint, onChange, latchMode = () => false }) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'pad';
  el.setAttribute('aria-pressed', 'false');
  if (hint) el.title = hint;
  el.innerHTML = '<span class="pad__label"></span><kbd class="pad__key"></kbd>';
  el.querySelector('.pad__label').textContent = label;
  el.querySelector('.pad__key').textContent = keyHint || '';

  let on = false;
  let latched = false;
  const set = (next) => {
    if (next === on) return;
    on = next;
    el.setAttribute('aria-pressed', String(on));
    onChange(on);
  };
  // down: engage (Shift latches; pressing a latched pad releases it). up: release unless latched.
  const press = (down, latch = false) => {
    if (down) {
      if (latched) {
        latched = false;
        return set(false);
      }
      latched = latch;
      set(true);
    } else if (!latched) {
      set(false);
    }
  };

  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    el.setPointerCapture(event.pointerId);
    press(true, event.shiftKey || latchMode());
  });
  el.addEventListener('pointerup', () => press(false));
  el.addEventListener('pointercancel', () => press(false));
  el.addEventListener('keydown', (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      press(true, event.shiftKey || latchMode());
    }
  });
  el.addEventListener('keyup', (event) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      press(false);
    }
  });
  // the click that follows pointer/keyboard activation must not do anything further
  el.addEventListener('click', (event) => event.preventDefault());
  el.addEventListener('blur', () => press(false));

  register(id, el, { press: (down) => press(down) });
  // let go, latched or not
  const release = () => {
    latched = false;
    set(false);
  };
  return { el, press, release, isOn: () => on };
}
