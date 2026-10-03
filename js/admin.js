// The admin sheet: the public beats, and the songs people have shared (and which of them
// the community shelf features). Only an admin
// account is offered it, and the database refuses these writes from anyone else
// (firestore.rules), so nothing here is what keeps other people out.
import { cloud } from './cloud.js';
import { songs, linkToSong } from './songs.js';
import { describeSong } from './library.js';
import { newId } from './songs-core.js';
import { orderBeats, newBeat, featuredOf, audienceOf, buildCatalog, beatsFromExport } from './beats-core.js';
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

export const admin = {
  els: null,
  beats: [],
  shared: [],
  // the share ids on the community shelf
  featured: new Set(),
  onChange: () => {},
  busy: false,

  // `siteBeats()` gives the beats that came with the site's own files, for a first
  // publication into an empty database.
  init(els, { onChange, siteBeats }) {
    this.els = els;
    this.onChange = onChange;
    this.siteBeats = siteBeats;
    els.seed.addEventListener('click', () => this.seed());
    els.close.addEventListener('click', () => els.dialog.close());
    els.dialog.addEventListener('click', (event) => event.target === els.dialog && els.dialog.close());
    for (const tab of els.tabs) tab.addEventListener('click', () => this.show(tab.dataset.adminTab));
    els.publish.addEventListener('click', () => this.publish(els.song.value));
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
      if (tab === 'beats') await this.loadBeats();
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
    this.renderBeats();
  },

  renderBeats() {
    const { list, song } = this.els;
    list.replaceChildren();
    if (!this.beats.length) {
      const empty = document.createElement('li');
      empty.className = 'admin__empty';
      empty.textContent = 'There are no beats in the database yet. Until there are, the site plays the beats in its own files.';
      list.append(empty);
    }
    // an empty database can be filled with the beats the site came with, in one go
    this.els.seed.hidden = this.beats.length > 0 || !this.siteBeats().length;
    const featuredId = featuredOf(this.beats)?.id;
    this.beats.forEach((beat, i) => {
      const audience = audienceOf(beat, featuredId);
      const row = document.createElement('li');
      row.className = `admin__row${audience === 'admin' ? ' is-private' : ''}`;
      row.dataset.id = beat.id;
      const name = document.createElement('span');
      name.className = 'admin__name';
      name.textContent = beat.by ? `${beat.title} — ${beat.by}` : beat.title;
      const meta = document.createElement('span');
      meta.className = 'admin__meta';
      meta.textContent = `${{ everyone: 'featured: anyone can play it', members: 'members can play it', admin: 'only you' }[audience]} · /beats/${beat.slug}`;
      const tools = document.createElement('span');
      tools.className = 'admin__tools';
      const up = button('↑', () => this.move(beat.id, -1), { title: 'Move up' });
      const down = button('↓', () => this.move(beat.id, 1), { title: 'Move down' });
      up.disabled = i === 0;
      down.disabled = i === this.beats.length - 1;
      const feature = button('Featured', () => this.feature(beat.id), { pressed: audience === 'everyone', title: 'The beat anyone can play without an account' });
      const members = button('Members', () => this.setMembers(beat.id, audience !== 'members'), { pressed: audience === 'members', title: 'Let everyone who is signed in play this beat' });
      members.disabled = audience === 'everyone';
      tools.append(
        up,
        down,
        feature,
        members,
        button('Rename', () => this.rename(beat.id)),
        button('Replace', () => this.replace(beat.id, song.value), { title: 'Replace its code with the song chosen below' }),
        confirmButton('Remove', 'Really remove?', () => this.remove(beat.id)),
      );
      row.append(name, tools, meta);
      list.append(row);
    });

    // the admin's own songs, to publish or to replace a beat with
    const mine = songs.list();
    song.replaceChildren(
      ...mine.map((entry) => {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = entry.title;
        return option;
      }),
    );
    song.disabled = !mine.length;
    this.els.publish.disabled = !mine.length;
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
    // exactly one beat is the featured one
    const featured = featuredOf(all);
    const settled = all.map((beat) => {
      const want = beat.id === featured?.id;
      if (beat.featured === want) return beat;
      const fixed = { ...beat, featured: want, updatedAt: now };
      changed.set(beat.id, fixed);
      return fixed;
    });
    try {
      await cloud.saveBeats({ save: [...changed.values()], remove, catalog: buildCatalog(settled, describe, now) });
      this.beats = orderBeats(settled);
      this.status(message);
      saved = true;
      this.onChange();
    } catch (error) {
      console.warn('[admin] could not save', error);
      this.status('That was not saved. Nothing has changed.');
    } finally {
      this.busy = false;
      this.renderBeats();
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

  feature(id) {
    const next = this.beats.map((beat) => ({ ...beat, featured: beat.id === id }));
    const save = next.filter((beat, i) => beat.featured !== this.beats[i].featured);
    this.commit(next, { save }, `"${next.find((beat) => beat.id === id).title}" is now the featured beat.`);
  },

  // Open a beat to everyone who is signed in, or take it back for the admin alone.
  setMembers(id, members) {
    const beat = { ...this.beats.find((entry) => entry.id === id), members, hidden: false };
    this.commit(this.beats.map((entry) => (entry.id === id ? beat : entry)), { save: [beat] }, members ? `"${beat.title}" is open to members.` : `"${beat.title}" is yours alone again.`);
  },

  rename(id) {
    const current = this.beats.find((entry) => entry.id === id);
    const title = window.prompt('Title', current.title)?.trim();
    if (!title || title === current.title) return;
    const beat = { ...current, title: title.slice(0, 200) };
    this.commit(this.beats.map((entry) => (entry.id === id ? beat : entry)), { save: [beat] }, `Renamed to "${beat.title}". Its address stays /beats/${beat.slug}.`);
  },

  replace(id, songId) {
    const song = songs.get(songId);
    if (!song) return this.status('Choose one of your songs below first.');
    const beat = { ...this.beats.find((entry) => entry.id === id), code: song.code };
    this.commit(this.beats.map((entry) => (entry.id === id ? beat : entry)), { save: [beat] }, `"${beat.title}" now plays the code of your song "${song.title}".`);
  },

  remove(id) {
    const beat = this.beats.find((entry) => entry.id === id);
    this.commit(this.beats.filter((entry) => entry.id !== id), { remove: [id] }, `Removed "${beat.title}".`);
  },

  publish(songId) {
    const song = songs.get(songId);
    if (!song) return;
    const beat = newBeat({ id: newId(), code: song.code, title: song.title, by: song.by, createdAt: song.createdAt }, this.beats);
    this.commit([...this.beats, beat], { save: [beat] }, `Added "${beat.title}". Only you can play it until you open it to members.`);
  },

  // The first publication: every beat in the site's own files, in their order, with the
  // one the site was featuring as the featured beat.
  seed() {
    const beats = [];
    for (const song of this.siteBeats()) {
      const beat = newBeat({ id: song.id, code: song.code, title: song.title, by: song.by }, beats);
      beats.push({ ...beat, featured: Boolean(song.featured) });
    }
    if (!beats.length) return;
    this.commit(beats, { save: beats }, `Published the site's ${beats.length} beats. Anyone can play the featured one; the rest are yours until you open them to members.`);
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
