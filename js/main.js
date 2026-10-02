// Boot and wiring. Each module owns one concern; this file connects them.
import { runtime } from './runtime.js';
import { Player } from './player.js';
import { master } from './master.js';
import { deck } from './deck.js';
import { crate } from './crate.js';
import { visuals } from './visuals.js';
import { loadLibrary, describeSong } from './library.js';
import { songs, linkToSong } from './songs.js';
import { withTitle, STARTERS, fromOf, isLive } from './songs-core.js';
import { cloud } from './cloud.js';
import { config, site } from './config.js';
import { SITE_NAME, HOME_TITLE, HOME_DESCRIPTION, beatPath, slugFromPath, songTitle, songDescription, creditLine, remixLine, songLinkIn, sharePath } from './routes-core.js';
import { VERSION } from './version.js';
import { persist } from './persist.js';
import { recorder, saveBlob } from './recorder.js';
import { mixFromHash, linkForMix } from './share.js';
import { midi } from './midi.js';
import { thumbs } from './thumbs.js';
import { register, registry } from './controls.js';
import { ARRANGEMENT_BARS } from './arrangement.js';
import { admin } from './admin.js';
import { analytics } from './analytics.js';
import { isApple, keyLabels, localizeKeys } from './keys-core.js';
import { explainError } from './errors-core.js';
import { tries } from './tries.js';
import { onboarding } from './onboarding.js';
import { shareSheet } from './share-sheet.js';

const $ = (id) => document.getElementById(id);

const els = {
  stage: $('stage'),
  panes: $('panes'),
  curtainPlay: $('curtain-play'),
  curtainTitle: $('curtain-title'),
  curtainBy: $('curtain-by'),
  curtainFrom: $('curtain-from'),
  bpm: $('bpm'),
  bar: $('bar'),
  beat: $('beat'),
  status: $('status'),
  notice: $('notice'),
  noticeTitle: $('notice-title'),
  noticeHint: $('notice-hint'),
  noticeDetail: $('notice-detail'),
  noticeRaw: $('notice-raw'),
  noticeRawText: $('notice-raw-text'),
  aboutSong: $('about-song'),
  about: $('about'),
  deckToggle: $('deck-toggle'),
  ribbonRow: $('ribbon-row'),
  ribbonToggle: $('ribbon-toggle'),
  ribbonRows: $('ribbon-rows'),
  ribbon: $('ribbon'),
  follow: $('follow'),
  split: $('split'),
  gallery: $('gallery'),
  hudTitle: $('hud-title'),
  hudBar: $('hud-bar'),
  record: $('record'),
  recordTime: $('record-time'),
  sync: $('sync'),
  mix: $('mix'),
  midiButton: $('midi-button'),
  midiStatus: $('midi-status'),
  midiLearn: $('midi-learn'),
  edit: $('edit'),
  update: $('update'),
  saveCopy: $('save-copy'),
  unsaved: $('unsaved'),
  save: $('save'),
  saveNew: $('save-new'),
  saveBeat: $('save-beat'),
  revert: $('revert'),
  gate: $('gate'),
  account: $('account'),
  accountDialog: $('account-dialog'),
  locked: $('locked'),
};

const A = new Player('A', { editor: $('editor-a'), pane: $('pane-a') });
const B = new Player('B', { editor: $('editor-b'), pane: $('pane-b') });
const players = [A, B];
const byId = { A, B };
const other = (player) => (player === A ? B : A);

const app = {
  // the built-in collection (the database's, or the files in beats/); the listener's own
  // songs live in songs.js
  songs: [],
  libraryMode: 'files',
  // 'full', or 'preview' for a visitor who is not signed in: one beat to listen to
  access: 'full',
  // a beat that is listed but needs an account, shown in place of the stage
  lockedSong: null,
  // a shared song waiting for the visitor to sign in
  pendingShared: null,
  // a mix link's settings for a beat the visitor has to sign in to play
  pendingMix: null,
  // the share of a song that came over from the player to be kept ("Edit a copy")
  copyIntent: null,
  booted: false,
  gatePeek: false,
  focusId: 'A',
  sync: true,
  // the deck that sets the tempo while both are playing
  leader: null,
  mixing: null,
  split: false,
  follow: persist.get('follow', true),
  gallery: false,
  lastPosition: '',
};
const focused = () => byId[app.focusId];
// ⌘ on a Mac, Ctrl everywhere else
const APPLE = isApple(navigator.userAgentData?.platform || navigator.platform);
const KEYS = keyLabels(APPLE);
const coarse = () => !matchMedia('(pointer: fine)').matches;
// the deck you mostly hear, by where the crossfader sits
const audible = () => (master.state.crossfade < 0.5 ? A : B);
const bothPlaying = () => A.started && B.started;

/* ---------- messages ---------- */

let statusTimer;
let statusIsProgress = false;
function setStatus(message, { hold = 6000, progress = false } = {}) {
  // an empty progress message only clears a progress message
  if (!message && progress && !statusIsProgress) return;
  clearTimeout(statusTimer);
  statusIsProgress = Boolean(message) && progress;
  els.status.textContent = message || '';
  els.status.classList.toggle('is-visible', Boolean(message));
  if (message && hold) statusTimer = setTimeout(() => els.status.classList.remove('is-visible'), hold);
}

const allSongs = () => [...songs.list(), ...app.songs];
const findSong = (id) => songs.get(id) || app.songs.find((song) => song.id === id) || null;

// A mistake in the code is said in plain words where we can; the browser's own message
// stays one click away.
function renderNotice() {
  const failure = focused().failure || focused().problem;
  els.notice.hidden = !failure;
  document.body.classList.toggle('has-notice', Boolean(failure));
  if (!failure) return;
  const { hint } = explainError(failure.detail);
  els.noticeTitle.textContent = failure.title;
  els.noticeHint.hidden = !hint;
  els.noticeHint.textContent = hint || '';
  els.noticeDetail.hidden = Boolean(hint);
  els.noticeDetail.textContent = failure.detail || '';
  els.noticeRaw.hidden = !hint || !failure.detail;
  els.noticeRawText.textContent = failure.detail || '';
}

/* ---------- rendering ---------- */

function renderChip(player) {
  const id = player.id.toLowerCase();
  const song = player.song;
  $(`title-${id}`).textContent = song ? song.title : 'Load a beat';
  $(`meta-${id}`).textContent = song ? (player.ready ? `${Math.round(player.bpm)}` : song.bpm ? `${Math.round(song.bpm)}` : '') : '';
  $(`tag-${id}`).textContent = song ? `${player.id} · ${song.title}` : player.id;
  const chip = $(`chip-${id}`);
  chip.dataset.transport = player.transport;
  chip.classList.toggle('is-empty', !song);
  // (signed out, a change cannot be kept, so it is not called unsaved)
  chip.classList.toggle('is-unsaved', Boolean(song) && player.edited && !player.gated && app.access === 'full');
  $(`play-${id}`).setAttribute('aria-label', `${{ idle: 'Play', loading: 'Loading', playing: 'Stop' }[player.transport]} deck ${player.id}`);
  $(`play-${id}`).disabled = !song;
}

function renderCurtain() {
  const song = A.song;
  if (!song) return;
  els.curtainTitle.textContent = song.title;
  els.curtainBy.textContent = creditLine({ by: song.by, ownerName: song.source === 'shared' ? song.ownerName : null, bpm: song.bpm });
  els.curtainFrom.textContent = remixLine(song.from);
  els.curtainFrom.hidden = !song.from;
}

function renderAbout() {
  const song = focused().song;
  els.aboutSong.replaceChildren();
  if (!song) return;
  const heading = document.createElement('h3');
  heading.textContent = song.by ? `${song.title} — ${song.by}` : song.title;
  els.aboutSong.append(heading);
  for (const note of song.notes) {
    const line = document.createElement('p');
    line.textContent = note;
    els.aboutSong.append(line);
  }
}

function renderReadouts() {
  const player = focused();
  els.bpm.textContent = player.ready ? String(Math.round(player.bpm)) : player.song?.bpm ? String(Math.round(player.song.bpm)) : '—';
  players.forEach(renderChip);
}

function renderPosition() {
  const player = focused();
  const position = player.position();
  const text = player.started ? `${Math.floor(position) + 1}.${Math.floor((((position % 1) + 1) % 1) * 4) + 1}` : player.offset ? `${player.offset + 1}.1` : '';
  if (text === app.lastPosition) return;
  app.lastPosition = text;
  const [bar, beat] = text ? text.split('.') : ['—', ''];
  els.bar.textContent = bar;
  els.beat.textContent = beat ? `.${beat}` : '';
  els.hudBar.textContent = text ? `bar ${bar}` : '';
}

// The track names beside the open arrangement view; each one mutes its track.
function renderRibbonRows() {
  const player = focused();
  els.ribbonRows.replaceChildren();
  els.ribbonRow.style.setProperty('--rows', String(Math.max(1, player.mixer.tracks.length)));
  for (const track of player.mixer.tracks) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = track.name;
    button.setAttribute('aria-pressed', String(!player.mixer.selected(track.index)));
    button.setAttribute('aria-label', `Mute ${track.name}`);
    button.addEventListener('click', () => player.mixer.setMute(track.index));
    item.append(button);
    els.ribbonRows.append(item);
  }
}

