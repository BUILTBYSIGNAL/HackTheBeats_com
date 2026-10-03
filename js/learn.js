// The Learn pages: the contents, the search box, the term drawer and the small things every
// page does (the version, the keys as this keyboard has them). The pages themselves are made
// by tools/learn.mjs; this only wakes them up.
import { VERSION } from './version.js';
import { analytics } from './analytics.js';
import { isApple, keyLabels } from './keys-core.js';
import { search, groupByArea, highlight, tokenize } from './learn-search-core.js';

const $ = (id) => document.getElementById(id);
const narrow = () => window.matchMedia('(max-width: 860px)').matches;
const editing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

analytics.start();
const version = $('version');
if (version) version.textContent = `v${VERSION}`;

/* ---------- keys as this keyboard has them ---------- */

const labels = keyLabels(isApple(navigator.platform));
for (const key of document.querySelectorAll('kbd[data-mod]')) key.textContent = labels.mod;

/* ---------- the article: headings that can take focus, and the contents following along ---------- */

const article = $('article');
const headings = [...document.querySelectorAll('.learn__body h2[id], .learn__body h3[id]')];
for (const heading of headings) heading.tabIndex = -1;

function arriveAt(id, { push = false } = {}) {
  const target = document.getElementById(id);
  if (!target) return false;
  if (push) history.pushState(null, '', `#${id}`);
  target.scrollIntoView({ block: 'start' });
  target.focus({ preventScroll: true });
  return true;
}
if (location.hash.length > 1) {
  const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (target) {
    requestAnimationFrame(() => target.focus?.({ preventScroll: true }));
    // once the pictures have their place, the address's part of the page is brought back into view
    window.addEventListener('load', () => target.scrollIntoView({ block: 'start', behavior: 'instant' }), { once: true });
  }
}

const navLinks = new Map([...document.querySelectorAll('.learnnav__sections a[href^="#"]')].map((link) => [link.getAttribute('href').slice(1), link]));
function markActive(id) {
  for (const [key, link] of navLinks) {
    const on = key === id;
    link.classList.toggle('is-active', on);
    if (on) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
  const active = navLinks.get(id);
  if (active) active.scrollIntoView({ block: 'nearest' });
}
if (navLinks.size) {
  const topbar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hb-topbar')) || 56;
  const sections = headings.filter((heading) => heading.tagName === 'H2');
  const current = () => {
    const line = topbar + window.innerHeight * 0.3;
    let found = sections[0];
    for (const heading of sections) if (heading.getBoundingClientRect().top <= line) found = heading;
    // at the very end of the page the last section is the one being read, however short
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) found = sections.at(-1);
    return found;
  };
  const update = () => {
    const heading = current();
    if (heading) markActive(heading.id);
  };
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(update, { rootMargin: `-${topbar}px 0px -70% 0px` });
    for (const heading of sections) observer.observe(heading);
  }
  window.addEventListener('scroll', update, { passive: true });
  update();
}

// Donate, in the bar: straight to the support block, however long the page (a smooth scroll
// over a long page can be cut short as pictures arrive)
document.querySelector('.learnbar__donate')?.addEventListener('click', (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  const support = document.getElementById('support');
  if (!support) return;
  event.preventDefault();
  history.pushState(null, '', '#support');
  support.scrollIntoView({ block: 'start', behavior: 'instant' });
  support.querySelector('a, button')?.focus({ preventScroll: true });
});

/* ---------- contents on a phone: the same list, in a sheet ---------- */

const contentsSheet = $('contents-sheet');
const contentsOpen = $('contents-open');
if (contentsSheet && contentsOpen) {
  const body = contentsSheet.querySelector('.learnnav-sheet__body');
  contentsOpen.addEventListener('click', () => {
    body.replaceChildren(...[...$('contents').children].map((node) => node.cloneNode(true)));
    contentsOpen.setAttribute('aria-expanded', 'true');
    contentsSheet.showModal();
  });
  contentsSheet.addEventListener('close', () => contentsOpen.setAttribute('aria-expanded', 'false'));
  contentsSheet.querySelector('[data-act="close"]').addEventListener('click', () => contentsSheet.close());
  contentsSheet.addEventListener('click', (event) => {
    if (event.target === contentsSheet) contentsSheet.close();
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (href.startsWith('#')) {
      event.preventDefault();
      contentsSheet.close();
      arriveAt(href.slice(1), { push: true });
    } else contentsSheet.close();
  });
}

/* ---------- the term drawer ---------- */

