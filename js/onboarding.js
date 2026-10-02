// First steps: a short list, in a corner of the stage, of things to do that show someone new
// what the site is for. Each step ticks itself off when it is actually done; "Show me"
// points at where to do it. The logic is in onboarding-core.js.
import { persist } from './persist.js';
import { stepsFor, progress, markDone, forVisitor, shouldAutoOpen } from './onboarding-core.js';

// What each step says. `keys` names the keys this keyboard has (keys-core.js).
function stepCopy(id, { hasTries, keys }) {
  return {
    play: { name: 'Press play', hint: 'The code lights up as it plays: every sound comes from it.' },
    knob: { name: 'Turn a knob', hint: 'Each knob is a number in the code. Watch the number change as you turn it.' },
    mute: { name: 'Mute a track', hint: 'Click a track name in the code, like DRUMS:, or press M on its channel.' },
    tweak: hasTries
      ? { name: 'Try a change', hint: 'Tap a suggestion over the code. The line changes, and so does the music.' }
      : { name: 'Change the code', hint: `Press Edit, change a number or a word, then press Update (or ${keys.run}).` },
    signin: { name: 'Sign in to keep going', hint: 'Free, with Google. Then change the code, keep your version and share it.', action: 'Sign in with Google' },
    save: { name: 'Keep your version', hint: 'Press Save as my song (or Save). It goes into My songs, in your account.' },
    share: { name: 'Share it', hint: 'Anyone with the link can play your song, and keep a copy of their own.', action: 'Share' },
  }[id];
}

export const onboarding = {
  els: null,
  hooks: {},
  state: null,
  audience: { access: 'full', hasTries: false },

  // hooks: { showMe(id) → element or null, signIn(), share(), keys, event(name) }
  init(els, hooks) {
    this.els = els;
    this.hooks = hooks;
    this.state = forVisitor(persist.get('onboarding', null), { lastSong: persist.get('lastSong'), signedIn: persist.get('signedIn', false) });
    this.save();
    els.close.addEventListener('click', () => this.setOpen(false));
    els.toggle.addEventListener('click', () => this.setOpen(!this.isOpen()));
    els.never.addEventListener('click', () => {
      this.state = { ...this.state, never: true, open: false };
      this.save();
      this.render();
    });
    els.done.addEventListener('click', () => {
      this.state = { ...this.state, finished: true, open: false };
      this.save();
      this.render();
    });
    els.restart.addEventListener('click', () => this.restart());
    els.steps.addEventListener('click', (event) => {
      const button = event.target.closest('[data-act]');
      if (button) this.act(button.dataset.act);
    });
    this.render();
  },

  save() {
    persist.set('onboarding', this.state);
  },

  ids() {
    return stepsFor(this.audience);
  },

  isOpen() {
    return this.state?.open === true && !this.state.never && !this.state.finished;
  },

  // Who is here (signed in or not) and whether the song in focus has suggestions to tap.
  setAudience({ access, hasTries }) {
    if (this.audience.access === access && this.audience.hasTries === hasTries) return;
    this.audience = { access, hasTries };
    this.render();
  },

  setOpen(open) {
    if (!this.state) return;
    this.state = { ...this.state, open };
    this.save();
    this.render();
    if (open) this.els.coach.querySelector('[data-act]')?.focus();
  },

  // A step was done, for real.
  done(id) {
    if (!this.state) return;
    const before = this.state;
    this.state = markDone(this.state, id);
    if (this.state === before) return;
    if (id === 'play' && shouldAutoOpen(this.state)) {
      this.state = { ...this.state, open: true };
      this.hooks.event?.('tutorial_begin');
    }
    const ids = this.ids();
    // the end of the list (with an account) is worth saying once
    if (this.audience.access === 'full' && progress(this.state, ids).complete && !this.state.finished && !this.state.never) {
      this.state = { ...this.state, open: true };
      this.hooks.event?.('tutorial_complete');
    }
    if (ids.includes(id)) this.els.live.textContent = `Done: ${stepCopy(id, this.copyOptions()).name}.`;
    this.save();
    this.render();
  },

  restart() {
    this.state = { ...forVisitor(null, {}), open: true };
    this.save();
    this.render();
  },

  copyOptions() {
    return { hasTries: this.audience.hasTries, keys: this.hooks.keys };
  },

  // The next step's button: sign in, share, or show where.
  act(id) {
    if (id === 'signin') return this.hooks.signIn();
    if (id === 'share') return this.hooks.share();
    const target = this.hooks.showMe(id);
    this.els.live.textContent = stepCopy(id, this.copyOptions()).hint;
    if (!target) return;
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    target.focus?.({ preventScroll: true });
    target.classList.remove('is-pointed');
    void target.offsetWidth;
    target.classList.add('is-pointed');
    clearTimeout(this.pointTimer);
    this.pointTimer = setTimeout(() => target.classList.remove('is-pointed'), 2600);
  },

  render() {
    const { els, state } = this;
    if (!els || !state) return;
    const ids = this.ids();
    const { done, total, next, complete } = progress(state, ids);
    const gone = state.never || state.finished;
    const open = this.isOpen();
    els.toggle.hidden = gone;
    els.toggle.setAttribute('aria-expanded', String(open));
    els.progress.textContent = `${done}/${total}`;
    els.coach.hidden = !open;
    document.body.classList.toggle('coach-open', open);
    els.count.textContent = `${done} of ${total}`;
    els.end.hidden = !complete;
    const copy = this.copyOptions();
    els.steps.replaceChildren(
      ...ids.map((id) => {
        const { name, hint, action } = stepCopy(id, copy);
        const item = document.createElement('li');
        item.className = `coach__step${state.done[id] ? ' is-done' : ''}`;
        item.dataset.step = id;
        item.innerHTML = '<span class="coach__mark" aria-hidden="true"></span><div class="coach__body"><p class="coach__name"></p></div>';
        item.querySelector('.coach__name').textContent = name;
        if (state.done[id]) {
          const mark = document.createElement('span');
          mark.className = 'visually-hidden';
          mark.textContent = ' (done)';
          item.querySelector('.coach__name').append(mark);
        }
        if (id === next) {
          item.setAttribute('aria-current', 'step');
          const body = item.querySelector('.coach__body');
          const text = document.createElement('p');
          text.className = 'coach__hint';
          text.textContent = hint;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = action ? 'pillbtn pillbtn--go' : 'chipbtn';
          button.dataset.act = id;
          button.textContent = action || 'Show me';
          body.append(text, button);
        }
        return item;
      }),
    );
  },
};