function renderMixButton() {
  const to = other(audible());
  els.mix.textContent = app.mixing ? 'Mixing…' : `Mix → ${to.id}`;
  els.mix.setAttribute('aria-pressed', String(Boolean(app.mixing)));
}

function renderFocus() {
  const player = focused();
  document.body.dataset.focus = player.id;
  document.body.dataset.transport = player.transport;
  $('deck-a').setAttribute('aria-pressed', String(player === A));
  $('deck-b').setAttribute('aria-pressed', String(player === B));
  document.querySelectorAll('.panel__deck').forEach((el) => (el.textContent = B.song ? `· ${player.id}` : ''));
  els.hudTitle.textContent = player.song?.title || '';
  deck.bind(player);
  // a pane that was hidden has stale measurements
  player.mirror.editor.requestMeasure();
  renderEditing();
  renderGate();
  renderReadouts();
  renderAbout();
  renderRibbonRows();
  renderNotice();
  renderTries();
  app.lastPosition = null;
  renderPosition();
  visuals.invalidate();
}

function setFocus(id) {
  if (app.focusId === id) return;
  app.focusId = id;
  renderFocus();
}

// The suggestions over the stage, and whether the first steps can offer one.
function renderTries() {
  tries.render();
  onboarding.setAudience({ access: app.access, hasTries: Boolean(tries.root && !tries.root.hidden) });
}

function setSplit(on) {
  app.split = on;
  els.panes.dataset.view = on ? 'split' : 'single';
  els.split.setAttribute('aria-pressed', String(on));
}

function setFollow(on) {
  app.follow = on;
  if (!site.guest) persist.set('follow', on);
  els.follow.setAttribute('aria-pressed', String(on));
  players.forEach((player) => {
    player.camera.enabled = on || app.gallery;
    player.camera.reset();
  });
}

/* ---------- gallery: full screen, code only ---------- */

let hudTimer;
function wakeHud() {
  document.body.classList.add('hud-awake');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => document.body.classList.remove('hud-awake'), 2600);
}

function setGallery(on) {
  if (app.gallery === on) return;
  app.gallery = on;
  document.body.classList.toggle('is-gallery', on);
  players.forEach((player) => {
    player.camera.enabled = on || app.follow;
    player.camera.reset();
  });
  if (on) {
    players.forEach((player) => player.stage.editing && player.setEditable(false));
    document.documentElement.requestFullscreen?.().catch(() => {});
    wakeHud();
  } else if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
  visuals.invalidate();
}

/* ---------- who may do what ---------- */

// Without an account a visitor gets a small player: the featured beat (or a song someone
// shared with them), to listen to. Everything else needs an account. The database
// enforces the part that matters (firestore.rules); this is the screen in front of it.
const walled = () => site.guest || (cloud.accounts && !cloud.user);
const featuredBeat = () => app.songs.find((song) => song.featured) || app.songs[0] || null;
const isLocked = (song) => Boolean(song.locked) || (app.access === 'preview' && song.source === 'beats' && !song.featured);

function setAccess(access) {
  app.access = access;
  document.body.classList.toggle('is-preview', access === 'preview');
  document.body.classList.toggle('is-guest', site.guest);
  renderTries();
  if (access !== 'preview') return;
  // leave nothing running that the small player has no control for
  players.forEach((player) => player.stage.editing && player.setEditable(false));
  if (B.started) B.stop();
  if (app.mixing) stopMixing();
  if (app.split) setSplit(false);
  if (app.gallery) setGallery(false);
  if (recorder.active) finishRecording();
  if (midi.learning) midi.setLearning(false);
  deck.crossfader?.set(0);
  master.setCrossfade(0);
  setFocus('A');
}

// True (after saying why) when the visitor has no account for what they just tried.
function needsAccount(what = 'do that') {
  if (app.access === 'full') return false;
  if (site.guest) {
    setStatus(`To ${what}, open this song on ${new URL(config.appOrigin).host}.`);
  } else {
    setStatus(`Sign in to ${what}.`);
    if (!document.querySelector('dialog[open]')) els.accountDialog.showModal();
  }
  return true;
}

// A beat that is listed but not playable yet: say what it is and how to get in.
function renderLocked() {
  const song = app.lockedSong;
  els.locked.hidden = !song;
  document.body.classList.toggle('is-locked', Boolean(song));
  if (!song) return;
  $('locked-title').textContent = song.title;
  $('locked-by').textContent = [song.by ? `by ${song.by}` : null, song.bpm ? `${Math.round(song.bpm)} bpm` : null, song.trackCount > 1 ? `${song.trackCount} tracks` : null].filter(Boolean).join(' · ');
  $('locked-text').textContent = cloud.user ? 'This beat could not be loaded just now.' : 'This beat is for people with an account. It is free, and takes one click with Google.';
  $('locked-notes').replaceChildren(
    ...(song.notes || []).map((note) => {
      const line = document.createElement('p');
      line.textContent = note;
      return line;
    }),
  );
  $('locked-sign-in').hidden = Boolean(cloud.user);
  const featured = featuredBeat();
  $('locked-featured').hidden = !featured || featured.id === song.id;
  if (featured) $('locked-featured').textContent = `Play "${featured.title}" instead`;
}

function showLocked(song, { route = true } = {}) {
  app.lockedSong = song;
  if (A.started) A.stop();
  renderLocked();
  if (route) navigate(song);
  else renderHead();
}

/* ---------- page addresses ---------- */

// Every built-in beat has an address of its own (/beats/<slug>) with its own title and
// description; one's own songs and shared songs are at "/". The address follows deck A.
const routeFor = (song) => (song?.source === 'beats' && song.slug ? beatPath(song.slug) : '/');
const songAtAddress = () => {
  const slug = slugFromPath(location.pathname);
  return slug ? app.songs.find((song) => song.slug === slug) || null : null;
};
const setHead = (selector, attribute, value) => document.querySelector(selector)?.setAttribute(attribute, value);

// The tab title, description and canonical address of the page being shown. The built
// site has these in its HTML already; this keeps them right as songs change.
function renderHead() {
  const song = app.lockedSong || A.song;
  const beatPage = song?.source === 'beats' && slugFromPath(location.pathname) === song.slug;
  const title = beatPage ? songTitle(song) : song && song.source !== 'beats' ? `${song.title} — ${SITE_NAME}` : HOME_TITLE;
  const description = beatPage ? song.description || songDescription(song) : HOME_DESCRIPTION;
  const address = `${config.appOrigin || location.origin}${beatPage ? location.pathname : '/'}`;
  document.title = title;
  // the tab may carry the title of the listener's own song; Google is given a public one
  analytics.page(beatPage ? title : HOME_TITLE);
  setHead('meta[name="description"]', 'content', description);
  setHead('link[rel="canonical"]', 'href', address);
  setHead('meta[property="og:title"]', 'content', title);
  setHead('meta[property="og:description"]', 'content', description);
  setHead('meta[property="og:url"]', 'content', address);
}

function navigate(song, { replace = false } = {}) {
  // the shared-song player stays on its link
  if (site.guest) return;
  const path = routeFor(song);
  if (path !== location.pathname) history[replace ? 'replaceState' : 'pushState'](null, '', path);
  renderHead();
}

/* ---------- songs ---------- */

// `route: false` loads a song without changing the page's address.
async function loadSong(id, deckId = app.focusId, { autoplay, shared, route = true } = {}) {
  const song = findSong(id);
  if (!song) return;
  if (app.access === 'preview' && (deckId !== 'A' || song.source !== 'beats')) return void needsAccount('use the second deck and your own songs');
  if (isLocked(song)) return showLocked(song, { route });
  if (app.lockedSong) {
    app.lockedSong = null;
    renderLocked();
  }
  const player = byId[deckId];
  // changes on this deck that have not been saved: ask before they are replaced
  if (!(await settleEdits(player))) return;
  if (deckId === 'A') persist.set('lastSong', song.id);
  // Choosing a beat while listening carries on playing; loading the second deck while
  // the first plays only cues it up.
  const carryOn = document.body.classList.contains('has-played') && !other(player).started;
  player.load(song, { autoplay: autoplay ?? carryOn, shared });
  setFocus(deckId);
  if (deckId === 'A' && route) navigate(song);
}

function step(direction) {
  const list = app.access === 'preview' ? app.songs : allSongs();
  if (!list.length) return;
  const player = focused();
  const current = (player === A && app.lockedSong) || player.song;
  const index = current ? list.findIndex((song) => song.id === current.id) : -1;
  const next = list[(index + direction + list.length) % list.length];
  loadSong(next.id, player.id);
}

/* ---------- editing and my songs ---------- */