const drawer = $('termdrawer');
const glossary = {
  dom: null,
  pending: null,
  // The glossary's entries: this page's own, or fetched once.
  async load() {
    if (this.dom) return this.dom;
    const own = document.querySelector('.learn__body .glossary');
    if (own) return (this.dom = own);
    if (!this.pending) {
      this.pending = fetch('/learn/glossary')
        .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
        .then((html) => (this.dom = new DOMParser().parseFromString(html, 'text/html').querySelector('.glossary')))
        .catch(() => null);
    }
    return this.pending;
  },
  entry(id) {
    return this.dom?.querySelector(`.entry[id="${CSS.escape(id)}"]`) ?? null;
  },
};

const termDrawer = {
  opener: null,
  init() {
    if (!drawer) return;
    drawer.querySelector('[data-act="close"]').addEventListener('click', () => this.close());
    drawer.addEventListener('close', () => {
      const back = this.opener;
      this.opener = null;
      back?.focus?.();
    });
    drawer.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    // the words themselves: a click on a term opens it here instead of leaving the page
    document.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const term = event.target.closest?.('a.term[data-term]');
      if (!term) return;
      event.preventDefault();
      this.open(term.dataset.term, term);
    });
    // a term under the pointer: have the glossary ready before the click
    document.addEventListener('pointerover', (event) => event.target.closest?.('a.term') && glossary.load(), { passive: true });
    document.addEventListener('focusin', (event) => event.target.closest?.('a.term') && glossary.load());
    // the chips of related terms, and the way to the full section
    drawer.addEventListener('click', (event) => {
      const related = event.target.closest?.('button[data-term]');
      if (related) return void this.fill(related.dataset.term);
      const more = event.target.closest?.('[data-act="more"]');
      if (!more) return;
      const href = more.getAttribute('href');
      const here = new URL(href, location.href);
      if (here.pathname === location.pathname && here.hash) {
        event.preventDefault();
        // the heading takes the focus, not the term that opened the drawer
        this.opener = null;
        this.close();
        arriveAt(decodeURIComponent(here.hash.slice(1)), { push: true });
      }
      // another page: the link itself takes us there
    });
    // outside the open (non-modal) drawer: a click elsewhere closes it
    document.addEventListener('click', (event) => {
      if (!drawer.open || drawer.matches('[data-modal]') || drawer.contains(event.target) || event.target.closest?.('a.term')) return;
      this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && drawer.open && !drawer.matches('[data-modal]')) this.close();
    });
  },
  async open(id, opener = null) {
    const ready = await this.fill(id);
    if (!ready) {
      if (opener?.href) location.href = opener.href;
      return;
    }
    this.opener = opener;
    if (!drawer.open) {
      if (narrow()) {
        drawer.setAttribute('data-modal', '');
        drawer.showModal();
      } else {
        drawer.removeAttribute('data-modal');
        drawer.show();
      }
    }
    drawer.querySelector('.termdrawer__body').scrollTop = 0;
    drawer.querySelector('.termdrawer__title').focus({ preventScroll: true });
    analytics.event?.('term_open', { term: id });
  },
  async fill(id) {
    const dom = await glossary.load();
    const entry = dom && glossary.entry(id);
    if (!entry) return false;
    drawer.querySelector('.termdrawer__title').textContent = entry.querySelector('dt')?.textContent ?? id;
    const body = drawer.querySelector('.termdrawer__body');
    body.replaceChildren(...[...(entry.querySelector('dd')?.childNodes ?? [])].map((node) => node.cloneNode(true)));
    const related = drawer.querySelector('.termdrawer__related');
    const chips = (entry.dataset.related || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((other) => ({ id: other, title: glossary.entry(other)?.querySelector('dt')?.textContent }))
      .filter((chip) => chip.title);
    const seeAlso = document.createElement('span');
    seeAlso.textContent = 'See also';
    related.replaceChildren(
      ...(chips.length ? [seeAlso] : []),
      ...chips.map((chip) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = chip.title;
        button.dataset.term = chip.id;
        return button;
      }),
    );
    related.hidden = !chips.length;
    const more = drawer.querySelector('[data-act="more"]');
    const link = entry.querySelector('.entry__more a');
    more.href = link ? new URL(link.getAttribute('href'), location.href).href : `/learn/glossary#${id}`;
    return true;
  },
  close() {
    if (drawer.open) drawer.close();
  },
};
termDrawer.init();

/* ---------- search ---------- */

