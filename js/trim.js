// Trimming from the arrangement strip. Drag across it to pick bars (or, with the strip open,
// along one track's row), or type their numbers, then cut them, keep only them, move them a
// bar earlier or later, or copy them and paste them in elsewhere (or silence that track there).
// The change is written into the code and run straight away, without stopping the music, so
// it is an edit like any other: the changed lines are marked, Save keeps it, Revert undoes
// it. The code it writes is described in trim-core.js.
import { analyze } from './analyze.js';
import { visuals } from './visuals.js';
import { reverse } from './tries.js';
import { BARS, planTrim, silenced, barsText, copyBars } from './trim-core.js';

// how long Undo stays on offer after a trim
const UNDO_FOR = 15000;

export const trim = {
  canvas: null,
  bar: null,
  hooks: {},
  drag: null,
  // what was picked: { from, to, row } (row null: every track)
  selection: null,
  // the trim just made, until the next: { player, before, after, changes, label }
  last: null,
  // bars copied, to paste: { song, bars, label } (bars are the song's own, from copyBars)
  clip: null,
  busy: false,
  undoTimer: null,

  // hooks: { focused(), canTrim(), status(message, options), seek(column) }
  init({ canvas, bar }, hooks) {
    this.canvas = canvas;
    this.bar = bar;
    this.hooks = hooks;
    canvas.addEventListener('pointerdown', (event) => this.down(event));
    canvas.addEventListener('pointermove', (event) => this.move(event));
    canvas.addEventListener('pointerup', (event) => this.up(event));
    canvas.addEventListener('pointercancel', () => (this.drag = null));
    bar.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-act]');
      if (button) this.act(button.dataset.act);
    });
    // the bar numbers can be typed: the pick follows once one is entered
    bar.addEventListener('change', (event) => {
      if (event.target.matches('.trimbar__num')) this.typed(event.target);
    });
  },

  /* ---------- picking bars ---------- */

  down(event) {
    if (event.button !== 0) return;
    const player = this.hooks.focused();
    const column = visuals.columnAt(event.clientX);
    if (column === null || !player?.song) return;
    const row = visuals.rowAt(event.clientY, player.mixer.tracks.length);
    this.drag = { from: column, to: column, row: typeof row === 'number' ? row : null, moved: false, shift: event.shiftKey };
    this.canvas.setPointerCapture(event.pointerId);
  },

  move(event) {
    const drag = this.drag;
    if (!drag) return;
    const column = visuals.columnNear(event.clientX);
    if (column === null || column === drag.to) return;
    drag.to = column;
    drag.moved = true;
    this.pick({ from: drag.from, to: drag.to, row: drag.row }, { final: false });
  },

  up(event) {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (drag.moved) return this.pick({ from: drag.from, to: drag.to, row: drag.row });
    // Shift-click picks one bar (or stretches what is picked); a plain click jumps there
    if (drag.shift) {
      const from = this.selection && this.selection.row === drag.row ? this.selection.from : drag.from;
      return this.pick({ from, to: drag.from, row: drag.row });
    }
    this.clear();
    this.hooks.seek(drag.from, event);
  },

  pick(selection, { final = true } = {}) {
    this.selection = selection;
    visuals.selection = selection;
    this.last = null;
    clearTimeout(this.undoTimer);
    if (final) this.render();
    else this.bar.hidden = true;
  },

  // A bar number typed into the bar of buttons (counted from 1, as on screen).
  typed(input) {
    const pick = this.selection;
    if (!pick) return;
    const value = Math.round(Number(input.value));
    let [a, b] = [Math.min(pick.from, pick.to), Math.max(pick.from, pick.to)];
    if (Number.isFinite(value)) {
      const bar = Math.max(1, Math.min(BARS, value)) - 1;
      if (input.dataset.end === 'from') a = bar;
      else b = bar;
    }
    this.pick({ from: Math.min(a, b), to: Math.max(a, b), row: pick.row });
    // put the cursor back where it was, ready for the next number
    const again = this.bar.querySelector(`.trimbar__num[data-end="${input.dataset.end}"]`);
    again?.focus();
    again?.select();
  },

  clear() {
    this.selection = null;
    visuals.selection = null;
    if (!this.last) this.bar.hidden = true;
  },

  /* ---------- the buttons over the strip ---------- */

  render() {
    const pick = this.selection;
    const player = this.hooks.focused();
    if (!pick || !player?.song) {
      this.bar.hidden = true;
      return;
    }
    const [a, b] = [Math.min(pick.from, pick.to), Math.max(pick.from, pick.to)];
    const button = (act, text, go = false, label = '') =>
      `<button type="button" class="chipbtn${go ? ' chipbtn--go' : ''}" data-act="${act}"${label ? ` aria-label="${label}"` : ''}>${text}</button>`;
    const number = (end, value) => `<input class="trimbar__num" data-end="${end}" type="number" inputmode="numeric" min="1" max="${BARS}" value="${value + 1}" aria-label="${end === 'from' ? 'First' : 'Last'} bar" />`;
    const numbers = `<span class="trimbar__bars">bars ${number('from', a)}–${number('to', b)}</span>`;
    let label;
    let buttons;
    if (pick.row === null) {
      label = '';
      const pasting = this.clip?.song === player.song.id;
      buttons =
        button('left', '‹', false, 'Move them a bar earlier') +
        button('right', '›', false, 'Move them a bar later') +
        button('cut', 'Cut', true) +
        button('keep', 'Keep only') +
        button('copy', 'Copy') +
        (pasting ? button('paste', 'Paste', false, `Paste ${this.clip.label} after these`) + button('over', 'Paste over', false, `Paste ${this.clip.label} over these`) : '');
    } else {
      const track = player.mixer.tracks[pick.row];
      label = `${track?.name ?? 'track'} ·`;
      const quiet = track && silenced(player.code, analyze(player.code).tracks[pick.row] ?? track, player.cut, pick.from, pick.to);
      buttons = quiet ? button('unsilence', 'Bring back', true) : button('silence', 'Silence', true);
    }
    this.show(label, numbers + buttons + `<button type="button" class="trimbar__close" data-act="cancel" aria-label="Cancel">×</button>`, a);
  },

  // The bar of buttons, over the strip at `column`.
  show(label, buttons, column) {
    const bar = this.bar;
    bar.innerHTML = `<span class="trimbar__label"></span>${buttons}`;
    bar.querySelector('.trimbar__label').textContent = label;
    bar.querySelector('.trimbar__label').hidden = !label;
    bar.hidden = false;
    const ribbon = bar.offsetParent?.getBoundingClientRect();
    const canvas = this.canvas.getBoundingClientRect();
    if (!ribbon) return;
    const x = canvas.left - ribbon.left + visuals.columnLeft(column);
    bar.style.left = `${Math.max(8, Math.min(x, ribbon.width - bar.offsetWidth - 8))}px`;
  },

  act(name) {
    const pick = this.selection;
    if (name === 'cancel') {
      this.last = null;
      this.bar.hidden = true;
      return this.clear();
    }
    if (name === 'undo') return this.undo();
    if (!pick) return;
    const player = this.hooks.focused();
    const bars = barsText(pick.from, pick.to);
    const [a, b] = [Math.min(pick.from, pick.to), Math.max(pick.from, pick.to)];
    const track = pick.row !== null ? player?.mixer.tracks[pick.row]?.name : null;
    if (name === 'copy') return this.copy();
    const clip = this.clip?.song === player?.song?.id ? this.clip : null;
    if ((name === 'paste' || name === 'over') && !clip) return this.hooks.status('Copy some bars first.');
    const n = clip?.bars.length ?? 0;
    // the bars that stay picked afterwards, so a move can be pressed again
    const actions = {
      cut: [{ kind: 'cut', from: a, to: b }, `Cut ${bars}`],
      keep: [{ kind: 'keep', from: a, to: b }, `Kept only ${bars}`],
      left: [{ kind: 'move', from: a, to: b, by: -1 }, `Moved ${bars} a bar earlier`, { from: a - 1, to: b - 1, row: null }],
      right: [{ kind: 'move', from: a, to: b, by: 1 }, `Moved ${bars} a bar later`, { from: a + 1, to: b + 1, row: null }],
      paste: [{ kind: 'paste', at: b + 1, bars: clip?.bars, over: false }, `Pasted ${clip?.label} after ${bars}`, { from: b + 1, to: b + n, row: null }],
      over: [{ kind: 'paste', at: a, bars: clip?.bars, over: true }, `Pasted ${clip?.label} over ${barsText(a, a + n - 1)}`, { from: a, to: a + n - 1, row: null }],
      silence: [{ kind: 'silence', track: pick.row, from: a, to: b, on: false }, `Silenced ${track} in ${bars}`],
      unsilence: [{ kind: 'silence', track: pick.row, from: a, to: b, on: true }, `Brought ${track} back in ${bars}`],
    };
    if (actions[name]) this.apply(...actions[name]);
  },

  // Copy: the picked bars of the song, to paste in after (or over) other bars.
  copy() {
    const pick = this.selection;
    const player = this.hooks.focused();
    if (!pick || pick.row !== null || !player?.song) return false;
    const bars = copyBars(player.cut, pick.from, pick.to);
    if (!bars) {
      this.hooks.status('Pick bars before the loop starts again.');
      return true;
    }
    const label = barsText(pick.from, pick.to);
    this.clip = { song: player.song.id, bars, label };
    this.hooks.status(`Copied ${label}. Pick where they go, then Paste puts them in after, Paste over in place.`, { hold: 6000 });
    this.render();
    return true;
  },

  // ← or → with bars picked: move them a bar earlier or later.
  moveSelection(by) {
    if (!this.selection || this.selection.row !== null) return false;
    this.act(by < 0 ? 'left' : 'right');
    return true;
  },

  // Backspace or Delete with bars picked: cut them (or silence the track's).
  cutSelection() {
    if (!this.selection) return false;
    this.act(this.selection.row === null ? 'cut' : 'silence');
    return true;
  },

  /* ---------- changing the code ---------- */

  // `then`: the bars to leave picked afterwards (a move, a paste), instead of offering Undo.
  async apply(action, label, then = null) {
    const player = this.hooks.focused();
    if (this.busy || !player?.song) return;
    if (player.gated || !player.ready) return this.hooks.status('Run the song first, then trim it.');
    if (!this.hooks.canTrim()) return;
    const before = player.code;
    const plan = planTrim(before, analyze(before).tracks, action);
    if (plan.error) return this.hooks.status(plan.error);
    this.clear();
    if (!plan.changes.length) return;
    this.busy = true;
    player.stage.applyChanges(plan.changes);
    const ran = await player.update();
    this.busy = false;
    if (!ran) {
      // it did not run: put the code back as it was, still playing the last good version
      player.stage.applyChanges(reverse(before, plan.changes));
      player.setProblem(null);
      return this.hooks.status('That trim did not run, so it was put back.');
    }
    this.last = { player, before, after: player.code, changes: plan.changes, label };
    this.hooks.status(`${label}. The change is marked in the code: Save keeps it.`, { hold: 9000 });
    if (then) return this.pick(then);
    this.offerUndo(label, Math.min(action.from, action.to));
  },

  offerUndo(label, column) {
    this.show(label, '<button type="button" class="chipbtn" data-act="undo">Undo</button><button type="button" class="trimbar__close" data-act="cancel" aria-label="Close">×</button>', column);
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => {
      this.last = null;
      if (!this.selection) this.bar.hidden = true;
    }, UNDO_FOR);
  },

  async undo() {
    const last = this.last;
    this.last = null;
    this.bar.hidden = true;
    if (!last || this.busy) return;
    const { player } = last;
    // only while the code is still as the trim left it
    if (player.code !== last.after) return this.hooks.status('The code has changed since, so that trim cannot be undone here. Revert puts the song back.');
    this.busy = true;
    player.stage.applyChanges(reverse(last.before, last.changes));
    await player.update();
    this.busy = false;
    this.hooks.status('Undone.');
  },
};
