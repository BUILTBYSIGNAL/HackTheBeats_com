// The song map: the sections of the code on stage (setup, knobs and switches, parts,
// helpers), listed in the stage's empty margin beside the code, or behind the Map button
// where there is no room. Hover or focus an entry for a fuller description; click it to
// glide the code there. Each part's dot pulses with its track. The sections and their
// words come from outline-core.js.
import { StateEffect, StateField, EditorView, Decoration } from '../vendor/strudel.bundle.js';
import { analyze } from './analyze.js';
import { outlineOf, itemsOf } from './outline-core.js';

// the free margin beside the code (px) that the map needs to sit in it
const DOCK_MIN = 210;
const phone = () => matchMedia('(max-width: 860px)').matches;
const KIND = { header: 'Setup', tempo: 'Setup', samples: 'Setup', knob: 'Knob', switch: 'Switch', part: 'Part', helper: 'Helper' };
const EDIT = { header: 'Edit the header', tempo: 'Edit the tempo', samples: 'Edit the sample packs', knob: 'Edit this knob', switch: 'Edit this switch', part: 'Edit this part', helper: 'Edit this helper' };

/* ---------- a brief mark on the lines of a section, in each editor ---------- */

const setMarked = StateEffect.define();
const marked = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    let next = tr.docChanged ? value.map(tr.changes) : value;
    for (const effect of tr.effects) if (effect.is(setMarked)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
const markLine = Decoration.line({ class: 'hb-mapped' });

// "Uses `key`" → text with the code parts in <code>
function withCode(text) {
  const parts = text.split(/`([^`]+)`/);
  return parts.map((part, i) => {
    if (i % 2 === 0) return document.createTextNode(part);
    const code = document.createElement('code');
    code.textContent = part;
    return code;
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const songMap = {
  els: null,
  hooks: {},
  // what the list on screen was drawn from
  built: { player: null, code: null, groups: [] },
  // the outline of the code as it is now (it may have been edited since the list was drawn)
  cache: { code: null, groups: [] },
  open: false,
  docked: false,
  levels: [],
  shown: null,
  // true while focus is put back on an entry, which should not bring its card back
  quiet: false,
  hideTimer: null,
  flashTimers: new Map(),

  // els: { root, list, empty, card, toggle, close, stage, panes }
  // hooks: { players, focused(), access() → 'full' | 'preview' | 'guest', edit(player, at),
  //          signIn(), releaseFocus(player) }
  init(els, hooks) {
    this.els = els;
    this.hooks = hooks;
    for (const player of hooks.players) {
      player.mirror.editor.dispatch({ effects: StateEffect.appendConfig.of(marked) });
      const mine = (fn) => (...args) => player === hooks.focused() && fn(...args);
      player.on('song', mine(() => this.render()));
      player.on('structure', mine(() => this.render()));
      player.on('mixer', mine(() => this.renderState()));
      player.on('frame', mine(() => this.pulse(player)));
      player.on('toggle', mine(() => this.pulse(player)));
    }

    const { root, list, card, toggle, close } = els;
    toggle.addEventListener('click', () => this.setOpen(!this.open));
    close.addEventListener('click', () => this.setOpen(false));
    list.addEventListener('click', (event) => {
      const button = event.target.closest('.map__item');
      if (button) this.choose(button.dataset.key);
    });
    list.addEventListener('mouseover', (event) => {
      const button = event.target.closest('.map__item');
      if (button) this.showCard(button);
      else if (event.target.closest('.map__card')) clearTimeout(this.hideTimer);
    });
    list.addEventListener('mouseout', (event) => {
      if (!event.relatedTarget?.closest?.('.map__card, .map__item')) this.hideSoon();
    });
    list.addEventListener('focusin', (event) => {
      const button = event.target.closest('.map__item');
      if (button?.matches(':focus-visible') && !this.quiet) this.showCard(button);
      else if (event.target.closest('.map__card')) clearTimeout(this.hideTimer);
    });
    list.addEventListener('focusout', (event) => {
      if (!event.relatedTarget?.closest?.('.map__card')) this.hideSoon();
    });
    list.addEventListener('scroll', () => this.placeCard(), { passive: true });
    card.querySelector('.map__card-edit').addEventListener('click', () => this.edit(this.shown));
    root.addEventListener('keydown', (event) => this.onKey(event));
    // a press anywhere else puts the opened map away
    document.addEventListener('pointerdown', (event) => {
      if (this.open && !this.docked && !root.contains(event.target) && !toggle.contains(event.target)) this.setOpen(false);
    });
    const watch = new ResizeObserver(() => this.measure());
    for (const node of [els.stage, ...els.panes]) watch.observe(node);
    this.render();
  },

  // The deck in focus, drawn again if its code has changed since.
  render() {
    if (!this.els) return;
    const player = this.hooks.focused();
    const code = player?.song ? player.code : null;
    if (this.built.player !== player || this.built.code !== code) this.build(player, code);
    this.renderState();
    this.measure();
  },

  groupsFor(code) {
    if (code === null) return [];
    if (this.cache.code !== code) this.cache = { code, groups: outlineOf(code, analyze(code)) };
    return this.cache.groups;
  },

  // An entry as the code says it now: the list may be a few keystrokes behind.
  entry(key) {
    const player = this.hooks.focused();
    if (!player?.song) return null;
    const find = (groups) => itemsOf(groups).find((item) => item.key === key);
    return find(this.groupsFor(player.code)) || find(this.built.groups) || null;
  },

  build(player, code) {
    const { root, list, empty, card } = this.els;
    // the same deck drawn again (after an edit, say) keeps its place and the entry in focus
    const same = this.built.player === player;
    const scroll = same ? list.scrollTop : 0;
    const focusKey = same && list.contains(document.activeElement) ? document.activeElement.closest('.map__item')?.dataset.key : null;
    this.hideCard();
    root.append(card);
    const groups = this.groupsFor(code);
    this.built = { player, code, groups };
    root.hidden = !player?.song;
    empty.hidden = groups.length > 0;
    for (let i = 0; i < this.levels.length; i++) root.style.removeProperty(`--lv-${i}`);
    this.levels = [];
    list.replaceChildren(
      ...groups.map((group) => {
        const section = el('section', 'map__group');
        const heading = el('h3', 'map__heading', group.title);
        heading.id = `map-group-${group.id}`;
        section.setAttribute('aria-labelledby', heading.id);
        const items = el('ul', 'map__items');
        for (const item of group.items) {
          const button = el('button', `map__item map__item--${item.kind}`);
          button.type = 'button';
          button.dataset.key = item.key;
          if (item.kind === 'part' && item.track !== null) button.style.setProperty('--lv', `var(--lv-${item.track}, 0)`);
          const text = el('span', 'map__text');
          text.append(el('span', 'map__label', item.label));
          if (item.summary) text.append(el('span', 'map__sub', item.summary));
          const line = el('span', 'map__line');
          line.append(el('span', 'visually-hidden', ', line '), String(item.line));
          button.append(el('span', 'map__mark'), text, el('span', 'visually-hidden map__state'), line);
          const entry = el('li');
          entry.append(button);
          items.append(entry);
        }
        section.append(heading, items);
        return section;
      }),
    );
    list.scrollTop = scroll;
    if (focusKey) [...list.querySelectorAll('.map__item')].find((button) => button.dataset.key === focusKey)?.focus({ preventScroll: true });
  },

  // Muted parts are dimmed, and said to be muted.
  renderState() {
    const player = this.built.player;
    if (!player?.song) return;
    for (const button of this.els.list.querySelectorAll('.map__item--part')) {
      const item = this.built.groups.length && itemsOf(this.built.groups).find((entry) => entry.key === button.dataset.key);
      const track = item?.track ?? null;
      const muted = track !== null && player.mixer.tracks[track] ? !player.mixer.audible(track) : false;
      button.classList.toggle('is-muted', muted);
      button.querySelector('.map__state').textContent = muted ? ', muted' : '';
    }
  },

  // Each part's dot follows its track's activity (the stage keeps it, rounded).
  pulse(player) {
    const levels = player.stage.levels;
    const root = this.els.root;
    for (let i = 0; i < Math.max(levels.length, this.levels.length); i++) {
      const value = levels[i] ?? 0;
      if (this.levels[i] === value) continue;
      this.levels[i] = value;
      root.style.setProperty(`--lv-${i}`, String(value));
    }
  },

  // Beside the code where the margin is wide enough; otherwise behind the Map button.
  measure() {
    const player = this.hooks.focused();
    if (!player) return;
    const { stage, root, toggle } = this.els;
    const free = parseFloat(getComputedStyle(player.mirror.editor.scrollDOM).paddingLeft) || 0;
    const atLeft = player.stage.root.getBoundingClientRect().left - stage.getBoundingClientRect().left < 2;
    const docked = !phone() && atLeft && free >= DOCK_MIN;
    root.style.setProperty('--map-free', `${Math.round(free)}px`);
    toggle.hidden = docked;
    if (docked === this.docked) return;
    this.docked = docked;
    document.body.classList.toggle('map-docked', docked);
    this.hideCard();
  },

  setOpen(open) {
    const { root, toggle } = this.els;
    const inside = root.contains(document.activeElement);
    this.open = open;
    document.body.classList.toggle('map-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    this.hideCard();
    if (open) root.querySelector('.map__item')?.focus({ preventScroll: true });
    else if (inside) toggle.focus({ preventScroll: true });
  },

  onKey(event) {
    const items = [...this.els.list.querySelectorAll('.map__item')];
    const at = items.indexOf(event.target);
    if (event.key === 'Escape') {
      if (this.shown) this.hideCard();
      else if (this.open && !this.docked) this.setOpen(false);
      else return;
      event.stopPropagation();
      return;
    }
    if (at < 0) return;
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, to))].focus();
  },

  /* ---------- going there ---------- */

  // Glide the code to an entry and mark its lines for a moment. The Follow camera keeps its
  // hands off for a while, so the reader can stay there.
  choose(key) {
    const player = this.hooks.focused();
    const item = this.entry(key);
    if (!player?.song || !item) return;
    this.go(player, item);
    for (const button of this.els.list.querySelectorAll('.map__item')) {
      if (button.dataset.key === key) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
    // on a phone the map covers the code: it gets out of the way
    if (!this.docked && phone()) this.setOpen(false);
  },

  go(player, item) {
    const { stage } = player;
    // an isolated track would leave the rest of the code too faint to read
    if (stage.focus !== null && stage.focus !== item.track) this.hooks.releaseFocus?.(player);
    stage.glideTo(item.from, 0.22);
    stage.handsOffUntil = performance.now() + 10000;
    this.flash(player, item);
  },

  flash(player, item) {
    const view = player.mirror.editor;
    const doc = view.state.doc;
    const first = doc.lineAt(Math.min(item.from, doc.length)).number;
    const last = Math.min(doc.lineAt(Math.min(Math.max(item.from, item.to - 1), doc.length)).number, first + 400);
    const ranges = [];
    for (let n = first; n <= last; n++) ranges.push(markLine.range(doc.line(n).from));
    view.dispatch({ effects: setMarked.of(Decoration.set(ranges)) });
    clearTimeout(this.flashTimers.get(view));
    this.flashTimers.set(
      view,
      setTimeout(() => view.dispatch({ effects: setMarked.of(Decoration.none) }), 2400),
    );
  },

  // "Edit this part": into the code with the caret at the start of the section. Signed out
  // it asks for an account first; the shared-song player has no editing.
  edit(key) {
    const player = this.hooks.focused();
    const item = key && this.entry(key);
    if (!player?.song || !item) return;
    const access = this.hooks.access();
    if (access === 'guest') return;
    this.hideCard();
    if (access !== 'full') return void this.hooks.signIn();
    this.go(player, item);
    if (!this.docked && this.open) this.setOpen(false);
    this.hooks.edit(player, item.from);
  },

  /* ---------- the card: the fuller description ---------- */

  showCard(button) {
    const item = this.entry(button.dataset.key);
    if (!item) return;
    clearTimeout(this.hideTimer);
    const { card } = this.els;
    const player = this.hooks.focused();
    this.shown = item.key;
    card.querySelector('.map__card-title').textContent = item.label;
    const lines = item.endLine > item.line ? `lines ${item.line}–${item.endLine}` : `line ${item.line}`;
    const muted = item.kind === 'part' && item.track !== null && player.mixer.tracks[item.track] && !player.mixer.audible(item.track);
    card.querySelector('.map__card-where').textContent = [KIND[item.kind], lines, muted ? 'muted' : null].filter(Boolean).join(' · ');
    card.querySelector('.map__card-details').replaceChildren(
      ...item.details.map((text) => {
        const line = el('li');
        line.append(...withCode(text));
        return line;
      }),
    );
    const note = card.querySelector('.map__card-note');
    note.hidden = !item.note;
    note.textContent = item.note || '';
    const code = card.querySelector('.map__card-code');
    code.hidden = !item.code;
    code.textContent = item.code || '';
    const access = this.hooks.access();
    const edit = card.querySelector('.map__card-edit');
    edit.hidden = access === 'guest';
    edit.textContent = access === 'full' ? EDIT[item.kind] : 'Sign in to edit';
    button.parentElement.append(card);
    card.hidden = false;
    this.placeCard();
  },

  // Beside its entry, inside the stage; gone once its entry has scrolled out of sight.
  placeCard() {
    const { card, root, list, stage } = this.els;
    const button = !card.hidden && card.parentElement?.querySelector('.map__item');
    if (!button) return;
    const at = button.getBoundingClientRect();
    const shown = list.getBoundingClientRect();
    if (at.bottom < shown.top || at.top > shown.bottom) return this.hideCard();
    const box = root.getBoundingClientRect();
    const bounds = stage.getBoundingClientRect();
    const lowest = bounds.bottom - box.top - card.offsetHeight - 8;
    card.style.top = `${Math.max(bounds.top - box.top + 8, Math.min(at.top - box.top, lowest))}px`;
  },

  hideSoon() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hideCard(), 280);
  },

  hideCard() {
    clearTimeout(this.hideTimer);
    if (!this.els || this.els.card.hidden) return;
    // (keyboard focus on the card's button goes back to its entry)
    const focusBack = this.els.card.contains(document.activeElement) ? this.els.card.parentElement?.querySelector('.map__item') : null;
    this.els.card.hidden = true;
    this.shown = null;
    this.quiet = true;
    focusBack?.focus({ preventScroll: true });
    this.quiet = false;
  },
};
