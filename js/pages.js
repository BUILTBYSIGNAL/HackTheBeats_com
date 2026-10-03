// The reading pages (About, Privacy) in a lightbox over the player, instead of a new tab.
// The pages stay what they are, at their own addresses: the lightbox fetches the page and
// shows its words, so there is one copy of them. A click with a modifier key (to open a
// new tab or window) is left to the browser, and so is any page that cannot be fetched.
import { config } from './config.js';
import { analytics } from './analytics.js';

const PAGES = new Set(['about', 'privacy']);

export const pages = {
  dialog: null,
  cache: new Map(),

  init(dialog) {
    this.dialog = dialog;
    dialog.querySelector('[data-act="close"]').addEventListener('click', () => dialog.close());
    // Donate glides to the shirt: About has it; from Privacy, About opens there
    dialog.querySelector('[data-act="donate"]').addEventListener('click', () => {
      const support = dialog.querySelector('.support');
      if (support) support.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else this.open('about', { to: '.support' });
    });
    // click on the backdrop closes
    dialog.addEventListener('click', (event) => event.target === dialog && dialog.close());
    // links to the pages anywhere on the player, including ones added later (the analytics notice)
    document.addEventListener('click', (event) => {
      const link = event.target.closest?.('a[href]');
      const name = link && PAGES.has(link.getAttribute('href')) ? link.getAttribute('href') : null;
      if (!name || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      this.open(name);
    });
  },

  // `to`: a part of the page to open at, rather than its top.
  async open(name, { to = null } = {}) {
    const dialog = this.dialog;
    let page = this.cache.get(name);
    if (!page) {
      try {
        const response = await fetch(name);
        if (!response.ok) throw new Error(`${response.status}`);
        page = new DOMParser().parseFromString(await response.text(), 'text/html');
        this.cache.set(name, page);
      } catch {
        // offline, say, with no copy kept: the page in a tab of its own, as before
        window.open(name, '_blank', 'noopener');
        return;
      }
    }
    const body = dialog.querySelector('.sheet__body');
    body.replaceChildren(...this.content(page));
    dialog.querySelector('.sheet__title').textContent = page.querySelector('h1')?.textContent ?? '';
    dialog.querySelector('[data-act="tab"]').href = name;
    if (!dialog.open) dialog.showModal();
    body.scrollTop = 0;
    if (to) body.querySelector(to)?.scrollIntoView({ block: 'start' });
  },

  // The page's words: everything in its body but the way home, the heading (it goes in the
  // lightbox's header), the footer and the scripts.
  content(page) {
    const nodes = [...page.body.children]
      .filter((node) => !node.matches('a.home, h1, footer, script'))
      .map((node) => document.importNode(node, true));
    const holder = document.createElement('div');
    holder.append(...nodes);
    // the page's ids would clash with the player's own (the help sheet's support section, say)
    for (const node of holder.querySelectorAll('[id]')) node.id = `page-${node.id}`;
    for (const node of holder.querySelectorAll('[aria-labelledby]')) node.setAttribute('aria-labelledby', `page-${node.getAttribute('aria-labelledby')}`);
    // what each page's own script would do
    if (config.contact) {
      for (const link of holder.querySelectorAll('[data-contact]')) {
        link.href = `mailto:${config.contact}`;
        link.textContent = config.contact;
      }
    }
    holder.querySelector('#page-analytics-choice')?.addEventListener('click', () => {
      // the notice is on the player, under the lightbox
      this.dialog.close();
      analytics.ask();
    });
    return [...holder.childNodes];
  },
};
