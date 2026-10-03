// The crate: the listener's own songs, the community shelf and the built-in beats, each
// with a small punchcard.
import { glyphSVG } from './library.js';
import { hash } from './library-core.js';
import { shelfLine } from './community-core.js';

const ICONS = {
  more: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>',
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>',
};

// "shared" stands out in the signal colour: anyone with the link can play that song
const sharedMark = () => Object.assign(document.createElement('span'), { className: 'beat__shared', textContent: 'shared' });

// When one of your songs was last saved: "saved Oct 3, 2:14 PM", with the year once it is not
// this one, kept on one line.
function savedMark(time) {
  const date = new Date(time);
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric';
  const when = date.toLocaleString(undefined, { month: 'short', day: 'numeric', year, hour: 'numeric', minute: '2-digit' });
  return Object.assign(document.createElement('span'), { className: 'beat__saved', textContent: `saved ${when}` });
}

export const crate = {
  dialog: null,
  lists: {},
  heading: null,
  note: null,
  handlers: {},
  target: 'A',
  thumbs: () => null,
  openMenu: null,

  // handlers: { onSelect(id, deck), onCopy(id), onRename(id, title), onDuplicate(id),
  //             onDelete(id), onShare(id), canShare(), isLocked(song),
  //             onCommunity(shareId, deck) }
  init({ dialog, mine, beats, close, heading, note, community, communitySection }, handlers) {
    this.dialog = dialog;
    this.lists = { mine, beats, community, communitySection };
    this.heading = heading;
    this.note = note;
    this.handlers = handlers;
    close.addEventListener('click', () => dialog.close());
    // click on the backdrop closes
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  },

  // `thumbs` maps a song to the SVG of its punchcard, when one has been drawn.
  render({ mine, beats, community = [] }, thumbs = this.thumbs) {
    this.thumbs = thumbs;
    this.fill(this.lists.mine, mine, true);
    this.fillCommunity(community);
    this.fill(this.lists.beats, beats, false);
    this.note.replaceChildren();
    if (!mine.length) {
      const more = document.createElement('a');
      more.className = 'learnlink';
      more.href = 'learn/build#start-a-song';
      more.textContent = 'Starting points in the guide';
      this.note.append('Nothing here yet. Change any beat and press Save as my song, copy a beat with the button beside it, or start a New song. ', more);
    }
    this.note.hidden = mine.length > 0;
  },

  fill(list, songs, own) {
    list.replaceChildren();
    songs.forEach((song, i) => {
      const item = document.createElement('li');
      item.className = `beat${!own && this.handlers.isLocked?.(song) ? ' is-locked' : ''}`;
      item.dataset.id = song.id;
      const facts = [
        song.bpm ? `${song.bpm} bpm` : null,
        song.trackCount ? `${song.trackCount} ${song.trackCount === 1 ? 'track' : 'tracks'}` : 'one pattern',
        song.knobCount ? `${song.knobCount} ${song.knobCount === 1 ? 'knob' : 'knobs'}` : null,
        own && song.shared ? sharedMark() : null,
        own && song.from ? `from ${song.from.title}` : null,
        // the admin's view of who else can play a beat
        song.audience === 'admin' ? 'only you' : song.audience === 'members' ? 'members' : song.audience === 'everyone' ? 'featured' : null,
        own && song.updatedAt ? savedMark(song.updatedAt) : null,
      ].filter(Boolean);
      item.innerHTML = `
        <button type="button" class="beat__main">
          <span class="beat__index">${String(i + 1).padStart(2, '0')}</span>
          <span class="beat__glyph">${this.thumbs(song) || glyphSVG(song.seed)}</span>
          <span class="beat__text">
            <span class="beat__title"></span>
            <span class="beat__meta"></span>
          </span>
        </button>
        <span class="beat__decks">
          <button type="button" class="beat__deck" data-deck="A">A</button>
          <button type="button" class="beat__deck" data-deck="B">B</button>
          <button type="button" class="beat__tool">${own ? ICONS.more : ICONS.copy}</button>
        </span>`;
      item.querySelector('.beat__title').textContent = song.title;
      item.querySelector('.beat__meta').append(
        ...[song.by ? `by ${song.by}` : null, ...facts].filter(Boolean).flatMap((fact, n) => (n ? [' · ', fact] : [fact])),
      );
      const choose = (deck) => {
        this.dialog.close();
        this.handlers.onSelect?.(song.id, deck);
      };
      item.querySelector('.beat__main').addEventListener('click', () => choose(this.target));
      item.querySelectorAll('.beat__deck').forEach((button) => {
        button.setAttribute('aria-label', `Load ${song.title} into deck ${button.dataset.deck}`);
        button.addEventListener('click', () => choose(button.dataset.deck));
      });
      const tool = item.querySelector('.beat__tool');
      if (own) {
        tool.setAttribute('aria-label', `More for ${song.title}`);
        tool.setAttribute('aria-expanded', String(this.openMenu === song.id));
        tool.addEventListener('click', () => this.toggleMenu(item, song));
        if (this.openMenu === song.id) item.append(this.menuFor(song));
      } else {
        tool.setAttribute('aria-label', `Copy ${song.title} to my songs`);
        tool.title = 'Copy to my songs';
        tool.addEventListener('click', () => this.handlers.onCopy?.(song.id));
      }
      list.append(item);
    });
  },

  // The songs the site's editors picked from what people share. Hidden while there are none.
  fillCommunity(entries) {
    const { community: list, communitySection: section } = this.lists;
    if (!list) return;
    section.hidden = !entries.length;
    list.replaceChildren();
    entries.forEach((entry, i) => {
      const item = document.createElement('li');
      item.className = 'beat beat--community';
      item.dataset.share = entry.shareId;
      item.innerHTML = `
        <button type="button" class="beat__main">
          <span class="beat__index">${String(i + 1).padStart(2, '0')}</span>
          <span class="beat__glyph">${glyphSVG(hash(entry.shareId))}</span>
          <span class="beat__text">
            <span class="beat__title"></span>
            <span class="beat__meta"></span>
            <span class="beat__blurb"></span>
          </span>
        </button>
        <span class="beat__decks">
          <button type="button" class="beat__deck" data-deck="A">A</button>
          <button type="button" class="beat__deck" data-deck="B">B</button>
        </span>`;
      item.querySelector('.beat__title').textContent = entry.title;
      item.querySelector('.beat__meta').textContent = shelfLine(entry);
      const blurb = item.querySelector('.beat__blurb');
      blurb.textContent = entry.blurb || '';
      blurb.hidden = !entry.blurb;
      const choose = (deck) => {
        this.dialog.close();
        this.handlers.onCommunity?.(entry.shareId, deck);
      };
      item.querySelector('.beat__main').addEventListener('click', () => choose(this.target));
      item.querySelectorAll('.beat__deck').forEach((button) => {
        button.setAttribute('aria-label', `Open ${entry.title} on deck ${button.dataset.deck}`);
        button.addEventListener('click', () => choose(button.dataset.deck));
      });
      list.append(item);
    });
  },

  toggleMenu(item, song) {
    const open = this.openMenu === song.id;
    this.dialog.querySelectorAll('.beat__menu').forEach((menu) => menu.remove());
    this.dialog.querySelectorAll('.beat__tool[aria-expanded]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
    this.openMenu = open ? null : song.id;
    if (open) return;
    item.querySelector('.beat__tool').setAttribute('aria-expanded', 'true');
    const menu = this.menuFor(song);
    item.append(menu);
    menu.querySelector('input').select();
  },

  // Rename, duplicate, share and delete for one of the listener's own songs.
  menuFor(song) {
    const { handlers } = this;
    const menu = document.createElement('div');
    menu.className = 'beat__menu';
    menu.innerHTML = `
      <form class="beat__rename">
        <input type="text" maxlength="80" aria-label="Song title" />
        <button type="submit" class="chipbtn">Rename</button>
      </form>
      <div class="beat__actions">
        <button type="button" class="chipbtn" data-action="duplicate">Duplicate</button>
        <button type="button" class="chipbtn" data-action="share"></button>
        <button type="button" class="chipbtn chipbtn--danger" data-action="delete">Delete</button>
      </div>`;
    const input = menu.querySelector('input');
    input.value = song.title;
    menu.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value.trim() && input.value.trim() !== song.title) handlers.onRename?.(song.id, input.value.trim());
    });
    const [duplicate, share, remove] = menu.querySelectorAll('[data-action]');
    duplicate.addEventListener('click', () => handlers.onDuplicate?.(song.id));

    share.textContent = handlers.canShare?.() ? (song.shared ? 'Shared · link' : 'Share…') : 'Sign in to share';
    share.addEventListener('click', () => handlers.onShare?.(song.id));

    let armed = false;
    remove.addEventListener('click', () => {
      if (armed) return handlers.onDelete?.(song.id);
      armed = true;
      remove.textContent = 'Really delete?';
      setTimeout(() => {
        armed = false;
        remove.textContent = 'Delete';
      }, 3000);
    });
    return menu;
  },

  setThumb(id, svg) {
    const glyph = this.dialog.querySelector(`.beat[data-id="${CSS.escape(id)}"] .beat__glyph`);
    if (glyph) glyph.innerHTML = svg;
  },

  // Mark which song is on which deck.
  setLoaded(loaded) {
    this.dialog.querySelectorAll('.beat[data-id]').forEach((item) => {
      const decks = Object.entries(loaded)
        .filter(([, id]) => id === item.dataset.id)
        .map(([deck]) => deck);
      item.classList.toggle('is-loaded', decks.length > 0);
      item.querySelectorAll('.beat__deck').forEach((button) => button.setAttribute('aria-pressed', String(decks.includes(button.dataset.deck))));
    });
  },

  // Opens the list; a click on a song loads it into `deck`.
  open(deck = this.target) {
    this.target = deck;
    this.heading.textContent = `Songs · deck ${deck}`;
    if (this.dialog.open) return;
    this.dialog.showModal();
    (this.dialog.querySelector('.beat.is-loaded .beat__main') || this.dialog.querySelector('.beat__main'))?.focus();
  },
};
