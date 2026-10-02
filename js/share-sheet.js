// The share sheet: one place to share what is on a deck (or a song from the list) by link,
// through the phone's own share menu, or as a recording. What it says comes from
// share-sheet-core.js; what it does is up to main.js, through the hooks.
import { sheetState } from './share-sheet-core.js';

const canNativeShare = (url) => typeof navigator.share === 'function' && navigator.canShare?.({ url }) !== false;

export const shareSheet = {
  els: null,
  hooks: {},
  target: null,
  view: null,
  input: null,
  dismissed: false,
  busy: false,
  clipMaker: null,

  // hooks: {
  //   input(target)        → what share-sheet-core.js needs, plus { title, credit, from, songId }
  //   setShared(id, on)    → switch sharing on or off; resolves once the link works
  //   setFeaturable(id, on) → offer the song to the community shelf, or withdraw it
  //   act(action, target)  → 'save-share' | 'save-new-share' | 'save-new'; resolves to the new target
  //   shared(method, kind) → the link went out ('copy' or 'native')
  //   opened(kind), record(), recording(), canRecord(), copyKey
  // }
  init(els, hooks) {
    this.els = els;
    this.hooks = hooks;
    els.close.addEventListener('click', () => els.dialog.close());
    els.dialog.addEventListener('click', (event) => event.target === els.dialog && els.dialog.close());
    els.toggle.addEventListener('change', () => this.setShared(els.toggle.checked));
    els.feature?.addEventListener('change', () => this.setFeaturable(els.feature.checked));
    els.copy.addEventListener('click', () => this.copy());
    els.native.addEventListener('click', () => this.nativeShare());
    els.link.addEventListener('focus', () => els.link.select());
    els.warningGo.addEventListener('click', () => this.act(this.view?.warning?.primary?.action));
    els.warningSkip.addEventListener('click', () => this.act(this.view?.warning?.secondary?.action));
    els.offerGo.addEventListener('click', () => this.act(this.view?.offer?.action));
    els.record.addEventListener('click', () => {
      els.dialog.close();
      hooks.record();
    });
    els.video.addEventListener('click', () => {
      els.dialog.close();
      this.clipMaker?.(this.target);
    });
  },

  get open() {
    return Boolean(this.els?.dialog.open);
  },

  // target: { player } for a deck, or { songId } for a song from the list
  open(target) {
    this.target = target;
    this.dismissed = false;
    this.busy = false;
    this.render();
    if (!this.els.dialog.open) this.els.dialog.showModal();
    this.hooks.opened?.(this.input.kind);
  },

  // A video clip maker, when there is one (it adds "Make a video clip").
  setClipMaker(fn) {
    this.clipMaker = fn;
    if (this.open) this.render();
  },

  render() {
    if (!this.els || !this.target) return;
    const { els } = this;
    const input = { ...this.hooks.input(this.target), dismissed: this.dismissed, busy: this.busy };
    const view = sheetState(input);
    this.input = input;
    this.view = view;
    els.song.textContent = input.title || '';
    els.credit.textContent = input.credit || '';
    els.credit.hidden = !input.credit;
    els.from.textContent = input.from || '';
    els.from.hidden = !input.from;

    els.intro.textContent = view.intro;
    els.intro.hidden = !view.intro;
    els.offer.hidden = !view.offer;
    if (view.offer) {
      els.offerText.textContent = view.offer.text;
      els.offerGo.textContent = view.offer.label;
      els.offerGo.disabled = this.busy;
    }

    els.warning.hidden = !view.warning;
    if (view.warning) {
      els.warningText.textContent = view.warning.text;
      els.warningGo.textContent = view.warning.primary.label;
      els.warningGo.disabled = this.busy;
      els.warningSkip.hidden = !view.warning.secondary;
      els.warningSkip.textContent = view.warning.secondary?.label || '';
    }

    els.toggleRow.hidden = !view.toggle;
    els.toggle.checked = Boolean(view.toggle?.on);
    els.toggle.disabled = Boolean(view.toggle?.disabled);

    els.linkRow.hidden = !view.link;
    els.link.value = view.link?.text || '';
    els.copy.disabled = !view.link || view.link.pending;
    els.native.hidden = !view.link || view.link.pending || !canNativeShare(view.link.text);
    els.linkNote.textContent = view.link?.note || '';
    els.linkNote.hidden = !view.link?.note;

    els.recipient.textContent = view.recipient;
    els.recipient.hidden = !view.recipient;
    if (els.feature) {
      els.featureRow.hidden = !view.feature;
      els.feature.checked = Boolean(view.feature?.on);
      els.feature.disabled = Boolean(view.feature?.disabled);
      els.featureNote.textContent = view.feature?.note || '';
      els.featureNote.hidden = !view.feature;
    }
    els.note.textContent = view.note;
    els.note.hidden = !view.note;

    els.record.hidden = !this.hooks.canRecord();
    els.record.textContent = this.hooks.recording() ? 'Stop and save the recording' : 'Record audio';
    els.video.hidden = !this.clipMaker;
  },

  announce(message) {
    this.els.live.textContent = message;
  },

  async setShared(on) {
    const id = this.input?.songId;
    if (!id) return;
    this.busy = on;
    this.render();
    await this.hooks.setShared(id, on);
    this.busy = false;
    this.render();
    this.announce(on ? 'Sharing is on: the link is ready.' : 'Sharing is off: the old link no longer works.');
  },

  async setFeaturable(on) {
    const id = this.input?.songId;
    if (!id || !this.hooks.setFeaturable) return;
    await this.hooks.setFeaturable(id, on);
    this.render();
    this.announce(on ? 'Offered to the site. If its editors pick it, it appears under From the community.' : 'Withdrawn: the site will not feature it.');
  },

  async act(action) {
    if (!action) return;
    if (action === 'dismiss') {
      this.dismissed = true;
      return this.render();
    }
    this.busy = true;
    this.render();
    const next = await this.hooks.act(action, this.target);
    if (next) this.target = next;
    this.busy = false;
    this.dismissed = false;
    this.render();
  },

  async copy() {
    const text = this.view?.link?.text;
    if (!text || this.view.link.pending) return;
    try {
      await navigator.clipboard.writeText(text);
      this.els.copy.textContent = 'Copied';
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => (this.els.copy.textContent = 'Copy'), 2000);
      this.announce('Link copied.');
      this.hooks.shared('copy', this.input.kind);
    } catch {
      // no clipboard here: the link is selected, ready to copy by hand
      this.els.link.focus();
      this.els.link.select();
      this.announce(`Press ${this.hooks.copyKey} to copy the link.`);
      this.els.linkNote.textContent = `Press ${this.hooks.copyKey} to copy the link.`;
      this.els.linkNote.hidden = false;
    }
  },

  async nativeShare() {
    const url = this.view?.link?.text;
    if (!url) return;
    try {
      await navigator.share({ title: this.input.title, text: `"${this.input.title}", a live-coded song on Hacking the Beats`, url });
      this.hooks.shared('native', this.input.kind);
    } catch (error) {
      if (error?.name !== 'AbortError') this.announce('That did not work here: copy the link instead.');
    }
  },
};
