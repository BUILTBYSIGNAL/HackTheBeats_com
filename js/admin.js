// The admin sheet: the public beats, the admin's own songs (to publish as beats), and the
// songs people have shared (and which of them the community shelf features). Only an admin
// account is offered it, and the database refuses these writes from anyone else
// (firestore.rules), so nothing here is what keeps other people out.
import { cloud } from './cloud.js';
import { songs, linkToSong } from './songs.js';
import { describeSong } from './library.js';
import { newId } from './songs-core.js';
import { orderBeats, newBeat, featuredIds, audienceOf, buildCatalog, beatsFromExport, MAX_FEATURED } from './beats-core.js';
import { SHELF_MAX, eligibleForShelf, communityEntry } from './community-core.js';

const describe = (beat) => describeSong({ id: beat.id || 'new', code: beat.code }, 'beats');
const describeShared = (song) => describeSong({ id: song.id, code: song.code }, 'shared');
const button = (label, onClick, { pressed, danger, title } = {}) => {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `chipbtn${danger ? ' chipbtn--danger' : ''}`;
  el.textContent = label;
  if (pressed !== undefined) el.setAttribute('aria-pressed', String(pressed));
  if (title) el.title = title;
  el.addEventListener('click', onClick);
  return el;
};
// A button that asks once more before it acts.
const confirmButton = (label, sure, onConfirm) => {
  let armed = false;
  const el = button(label, () => {
    if (armed) return onConfirm();
    armed = true;
    el.textContent = sure;
    setTimeout(() => {
      armed = false;
      el.textContent = label;
    }, 3000);
  }, { danger: true });
  return el;
};
const span = (className, text) => {
  const el = document.createElement('span');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// Who may play a beat, as the sheet names it.
const AUDIENCES = [
  ['everyone', 'Anyone', 'Featured: anyone can play it, signed in or not'],
  ['members', 'Members', 'Everyone who is signed in can play it'],
  ['admin', 'Only me', 'Only you can play it'],
];
const audienceName = (audience) => AUDIENCES.find(([key]) => key === audience)[1].toLowerCase();

export const admin = {
  els: null,
  beats: [],
  shared: [],
  // the share ids on the community shelf
  featured: new Set(),
  // which beats the list shows: 'all', or one audience
  filter: 'all',
  // the beat whose code is being replaced from one of the admin's songs
  replacing: null,
  onChange: () => {},
  busy: false,

  // `siteBeats()` gives the beats that came with the site's own files, for a first
  // publication into an empty database; `openSong(id)` puts one of the admin's songs on deck A.
  init(els, { onChange, siteBeats, openSong }) {
    this.els = els;
    this.onChange = onChange;
    this.siteBeats = siteBeats;
    this.openSong = openSong;
    els.seed.addEventListener('click', () => this.seed());
    els.close.addEventListener('click', () => els.dialog.close());
    els.dialog.addEventListener('click', (event) => event.target === els.dialog && els.dialog.close());
    for (const tab of els.tabs) tab.addEventListener('click', () => this.show(tab.dataset.adminTab));
    // one ⋯ menu open at a time, and a click anywhere else closes it
    els.dialog.addEventListener('click', (event) => {
      for (const menu of els.dialog.querySelectorAll('.admin__more[open]')) if (!menu.contains(event.target)) menu.open = false;
    });
    els.importButton.addEventListener('click', () => els.file.click());
    els.file.addEventListener('change', async (event) => {
      const [file] = event.target.files;
      event.target.value = '';
      if (file) this.importFile(await file.text());
    });
  },

  async open() {
    if (!cloud.user?.admin) return;
    this.els.dialog.showModal();
    this.show('beats');
  },

  async show(tab) {
    for (const el of this.els.tabs) el.setAttribute('aria-pressed', String(el.dataset.adminTab === tab));
    for (const panel of this.els.panels) panel.hidden = panel.dataset.adminPanel !== tab;
    this.status('');
    try {
      if (tab === 'beats' || tab === 'mine') await this.loadBeats();
      else await this.loadShared();
    } catch (error) {
      console.warn('[admin]', error);
      this.status('Could not read that just now.');
    }
  },

  status(message) {
    this.els.status.textContent = message;
  },

  /* ---------- public beats ---------- */

  async loadBeats() {
    this.beats = orderBeats(await cloud.listBeats({ all: true }));
    this.render();
  },

  render() {
    this.renderBeats();
    this.renderMine();
  },

  // The beat published from one of the admin's songs: by the link it was published with,
  // else one that plays exactly that song's code.
  beatOf(song) {
    return this.beats.find((beat) => beat.song === song.id) || this.beats.find((beat) => !beat.song && beat.code === song.code) || null;
  },

  renderBeats() {
    const { list, filter } = this.els;
    list.replaceChildren();
    // an empty database can be filled with the beats the site came with, in one go
    this.els.seed.hidden = this.beats.length > 0 || !this.siteBeats().length;
    const featured = featuredIds(this.beats);
    const audiences = new Map(this.beats.map((beat) => [beat.id, audienceOf(beat, featured)]));
    const count = (audience) => [...audiences.values()].filter((value) => value === audience).length;
    if (this.filter !== 'all' && !count(this.filter)) this.filter = 'all';
    filter.replaceChildren(
      ...[['all', 'All', this.beats.length], ...AUDIENCES.map(([key, label]) => [key, label, count(key)])].map(([key, label, n]) => {
        const chip = button(`${label} ${n}`, () => {
          this.filter = key;
          this.renderBeats();
        }, { pressed: this.filter === key });
        chip.dataset.filter = key;
        return chip;
      }),
    );
    filter.hidden = !this.beats.length;
    if (!this.beats.length) {
      const empty = document.createElement('li');
      empty.className = 'admin__empty';
      empty.textContent = 'There are no beats in the database yet. Until there are, the site plays the beats in its own files.';
      list.append(empty);
    }
    const mine = songs.list();
    this.beats.forEach((beat, i) => {
      const audience = audiences.get(beat.id);
      const row = document.createElement('li');
      row.className = `admin__row admin__row--beat${audience === 'admin' ? ' is-private' : ''}`;
      row.dataset.id = beat.id;
      row.dataset.audience = audience;
      row.hidden = this.filter !== 'all' && this.filter !== audience;
      const source = beat.song && mine.find((song) => song.id === beat.song);
      const meta = [`/beats/${beat.slug}`, source ? `from your song "${source.title}"` : null, beat.updatedAt ? `changed ${day(beat.updatedAt)}` : null];

      const who = span('admin__audience');
      who.setAttribute('role', 'group');
      who.setAttribute('aria-label', `Who can play ${beat.title}`);
      for (const [key, label, title] of AUDIENCES) {
        const choice = button(label, () => key !== audience && this.setAudience(beat.id, key), { pressed: key === audience, title });
        choice.dataset.audience = key;
        who.append(choice);
      }

      const more = document.createElement('details');
      more.className = 'admin__more';
      const summary = document.createElement('summary');
      summary.className = 'chipbtn';
      summary.textContent = '⋯';
      summary.title = 'More';
      summary.setAttribute('aria-label', `More for ${beat.title}`);
      const menu = span('admin__menu');
      const up = button('Move up', () => this.move(beat.id, -1));
      const down = button('Move down', () => this.move(beat.id, 1));
      up.disabled = i === 0;
      down.disabled = i === this.beats.length - 1;
      const replace = button('Replace code…', () => {
        this.replacing = beat.id;
        this.renderBeats();
      }, { title: 'Play the code of one of your songs instead' });
      replace.disabled = !mine.length;
      menu.append(up, down, button('Rename', () => this.rename(beat.id)), replace, confirmButton('Remove', 'Really remove?', () => this.remove(beat.id)));
      more.append(summary, menu);

      const tools = span('admin__tools');
      tools.append(who, more);
      row.append(span('admin__name', beat.by ? `${beat.title} — ${beat.by}` : beat.title), tools, span('admin__meta', meta.filter(Boolean).join(' · ')));
      if (this.replacing === beat.id) row.append(this.replacePicker(beat, mine));
      list.append(row);
    });
  },

  // Under a beat: choose one of the admin's songs to take its code from.
  replacePicker(beat, mine) {
    const picker = span('admin__replace');
    const select = document.createElement('select');
    select.setAttribute('aria-label', `The song whose code "${beat.title}" will play`);
    for (const song of mine) {
      const option = document.createElement('option');
      option.value = song.id;
      option.textContent = song.title;
      option.selected = song.id === beat.song;
      select.append(option);
    }
    const cancel = () => {
      this.replacing = null;
      this.renderBeats();
    };
    picker.append(span('admin__meta', 'Play the code of'), select, button('Use its code', () => this.replace(beat.id, select.value)), button('Cancel', cancel));
    return picker;
  },

  // The admin's own songs, newest change first: each can become a beat, and one that is a
  // beat already can put its latest code on it.
  renderMine() {
    const list = this.els.mine;
    list.replaceChildren();
    const mine = songs.list();
    if (!mine.length) {
      const empty = document.createElement('li');
      empty.className = 'admin__empty';
      empty.textContent = 'You have no songs of your own yet. Copy a beat or start a new song from the song list.';
      list.append(empty);
    }
    const featured = featuredIds(this.beats);
    for (const song of mine) {
      const beat = this.beatOf(song);
      const row = document.createElement('li');
      row.className = 'admin__row';
      row.dataset.id = song.id;
      const meta = [
        song.updatedAt ? `changed ${day(song.updatedAt)}` : null,
        song.shared ? 'shared' : null,
        beat ? `beat "${beat.title}" (${audienceName(audienceOf(beat, featured))})` : song.from?.title ? `a copy of "${song.from.title}"` : null,
      ];
      const tools = span('admin__tools');
      const open = button('Open', () => this.openSong(song.id), { title: 'Put it on deck A' });
      if (beat) {
        const update = button('Update beat', () => this.replace(beat.id, song.id), { title: `Put this song's code on "${beat.title}"` });
        const current = beat.code === song.code;
        update.disabled = current;
        if (current) update.title = `"${beat.title}" already plays this code`;
        tools.append(open, update);
      } else {
        tools.append(open, button('Publish as beat', () => this.publish(song.id), { title: 'Add it to the beats. Only you can play it until you say who else can.' }));
      }
      row.append(span('admin__name', song.title), tools, span('admin__meta', meta.filter(Boolean).join(' · ')));
      list.append(row);
    }
  },

  // Write a new state of the collection: the changed beats, and the catalog made from all of them.
  // Resolves to whether it was saved.
  async commit(next, { save = [], remove = [] }, message) {
    if (this.busy) return false;
    this.busy = true;
    let saved = false;
    const now = Date.now();
    const changed = new Map(save.map((beat) => [beat.id, { ...beat, updatedAt: now }]));
    const all = next.map((beat) => changed.get(beat.id) || beat);
    // at least one beat is featured: with none marked, the first one is
    const featured = featuredIds(all);
    const settled = all.map((beat) => {
      const want = featured.has(beat.id);
      if (beat.featured === want) return beat;
      const fixed = { ...beat, featured: want, updatedAt: now };
      changed.set(beat.id, fixed);
      return fixed;
    });
    try {
      await cloud.saveBeats({ save: [...changed.values()], remove, catalog: buildCatalog(settled, describe, now) });
      this.beats = orderBeats(settled);
      this.replacing = null;
      this.status(message);
      saved = true;
      this.onChange();
    } catch (error) {
      console.warn('[admin] could not save', error);
      this.status('That was not saved. Nothing has changed.');
    } finally {
      this.busy = false;
      this.render();
    }
    return saved;
  },

  // From the stage: put the code on a deck in place of a public beat's.
  async updateBeatCode(id, code) {
    if (!cloud.user?.admin) return false;
    if (!this.beats.some((entry) => entry.id === id)) this.beats = orderBeats(await cloud.listBeats({ all: true }));
    const current = this.beats.find((entry) => entry.id === id);
    if (!current) return false;
    const beat = { ...current, code };
    return this.commit(this.beats.map((entry) => (entry.id === id ? beat : entry)), { save: [beat] }, `"${beat.title}" has been updated for everyone.`);
  },

  move(id, direction) {
    const i = this.beats.findIndex((beat) => beat.id === id);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= this.beats.length) return;
    const a = { ...this.beats[i], order: this.beats[j].order };
    const b = { ...this.beats[j], order: this.beats[i].order };
    // two beats with the same place (an old import, say) still swap
    if (a.order === b.order) a.order += direction;
    this.commit(this.beats.map((beat) => (beat.id === a.id ? a : beat.id === b.id ? b : beat)), { save: [a, b] }, `Moved "${a.title}".`);
  },

  // Who may play a beat: 'everyone' (featured), 'members', or 'admin' (the admin alone).
  setAudience(id, audience) {
    const current = this.beats.find((entry) => entry.id === id);
    const featured = featuredIds(this.beats);
    if (audience === 'everyone' && !featured.has(id) && this.beats.filter((beat) => beat.featured).length >= MAX_FEATURED) {
      return this.status(`Up to ${MAX_FEATURED} beats can be featured. Choose Members or Only me for one of them first.`);
    }
    if (audience !== 'everyone' && featured.has(id) && featured.size === 1) {
      return this.status('One beat always stays featured: it is what visitors without an account hear. Feature another beat first.');
    }
    const beat = { ...current, featured: audience === 'everyone', members: audience !== 'admin', hidden: false };
    const message = {
      everyone: `"${beat.title}" is featured: anyone can play it.`,
      members: `"${beat.title}" is open to members.`,
      admin: `"${beat.title}" is yours alone again.`,
    }[audience];
    this.commit(this.beats.map((entry) => (entry.id === id ? beat : entry)), { save: [beat] }, message);
  },

  rename(id) {
    const current = this.beats.find((entry) => entry.id === id);
    const title = window.prompt('Title', current.title)?.trim();
    if (!title || title === current.title) return;
    const beat = { ...current, title: title.slice(0, 200) };
    this.commit(this.beats.map((entry) => (entry.id === id ? beat : entry)), { save: [beat] }, `Renamed to "${beat.title}". Its address stays /beats/${beat.slug}.`);
  },

  // A beat plays the code of one of the admin's songs, and remembers which.
  replace(id, songId) {
    const song = songs.get(songId);
    if (!song) return this.status('Choose one of your songs first.');
    const beat = { ...this.beats.find((entry) => entry.id === id), code: song.code, song: song.id };
    this.commit(this.beats.map((entry) => (entry.id === id ? beat : entry)), { save: [beat] }, `"${beat.title}" now plays the code of your song "${song.title}".`);
  },

  remove(id) {
    const beat = this.beats.find((entry) => entry.id === id);
    this.commit(this.beats.filter((entry) => entry.id !== id), { remove: [id] }, `Removed "${beat.title}".`);
  },

  publish(songId) {
    const song = songs.get(songId);
    if (!song) return;
    const beat = newBeat({ id: newId(), code: song.code, title: song.title, by: song.by, song: song.id, createdAt: song.createdAt }, this.beats);
    this.commit([...this.beats, beat], { save: [beat] }, `Added "${beat.title}". Only you can play it until you say who else can.`);
  },

  // The first publication: every beat in the site's own files, in their order, with the
  // ones the site was featuring as the featured beats.
  seed() {
    const beats = [];
    for (const song of this.siteBeats()) {
      const beat = newBeat({ id: song.id, code: song.code, title: song.title, by: song.by }, beats);
      beats.push({ ...beat, featured: Boolean(song.featured) });
    }
    if (!beats.length) return;
    this.commit(beats, { save: beats }, `Published the site's ${beats.length} beats. Anyone can play the featured ones; the rest are yours until you open them to members.`);
  },

  // The catalog is what everyone else is told about the beats. If it no longer says what
  // the beats themselves say (it was written by an earlier version, say), write it again.
  async syncCatalog() {
    if (!cloud.user?.admin) return;
    const [beats, catalog] = await Promise.all([cloud.listBeats({ all: true }), cloud.getCatalog()]);
    if (!beats.length) return;
    const fresh = buildCatalog(beats, describe);
    if (JSON.stringify(catalog?.beats ?? null) === JSON.stringify(fresh.beats)) return;
    await cloud.saveBeats({ catalog: fresh });
  },

  importFile(text) {
    let added;
    try {
      added = beatsFromExport(text, this.beats, describe);
    } catch {
      return this.status('That file is not a strudel.cc export.');
    }
    if (!added.length) return this.status('Nothing new in that file.');
    this.commit([...this.beats, ...added], { save: added }, `Added ${added.length} ${added.length === 1 ? 'beat' : 'beats'} from the file. Only you can play them until you open them to members.`);
  },

  /* ---------- shared songs ---------- */

  async loadShared() {
    // (the shared songs are still listed if the shelf cannot be read)
    const [shared, shelf] = await Promise.all([
      cloud.listShared(),
      cloud.listCommunity({ max: SHELF_MAX }).catch((error) => {
        console.warn('[admin] could not read the shelf', error);
        return [];
      }),
    ]);
    this.shared = shared.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    this.featured = new Set(shelf.map((entry) => entry.shareId));
    this.renderShared();
  },

  renderShared() {
    const list = this.els.sharedList;
    list.replaceChildren();
    if (!this.shared.length) {
      const empty = document.createElement('li');
      empty.className = 'admin__empty';
      empty.textContent = 'Nobody is sharing a song at the moment.';
      list.append(empty);
    }
    for (const song of this.shared) {
      const row = document.createElement('li');
      row.className = 'admin__row';
      row.dataset.id = song.id;
      const name = document.createElement('span');
      name.className = 'admin__name';
      name.textContent = song.title;
      const meta = document.createElement('span');
      meta.className = 'admin__meta';
      const featured = Boolean(song.shareId) && this.featured.has(song.shareId);
      meta.textContent = [song.ownerName ? `shared by ${song.ownerName}` : null, song.updatedAt ? `changed ${new Date(song.updatedAt).toLocaleDateString()}` : null, featured ? 'featured' : null].filter(Boolean).join(' · ');
      const tools = document.createElement('span');
      tools.className = 'admin__tools';
      const open = document.createElement('a');
      open.className = 'chipbtn';
      open.textContent = 'Open';
      open.href = linkToSong(song);
      open.target = '_blank';
      open.rel = 'noopener';
      tools.append(open, this.featureControl(song, featured), confirmButton('Switch sharing off', 'Really switch it off?', () => this.takeDown(song)));
      row.append(name, tools, meta);
      list.append(row);
    }
  },

  // Feature or Unfeature, for a song its owner offered to the community shelf. One that is
  // featured can always be taken off, even after its owner has withdrawn it.
  featureControl(song, featured) {
    if (!featured && !eligibleForShelf(song)) {
      const note = document.createElement('span');
      note.className = 'admin__offer';
      note.textContent = 'not offered';
      note.title = 'Its owner has not offered it to the community shelf';
      return note;
    }
    const toggle = button(featured ? 'Unfeature' : 'Feature', () => this.setFeatured(song, !featured), { title: featured ? 'Take it off the community shelf' : 'Show it under From the community' });
    toggle.disabled = !featured && this.featured.size >= SHELF_MAX;
    return toggle;
  },

  async setFeatured(song, on) {
    if (this.busy) return;
    if (on && this.featured.size >= SHELF_MAX) return this.status(`The shelf holds ${SHELF_MAX} songs. Unfeature one first.`);
    this.busy = true;
    try {
      if (on) {
        await cloud.feature(song.shareId, communityEntry(song, describeShared));
        this.featured.add(song.shareId);
        this.status(`"${song.title}" is featured under From the community.`);
      } else {
        await cloud.unfeature(song.shareId);
        this.featured.delete(song.shareId);
        this.status(`"${song.title}" is no longer featured.`);
      }
      // what the admin changed is what everybody is shown: read it back
      this.onChange();
    } catch (error) {
      console.warn('[admin] could not change the shelf', error);
      this.status(on ? 'That was not featured. Its owner may have withdrawn it.' : 'That did not work. It is still featured.');
    } finally {
      this.busy = false;
    }
    this.renderShared();
  },

  // The shelf keeps only songs that are still shared, offered and not switched off: an
  // owner who switched sharing off may not have reached the database to say so. Resolves
  // to how many entries were taken off.
  async syncCommunity() {
    if (!cloud.user?.admin) return 0;
    let removed = 0;
    for (const entry of await cloud.listCommunity({ max: SHELF_MAX })) {
      const share = await cloud.getShare(entry.shareId);
      const song = share && (await cloud.getShared(share.owner, share.song));
      if (eligibleForShelf(song, entry.shareId)) continue;
      await cloud.unfeature(entry.shareId);
      removed++;
    }
    return removed;
  },

  async takeDown(song) {
    try {
      await cloud.takeDown(song.owner, song.id, song.shareId);
      this.shared = this.shared.filter((entry) => !(entry.id === song.id && entry.owner === song.owner));
      if (song.shareId && this.featured.delete(song.shareId)) this.onChange();
      this.status(`Sharing is off for "${song.title}". Its link no longer works.`);
    } catch (error) {
      console.warn('[admin] could not switch sharing off', error);
      this.status('That did not work. The song is still shared.');
    }
    this.renderShared();
  },
};
