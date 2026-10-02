// The stage: one deck's code, locked and animated. These are CodeMirror extensions layered
// onto Strudel's editor — the code can be rewritten by the deck, never by the keyboard.
import {
  EditorState,
  EditorView,
  Compartment,
  StateEffect,
  StateField,
  Decoration,
  WidgetType,
  RangeSetBuilder,
  Prec,
  HighlightStyle,
  syntaxHighlighting,
  tags as t,
  codemirror,
  draw,
} from '../vendor/strudel.bundle.js';
import { changedLines } from './analyze-core.js';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- structure: tracks, slider numbers, focus, type-on veil ---------- */

const setStructure = StateEffect.define();
const setFlags = StateEffect.define();
const setReveal = StateEffect.define();
const setHot = StateEffect.define();
const setFocus = StateEffect.define();

const structure = StateField.define({
  create: () => ({ tracks: [], sliders: [], switches: [], flags: [], reveal: null, hot: null, focus: null }),
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      const map = (pos, assoc) => tr.changes.mapPos(pos, assoc);
      next = {
        ...next,
        tracks: next.tracks.map((track) => ({
          ...track,
          from: map(track.from, 1),
          to: map(track.to, -1),
          labelFrom: map(track.labelFrom, 1),
          labelTo: map(track.labelTo, -1),
        })),
        // a deck-owned number is replaced wholesale: keep hold of both ends of the new text
        sliders: next.sliders.map((slider) => ({ ...slider, from: map(slider.from, -1), to: map(slider.to, 1) })),
        switches: next.switches.map((item) => ({ ...item, from: map(item.from, -1), to: map(item.to, 1) })),
      };
    }
    for (const effect of tr.effects) {
      if (effect.is(setStructure)) next = { ...next, switches: [], ...effect.value, hot: null, focus: effect.value.keepFocus ? next.focus : null };
      else if (effect.is(setFlags)) next = { ...next, flags: effect.value };
      else if (effect.is(setReveal)) next = { ...next, reveal: effect.value };
      else if (effect.is(setHot)) next = { ...next, hot: effect.value };
      else if (effect.is(setFocus)) next = { ...next, focus: effect.value };
    }
    return next;
  },
});

/* ---------- what has changed since the song was last saved ---------- */

// The saved song's shape (its code with deck-owned numbers blanked), line by line. A line
// of the code on stage that is not in it, in order, is marked as changed.
const setBaseline = StateEffect.define();
const baseline = StateField.define({
  create: () => null,
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setBaseline)) return effect.value;
    return value;
  },
});

const changeDecorations = EditorView.decorations.compute([baseline, structure, 'doc'], (state) => {
  const before = state.field(baseline);
  if (!before) return Decoration.none;
  const { sliders, switches } = state.field(structure);
  const doc = state.doc;
  let text = doc.toString();
  const numbers = [...sliders, ...switches].filter(({ from, to }) => from < to && to <= text.length).sort((x, y) => y.from - x.from);
  for (const { from, to } of numbers) text = text.slice(0, from) + '#' + text.slice(to);
  const lines = changedLines(before, text.split('\n'));
  return Decoration.set(lines.filter((n) => n <= doc.lines).map((n) => Decoration.line({ class: 'hb-changed' }).range(doc.line(n).from)));
});

class CaretWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const caret = document.createElement('span');
    caret.className = 'hb-caret';
    caret.setAttribute('aria-hidden', 'true');
    return caret;
  }
  ignoreEvent() {
    return true;
  }
}
const caret = Decoration.widget({ widget: new CaretWidget(), side: 1 });
const veil = Decoration.mark({ class: 'hb-veil' });