const searchBox = {
  form: $('search'),
  input: $('q'),
  panel: $('search-panel'),
  list: $('search-results'),
  note: $('search-note'),
  index: null,
  loading: null,
  results: [],
  active: -1,
  init() {
    if (!this.input) return;
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.go(this.active >= 0 ? this.active : 0);
    });
    this.input.addEventListener('focus', () => this.load());
    this.input.addEventListener('input', () => this.run());
    this.input.addEventListener('keydown', (event) => this.keys(event));
    this.list.addEventListener('mousedown', (event) => {
      const item = event.target.closest?.('[data-index]');
      if (!item) return;
      event.preventDefault();
      this.go(Number(item.dataset.index));
    });
    document.addEventListener('click', (event) => {
      if (!this.form.contains(event.target)) this.hide();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && !editing(document.activeElement) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        this.show();
        this.input.focus();
        this.input.select();
      }
    });
    $('search-open')?.addEventListener('click', () => {
      this.show();
      this.input.focus();
    });
    $('search-close')?.addEventListener('click', () => {
      this.input.value = '';
      this.hide();
      document.body.classList.remove('is-searching');
    });
  },
  show() {
    if (narrow()) document.body.classList.add('is-searching');
  },
  async load() {
    if (this.index) return this.index;
    if (!this.loading) {
      this.loading = fetch('/learn/search.json')
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then((index) => (this.index = index))
        .catch(() => null);
    }
    return this.loading;
  },
  async run() {
    const query = this.input.value.trim();
    if (!query) return this.hide();
    this.panel.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    if (!this.index) {
      this.say('Looking…');
      if (!(await this.load())) return this.say('Search needs a connection the first time. The glossary is a page of its own.');
      if (this.input.value.trim() !== query) return;
    }
    this.results = search(this.index, query);
    this.active = -1;
    this.input.removeAttribute('aria-activedescendant');
    if (!this.results.length) {
      this.list.replaceChildren();
      return this.say(`Nothing for “${query}”. Try another word, or the glossary.`);
    }
    this.note.hidden = true;
    const terms = tokenize(query);
    const kinds = { term: 'Glossary', key: 'Shortcut', page: 'Page' };
    const nodes = [];
    for (const group of groupByArea(this.results, this.index.areas)) {
      const label = document.createElement('li');
      label.className = 'search__group';
      label.setAttribute('role', 'presentation');
      label.textContent = group.title || (group.area === 'glossary' ? 'Glossary' : 'Learn');
      nodes.push(label);
      for (const result of group.results) {
        const index = this.results.indexOf(result);
        const item = document.createElement('li');
        item.className = 'search__result';
        item.id = `r-${index}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', 'false');
        item.dataset.index = String(index);
        const kind = kinds[result.entry.k];
        item.innerHTML = `<span class="search__title">${highlight(result.entry.t, terms)}${kind ? `<span class="search__kind">${kind}</span>` : ''}</span>${result.entry.s ? `<span class="search__snippet">${highlight(result.entry.s, terms)}</span>` : ''}`;
        nodes.push(item);
      }
    }
    this.list.replaceChildren(...nodes);
  },
  say(text) {
    this.note.textContent = text;
    this.note.hidden = false;
    this.list.replaceChildren();
  },
  keys(event) {
    if (event.key === 'Escape') {
      if (this.panel.hidden && !this.input.value) {
        this.input.blur();
        document.body.classList.remove('is-searching');
      } else {
        this.input.value = '';
        this.hide();
      }
      return;
    }
    if (!this.results.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.setActive((this.active + step + this.results.length) % this.results.length);
    }
  },
  setActive(index) {
    this.active = index;
    for (const item of this.list.querySelectorAll('[data-index]')) {
      const on = Number(item.dataset.index) === index;
      item.classList.toggle('is-active', on);
      item.setAttribute('aria-selected', String(on));
      if (on) {
        this.input.setAttribute('aria-activedescendant', item.id);
        item.scrollIntoView({ block: 'nearest' });
      }
    }
  },
  go(index) {
    const result = this.results[index];
    if (!result) return;
    const url = new URL(result.entry.u, location.href);
    analytics.event?.('guide_search', { query: this.input.value.trim(), to: result.entry.u });
    this.hide();
    if (url.pathname === location.pathname && url.hash) {
      document.body.classList.remove('is-searching');
      arriveAt(decodeURIComponent(url.hash.slice(1)), { push: true });
    } else location.href = url.href;
  },
  hide() {
    this.panel.hidden = true;
    this.results = [];
    this.active = -1;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  },
};
searchBox.init();