function renderEditing() {
  const player = focused();
  const editing = player.stage.editing;
  const unsaved = Boolean(player.song) && player.edited && !player.gated && app.access === 'full';
  els.edit.setAttribute('aria-pressed', String(editing));
  els.edit.textContent = editing ? 'Done' : 'Edit';
  els.edit.title = editing ? 'Leave the code (Esc)' : app.access !== 'full' ? 'Sign in to change the code' : coarse() ? 'Change the code' : 'Change the code (or just click in it)';
  els.edit.disabled = !player.song || player.gated;
  els.edit.hidden = site.guest;
  els.update.hidden = !editing;
  els.update.classList.toggle('is-dirty', player.dirty);
  // something to save: say so, and offer what can be done with it
  els.unsaved.hidden = !unsaved;
  els.save.hidden = !(unsaved && player.own);
  els.saveNew.hidden = !unsaved;
  els.saveNew.textContent = player.own ? 'Save as new' : 'Save as my song';
  els.saveBeat.hidden = !(unsaved && cloud.user?.admin && player.song.source === 'beats' && app.libraryMode === 'database');
  els.revert.hidden = !unsaved;
  els.saveCopy.hidden = !player.song || player.own || player.gated || unsaved || app.access !== 'full';
  document.body.classList.toggle('is-editing', editing);
  document.body.classList.toggle('is-unsaved', unsaved);
}

// A one-time hint is shown once in this browser, not once per visit.
function firstTime(name) {
  const hints = persist.get('hints', {});
  if (hints[name]) return false;
  persist.set('hints', { ...hints, [name]: true });
  return true;
}

function setEditing(on, player = focused()) {
  if (!player.song || player.gated) return;
  if (site.guest) return takeHome(player);
  if (on && needsAccount('edit the code')) return;
  player.setEditable(on);
  if (on && firstTime('edit')) {
    const run = coarse() ? 'Update' : `${KEYS.run} (or Update)`;
    setStatus(`Change anything. ${run} runs it without stopping the music; nothing is saved until you press Save.`, { hold: 9000 });
  }
}

// The shared-song player keeps nothing. Changing a song or keeping a copy happens on the
// main site, which opens the same song and asks before running it.
function takeHome(player = focused()) {
  const song = player.song;
  if (!song) return;
  const home = `${config.appOrigin}/`;
  location.href = song.source === 'shared' ? `${home}#copy=${song.shareId || `${song.owner}~${song.id}`}` : linkForMix({ song: song.id, ...player.snapshot(), tempo: player.tempo }, home);
}

// Make the code on stage read exactly `code` with the smallest single edit (a new title
// line, say), so the caret, the scroll position and the music are left alone.
function syncEditor(player, code) {
  const now = player.code;
  if (now === code) return;
  let start = 0;
  while (start < now.length && start < code.length && now[start] === code[start]) start++;
  let endNow = now.length;
  let endCode = code.length;
  while (endNow > start && endCode > start && now[endNow - 1] === code[endCode - 1]) {
    endNow--;
    endCode--;
  }
  player.mirror.editor.dispatch({ changes: { from: start, to: endNow, insert: code.slice(start, endCode) } });
}

// Keep what is on a deck as a new song of the listener's own. The song it came from (a
// built-in beat, a shared song, or another of their own) stays as it was.
function saveAsNew(player = focused()) {
  if (!player.song || player.gated) return;
  if (site.guest) return takeHome(player);
  if (needsAccount('keep a copy')) return;
  const from = player.song;
  const song = songs.copyOf(from, player.code);
  // the new song may have been given a title of its own ("Amber copy")
  syncEditor(player, song.code);
  player.adopt(song);
  if (player.dirty) player.update();
  onboarding.done('save');
  setStatus(song.title === from.title ? `Saved "${song.title}" to My songs.` : `Saved as "${song.title}" in My songs. You can rename it from the song list.`);
}
const saveCopy = saveAsNew;

// Save the changes on a deck over the listener's own song.
function saveChanges(player = focused()) {
  if (!player.song || player.gated) return;
  if (!player.own) return saveAsNew(player);
  const updated = songs.update(player.song.id, { code: player.code, mixer: player.mixer.snapshot() });
  if (!updated) return;
  player.adopt(updated);
  if (player.dirty) player.update();
  onboarding.done('save');
  setStatus(`Saved "${updated.title}".`);
}

function revertChanges(player = focused()) {
  if (!player.song || !player.edited) return;
  player.revert();
  setStatus('Back to the saved version.');
}

// Admin: put the version on stage in place of the public beat, for everyone.
async function updatePublicBeat(player = focused()) {
  const song = player.song;
  if (!song || song.source !== 'beats' || !cloud.user?.admin) return;
  setStatus(`Updating "${song.title}"…`, { hold: 0 });
  if (!(await admin.updateBeatCode(song.id, player.code))) return setStatus('The beat was not updated.');
  await reloadLibrary().catch(() => {});
  const fresh = app.songs.find((entry) => entry.id === song.id);
  if (fresh && player.song?.id === song.id) player.adopt(fresh);
  if (player.dirty) player.update();
  setStatus(`"${song.title}" has been updated for everyone.`);
}

// Before a deck is given another song (or the listener signs out): if it holds changes
// that are not saved, ask what to do with them. Resolves to false if they said "cancel".
function settleEdits(player) {
  if (!player.song || !player.edited || player.gated || app.access !== 'full') return Promise.resolve(true);
  const dialog = $('unsaved-dialog');
  $('unsaved-text').textContent = `You have changed "${player.song.title}"${B.song ? ` on deck ${player.id}` : ''}. What should happen to your changes?`;
  $('unsaved-save').hidden = !player.own;
  $('unsaved-new').textContent = player.own ? 'Save as new' : 'Save as my song';
  return new Promise((resolve) => {
    const finish = (choice) => {
      dialog.oncancel = null;
      for (const name of ['save', 'new', 'discard', 'cancel']) $(`unsaved-${name}`).onclick = null;
      if (dialog.open) dialog.close();
      if (choice === 'save') saveChanges(player);
      else if (choice === 'new') saveAsNew(player);
      else if (choice === 'discard') player.forget();
      resolve(choice !== 'cancel');
    };
    for (const name of ['save', 'new', 'discard', 'cancel']) $(`unsaved-${name}`).onclick = () => finish(name);
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish('cancel');
    };
    dialog.showModal();
  });
}

// Knob and channel positions of one's own song are saved a moment after they change.
const saveTimers = new Map();
function saveOwn(player) {
  clearTimeout(saveTimers.get(player));
  saveTimers.set(
    player,
    setTimeout(() => {
      // only knob and channel positions are saved without asking
      if (!player.own || player.edited) return;
      const updated = songs.update(player.song.id, { code: player.code, mixer: player.mixer.snapshot() });
      if (!updated) return;
      const renamed = updated.title !== player.song.title;
      player.song = updated;
      if (renamed) refreshSongLabels(player);
    }, 700),
  );
}

function refreshSongLabels(player) {
  renderChip(player);
  if (player === A) renderCurtain();
  if (player === A) renderHead();
  if (player === focused()) {
    els.hudTitle.textContent = player.song.title;
    renderAbout();
  }
}

let thumbTimer;
function renderCrate() {
  const mine = app.access === 'preview' ? [] : songs.list();
  crate.render({ mine, beats: app.songs }, (song) => thumbs.get(song));
  crate.setLoaded({ A: A.song?.id, B: B.song?.id });
  $('crate-count').textContent = [mine.length ? `${mine.length} of your own` : null, `${app.songs.length} ${app.songs.length === 1 ? 'beat' : 'beats'}`].filter(Boolean).join(' · ');
  // new songs get their punchcards drawn in the background
  clearTimeout(thumbTimer);
  if (app.thumbsStarted) thumbTimer = setTimeout(drawThumbs, 1500);
}

function drawThumbs() {
  // a beat that is only listed has no code to draw from
  const drawable = allSongs().filter((song) => song.code);
  thumbs.build(drawable, (song, svg) => crate.setThumb(song.id, svg), () => players.some((player) => player.transport === 'loading'));
}

/* ---------- someone else's song ---------- */

// A shared song is shown, not run, until the listener says so.
function renderGate() {
  const player = focused();
  const show = player.gated && !app.gatePeek;
  const appeared = show && els.gate.hidden;
  els.gate.hidden = !show;
  // while the question is open, the opening curtain stays out of the way
  document.body.classList.toggle('is-gated', player.gated);
  if (!show) return;
  $('gate-title').textContent = player.song.title;
  $('gate-by').textContent = [player.song.ownerName ? `shared by ${player.song.ownerName}` : null, remixLine(player.song.from) || null].filter(Boolean).join(' · ');
  $('gate-run').textContent = keepingCopy(player) ? 'Run and keep a copy' : 'Run this song';
  if (appeared) armGate();
}

// A song sent over from the player with "Edit a copy": its gate keeps it as well as runs it.
const keepingCopy = (player) => Boolean(app.copyIntent) && player.song?.source === 'shared' && player.song.shareId === app.copyIntent;

// The answer to the gate. Running a song that came over to be kept also keeps it: one
// click, and it is the listener's own (crediting where it came from).
async function runGated(player = focused()) {
  const keep = keepingCopy(player);
  await player.run();
  if (!keep || !player.song || player.gated) return;
  app.copyIntent = null;
  saveAsNew(player);
  analytics.event('copy_saved', { source: 'shared', via: 'gate' });
  setStatus(`Saved "${player.song.title}" to My songs. Click in the code to change it.`, { hold: 9000 });
}