const structureDecorations = EditorView.decorations.compute([structure], (state) => {
  const { tracks, sliders, switches, flags, reveal, hot, focus } = state.field(structure);
  const doc = state.doc;
  const ranges = [];

  for (const track of tracks) {
    if (track.to > doc.length || track.from >= track.to) continue;
    const flag = flags[track.index] || {};
    const stateClass = (flag.muted ? ' is-muted' : '') + (flag.solo ? ' is-solo' : '') + (focus === track.index ? ' is-focus' : '');
    const style = `--lv: var(--lv-${track.index}, 0)`;
    const first = doc.lineAt(track.from).number;
    const last = doc.lineAt(track.to).number;
    for (let n = first; n <= last; n++) {
      const edge = (n === first ? ' is-first' : '') + (n === last ? ' is-last' : '');
      ranges.push(Decoration.line({ class: `hb-trk${stateClass}${edge}`, attributes: { style } }).range(doc.line(n).from));
    }
    if (track.labelFrom < track.labelTo) {
      ranges.push(
        Decoration.mark({
          class: `hb-label${stateClass}`,
          attributes: { 'data-track': String(track.index), style, title: flag.muted ? 'Click to bring in' : 'Click to mute' },
        }).range(track.labelFrom, track.labelTo),
      );
    }
  }

  for (const slider of sliders) {
    if (slider.from >= slider.to || slider.to > doc.length) continue;
    ranges.push(
      Decoration.mark({
        class: `hb-num${hot === slider.k ? ' is-hot' : ''}`,
        attributes: { 'data-slider': String(slider.k), title: 'Controlled from the deck' },
      }).range(slider.from, slider.to),
    );
  }

  for (const item of switches) {
    if (item.from >= item.to || item.to > doc.length) continue;
    ranges.push(
      Decoration.mark({
        class: `hb-num hb-switch${hot === `s${item.j}` ? ' is-hot' : ''}`,
        attributes: { 'data-switch': String(item.j), title: 'Switched from the deck' },
      }).range(item.from, item.to),
    );
  }

  if (reveal !== null && reveal < doc.length) {
    ranges.push(caret.range(reveal));
    ranges.push(veil.range(reveal, doc.length));
  }
  return Decoration.set(ranges, true);
});

/* ---------- layout: hanging indents and break points for long method chains ---------- */

class BreakWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return document.createElement('wbr');
  }
  ignoreEvent() {
    return true;
  }
}
const softBreak = Decoration.widget({ widget: new BreakWidget(), side: -1 });
// `)` or a name, followed by `.method` — a good place to wrap `.a().b().c()` chains
const CHAIN = /[)\]\w"'`]\.(?=[A-Za-z_$])/g;

function buildLayout(doc) {
  const ranges = [];
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = line.text;
    if (!text) continue;
    // wrapped rows hang two characters in from the line's own indentation
    const indent = text.length - text.trimStart().length;
    ranges.push(Decoration.line({ attributes: { style: `--ind:${indent}` } }).range(line.from));
    CHAIN.lastIndex = 0;
    let match;
    while ((match = CHAIN.exec(text))) ranges.push(softBreak.range(line.from + match.index + 1));
  }
  return Decoration.set(ranges, true);
}

const layout = StateField.define({
  create: (state) => buildLayout(state.doc),
  update: (value, tr) => (tr.docChanged ? buildLayout(tr.newDoc) : value),
  provide: (field) => EditorView.decorations.from(field),
});

/* ---------- live notation: the tokens sounding right now ---------- */

const setLocations = StateEffect.define();
const setActive = StateEffect.define();
const hit = Decoration.mark({ class: 'hb-hit' });

const hits = StateField.define({
  create: () => ({ marks: Decoration.none, active: new Set() }),
  update(value, tr) {
    let { marks, active } = value;
    if (tr.docChanged) marks = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setLocations)) {
        // ids are the offsets at evaluation time; haps keep referring to those even after
        // the deck rewrites a number and CodeMirror shifts the marks.
        const length = tr.newDoc.length;
        marks = Decoration.set(
          effect.value
            .filter(([from, to]) => from < to && to <= length)
            .map(([from, to]) => Decoration.mark({ id: `${from}:${to}` }).range(from, to)),
          true,
        );
        active = new Set();
      } else if (effect.is(setActive)) {
        active = effect.value;
      }
    }
    return marks === value.marks && active === value.active ? value : { marks, active };
  },
});

const hitDecorations = EditorView.decorations.compute([hits], (state) => {
  const { marks, active } = state.field(hits);
  if (!active.size) return Decoration.none;
  const builder = new RangeSetBuilder();
  const cursor = marks.iter();
  while (cursor.value) {
    if (active.has(cursor.value.spec.id)) builder.add(cursor.from, cursor.to, hit);
    cursor.next();
  }
  return builder.finish();
});

/* ---------- look ---------- */

const theme = EditorView.theme(
  {
    '&': { color: 'var(--hb-ink-2)', backgroundColor: 'transparent' },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--hb-ink-4)', border: 'none' },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
);

