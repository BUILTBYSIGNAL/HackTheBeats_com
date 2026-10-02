// Changes to try: a song's own @try lines (see analyze-core.js), as chips over the stage.
// A tap makes the change in the code and runs it, so the music changes and the changed line
// is marked; another tap puts it back. Nothing is saved by trying.
import { analyze, planTry } from './analyze.js';

const MAX = 4;

// The edit that undoes `changes` once they have been made to `code`.
function reverse(code, changes) {
  let shift = 0;
  return changes.map(({ from, to, insert }) => {
    const at = from + shift;
    shift += insert.length - (to - from);
    return { from: at, to: at + insert.length, insert: code.slice(from, to) };
  });
}

export const tries = {
  root: null,
  list: null,
  hooks: {},
  busy: false,

  // hooks: { focused(), canUse(player), status(message), signedIn(), onTried(label, on) }
  init({ root, list }, hooks) {
    this.root = root;
    this.list = list;
    this.hooks = hooks;
    list.addEventListener('click', (event) => {
      const chip = event.target.closest('.tries__chip');
      if (chip) this.toggle(Number(chip.dataset.index));
    });
  },

  // What the deck in focus suggests, read afresh from its code.
  render() {
    if (!this.root) return;
    const player = this.hooks.focused();
    const usable = Boolean(player?.song) && !player.gated && this.hooks.canUse(player);
    const analysis = usable ? analyze(player.code) : null;
    const items = analysis ? analysis.meta.tries.slice(0, MAX) : [];
    this.root.hidden = !items.length;
    document.body.classList.toggle('has-tries', items.length > 0);
    this.list.replaceChildren(
      ...items.map((item, index) => {
        const { state } = planTry(player.code, item, analysis);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tries__chip';
        chip.dataset.index = String(index);
        chip.textContent = item.label;
        chip.setAttribute('aria-pressed', String(state === 'on'));
        chip.disabled = this.busy || state === 'gone';
        chip.title =
          state === 'gone'
            ? 'That part of the code has changed since'
            : item.changes.map(({ find, replace }) => (state === 'on' ? `${replace} → ${find}` : `${find} → ${replace}`)).join(' · ');
        return chip;
      }),
    );
  },

  async toggle(index) {
    const player = this.hooks.focused();
    if (this.busy || !player?.song || player.gated) return;
    const code = player.code;
    const analysis = analyze(code);
    const item = analysis.meta.tries[index];
    const plan = planTry(code, item, analysis);
    if (!item || plan.state === 'gone') {
      this.render();
      return this.hooks.status('That part of the code has changed, so this suggestion no longer fits.');
    }
    this.busy = true;
    this.render();
    player.stage.applyChanges(plan.changes);
    const ran = await player.update();
    if (!ran) {
      // it did not run: put the code back as it was, still playing the last good version
      player.stage.applyChanges(reverse(code, plan.changes));
      player.setProblem(null);
      this.hooks.status('That change did not run, so it was put back.');
    } else if (plan.state === 'off') {
      const keep = this.hooks.signedIn() ? '' : ' Sign in to keep your own version.';
      this.hooks.status(`${item.label}: the changed line is marked. Tap it again to put it back.${keep}`);
      this.hooks.onTried?.(item.label, true);
    } else {
      this.hooks.status(`${item.label}: put back as it was.`);
      this.hooks.onTried?.(item.label, false);
    }
    this.busy = false;
    this.render();
  },
};