// The answer has to be meant. Another page can lay a window of its own over this one and
// take it away between the two clicks of a double-click, so that the second click lands
// here. So "Run this song" only wakes a moment after the question appears, and again a
// moment after this window comes back to the front.
let gateTimer;
function armGate() {
  const run = $('gate-run');
  run.disabled = true;
  clearTimeout(gateTimer);
  gateTimer = setTimeout(() => (run.disabled = false), 1000);
}

// `link` is what songLinkIn() read from the address: a share's UUID, or (for songs shared
// before links were UUIDs) the owner and the song.
async function openSharedSong(link) {
  if (!cloud.available) return setStatus('That link points at a shared song, which needs the hosted site.');
  // on the main site a shared song is for editing a copy, which needs an account
  if (app.access === 'preview' && !site.guest) {
    app.pendingShared = link;
    return void needsAccount('keep your own copy of this song');
  }
  let share;
  let record;
  try {
    share = link.share ? await cloud.getShare(link.share) : { owner: link.owner, song: link.id };
    record = share && (await cloud.getShared(share.owner, share.song));
  } catch (error) {
    console.warn('[shared] could not reach the song', error);
    return showGone('unreachable', link);
  }
  // a link switched off (or replaced by a newer one) stays closed
  if (!share || !record || !isLive(record, link.share)) return showGone('closed');
  const { owner: uid, song: id } = share;
  // one's own song, opened from its own link, is just the song
  if (cloud.user?.uid === uid && songs.get(id)) return loadSong(id, 'A', { autoplay: false });
  // the deck may hold changes that need dealing with first
  if (!site.guest && !(await settleEdits(A))) return;
  const song = { ...describeSong(record, 'shared'), owner: uid, ownerName: record.ownerName, shareId: link.share || record.shareId || null, from: record.from };
  app.gatePeek = false;
  showGone(null);
  setFocus('A');
  // On the player's own address there is nothing for a song to reach, so it just loads.
  A.load(song, { trust: site.guest });
  navigate(song, { replace: true });
  if (site.guest) renderGuestIntro(song);
}

// A link that leads nowhere: say so in place of the stage, and offer a way on. `why` is
// 'closed' (sharing switched off, or the link replaced), 'unreachable', or null to clear.
function showGone(why, link = null) {
  $('gone').hidden = !why;
  document.body.classList.toggle('is-gone', Boolean(why));
  if (!why) return;
  if (A.started) A.stop();
  const go = $('gone-go');
  if (why === 'unreachable') {
    $('gone-title').textContent = 'The song could not be reached just now';
    $('gone-text').textContent = 'The connection may have dropped. Try again in a moment.';
    go.textContent = 'Try again';
    go.onclick = () => openSharedSong(link);
  } else {
    $('gone-title').textContent = 'This link no longer works';
    $('gone-text').textContent = 'Its owner may have switched sharing off, which closes a link for good. Ask them for a new one.';
    go.textContent = site.guest ? 'Listen to the featured beat' : 'Back to the beats';
    go.onclick = () => (site.guest ? (location.href = `${config.appOrigin}/`) : showGone(null));
  }
  // on the player, there is no copy to take home
  $('intro-sign-in').hidden = site.guest;
}

// The player's introduction speaks about the song in front of it, and who shared it.
function renderGuestIntro(song) {
  const home = new URL(config.appOrigin).host;
  const who = song.ownerName || 'Someone';
  $('intro-title').textContent = `${who} shared "${song.title}" with you.`;
  $('intro-lede').textContent = `It is code, running live in your browser. Press play, then try its knobs, channels and pads: nothing you do changes their song. To change it or keep a copy, open it on ${home} and sign in, free.`;
  $('intro-now').textContent = `${who} shared "${song.title}" with you. The knobs, channels and pads are yours to try; to keep a copy of your own, sign in on ${home}.`;
  $('intro-sign-in').hidden = false;
}

/* ---------- account ---------- */

function renderAccount() {
  const user = cloud.user;
  els.account.hidden = !cloud.accounts;
  els.account.classList.toggle('is-signed-in', Boolean(user));
  els.account.setAttribute('aria-label', user ? `Account: ${user.name}` : 'Sign in');
  $('account-initial').textContent = user ? (user.name || user.email || '?').trim().charAt(0).toUpperCase() : '';
  $('account-out').hidden = Boolean(user);
  $('account-in').hidden = !user;
  if (!user) return;
  $('account-name').textContent = user.name;
  $('account-email').textContent = user.email;
  const count = songs.list().length;
  $('account-count').textContent = `${count} ${count === 1 ? 'song' : 'songs'} in your account.${user.admin ? ' You are an admin of this site.' : ''}`;
  $('open-admin').hidden = !user.admin;
}

// The beats again, as this visitor is allowed to see them.
async function reloadLibrary() {
  const library = await loadLibrary();
  app.songs = library.songs;
  app.libraryMode = library.mode;
  renderCrate();
  // the admin's visit keeps what everyone else is told about the beats up to date
  if (cloud.user?.admin && library.mode === 'database') admin.syncCatalog().catch((error) => console.warn('[admin] could not refresh the catalog', error));
}

// Someone with an account and no songs yet is given one to play with: their own copy of
// the featured beat, called "User demo". The featured beat itself is never changed.
const STARTER_TITLE = 'User demo';
function giveStarter() {
  const user = cloud.user;
  const featured = featuredBeat();
  if (!user || app.access !== 'full' || !featured?.code || songs.list().length) return null;
  // once per account in this browser: deleting it should not bring it back
  if (persist.get(`starter:${user.uid}`, false)) return null;
  persist.set(`starter:${user.uid}`, true);
  return songs.create({ code: withTitle(featured.code, STARTER_TITLE), mixer: featured.mixer || null, from: fromOf(featured) });
}
// Put their copy on the deck: it is theirs to change.
function openStarter(song) {
  loadSong(song.id, 'A');
  setStatus(`"${STARTER_TITLE}" is your own copy of the featured beat to play with. Click in the code and change anything.`, { hold: 12000 });
}

// Someone signed in or out.
async function onAccountChange(user) {
  renderAccount();
  // the sign-in prompt has done its job (straight away: by the time the beats have been
  // read again, the person may have opened the panel themselves)
  if (user && els.accountDialog.open) els.accountDialog.close();
  setAccess(walled() ? 'preview' : 'full');
  if (!site.guest && cloud.accounts) persist.set('signedIn', Boolean(user));
  const synced = songs.setUser(user).then(renderAccount);
  app.synced = synced;
  if (user) {
    onboarding.done('signin');
    // an account that has kept or shared a song before has done those steps already
    synced.then(() => {
      if (songs.list().some((song) => song.title !== STARTER_TITLE)) onboarding.done('save');
      if (songs.list().some((song) => song.shared)) onboarding.done('share');
    });
  }
  // the first time round, start-up is still under way and loads everything itself
  if (!app.booted) return synced;
  await reloadLibrary().catch((error) => console.warn('[library] could not reload', error));
  if (app.access === 'full') {
    const pending = app.pendingShared;
    const wanted = app.lockedSong;
    app.pendingShared = null;
    // their songs have to be in before we know whether this account has any
    await synced;
    const starter = cloud.user === user ? giveStarter() : null;
    // the beat they asked for while signed out, if their account can play it
    const asked = wanted && findSong(wanted.id);
    if (pending) openSharedSong(pending);
    else if (asked && !isLocked(asked)) loadSong(asked.id, 'A', { route: false, shared: app.pendingMix?.song === asked.id ? app.pendingMix : null });
    else {
      if (app.lockedSong) {
        app.lockedSong = null;
        renderLocked();
        if (location.pathname !== '/') history.replaceState(null, '', '/');
      }
      // a change tried before signing in stays on the deck, ready to keep
      if (A.edited) setStatus('Your change is still on the deck: press Save as my song to keep it.', { hold: 9000 });
      else if (starter) openStarter(starter);
    }
  } else {
    // signed out: back to the featured beat, at the front door
    const featured = featuredBeat();
    app.lockedSong = null;
    renderLocked();
    if (location.pathname !== '/') history.replaceState(null, '', '/');
    if (featured && A.song?.id !== featured.id) loadSong(featured.id, 'A', { autoplay: false, route: false });
  }
  renderFocus();
  renderHead();
  return synced;
}

async function signIn() {
  try {
    const { isNew } = await cloud.signIn();
    analytics.event(isNew ? 'sign_up' : 'login', { method: 'Google' });
    els.accountDialog.close();
  } catch (error) {
    console.warn('[account] sign-in did not complete', error);
    setStatus(error?.code === 'auth/popup-blocked' ? 'The browser blocked the sign-in window. Allow pop-ups for this site and try again.' : 'Sign-in did not complete.');
  }
}

async function signOut() {
  for (const player of players) if (!(await settleEdits(player))) return;
  await songs.flush();
  await cloud.signOut();
  els.accountDialog.close();
}

/* ---------- sharing ---------- */

// What the share sheet is about: a deck's song, or one of my songs from the list.
function shareSubject(target) {
  const player = target.player ?? players.find((entry) => entry.song && entry.song.id === target.songId) ?? null;
  const onDeck = target.songId ? songs.get(target.songId) ?? player?.song ?? null : player?.song ?? null;
  // one of my songs as My songs holds it now (the deck's copy predates sharing changes)
  const song = onDeck?.source === 'mine' ? songs.get(onDeck.id) ?? onDeck : onDeck;
  return { player: player && song && player.song?.id === song.id ? player : null, song };
}