const syntax = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--hb-ink-4)', fontStyle: 'italic' },
  // the mini-notation is the music: it gets the brightest ink
  { tag: [t.string, t.special(t.string)], color: 'var(--hb-ink)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--hb-ink-2)' },
  { tag: [t.keyword, t.definitionKeyword, t.controlKeyword, t.operatorKeyword], color: 'var(--hb-ink-3)' },
  { tag: t.labelName, color: 'var(--hb-ink)', fontWeight: '600' },
  { tag: [t.variableName, t.definition(t.variableName), t.function(t.variableName)], color: 'var(--hb-ink-2)' },
  { tag: [t.propertyName, t.function(t.propertyName), t.definition(t.propertyName)], color: 'var(--hb-ink-3)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.paren, t.squareBracket, t.brace], color: 'var(--hb-ink-4)' },
  { tag: [t.typeName, t.className, t.tagName, t.attributeName, t.meta, t.regexp, t.invalid], color: 'var(--hb-ink-3)' },
]);

let drawThemeSet = false;

/* ---------- one stage per deck ---------- */

export class Stage {
  // `root` is the pane element: it carries the per-track activity variables and state classes.
  constructor(mirror, root, callbacks = {}) {
    this.view = mirror.editor;
    this.root = root;
    this.callbacks = callbacks;
    this.lastActive = '';
    this.revealJob = null;
    this.levels = [];
    this.scrollJob = null;
    this.handsOffUntil = 0;
    this.editing = false;
    this.lock = new Compartment();

    // While locked, the code is something to look at and click on: labels mute their track,
    // deck-owned numbers lead to their control. While editing, clicks just place the caret.
    const behaviour = [
      EditorView.domEventHandlers({
        mousedown: (event) => {
          if (this.editing) return false;
          const target = event.target.closest?.('[data-track], [data-slider], [data-switch]');
          if (!target) {
            // A click on the code itself (not on a slider or a drawing) starts editing,
            // where that is allowed; the editor then places the caret as usual.
            if (event.button === 0 && !event.target.closest?.('.cm-slider, canvas')) this.callbacks.onWantEdit?.();
            return false;
          }
          event.preventDefault();
          if (target.dataset.track !== undefined) this.callbacks.onTrack?.(Number(target.dataset.track));
          else if (target.dataset.slider !== undefined) this.callbacks.onSlider?.(Number(target.dataset.slider));
          else this.callbacks.onSwitch?.(Number(target.dataset.switch));
          return true;
        },
        copy: (event) => (this.editing ? false : (event.preventDefault(), true)),
        cut: (event) => (this.editing ? false : (event.preventDefault(), true)),
        dragstart: (event) => (this.editing ? false : (event.preventDefault(), true)),
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        this.syncInlineSliders();
        this.callbacks.onDocChange?.();
      }),
    ];

    this.view.dispatch({
      effects: [
        StateEffect.appendConfig.of([this.lock.of(this.lockFor(false)), behaviour, layout, structure, structureDecorations, baseline, changeDecorations, hits, hitDecorations]),
        codemirror.compartments.theme.reconfigure(Prec.highest([theme, syntaxHighlighting(syntax)])),
      ],
    });

    // When someone scrolls the code themselves, the camera keeps its hands off for a while.
    const scroller = this.view.scrollDOM;
    const handsOff = () => {
      this.cancelScroll();
      this.handsOffUntil = performance.now() + 8000;
    };
    scroller.addEventListener('keydown', handsOff);
    scroller.addEventListener('wheel', handsOff, { passive: true });
    scroller.addEventListener('touchstart', handsOff, { passive: true });
    scroller.addEventListener('pointerdown', () => {
      this.cancelReveal();
      handsOff();
    });

    if (!drawThemeSet) {
      // Inline visuals take their colour from Strudel's draw theme.
      const ink = getComputedStyle(document.documentElement).getPropertyValue('--hb-ink').trim() || '#eceae4';
      draw.setTheme({ ...draw.getTheme(), foreground: ink });
      drawThemeSet = true;
    }
  }

  get state() {
    return this.view.state.field(structure);
  }

  lockFor(editing) {
    return [
      EditorState.readOnly.of(!editing),
      EditorView.editable.of(editing),
      EditorView.contentAttributes.of(
        editing ? { 'aria-label': 'Song source code' } : { 'aria-label': 'Song source code, read-only', 'aria-readonly': 'true' },
      ),
    ];
  }

  // Unlock the code for typing, or lock it again.
  setEditable(on) {
    this.editing = on;
    this.cancelReveal();
    this.root.classList.toggle('is-editing', on);
    this.view.dispatch({ effects: this.lock.reconfigure(this.lockFor(on)) });
    if (on) this.view.focus();
  }

