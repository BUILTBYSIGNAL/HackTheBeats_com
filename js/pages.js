// The reading pages (About, Privacy, and the Learn guide) in a lightbox over the player,
// instead of a new tab. The pages stay what they are, at their own addresses: the lightbox
// fetches the page and shows its words, so there is one copy of them. A click with a
// modifier key (to open a new tab or window) is left to the browser, and so is any page
// that cannot be fetched.
import { config } from './config.js';
import { analytics } from './analytics.js';

// A link to one of the pages: "about", "/privacy", "learn", "learn/perform#pads".
//   → { name: 'learn/perform', to: '#page-pads' } (ids are prefixed by content()), or null
export function pageOf(href) {
  const found = /^\/?(about|privacy|learn(?:\/[a-z-]+)?)(?:#([A-Za-z0-9_-]+))?$/.exec(href || '');
  if (!found) return null;
  return { name: found[1], to: found[2] ? `#page-${found[2]}` : null };
}

export const pages = {
  dialog: null,
  cache: new Map(),
  hooks: {},

  // hooks: { openExample(id) } — "Open in the player" links in the guide
  init(dialog, hooks = {}) {
    this.dialog = dialog;
    this.hooks = hooks;
    dialog.querySelector('[data-act="close"]').addEventListener('click', () => dialog.close());
    // Donate glides to the shirt: About has it; from Privacy, About opens there
    dialog.querySelector('[data-act="donate"]').addEventListener('click', () => {
      const support = dialog.querySelector('.support');
      if (support) support.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else this.open('about', { to: '.support' });
    });
    // click on the backdrop closes
    dialog.addEventListener('click', (event) => event.target === dialog && dialog.close());
    // Inside the lightbox: a link to a part of the page scrolls there (the player's
    // <base href="/"> would otherwise take the browser away), and "Open in the player"
    // puts the example on deck A.
    dialog.addEventListener('click', (event) => {
      const link = event.target.closest?.('a[href]');
      if (!link || !dialog.contains(link) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (link.dataset.start) {
        event.preventDefault();
        dialog.close();
        this.hooks.openExample?.(link.dataset.start);
        return;
      }
      const href = link.getAttribute('href');
      if (!href.startsWith('#')) return;
      event.preventDefault();
      const id = href.slice(1);
      dialog.querySelector(`#page-${CSS.escape(id)}`)?.scrollIntoView({ block: 'start' });
    });
    // links to the pages anywhere on the player, including ones added later (the analytics
    // notice) and inside the lightbox itself (one Learn page to another)
    document.addEventListener('click', (event) => {
      const link = event.target.closest?.('a[href]');
      const page = link && !link.hasAttribute('target') && !link.hasAttribute('download') ? pageOf(link.getAttribute('href')) : null;
      if (!page || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      this.open(page.name, { to: page.to });
    });
  },

  // `to`: a part of the page to open at, rather than its top.
  async open(name, { to = null } = {}) {
    const dialog = this.dialog;
    // one lightbox at a time: the help sheet, say, would otherwise stay open underneath
    for (const open of document.querySelectorAll('dialog[open]')) if (open !== dialog) open.close();
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
    // a Learn page's words are in its article; About and Privacy are all words
    const root = page.querySelector('main.learn__body') ?? page.body;
    const learn = root !== page.body;
    const body = dialog.querySelector('.sheet__body');
    body.classList.toggle('learn-content', learn);
    body.replaceChildren(...this.content(page, root));
    dialog.querySelector('.sheet__title').textContent = page.querySelector('h1')?.textContent ?? '';
    dialog.querySelector('[data-act="tab"]').href = to ? `${name}#${to.replace(/^#page-/, '')}` : name;
    if (!dialog.open) dialog.showModal();
    body.scrollTop = 0;
    if (to) body.querySelector(to)?.scrollIntoView({ block: 'start' });
  },

  // The page's words: everything in `root` (its body, or its article) but the way home,
  // the heading (it goes in the lightbox's header), the footer and the scripts. A Learn
  // article also gets a list of its sections at the top.
  content(page, root = page.body) {
    const nodes = [...root.children]
      .filter((node) => !node.matches('a.home, h1, footer, script'))
      .map((node) => document.importNode(node, true));
    const holder = document.createElement('div');
    if (root !== page.body) {
      const sections = [...root.querySelectorAll('h2[id]')];
      if (sections.length) {
        const toc = document.createElement('nav');
        toc.className = 'readpage__toc';
        toc.setAttribute('aria-label', 'In this article');
        for (const section of sections) {
          const link = document.createElement('a');
          link.href = `#${section.id}`;
          link.textContent = section.textContent.trim();
          toc.append(link);
        }
        holder.append(toc);
      }
    }
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
    // About and Privacy end as the help sheet does: the shirt (About has its own), then a
    // way back to the top
    if (root === page.body) {
      if (!holder.querySelector('.support')) {
        const support = document.getElementById('support')?.cloneNode(true);
        if (support) {
          for (const node of [support, ...support.querySelectorAll('[id]')]) node.id &&= `page-${node.id}`;
          support.setAttribute('aria-labelledby', 'page-support-title');
          holder.append(support);
        }
      }
      const end = document.createElement('p');
      end.className = 'about__end';
      end.innerHTML = '<button type="button" class="about__up" aria-label="Back to the top"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg></button>';
      end.querySelector('button').addEventListener('click', () => this.dialog.querySelector('.sheet__body').scrollTo({ top: 0, behavior: 'smooth' }));
      holder.append(end);
    }
    holder.querySelector('#page-analytics-choice')?.addEventListener('click', () => {
      // the notice is on the player, under the lightbox
      this.dialog.close();
      analytics.ask();
    });
    return [...holder.childNodes];
  },
};