// A built-in beat goes out as its own page's address with the deck's settings, so a link
// preview shows that beat.
function mixLink(player, song) {
  const base = `${config.appOrigin || location.origin}${song.slug ? beatPath(song.slug) : '/'}`;
  return linkForMix({ song: song.id, ...player.snapshot(), tempo: player.tempo }, base);
}

// What share-sheet-core.js needs to know, and the words around it.
function shareInput(target) {
  const { player, song } = shareSubject(target);
  if (!song) return { kind: 'loose', title: '' };
  const base = {
    songId: song.id,
    title: song.title,
    credit: creditLine({ by: song.by, ownerName: song.source === 'shared' ? song.ownerName : null, bpm: song.bpm }),
    from: remixLine(song.from),
    edited: Boolean(player?.edited),
  };
  if (song.source === 'mine') {
    const host = new URL(site.split ? config.shareOrigin : location.origin).host;
    return { ...base, kind: 'own', accounts: cloud.accounts, shared: song.shared, blocked: song.blocked, synced: song.synced, link: songs.shareLink(song.id), host, sharer: cloud.user?.displayName || '' };
  }
  if (song.source === 'beats' && player) return { ...base, kind: 'beat', accounts: cloud.accounts && app.access === 'full', audience: song.audience ?? (song.featured ? 'everyone' : 'members'), link: mixLink(player, song) };
  if (song.source === 'shared') return { ...base, kind: 'theirs', ownerName: song.ownerName, link: linkToSong(song) };
  return { ...base, kind: 'loose' };
}

function openShareSheet(target = { player: focused() }) {
  const { song } = shareSubject(target);
  if (!song) return;
  if (needsAccount('share')) return;
  shareSheet.open(target);
}

// Switch sharing on (and wait until the link works) or off.
async function setSharing(id, on) {
  if (!songs.setShared(id, on)) return;
  analytics.event('share_link', { on });
  if (on) await songs.flush();
  else setStatus('That song is private again. Its old link no longer works.');
}

// The share sheet's offers: keep the changes first, then share.
async function shareAction(action, target) {
  const { player } = shareSubject(target);
  if (!player) return null;
  if (action === 'save-share') saveChanges(player);
  else saveAsNew(player);
  if (!player.own) return null;
  if (action !== 'save-new') await setSharing(player.song.id, true);
  return { player };
}

/* ---------- tempo, sync and the crossfade ---------- */

// With sync on and both decks playing there is one tempo: the leader's.
function syncTempo() {
  if (app.sync && bothPlaying()) {
    const leader = app.leader ?? A;
    leader.lockTo(null);
    other(leader).lockTo(leader.baseCps * leader.tempo);
  } else {
    A.lockTo(null);
    B.lockTo(null);
  }
  const heard = audible().started ? audible() : other(audible());
  master.setTempo(heard.cps);
  deck.syncTempo();
  renderReadouts();
}

const tempoTarget = () => (app.sync && bothPlaying() ? (app.leader ?? A) : focused());

function setSync(on) {
  app.sync = on;
  els.sync.setAttribute('aria-pressed', String(on));
  syncTempo();
}

function stopMixing() {
  if (!app.mixing) return;
  cancelAnimationFrame(app.mixing);
  app.mixing = null;
  renderMixButton();
}

// Bring the other deck in: start it in time, fade across over eight bars, stop the old one.
async function mix() {
  if (app.mixing) return stopMixing();
  if (needsAccount('mix two decks')) return;
  const from = audible();
  const to = other(from);
  if (!to.song) {
    setStatus(`Load a beat into deck ${to.id} first`);
    crate.open(to.id);
    return;
  }
  if (!to.started && !(await to.play())) return;
  if (app.mixing) return;
  if (window.innerWidth >= 1100 && from.started) setSplit(true);

  const duration = from.started ? (8 / from.cps) * 1000 : 800;
  const startedAt = performance.now();
  const x0 = master.state.crossfade;
  const x1 = to === B ? 1 : 0;
  const frame = (now) => {
    const p = Math.min(1, (now - startedAt) / duration);
    const x = x0 + (x1 - x0) * (p * p * (3 - 2 * p));
    deck.crossfader.set(x);
    master.setCrossfade(x);
    if (p < 1) {
      app.mixing = requestAnimationFrame(frame);
      return;
    }
    app.mixing = null;
    from.stop();
    setFocus(to.id);
    setSplit(false);
    renderMixButton();
  };
  app.mixing = requestAnimationFrame(frame);
  renderMixButton();
}

/* ---------- record and share ---------- */

let recordTimer;
// `save: false` is for tests: it returns the WAV without starting a download.
function finishRecording({ save = true } = {}) {
  clearInterval(recordTimer);
  const blob = recorder.stop();
  els.record.setAttribute('aria-pressed', 'false');
  els.recordTime.textContent = '';
  if (!blob) return setStatus('Nothing was recorded');
  if (!save) return blob;
  const title = (audible().song?.title || 'mix').replace(/[^\w\- ]+/g, '').trim() || 'mix';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const name = `hacking-the-beats ${title} ${stamp}.wav`;
  saveBlob(blob, name);
  analytics.event('record', { action: 'save', minutes: Math.round(recorder.seconds / 60) });
  setStatus(`Saved ${name} (${(blob.size / 1048576).toFixed(1)} MB)`, { hold: 9000 });
  return blob;
}