  // What the code on stage is compared with to mark changed lines: the shape of the song
  // as it was last saved (null to mark nothing).
  setBaseline(shape) {
    this.view.dispatch({ effects: setBaseline.of(shape === null ? null : shape.split('\n')) });
  }

  // Describe the code that is already on stage again, after it has been edited.
  setStructure({ tracks, sliders, switches = [] }, flags) {
    this.view.dispatch({
      effects: setStructure.of({
        tracks: tracks.map(({ index, from, to, labelFrom, labelTo }) => ({ index, from, to, labelFrom, labelTo })),
        sliders: sliders.map(({ k, from, to }) => ({ k, from, to })),
        switches: switches.map(({ j, from, to }) => ({ j, from, to })),
        flags,
        keepFocus: true,
      }),
    });
  }

  // Strudel's inline slider remembers the number it was drawn with: its text, and where
  // that text is. When the number is changed from anywhere else (a knob, the keyboard) the
  // slider would show the old value, and its next move would overwrite the wrong
  // characters. After every change, tell each one what is in the code now.
  syncInlineSliders() {
    const widgets = this.view.plugin(codemirror.sliderPlugin)?.decorations;
    if (!widgets) return;
    const numbers = this.state.sliders;
    const byStart = new Map(numbers.map((number) => [number.from, number]));
    for (let at = widgets.iter(), i = 0; at.value; at.next(), i++) {
      const widget = at.value.widget;
      // widgets and numbers are both in source order; fall back to position if they differ
      const number = widgets.size === numbers.length ? numbers[i] : byStart.get(at.from);
      if (!widget || !number || number.from >= number.to) continue;
      const text = this.view.state.sliceDoc(number.from, number.to);
      widget.from = number.from;
      widget.to = number.to;
      widget.value = text;
      const input = widget.slider;
      if (!input) continue;
      input.from = number.from;
      input.to = number.to;
      input.originalValue = text;
      if (input.value !== text) input.value = text;
    }
  }

  // The text currently sitting in each deck-owned number.
  readNumbers() {
    const { sliders, switches } = this.state;
    const read = ({ from, to }) => (from < to ? this.view.state.sliceDoc(from, to) : '');
    return { sliders: sliders.map(read), switches: switches.map(read) };
  }
  // Where the deck-owned numbers are right now (for comparing two versions of the code).
  sliderRanges() {
    return this.state.sliders.filter(({ from, to }) => from < to);
  }
  numberRanges() {
    const { sliders, switches } = this.state;
    return [...sliders, ...switches].filter(({ from, to }) => from < to);
  }

