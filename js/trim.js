// Trimming from the arrangement strip. Drag across it to pick bars (or, with the strip open,
// along one track's row), then cut them or keep only them (or silence that track there).
// The change is written into the code and run straight away, without stopping the music, so
// it is an edit like any other: the changed lines are marked, Save keeps it, Revert undoes
// it. The code it writes is described in trim-core.js.
import { analyze } from './analyze.js';
import { visuals } from './visuals.js';
import { reverse } from './tries.js';
import { planTrim, silenced, barsText } from './trim-core.js';

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
    const bars = barsText(pick.from, pick.to);
    const button = (act, text, go = false) => `<button type="button" class="chipbtn${go ? ' chipbtn--go' : ''}" data-act="${act}">${text}</button>`;
    let label;
    let buttons;
    if (pick.row === null) {
      label = bars;
      buttons = button('cut', 'Cut', true) + button('keep', 'Keep only');
    } else {
      const track = player.mixer.tracks[pick.row];
      label = `${track?.name ?? 'track'} · ${bars}`;
      const quiet = track && silenced(player.code, analyze(player.code).tracks[pick.row] ?? track, player.cut, pick.from, pick.to);
      buttons = quiet ? button('unsilence', 'Bring back', true) : button('silence', 'Silence', true);
    }
    this.show(label, buttons + `<button type="button" class="trimbar__close" data-act="cancel" aria-label="Cancel">×</button>`, Math.min(pick.from, pick.to));
  },

  // The bar of buttons, over the strip at `column`.
  show(label, buttons, column) {
    const bar = this.bar;
    bar.innerHTML = `<span class="trimbar__label"></span>${buttons}`;
    bar.querySelector('.trimbar__label').textContent = label;
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
    const bars = barsText(pick.from, pick.to);
    const track = pick.row !== null ? this.hooks.focused()?.mixer.tracks[pick.row]?.name : null;
    const actions = {
      cut: [{ kind: 'cut', from: pick.from, to: pick.to }, `Cut ${bars}`],
      keep: [{ kind: 'keep', from: pick.from, to: pick.to }, `Kept only ${bars}`],
      silence: [{ kind: 'silence', track: pick.row, from: pick.from, to: pick.to, on: false }, `Silenced ${track} in ${bars}`],
      unsilence: [{ kind: 'silence', track: pick.row, from: pick.from, to: pick.to, on: true }, `Brought ${track} back in ${bars}`],
    };
    if (actions[name]) this.apply(...actions[name]);
  },

  // Backspace or Delete with bars picked: cut them (or silence the track's).
  cutSelection() {
    if (!this.selection) return false;
    this.act(this.selection.row === null ? 'cut' : 'silence');
    return true;
  },

  /* ---------- changing the code ---------- */

  async apply(action, label) {
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