async function toggleRecord() {
  if (recorder.active) return finishRecording();
  if (needsAccount('record the mix')) return;
  if (!recorder.supported) return setStatus('This browser cannot record audio here');
  try {
    await runtime.ensureAudio();
    master.attach();
    await recorder.start(master.output);
  } catch (error) {
    console.error(error);
    return setStatus('Recording could not start');
  }
  els.record.setAttribute('aria-pressed', 'true');
  analytics.event('record', { action: 'start' });
  const tick = () => {
    const s = Math.floor(recorder.seconds);
    els.recordTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  recordTimer = setInterval(tick, 500);
  setStatus(players.some((player) => player.started) ? 'Recording the mix. Press again to save.' : 'Recording. Press play, then press record again to save.');
}
recorder.onAutoStop = () => finishRecording();

/* ---------- MIDI ---------- */

let midiPrompted = false;
function renderMidi(boundKey) {
  const inputs = midi.inputs;
  let text;
  if (!midi.supported) text = 'This browser does not support Web MIDI (Chrome, Edge and Firefox do).';
  else if (!midi.access) text = 'Not connected.';
  else if (!inputs.length) text = 'Connected, but no MIDI device is plugged in.';
  else text = `Connected: ${inputs.join(', ')}.`;
  if (midi.count) text += ` ${midi.count} ${midi.count === 1 ? 'control' : 'controls'} bound.`;
  els.midiStatus.textContent = text;
  els.midiLearn.setAttribute('aria-pressed', String(midi.learning));
  els.midiButton.setAttribute('aria-pressed', String(midi.learning));
  if (boundKey) setStatus('Bound. Click another control, or press MIDI again to finish.', { hold: 0 });
  else if (midi.learning) setStatus(midi.target ? 'Now move a knob or press a pad on your controller' : 'MIDI learn: click a knob, fader, pad or button', { hold: 0 });
  else if (midiPrompted) setStatus('');
  midiPrompted = midi.learning;
}

async function toggleLearn() {
  if (app.access === 'preview') return;
  if (!midi.supported) return setStatus('This browser does not support Web MIDI');
  if (midi.learning) return midi.setLearning(false);
  try {
    await midi.connect();
  } catch {
    return setStatus('MIDI access was not allowed');
  }
  midi.setLearning(true);
}

// If the sound device is asleep or missing, the browser reports the audio as running but
// its clock never moves, and the deck would sit at bar 1 in silence. Say so.
function watchAudioClock(player) {
  const context = runtime.audioContext;
  const before = context.currentTime;
  setTimeout(() => {
    if (player.started && context.currentTime - before < 0.2) {
      setStatus('No sound is coming out: the audio output is not running. Check your sound device, then press play again.', { hold: 0 });
    }
  }, 1500);
}

/* ---------- first steps: where each one is done ---------- */

const visible = (el) => Boolean(el) && !el.hidden && el.getClientRects().length > 0;
function showDeck(tab) {
  if (document.body.classList.contains('deck-collapsed')) els.deckToggle.click();
  deck.showTab(tab);
}
function showMe(step) {
  const player = focused();
  if (step === 'play') return $(`play-${player.id.toLowerCase()}`);
  if (step === 'knob') {
    showDeck(player.sliders.length || player.switches.length ? 'knobs' : 'master');
    return deck.knobs[0]?.dial || deck.switchKnobs[0]?.dial || deck.masterKnobs.filter.dial;
  }
  if (step === 'mute') {
    showDeck('mixer');
    if (player.mixer.tracks.length) player.stage.scrollToTrack(0, { force: true });
    return deck.strips[0]?.mute || null;
  }
  if (step === 'tweak') {
    const chip = $('tries').querySelector('.tries__chip:not(:disabled)');
    return visible(chip) ? chip : els.edit;
  }
  if (step === 'save') return [els.saveNew, els.save, els.saveCopy].find(visible) || els.edit;
  if (step === 'share') return $('share');
  return null;
}

/* ---------- boot ---------- */

// Where the site has a separate address for playing shared songs, send each visit to the
// right one. Returns true if the page is on its way somewhere else.
function reroute() {
  // The site's files answering at an address that is neither of its own: go to the real
  // one, which sends a shared song on to the player.
  if (site.stray) {
    location.replace(`${site.stray}${location.pathname}${location.search}${location.hash}`);
    return true;
  }
  if (!site.split) return false;
  const link = songLinkIn(location);
  // a song's own address on the player, where there is one, is what a link preview reads
  const songAddress = (found) => (found.share && config.linkPreviews ? sharePath(found.share) : `/#song=${found.raw}`);
  let to = null;
  if (site.guest && !link) to = `${config.appOrigin}/${location.hash}`;
  else if (!site.guest && link?.kind === 'song') to = `${config.shareOrigin}${songAddress(link)}`;
  // on the player, an old #song= link becomes the song's own address, so copying it on works
  else if (site.guest && link?.form === 'hash' && link.kind === 'song' && link.share && config.linkPreviews) history.replaceState(null, '', sharePath(link.share));
  if (to) location.replace(to);
  return Boolean(to);
}

async function boot() {
  if (reroute()) return;
  // Until Firebase says who is here, assume what was true last time.
  setAccess(site.guest || (cloud.accounts && !persist.get('signedIn', false)) ? 'preview' : 'full');
  if (site.guest) {
    const home = new URL(config.appOrigin).host;
    $('intro-title').textContent = 'A song someone shared with you.';
    $('intro-lede').textContent = `It is code, running live in your browser. To change it or keep a copy, open it on ${home} and sign in, free.`;
    $('intro-sign-in').textContent = 'Edit a copy';
    $('intro-fine').hidden = true;
  }
  analytics.start();
  Object.assign(master.state, persist.get('master', {}), { crossfade: 0 });

  deck.init(
    {
      deck: $('deck'),
      tabs: [...document.querySelectorAll('.deck__tab')],
      knobs: $('knobs'),
      knobsEmpty: $('knobs-empty'),
      knobsIdle: $('knobs-idle'),
      strips: $('strips'),
      stripsEmpty: $('strips-empty'),
      pads: $('pads'),
      latch: $('pads-latch'),
      latchNote: document.querySelector('.panel__note--hold'),
      master: $('master'),
      crossfader: $('crossfader'),
      sync: els.sync,
      mix: els.mix,
      reset: $('reset'),
    },
    {
      players,
      tempoTarget,
      setTempo: (multiplier) => {
        tempoTarget().setTempo(multiplier);
        syncTempo();
        onboarding.done('knob');
      },
      setSync,
      mix,
      saveMaster: () => {
        onboarding.done('knob');
        // the shared-song player keeps nothing
        if (site.guest) return;
        const { volume, filter, echo, reverb } = master.state;
        persist.set('master', { volume, filter, echo, reverb });
      },
      onCrossfade: () => {
        renderMixButton();
        master.setTempo((audible().started ? audible() : other(audible())).cps);
      },
    },
  );
  crate.init(
    { dialog: $('crate'), mine: $('mine-list'), beats: $('crate-list'), close: $('crate-close'), heading: $('crate-title'), note: $('mine-note') },
    {
      onSelect: (id, deckId) => loadSong(id, app.access === 'preview' ? 'A' : deckId),
      isLocked,
      onCopy: (id) => {
        if (needsAccount('keep a copy')) return;
        const song = songs.copyOf(findSong(id));
        onboarding.done('save');
        setStatus(`"${song.title}" is now in My songs.`);
      },
      onRename: (id, title) => songs.rename(id, title),
      onDuplicate: (id) => songs.copyOf(songs.get(id)),
      onDelete: (id) => songs.remove(id),
      onShare: (id) => openShareSheet({ songId: id }),
      canShare: () => Boolean(cloud.user),
    },
  );
  tries.init(
    { root: $('tries'), list: $('tries-chips') },
    {
      focused,
      // the shared-song player is for listening
      canUse: () => !site.guest,
      status: (message) => setStatus(message, { hold: 9000 }),
      signedIn: () => app.access === 'full',
      onTried: (label, on) => on && onboarding.done('tweak'),
    },
  );
  shareSheet.init(
    {
      dialog: $('share-sheet'),
      close: $('share-close'),
      song: $('share-song'),
      credit: $('share-credit'),
      from: $('share-from'),
      intro: $('share-intro'),
      offer: $('share-offer'),
      offerText: $('share-offer-text'),
      offerGo: $('share-offer-go'),
      warning: $('share-warning'),
      warningText: $('share-warning-text'),
      warningGo: $('share-warning-go'),
      warningSkip: $('share-warning-skip'),
      toggleRow: $('share-toggle-row'),
      toggle: $('share-toggle'),
      linkRow: $('share-link-row'),
      link: $('share-link'),
      copy: $('share-copy'),
      native: $('share-native'),
      linkNote: $('share-link-note'),
      recipient: $('share-recipient'),
      note: $('share-note'),
      live: $('share-live'),
      record: $('share-record'),
      video: $('share-video'),
    },
    {
      input: shareInput,
      setShared: setSharing,
      act: shareAction,
      shared: (method, kind) => {
        analytics.event('share', { method, content_type: kind });
        onboarding.done('share');
      },
      opened: (kind) => analytics.event('share_open', { content_type: kind }),
      record: () => toggleRecord(),
      recording: () => recorder.active,
      canRecord: () => app.access === 'full',
      copyKey: APPLE ? '⌘C' : 'Ctrl+C',
    },
  );
  if (!site.guest) {
    onboarding.init(
      {
        coach: $('coach'),
        count: $('coach-count'),
        steps: $('coach-steps'),
        close: $('coach-close'),
        end: $('coach-end'),
        done: $('coach-done'),
        never: $('coach-never'),
        live: $('coach-live'),
        toggle: $('coach-toggle'),
        progress: $('coach-progress'),
        restart: $('coach-restart'),
      },
      { showMe, signIn, share: () => openShareSheet(), keys: KEYS, event: (name) => analytics.event(name) },
    );
    $('coach-restart').addEventListener('click', () => els.about.close());
  }

  // New: first choose what to start from (songs-core.js STARTERS)
  const starters = $('starters');
  const showStarters = (on) => {
    starters.hidden = !on;
    $('song-new').setAttribute('aria-expanded', String(on));
  };
  for (const { kind, label, blurb } of STARTERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'starter';
    button.dataset.starter = kind;
    button.innerHTML = '<span class="starter__label"></span><span class="starter__blurb"></span>';
    button.querySelector('.starter__label').textContent = label;
    button.querySelector('.starter__blurb').textContent = blurb;
    button.addEventListener('click', async () => {
      // the deck the list was opened for ("Songs · deck B")
      const deckId = crate.target;
      // the deck may hold changes that need dealing with first
      if (!(await settleEdits(byId[deckId]))) return;
      const song = songs.createBlank(kind);
      showStarters(false);
      crate.dialog.close();
      await loadSong(song.id, deckId);
      setEditing(true, byId[deckId]);
    });
    starters.append(button);
  }
  $('song-new').addEventListener('click', () => {
    if (needsAccount('start a song')) return;
    showStarters(starters.hidden);
    if (!starters.hidden) starters.querySelector('.starter').focus();
  });
  crate.dialog.addEventListener('close', () => showStarters(false));
  $('song-import').addEventListener('click', () => $('song-file').click());
  $('song-file').addEventListener('change', async (event) => {
    let count = 0;
    for (const file of event.target.files) count += songs.importText(await file.text(), file.name);
    event.target.value = '';
    setStatus(count ? `${count} ${count === 1 ? 'song' : 'songs'} added to My songs.` : 'No songs were found in that file.');
  });
  $('song-export').addEventListener('click', () => {
    if (!songs.list().length) return setStatus('There is nothing in My songs to export yet.');
    saveBlob(new Blob([songs.exportText()], { type: 'application/json' }), `hacking-the-beats-songs-${new Date().toISOString().slice(0, 10)}.json`);
  });

  for (const player of players) {
    const id = player.id.toLowerCase();
    const mine = (fn) => (...args) => player === focused() && fn(...args);
    player.partner = () => (app.sync && other(player).started ? other(player) : null);

    player.on('song', () => {
      // the built site shows a song's code in plain HTML until the editor takes over
      if (player === A) $('prerender')?.remove();
      if (player === A) renderHead();
      renderChip(player);
      $(`pane-${id}`).classList.toggle('has-song', Boolean(player.song));
      if (player === A) renderCurtain();
      crate.setLoaded({ A: A.song?.id, B: B.song?.id });
      if (player === focused()) renderFocus();
    });
    // editing
    player.on('editable', mine(renderEditing));
    player.on('dirty', mine(renderEditing));
    player.on('changed', () => saveOwn(player));
    player.on('structure', mine(() => {
      renderRibbonRows();
      visuals.invalidate();
      renderTries();
    }));
    // first steps: a knob turned, a track muted, the code changed and run
    player.on('slider', () => onboarding.done('knob'));
    player.on('switch', () => onboarding.done('knob'));
    player.on('mixer', (reason) => (reason === 'mute' || reason === 'solo') && onboarding.done('mute'));
    player.on('updated', () => player.edited && onboarding.done('tweak'));
    player.on('unsaved', () => {
      renderChip(player);
      if (player === focused()) renderEditing();
    });
    // A click in the code starts editing, for someone with an account and a mouse. On a
    // touch screen a tap is usually meant for the music (a track name, a number), so the
    // keyboard waits for the Edit button; signed out, the code is there to play with.
    player.wantEdit = () => {
      if (!player.song || player.gated || app.gallery || site.guest) return;
      if (app.access !== 'full') {
        if (firstTime('preview-code')) setStatus('Sign in, free, to change the code. Meanwhile, click a track name to mute it, or a lit number to find its knob.', { hold: 9000 });
        return;
      }
      if (coarse()) {
        if (firstTime('touch-edit')) setStatus('To change the code, press Edit.', { hold: 6000 });
        return;
      }
      setFocus(player.id);
      setEditing(true, player);
    };
    player.on('adopted', () => {
      if (player === A) persist.set('lastSong', player.song.id);
      if (player === A) navigate(player.song, { replace: true });
      refreshSongLabels(player);
      crate.setLoaded({ A: A.song?.id, B: B.song?.id });
      if (player === focused()) renderEditing();
    });
    player.on('gate', () => {
      if (player.gated) player.stage.editing && player.setEditable(false);
      app.gatePeek = false;
      if (player === focused()) {
        renderGate();
        renderEditing();
        renderTries();
      }
    });
    player.on('ready', renderReadouts);
    player.on('ready', mine(renderTries));
    player.on('transport', (state) => {
      renderChip(player);
      if (player === focused()) document.body.dataset.transport = state;
      if (state === 'playing') document.body.classList.add('has-played');
      if (state === 'playing') onboarding.done('play');
    });
    player.on('toggle', (started) => {
      document.body.classList.toggle('is-playing', A.started || B.started);
      if (started) watchAudioClock(player);
      if (started) analytics.event('play', { song: player.song?.slug || player.song?.source || '' });
      if (started && !other(player).started) app.leader = player;
      // The deck left playing keeps the tempo the pair was at, rather than snapping back
      // to its own (as far as the tempo knob's range allows).
      const partner = other(player);
      if (!started && partner.started && partner.lockedCps) {
        partner.tempo = Math.min(1.25, Math.max(0.75, partner.lockedCps / partner.baseCps));
      }
      if (!started && app.leader === player) app.leader = partner.started ? partner : null;
      if (!started && app.mixing) stopMixing();
      syncTempo();
      if (player === focused()) {
        deck.setLevels();
        renderPosition();
      }
      visuals.invalidate();
    });
    player.on('frame', mine(() => {
      deck.setLevels();
      renderPosition();
    }));
    player.on('tempo', renderReadouts);
    player.on('mixer', mine(() => {
      renderRibbonRows();
      visuals.invalidate();
    }));
    player.on('grid', mine(() => visuals.invalidate()));
    player.on('seek', mine(() => {
      app.lastPosition = null;
      renderPosition();
      visuals.invalidate();
    }));
    player.on('error', mine(renderNotice));
    player.on('status', (message, options) => setStatus(message, options));

    const playButton = $(`play-${id}`);
    playButton.addEventListener('click', () => {
      setFocus(player.id);
      player.toggle();
    });
    register(`play:${player.id}`, playButton, { press: (down) => down && player.toggle() });
    // a chip focuses its deck; pressing the one already in focus opens the beats list
    $(`deck-${id}`).addEventListener('click', () => {
      if (app.focusId === player.id || !player.song) crate.open(player.id);
      setFocus(player.id);
    });
    $(`tag-${id}`).addEventListener('click', () => setFocus(player.id));
    $(`pane-${id}`).addEventListener('pointerdown', () => setFocus(player.id));
  }
  runtime.on('log', (message) => setStatus(message));
  runtime.on('packs', () => players.forEach((player) => player.prepareSounds()));

  visuals.start({
    scope: $('scope'),
    spectrum: $('spectrum'),
    ribbon: els.ribbon,
    meter: $('meter'),
    getPlayer: focused,
    anyPlaying: () => A.started || B.started,
  });

  // view controls
  setFollow(app.follow);
  setSplit(false);
  els.follow.addEventListener('click', () => setFollow(!app.follow));
  els.split.addEventListener('click', () => setSplit(!app.split));
  els.gallery.addEventListener('click', () => setGallery(true));
  $('locked-sign-in').addEventListener('click', signIn);
  $('locked-featured').addEventListener('click', () => {
    const featured = featuredBeat();
    if (featured) loadSong(featured.id, 'A');
  });
  $('intro-sign-in').addEventListener('click', () => (site.guest ? takeHome(A) : signIn()));
  $('hud-exit').addEventListener('click', () => setGallery(false));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) setGallery(false);
  });
  els.stage.addEventListener('pointermove', () => app.gallery && wakeHud());

  // navigation
  els.curtainPlay.addEventListener('click', () => A.play());
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  $('open-crate').addEventListener('click', () => (site.guest ? (location.href = `${config.appOrigin}/`) : crate.open(app.focusId)));
  $('open-list').addEventListener('click', () => crate.open(app.focusId));
  $('load-b').addEventListener('click', () => crate.open('B'));
  $('open-about').addEventListener('click', () => els.about.showModal());
  $('about-close').addEventListener('click', () => els.about.close());
  els.about.addEventListener('click', (event) => event.target === els.about && els.about.close());
  els.record.addEventListener('click', toggleRecord);
  $('share').addEventListener('click', () => openShareSheet());

  // editing
  els.edit.addEventListener('click', () => setEditing(!focused().stage.editing));
  els.update.addEventListener('click', () => focused().update());
  els.saveCopy.addEventListener('click', () => saveCopy());
  els.save.addEventListener('click', () => saveChanges());
  els.saveNew.addEventListener('click', () => saveAsNew());
  els.saveBeat.addEventListener('click', () => updatePublicBeat());
  els.revert.addEventListener('click', () => revertChanges());
  // leaving the page with changes that are not saved: the browser asks first
  window.addEventListener('beforeunload', (event) => {
    if (app.access !== 'full' || !players.some((player) => player.song && player.edited && !player.gated)) return;
    event.preventDefault();
    event.returnValue = '';
  });
  $('gate-run').addEventListener('click', () => runGated());
  $('gate-read').addEventListener('click', () => {
    app.gatePeek = true;
    renderGate();
  });
  window.addEventListener('focus', () => !els.gate.hidden && armGate());
  document.addEventListener('visibilitychange', () => !document.hidden && !els.gate.hidden && armGate());

  // account
  els.account.addEventListener('click', () => els.accountDialog.showModal());
  $('account-close').addEventListener('click', () => els.accountDialog.close());
  els.accountDialog.addEventListener('click', (event) => event.target === els.accountDialog && els.accountDialog.close());
  $('sign-in').addEventListener('click', signIn);
  $('sign-out').addEventListener('click', signOut);
  songs.onStatus((message) => setStatus(message, { hold: 9000 }));
  songs.onChange((reason, id) => {
    renderCrate();
    renderAccount();
    // a song that has left My songs (deleted, or its account signed out) but is still on
    // a deck carries on as a loose copy
    for (const player of players) {
      if (player.own && !songs.get(player.song.id)) {
        player.song = { ...player.song, source: 'loose' };
        if (player === focused()) renderEditing();
      }
    }
    if (reason === 'updated' && id) crate.setLoaded({ A: A.song?.id, B: B.song?.id });
    if (shareSheet.open) shareSheet.render();
  });
  admin.init(
    {
      dialog: $('admin'),
      close: $('admin-close'),
      tabs: [...document.querySelectorAll('[data-admin-tab]')],
      panels: [...document.querySelectorAll('[data-admin-panel]')],
      status: $('admin-status'),
      list: $('admin-beats'),
      song: $('admin-song'),
      publish: $('admin-publish'),
      importButton: $('admin-import'),
      file: $('admin-file'),
      seed: $('admin-seed'),
      sharedList: $('admin-shared'),
    },
    {
      // what the admin changed is what everybody is offered: read it back
      onChange: () => reloadLibrary().catch(() => {}),
      siteBeats: () => (app.libraryMode === 'files' ? app.songs.filter((song) => song.code && !song.broken) : []),
    },
  );
  $('open-admin').addEventListener('click', () => {
    els.accountDialog.close();
    admin.open();
  });
  cloud.onUser(onAccountChange);
  renderAccount();
  // who is here decides which beats they are given, so start-up waits to be told
  const ready = cloud.init().catch((error) => console.warn('[account] accounts are unavailable', error));

  // key names as this keyboard has them
  document.querySelectorAll('[data-keys]').forEach((el) => (el.title = localizeKeys(el.title, APPLE)));
  document.querySelectorAll('kbd[data-mod]').forEach((el) => (el.textContent = KEYS.mod));

  $('version').textContent = `v${VERSION}`;
  $('about-version').textContent = `v${VERSION}`;
  $('source-link').href = `source/hacking-the-beats-${VERSION}.tar.gz`;

  // arrangement ribbon: open it for track names, click a bar to jump there
  els.ribbonToggle.addEventListener('click', () => {
    const open = els.ribbonRow.classList.toggle('is-open');
    els.ribbonToggle.setAttribute('aria-expanded', String(open));
    visuals.open = open;
    visuals.invalidate();
  });
  els.ribbon.addEventListener('pointermove', (event) => {
    visuals.hover = visuals.columnAt(event.clientX);
  });
  els.ribbon.addEventListener('pointerleave', () => (visuals.hover = null));
  els.ribbon.addEventListener('click', (event) => {
    const column = visuals.columnAt(event.clientX);
    const player = focused();
    if (column === null || !player.song) return;
    const base = Math.floor(player.position() / ARRANGEMENT_BARS) * ARRANGEMENT_BARS;
    player.seek(base + column);
    if (!player.started) setStatus(column ? `Deck ${player.id} will start from bar ${column + 1}` : '');
  });

  els.deckToggle.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('deck-collapsed');
    els.deckToggle.setAttribute('aria-expanded', String(!collapsed));
    visuals.invalidate();
  });
  // In a very small window the code comes first: start with the deck folded away.
  if (window.innerHeight < 420 && window.innerWidth < 560) els.deckToggle.click();

  // MIDI
  midi.onChange = renderMidi;
  els.midiButton.addEventListener('click', toggleLearn);
  els.midiLearn.addEventListener('click', toggleLearn);
  $('midi-connect').addEventListener('click', () => midi.connect().catch(() => setStatus('MIDI access was not allowed')));
  $('midi-clear').addEventListener('click', () => midi.clear());
  document.addEventListener('pointerdown', (event) => midi.pickFromEvent(event), true);
  document.addEventListener('click', (event) => midi.learning && event.target.closest?.('[data-midi]') && (event.preventDefault(), event.stopPropagation()), true);
  renderMidi();

  const seekBy = (bars) => {
    const player = focused();
    if (player.song) player.seek(Math.max(0, Math.floor(player.position()) + bars));
  };
  const channelKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

  document.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]')) return;
    const inEditor = Boolean(event.target.closest?.('.cm-content[contenteditable="true"]'));
    if (event.metaKey || event.ctrlKey) {
      // Stop. In the code, Ctrl+. is the editor's own; ⌘. on a Mac arrives here.
      if (event.key === '.') {
        if (!(inEditor && event.ctrlKey)) {
          event.preventDefault();
          focused().stop();
        }
        return;
      }
      if (app.access === 'preview') return;
      // Ctrl+Enter and ⌘+Enter inside the editor are handled by the editor itself
      if (event.key === 'Enter' && !inEditor) {
        event.preventDefault();
        focused().update();
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (focused().edited) saveChanges();
        else if (focused().own) setStatus('Nothing to save.');
        else saveCopy();
      }
      return;
    }
    // Esc leaves the code
    if (inEditor && event.key === 'Escape') {
      focused().setEditable(false);
      event.target.blur?.();
      return;
    }
    // typing in the code is just typing
    if (event.altKey || inEditor) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const interactive = event.target.closest?.('button, a, input, [role="slider"]');
    const pad = deck.pads.get(key);
    const channel = channelKeys.indexOf(key);
    // Without an account (and on the shared-song player): play, the list, the next beat,
    // help, the pads, channels and views. The second deck, mixing and recording need one.
    if (app.access === 'preview') {
      const mixing = pad || channel >= 0 || ['[', ']', 'f', 'g'].includes(key);
      if (!['Escape', ' ', 'ArrowLeft', 'ArrowRight', 'b', '?'].includes(key) && !mixing) return;
    }

    if (key === 'Escape') {
      if (midi.learning) toggleLearn();
      else if (app.gallery) setGallery(false);
      else if (focused().stage.focus !== null) {
        focused().stage.setFocus(focused().stage.focus);
        deck.syncFocus();
      }
    } else if (key === ' ' && !interactive) {
      event.preventDefault();
      focused().toggle();
    } else if (pad) {
      if (!event.repeat) pad.press(true, event.shiftKey || deck.latch);
    } else if (key === 'ArrowRight' && !interactive) step(1);
    else if (key === 'ArrowLeft' && !interactive) step(-1);
    else if (channel >= 0 && focused().mixer.tracks[channel]) focused().mixer.setMute(channel);
    else if (key === 'x') setFocus(other(focused()).id);
    else if (key === 'm') mix();
    else if (key === 'f') setFollow(!app.follow);
    else if (key === 'g') setGallery(!app.gallery);
    else if (key === 'r') toggleRecord();
    else if (key === 'b') crate.open(app.focusId);
    else if (key === '[') seekBy(-4);
    else if (key === ']') seekBy(4);
    else if (key === '?') els.about.showModal();
  });
  document.addEventListener('keyup', (event) => {
    if (event.target.closest?.('.cm-content[contenteditable="true"]')) return;
    const pad = event.key.length === 1 && deck.pads.get(event.key.toLowerCase());
    if (pad) pad.press(false);
  });

  renderFocus();
  renderMixButton();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  await ready;
  setAccess(walled() ? 'preview' : 'full');

  // The shared-song player has one job: the song its link names.
  if (site.guest) {
    const link = songLinkIn(location);
    renderCrate();
    await openSharedSong(link);
    renderHead();
    app.booted = true;
    return;
  }

  setStatus('Reading beats…', { hold: 0 });
  try {
    await reloadLibrary();
  } catch (error) {
    console.error(error);
    setStatus('');
    A.fail('No beats to play', error.message);
    return;
  }
  setStatus('');
  if (!app.songs.length) {
    A.fail('No beats to play', 'Put a strudel.cc export (.json) or a .strudel file in the beats folder.');
    return;
  }

  // A link can carry a mix of a built-in beat (#mix=…) or point at a song someone shared
  // from their account (#song=…). Otherwise pick up where we left off, or on a first
  // visit open the featured beat.
  const hash = location.hash;
  const shared = mixFromHash(hash);
  const sharedSong = shared && app.songs.find((song) => song.id === shared.song);
  const songLink = songLinkIn(location);
  if (shared || songLink) history.replaceState(null, '', location.pathname + location.search);
  if (shared && !sharedSong) setStatus('The beat in that link is not in this collection');
  // A beat's own address opens that beat.
  const addressed = songAtAddress();
  if (!addressed && location.pathname !== '/') {
    if (slugFromPath(location.pathname)) {
      setStatus('That beat is not in this collection');
      // nothing lives at this address: keep it out of search results
      const robots = document.createElement('meta');
      robots.name = 'robots';
      robots.content = 'noindex';
      document.head.append(robots);
    }
    history.replaceState(null, '', `/${location.hash}`);
  }
  const featured = featuredBeat();
  const remembered = app.access === 'full' ? findSong(persist.get('lastSong')) : null;
  const wanted = sharedSong || addressed || remembered || featured;
  // a beat this visitor may not play yet is described over the featured one
  const opener = isLocked(wanted) ? featured : wanted;
  if (!isLocked(opener)) await loadSong(opener.id, 'A', { autoplay: false, shared: sharedSong && opener === sharedSong ? shared : null, route: false });
  if (isLocked(wanted)) {
    showLocked(wanted, { route: false });
    if (sharedSong === wanted) app.pendingMix = shared;
  }
  if (sharedSong) navigate(sharedSong, { replace: true });
  renderHead();
  app.booted = true;
  // someone who arrives already signed in, with no songs yet, gets their starter too
  Promise.resolve(app.synced).then(() => {
    const starter = giveStarter();
    if (starter && wanted === featured && !songLink) openStarter(starter);
  });
  // back and forward move between the beats that were opened
  window.addEventListener('popstate', () => {
    const song = songAtAddress();
    const shown = app.lockedSong || A.song;
    if (song && shown?.id !== song.id) loadSong(song.id, 'A', { route: false });
    if (!song && app.lockedSong) {
      app.lockedSong = null;
      renderLocked();
    }
    renderHead();
  });
  if (songLink?.kind === 'copy') {
    app.copyIntent = songLink.share || null;
    analytics.event('copy_arrival', { signed_in: Boolean(cloud.user) });
  }
  if (songLink) openSharedSong(songLink);
  // A link pasted into the address bar of the open site only changes the part after the
  // #, which does not load the page again by itself.
  window.addEventListener('hashchange', () => {
    if (songLinkIn(location) || mixFromHash(location.hash)) location.reload();
  });

  // Draw the punchcards for the song list once the first song has settled.
  A.on('ready', () => {
    if (app.thumbsStarted) return;
    app.thumbsStarted = true;
    setTimeout(drawThumbs, 1200);
  });
}

// A handle for tests and for poking around in the console.
window.hackingTheBeats = { app, players: byId, master, deck, recorder, midi, visuals, runtime, registry, crate, thumbs, songs, cloud, config, site, admin, analytics, tries, onboarding, finishRecording, VERSION };

boot();