  // Replace the code on stage and describe its structure in the same transaction.
  load(code, { tracks, sliders, switches = [] }, flags) {
    this.cancelReveal();
    this.cancelScroll();
    this.lastActive = '';
    this.handsOffUntil = 0;
    this.root.classList.remove('has-focus');
    const animate = !reducedMotion();
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: code },
      effects: [
        setStructure.of({
          tracks: tracks.map(({ index, from, to, labelFrom, labelTo }) => ({ index, from, to, labelFrom, labelTo })),
          sliders: sliders.map(({ k, from, to }) => ({ k, from, to })),
          switches: switches.map(({ j, from, to }) => ({ j, from, to })),
          flags,
        }),
        setLocations.of([]),
        setReveal.of(animate ? 0 : null),
        EditorView.scrollIntoView(0, { y: 'start' }),
      ],
    });
    return animate ? this.reveal() : Promise.resolve();
  }

  // Type the code on. Scaled so the first screenful lands in about a second.
  reveal() {
    const length = this.view.state.doc.length;
    const duration = Math.min(2600, Math.max(1200, length * 0.8));
    const started = performance.now();
    this.root.classList.add('is-revealing');
    return new Promise((resolve) => {
      const finish = () => {
        this.revealJob = null;
        this.view.dispatch({ effects: setReveal.of(null) });
        this.root.classList.remove('is-revealing');
        resolve();
      };
      const step = (now) => {
        const progress = Math.min(1, (now - started) / duration);
        if (progress >= 1) return finish();
        this.view.dispatch({ effects: setReveal.of(Math.floor(length * progress)) });
        this.revealJob.frame = requestAnimationFrame(step);
      };
      this.revealJob = { finish, frame: requestAnimationFrame(step) };
    });
  }
  cancelReveal() {
    if (!this.revealJob) return;
    cancelAnimationFrame(this.revealJob.frame);
    this.revealJob.finish();
  }

  setLocations(locations) {
    this.lastActive = '';
    this.view.dispatch({ effects: setLocations.of(locations || []) });
  }

  // Called every frame while playing; only touches the editor when the set changes.
  highlight(haps) {
    const ids = new Set();
    for (const hap of haps) {
      if (!hap.whole || !hap.context?.locations) continue;
      for (const { start, end } of hap.context.locations) ids.add(`${start}:${end}`);
    }
    const key = [...ids].sort().join(' ');
    if (key === this.lastActive) return;
    this.lastActive = key;
    this.view.dispatch({ effects: setActive.of(ids) });
  }
  clearHighlight() {
    if (!this.lastActive) return;
    this.lastActive = '';
    this.view.dispatch({ effects: setActive.of(new Set()) });
  }

  setFlags(flags) {
    this.view.dispatch({ effects: setFlags.of(flags) });
  }

  // Track activity is exposed as CSS variables so pulsing costs no editor transactions.
  setLevels(tracks) {
    for (const track of tracks) {
      const level = Math.round(track.level * 20) / 20;
      if (this.levels[track.index] === level) continue;
      this.levels[track.index] = level;
      this.root.style.setProperty(`--lv-${track.index}`, String(level));
    }
  }
  clearLevels() {
    this.levels.forEach((_, index) => this.root.style.removeProperty(`--lv-${index}`));
    this.levels = [];
  }

  // The deck moved a control: rewrite its number in the code.
  writeSlider(k, text) {
    const slider = this.state.sliders[k];
    if (!slider || this.view.state.sliceDoc(slider.from, slider.to) === text) return;
    this.view.dispatch({ changes: { from: slider.from, to: slider.to, insert: text } });
  }

  writeSwitch(j, text) {
    const item = this.state.switches[j];
    if (!item || this.view.state.sliceDoc(item.from, item.to) === text) return;
    this.view.dispatch({ changes: { from: item.from, to: item.to, insert: text } });
  }

  // Light a deck-owned number, optionally bringing it into view. `k` is a slider's index,
  // or "s<j>" for a switch, or null to clear.
  spotlight(k, { scroll = false } = {}) {
    const state = this.state;
    if (state.hot === k && !scroll) return;
    const effects = [setHot.of(k)];
    const slider = k === null ? null : typeof k === 'string' ? state.switches[Number(k.slice(1))] : state.sliders[k];
    if (scroll && slider && !this.editing) {
      this.cancelScroll();
      this.handsOffUntil = performance.now() + 8000;
      effects.push(EditorView.scrollIntoView(slider.from, { y: 'nearest', yMargin: 96 }));
    }
    this.view.dispatch({ effects });
  }

  /* ---------- focus: isolate one track's code and visual ---------- */

  get focus() {
    return this.state.focus;
  }
  setFocus(index) {
    const next = index === this.state.focus ? null : index;
    this.view.dispatch({ effects: setFocus.of(next) });
    this.root.classList.toggle('has-focus', next !== null);
    if (next !== null) this.scrollToTrack(next, { force: true });
    return next;
  }

  /* ---------- camera ---------- */

  // True while the viewer is scrolling or reading by hand.
  get handsOff() {
    return performance.now() < this.handsOffUntil;
  }

  cancelScroll() {
    if (!this.scrollJob) return;
    cancelAnimationFrame(this.scrollJob);
    this.scrollJob = null;
  }

  // Glide the code so that a track's block sits in the upper part of the stage.
  scrollToTrack(index, { force = false, align = 0.18 } = {}) {
    const track = this.state.tracks.find((entry) => entry.index === index);
    if (!track || (!force && this.handsOff)) return;
    const scroller = this.view.scrollDOM;
    const target = () => {
      const block = this.view.lineBlockAt(Math.min(track.from, this.view.state.doc.length));
      const offset = this.view.contentDOM.offsetTop;
      return clamp(block.top + offset - scroller.clientHeight * align, 0, scroller.scrollHeight - scroller.clientHeight);
    };
    this.cancelScroll();
    if (reducedMotion()) {
      scroller.scrollTop = target();
      return;
    }
    const from = scroller.scrollTop;
    const started = performance.now();
    const duration = clamp(Math.abs(target() - from) * 0.9, 350, 1100);
    const step = (now) => {
      const p = Math.min(1, (now - started) / duration);
      const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      // the target is re-read each frame: line heights firm up as lines scroll into view
      scroller.scrollTop = from + (target() - from) * eased;
      this.scrollJob = p < 1 ? requestAnimationFrame(step) : null;
    };
    this.scrollJob = requestAnimationFrame(step);
  }
}
