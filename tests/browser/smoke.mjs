// End-to-end smoke test in real browser engines. Starts its own server, then for each
// engine: loads the site, plays, and exercises the deck the way a person would.
//
//   npm run test:browsers                 chromium, firefox and webkit
//   npm run test:browsers -- firefox      just one
//   npm run test:browsers -- --built      the built site in dist/, as it is published
//
// Needs `npx playwright install` once, and a network connection for the sample packs
// (unless they have been vendored with `npm run samples`).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as playwright from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// SMOKE_PORT lets two copies of the project run this at once
const PORT = Number(process.env.SMOKE_PORT) || 5199;
const URL = `http://localhost:${PORT}/`;
// --built tests the site as it is published (run `npm run build` first)
const built = process.argv.includes('--built');
const named = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const engines = named.length ? named : ['chromium', 'firefox', 'webkit'];

const server = spawn(process.execPath, [resolve(root, 'tools/serve.mjs')], { env: { ...process.env, PORT: String(PORT), ...(built ? { SERVE: 'dist' } : {}) }, stdio: 'ignore' });
const stopServer = () => server.kill();
process.on('exit', stopServer);

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('test server did not start');
}

// Runs in the page. Each step returns [name, passed, detail].
async function scenario() {
  const h = window.hackingTheBeats;
  const { A, B } = h.players;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (test, ms = 20000) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      if (test()) return true;
      await sleep(50);
    }
    return false;
  };
  const results = [];
  const check = (name, passed, detail = '') => results.push([name, Boolean(passed), String(detail)]);
  const onsets = (player, from, filter = () => true) => player.scheduler.pattern.queryArc(from, from + 1).filter((hap) => hap.hasOnset() && filter(hap)).length;

  check('deck A is playing', A.started, A.song?.title);
  check('notation lights up', await until(() => document.querySelectorAll('#pane-a .hb-hit').length > 0, 6000));

  let peak = 0;
  await until(() => (peak = Math.max(peak, h.master.peak())) > 0.02, 5000);
  check('audio reaches the master bus', peak > 0.02, `peak ${peak.toFixed(3)}`);
  let top = 0;
  for (let i = 0; i < 40; i++) {
    top = Math.max(top, h.master.peak());
    await sleep(40);
  }
  check('output stays under full scale', top < 0.97, `peak ${top.toFixed(3)}`);
  // a song that is one pattern has no channels of its own
  if (A.mixer.tracks.length) check('channel meters read audio', await until(() => A.mixer.tracks.some((track) => track.meter > 0.01), 5000));
  // the levels have been measured: turn the master right down for the rest of the run,
  // since Firefox and WebKit play through the machine's real speakers
  h.master.setVolume(0.03);

  if (A.sliders.length) {
    const slider = A.sliders[0];
    const target = slider.min + (slider.max - slider.min) * 0.5;
    h.deck.knobs[0].set(target, { silent: false });
    check('a knob rewrites its number in the code', A.mirror.code.slice(0, 4000).includes(String(slider.value)) && A.sliderStore[A.sliderIds[0]] === slider.value, `${slider.title} = ${slider.value}`);
  }

  if (A.mixer.tracks.length) {
    const bar = Math.floor(A.now()) + 2;
    const index = A.mixer.tracks.findIndex((track, i) => onsets(A, bar, (hap) => hap.context.track === i) > 0);
    if (index >= 0) {
      A.mixer.setMute(index, true);
      check('mute removes a track from what plays', onsets(A, bar, (hap) => hap.context.track === index) === 0, A.mixer.tracks[index].name);
      A.mixer.setMute(index, false);
    }
    const before = onsets(A, bar);
    A.setFx('half', true);
    const halved = onsets(A, bar);
    A.setFx('half', false);
    check('the half-time pad thins the pattern', halved < before && halved > 0, `${before} → ${halved}`);
  }

  A.seek(Math.floor(A.position()) + 8);
  await sleep(200);
  check('seeking moves the song position', A.offset === 8, `offset ${A.offset}`);

  // Strudel's global scope must not take over names other code on the page relies on:
  // Google's sign-in library needs window.frames to be the browser's
  let parseError;
  try {
    JSON.parse('{');
  } catch (error) {
    parseError = error;
  }
  check("the music engine leaves the browser's own globals alone", window.frames === window && parseError instanceof SyntaxError && typeof window.stack === 'function');

  check('the version is shown', document.getElementById('version').textContent === `v${h.VERSION}`, h.VERSION);

  const apple = /mac|iphone|ipad/i.test(navigator.platform);
  const runTitle = document.getElementById('update').title;
  check('key hints name the keys this keyboard has', apple ? runTitle.includes('⌘') && !runTitle.includes('Ctrl') : runTitle.includes('Ctrl+Enter'), runTitle);

  // with Latch on, a tap leaves a pad on until the next tap; switching Latch off lets go
  const pad = h.deck.pads.get('w');
  document.getElementById('pads-latch').click();
  pad.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  pad.el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
  const stayed = pad.isOn();
  document.getElementById('pads-latch').click();
  check('Latch keeps a tapped pad on, and switching it off lets go', stayed && !pad.isOn() && !h.deck.latch);

  // first steps open by themselves once the music starts
  check('first steps open once the music plays', !document.getElementById('coach').hidden && document.querySelector('.coach__step[data-step="play"]')?.classList.contains('is-done'));

  // a suggestion: one tap changes the code and the music, another puts it back exactly
  const chips = () => [...document.querySelectorAll('#tries .tries__chip')];
  if (chips().length) {
    const original = A.code;
    chips()[0].click();
    const applied = await until(() => chips()[0]?.getAttribute('aria-pressed') === 'true', 8000);
    await until(() => A.mirror.editor.dom.querySelectorAll('.cm-line.hb-changed').length > 0, 3000);
    const tried = { applied, changed: A.code !== original, marked: A.mirror.editor.dom.querySelectorAll('.cm-line.hb-changed').length, dirty: A.dirty, playing: A.started };
    chips()[0].click();
    const undone = await until(() => chips()[0]?.getAttribute('aria-pressed') === 'false', 8000);
    check('a suggestion changes the code and the music, and a second tap puts it back', tried.applied && tried.changed && tried.marked > 0 && !tried.dirty && tried.playing && undone && A.code === original && !A.edited, JSON.stringify(tried));
  } else {
    check('the opening beat offers suggestions to try', false, A.song.title);
  }

  // the song map: the sections of the code, each a click away (here behind the Map button)
  const map = document.getElementById('map');
  const mapShown = () => getComputedStyle(map).display !== 'none';
  if (!document.body.classList.contains('map-docked')) document.getElementById('map-toggle').click();
  const labels = (kind) => [...map.querySelectorAll(`.map__item--${kind} .map__label`)].map((el) => el.textContent);
  const listed = { shown: mapShown(), parts: labels('part'), knobs: labels('knob') };
  check("the song map lists the beat's parts and knobs", listed.shown && listed.parts.join() === A.mixer.tracks.map((track) => track.name).join() && A.sliders.every((slider) => listed.knobs.includes(slider.title)), JSON.stringify(listed));
  const lastPart = [...map.querySelectorAll('.map__item--part')].at(-1);
  const mapped = A.stage.state.tracks.at(-1);
  A.stage.view.scrollDOM.scrollTop = 0;
  lastPart.scrollIntoView({ block: 'nearest' });
  await sleep(100);
  lastPart.click();
  await sleep(1400);
  const box = A.stage.view.scrollDOM.getBoundingClientRect();
  const spot = A.stage.view.coordsAtPos(mapped.from);
  const marked = [...A.stage.view.contentDOM.querySelectorAll('.cm-line.hb-mapped')];
  check('choosing a part in the map brings its code into view and marks it', spot && spot.top >= box.top && spot.bottom <= box.bottom && marked[0]?.textContent.startsWith(A.code.slice(mapped.labelFrom, mapped.labelTo)), `${marked.length} lines marked`);
  lastPart.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  const card = document.getElementById('map-card');
  const described = { shown: !card.hidden && getComputedStyle(card).display !== 'none', title: card.querySelector('.map__card-title').textContent, text: card.querySelector('.map__card-details').textContent, edit: card.querySelector('.map__card-edit').textContent };
  check('hovering an entry shows what that part plays and does', described.shown && described.title === A.mixer.tracks.at(-1).name && /Sounds|Notes/.test(described.text) && /Effects/.test(described.text) && described.edit === 'Edit this part', JSON.stringify(described));
  // signed out, the card offers an account instead, and the code stays locked
  h.app.access = 'preview';
  lastPart.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  const offer = card.querySelector('.map__card-edit').textContent;
  card.querySelector('.map__card-edit').click();
  const mapSignIn = document.getElementById('account-dialog').open && !A.stage.editing;
  document.getElementById('account-dialog').close();
  h.app.access = 'full';
  check('signed out, the card says "Sign in to edit" and asks for an account', offer === 'Sign in to edit' && mapSignIn, offer);
  lastPart.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  card.querySelector('.map__card-edit').click();
  const caret = A.stage.view.state.selection.main.head;
  check('"Edit this part" opens the code with the caret at that part', A.stage.editing && caret === mapped.from, `caret on line ${A.stage.view.state.doc.lineAt(caret).number}, part on line ${A.stage.view.state.doc.lineAt(mapped.from).number}`);
  if (A.stage.editing) document.getElementById('edit').click();
  h.songMap.setOpen(false);

  // locked by default: typing must not change the code
  const code = A.mirror.code;
  A.mirror.editor.contentDOM.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true }));
  document.execCommand?.('insertText', false, 'HACK');
  check('the code is locked until Edit is pressed', A.mirror.code === code && A.mirror.editor.state.readOnly);

  // the slider drawn in the code and the knob on the deck are the same control
  if (h.app.follow) document.getElementById('follow').click();
  if (A.sliders.length) {
    const slider = A.sliders[0];
    // bring the top of the code, where the first slider is, onto the screen
    const firstInline = () => (A.stage.view.viewport.from <= slider.from ? document.querySelector('#pane-a .cm-slider input') : null);
    await until(() => {
      A.stage.view.scrollDOM.scrollTop = 0;
      return firstInline();
    }, 5000);
    const inline = firstInline();
    check('an inline slider follows its knob', inline && Number(inline.value) === slider.value, `${slider.title}: ${inline?.value} / ${slider.value}`);
    const was = slider.value;
    if (inline) {
      inline.value = String(Number(inline.min) + (Number(inline.max) - Number(inline.min)) * 0.25);
      inline.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);
    }
    check(
      'an inline slider moves its knob and the sound',
      inline && slider.value !== was && Number(inline.value) === slider.value && Math.abs(h.deck.knobs[0].get() - slider.value) < 1e-9 && A.sliderStore[A.sliderIds[0]] === slider.value,
      `${slider.title} = ${slider.value}`,
    );
  }

  // edit: click into the code, change it, run it without stopping, then decide what to keep
  const view = A.mirror.editor;
  const shownNow = (id) => !document.getElementById(id).hidden;
  const beat = A.song;
  const aLine = view.contentDOM.querySelector('.cm-line');
  aLine.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  check('a click in the code starts editing', A.stage.editing && !view.state.readOnly && document.getElementById('edit').textContent === 'Done');
  A.stage.view.scrollDOM.scrollTop = 0;
  view.dispatch({ changes: [{ from: 0, insert: '// tried something\n' }, { from: view.state.doc.length, insert: '\nEDITED: s("hh*4").gain(0.15)\n' }], userEvent: 'input.type' });
  // (the top of the code has to be on screen for its marked line to be drawn)
  await until(() => {
    A.stage.view.scrollDOM.scrollTop = 0;
    return view.dom.querySelectorAll('.cm-line.hb-changed').length > 0;
  }, 4000);
  const wasDirty = A.dirty && document.getElementById('update').classList.contains('is-dirty');
  const cues = { marked: view.dom.querySelectorAll('.cm-line.hb-changed').length, unsaved: shownNow('unsaved'), chip: document.getElementById('chip-a').classList.contains('is-unsaved'), save: shownNow('save'), saveNew: shownNow('save-new') && document.getElementById('save-new').textContent, revert: shownNow('revert') };
  check('changes are marked and offered for saving', cues.marked >= 1 && cues.marked <= 3 && cues.unsaved && cues.chip && !cues.save && cues.saveNew === 'Save as my song' && cues.revert, JSON.stringify(cues));
  document.getElementById('update').click();
  const ranEdit = await until(() => !A.dirty && A.mixer.tracks.some((track) => track.name === 'EDITED'), 8000);
  check('edited code runs without stopping the music', wasDirty && ranEdit && A.started && !A.own && h.songs.list().length === 0);

  // sharing an edited site beat (no accounts here): the sheet says what it is, offers to keep
  // the changes first, and the beat's own link goes without them
  document.getElementById('share').click();
  const sheet = {
    open: document.getElementById('share-sheet').open,
    intro: document.getElementById('share-intro').textContent,
    warning: !document.getElementById('share-warning').hidden && document.getElementById('share-warning-go').textContent,
    link: document.getElementById('share-link').value,
    note: document.getElementById('share-link-note').textContent,
  };
  document.getElementById('share-warning-skip').click();
  const skipped = document.getElementById('share-warning').hidden;
  document.getElementById('share-close').click();
  check(
    "sharing an edited site beat says what it is, and that its link goes without the changes",
    sheet.open && /one of the site's beats/.test(sheet.intro) && sheet.warning === 'Save as my song' && /\/beats\/[a-z0-9-]+#mix=/.test(sheet.link) && /without your changes/.test(sheet.note) && skipped,
    JSON.stringify(sheet),
  );

  // a different beat is asked for while the changes are unsaved: the site asks first
  const elsewhere = h.app.songs.find((song) => song !== beat && !song.broken);
  document.querySelector(`.beat[data-id="${CSS.escape(elsewhere.id)}"] .beat__main`).click();
  await sleep(200);
  const asked = document.getElementById('unsaved-dialog').open;
  document.getElementById('unsaved-cancel').click();
  await sleep(100);
  check('leaving unsaved changes asks first, and Cancel stays put', asked && !document.getElementById('unsaved-dialog').open && A.song === beat && A.edited);

  // revert throws them away
  document.getElementById('revert').click();
  check('Revert goes back to the saved version', (await until(() => A.ready && !A.code.includes('EDITED:') && !A.edited, 15000)) && !shownNow('unsaved') && view.dom.querySelectorAll('.cm-line.hb-changed').length === 0);
  await until(() => A.started, 15000);

  // save as a new song of my own; the beat itself is untouched
  if (!A.stage.editing) document.getElementById('edit').click();
  view.dispatch({ changes: { from: view.state.doc.length, insert: '\nEDITED: s("hh*4").gain(0.15)\n' }, userEvent: 'input.type' });
  document.getElementById('update').click();
  await until(() => !A.dirty && A.edited, 8000);
  document.getElementById('save-new').click();
  await sleep(300);
  const mine = h.songs.list();
  check('"Save as my song" keeps the changes as a new song of mine', A.own && !A.edited && mine.length === 1 && mine[0].code.includes('EDITED:') && !beat.code.includes('EDITED:') && !shownNow('unsaved'), mine[0]?.title);
  check('and the copy remembers the beat it came from', mine[0].from?.title === beat.title && mine[0].from?.beat === beat.slug && /^from /.test(document.querySelector(`.beat[data-id="${CSS.escape(mine[0].id)}"] .beat__meta`)?.textContent.split(' · ').find((part) => part.startsWith('from ')) || ''), JSON.stringify(mine[0].from));

  // one of my songs, from the list: one Share item, and here (no accounts) the sheet says what sharing needs
  h.crate.open('A');
  document.querySelector(`.beat[data-id="${CSS.escape(mine[0].id)}"] .beat__tool`).click();
  const menuShare = document.querySelector('.beat__menu [data-action="share"]');
  const menuItems = [...document.querySelectorAll('.beat__menu [data-action]')].map((button) => button.dataset.action).join();
  menuShare.click();
  const ownSheet = { open: document.getElementById('share-sheet').open, toggle: !document.getElementById('share-toggle-row').hidden, note: document.getElementById('share-note').textContent };
  document.getElementById('share-close').click();
  h.crate.dialog.close();
  check('a song of my own is shared from one Share item; without accounts the sheet says so', menuItems === 'duplicate,share,delete' && ownSheet.open && !ownSheet.toggle && /needs accounts/.test(ownSheet.note), JSON.stringify({ menuItems, ...ownSheet }));
  // without accounts there is no community shelf: nothing to offer a song to, nothing listed
  check('without accounts, no community shelf to offer to or list', document.getElementById('share-feature-row').hidden && document.getElementById('community-section').hidden);
  await sleep(400);
  const ticked = Object.keys(JSON.parse(localStorage.getItem('hacking-the-beats:v1')).onboarding?.done || {});
  check('each first step ticks itself off when it is done, and is remembered', ['play', 'knob', 'mute', 'tweak', 'save'].every((step) => ticked.includes(step) && document.querySelector(`.coach__step[data-step="${step}"]`)?.classList.contains('is-done')), ticked.join(' '));

  // my own song: Save overwrites it, Save as new makes another
  view.dispatch({ changes: { from: view.state.doc.length, insert: '// a second thought\n' }, userEvent: 'input.type' });
  await sleep(100);
  const ownCues = { save: shownNow('save'), saveNew: document.getElementById('save-new').textContent, stored: h.songs.list()[0].code.includes('second thought') };
  document.getElementById('save').click();
  await sleep(300);
  check('"Save" writes the changes over my own song, and not before', ownCues.save && ownCues.saveNew === 'Save as new' && !ownCues.stored && h.songs.list().length === 1 && h.songs.list()[0].code.includes('second thought') && !A.edited);
  view.dispatch({ changes: { from: view.state.doc.length, insert: '// a third\n' }, userEvent: 'input.type' });
  await sleep(100);
  const firstTitle = A.song.title;
  document.getElementById('save-new').click();
  await sleep(400);
  const both = h.songs.list();
  check('"Save as new" makes a second song and leaves the first as it was', both.length === 2 && A.song.title !== firstTitle && A.code.includes(`@title ${A.song.title}`) && both.filter((song) => song.code.includes('a third')).length === 1 && !A.edited, both.map((song) => song.title).join(' / '));

  view.dispatch({ changes: { from: 0, insert: 'const oops = (\n' }, userEvent: 'input.type' });
  const ran = await A.update();
  check('a mistake leaves the last version playing', !ran && A.started && Boolean(A.problem));
  const notice = { hint: document.getElementById('notice-hint').textContent, raw: document.getElementById('notice-raw-text').textContent, shown: !document.getElementById('notice-hint').hidden && !document.getElementById('notice-raw').hidden };
  check('the mistake is explained in plain words, with the line it is on', notice.shown && /line \d+/.test(notice.hint) && notice.raw.length > 0, notice.hint);
  view.dispatch({ changes: { from: 0, to: 'const oops = (\n'.length, insert: '' } });
  await A.update();
  if (A.stage.editing) document.getElementById('edit').click();
  check('nothing is left unsaved', !A.edited && !A.stage.editing);

  // second deck, started in time
  const second = h.app.songs.find((song) => song !== A.song && !song.broken && song.trackCount > 0);
  document.querySelector(`.beat[data-id="${CSS.escape(second.id)}"] .beat__deck[data-deck="B"]`).click();
  check('a second beat loads onto deck B without starting', (await until(() => B.ready)) && !B.started && A.started, second.title);
  document.getElementById('play-b').click();
  check('deck B starts', await until(() => B.started, 30000));
  await sleep(700);
  const frac = (x) => ((x % 1) + 1) % 1;
  // what is heard: the clocks' difference, less the fine correction deck B applied to itself
  let error = frac(A.scheduler.now() - B.scheduler.now() - B.nudge);
  if (error > 0.5) error -= 1;
  const ms = Math.abs(error / A.cps) * 1000;
  check('deck B comes in on the bar, at the same tempo', ms < 5 && Math.abs(A.cps - B.cps) < 1e-9, `${ms.toFixed(1)} ms off`);

  h.deck.crossfader.set(1, { silent: false });
  await sleep(250);
  check('the crossfader swaps the decks', h.master.nodes.busA.gain.value < 0.02 && h.master.nodes.busB.gain.value > 0.98);
  h.deck.crossfader.set(0, { silent: false });
  B.stop();

  // record a second and a half
  document.getElementById('record').click();
  if (await until(() => h.recorder.active, 5000)) {
    await sleep(1500);
    const blob = h.finishRecording({ save: false });
    check('recording produces a WAV', blob && blob.type === 'audio/wav' && blob.size > 50000, `${blob?.size} bytes`);
  } else {
    check('recording produces a WAV', false, 'recorder did not start');
  }

  // a video clip: V opens its sheet, and a one-bar clip holds the code and the mix
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true }));
  const clipOpened = document.getElementById('clip').open;
  const clipProblem = document.getElementById('clip-problem');
  const clipNote = { problem: clipProblem.hidden ? '' : clipProblem.textContent, record: document.getElementById('clip-record').disabled };
  document.getElementById('clip-close').click();
  check('V opens the video clip sheet', clipOpened, JSON.stringify(clipNote));
  if (!h.clip.supported) {
    check('a browser that cannot record video is told so', /cannot record video/.test(clipNote.problem) && clipNote.record, clipNote.problem);
  } else {
    const core = await import('./js/clip-core.js');
    const made = await h.clip.record({ bars: 1, format: '9:16', save: false });
    const wanted = core.pickMimeType((type) => MediaRecorder.isTypeSupported(type));
    const size = core.resolutionFor('9:16', wanted);
    let meta = {};
    if (made) {
      const video = document.createElement('video');
      video.muted = true;
      video.src = URL.createObjectURL(made.blob);
      meta = await new Promise((resolve) => {
        video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight });
        video.onerror = () => resolve({ error: video.error?.code });
        setTimeout(() => resolve({ timeout: true }), 15000);
      });
      URL.revokeObjectURL(video.src);
    }
    check(
      'a one-bar video clip records the code and the mix, at the size its type is made at',
      made && made.blob.size > 20000 && made.type === wanted && made.blob.type === wanted && made.width === size.width && made.height === size.height && meta.width === size.width && meta.height === size.height,
      `${made?.type} · ${made?.blob.size} bytes · ${JSON.stringify(meta)}`,
    );
    check('and the clip maker lets go afterwards', !h.clip.active && document.getElementById('clip-hud').hidden && !document.getElementById('clip').open);
    // Esc throws away a clip that is still counting in
    const thrown = h.clip.record({ bars: 4, format: '1:1', save: false });
    const counting = await until(() => h.clip.take?.state === 'counting', 10000);
    const hudShown = !document.getElementById('clip-hud').hidden;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const outcome = await Promise.race([thrown, sleep(3000).then(() => 'still recording')]);
    check('Esc cancels a clip that is counting in', counting && hudShown && outcome === null && !h.clip.active && document.getElementById('clip-hud').hidden, String(outcome));
  }

  // New offers a choice of starting points
  const before = h.songs.list().length;
  h.crate.open('A');
  document.getElementById('song-new').click();
  const offered = [...document.querySelectorAll('#starters .starter')].map((button) => button.dataset.starter);
  document.querySelector('.starter[data-starter="loop"]').click();
  const started = await until(() => A.own && A.ready && h.songs.list().length === before + 1, 15000);
  check('New offers starting points, and the drum loop is a song of my own to edit', started && offered.join() === 'loop,full' && A.mixer.tracks.length === 1 && A.stage.editing && !h.crate.dialog.open, offered.join());
  if (A.stage.editing) document.getElementById('edit').click();

  h.songMap.setOpen(true);
  document.getElementById('gallery').click();
  await sleep(200);
  check('gallery hides the controls', document.body.classList.contains('is-gallery') && getComputedStyle(document.getElementById('deck')).display === 'none');
  check('and the song map', getComputedStyle(document.getElementById('map')).display === 'none');
  document.getElementById('hud-exit').click();
  h.songMap.setOpen(false);

  A.stop();
  check('stop stops', await until(() => !A.started, 3000));
  return results;
}

// Analytics is on unless the visitor opts out. (A made-up id, and Google is never reached.)
async function counting(browser) {
  const results = [];
  const check = (name, passed, detail = '') => results.push([name, Boolean(passed), String(detail)]);
  const visit = async ({ signal = false } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript((gpc) => {
      window.HTB_CONFIG = { firebase: null, analytics: 'G-TEST' };
      if (gpc) Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true });
    }, signal);
    await context.route(/googletagmanager\.com/, (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));
    const page = await context.newPage();
    await page.goto(`${URL}about`);
    return { context, page };
  };
  const state = (page) =>
    page.evaluate(() => ({
      tag: document.querySelectorAll('script[src*="googletagmanager.com/gtag/js?id=G-TEST"]').length,
      off: window['ga-disable-G-TEST'] === true,
      notice: document.querySelector('.consent')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      answer: localStorage.getItem('hacking-the-beats:analytics'),
    }));

  const { context, page } = await visit();
  await page.waitForSelector('.consent');
  const first = await state(page);
  check('analytics runs by default, and a first visit says so', first.tag === 1 && !first.off && /Opt out/.test(first.notice) && first.answer === null, first.notice);

  await page.evaluate(() => (document.cookie = '_ga=GA1.1.1.1; path=/'));
  await page.click('.consent [data-answer="no"]');
  const out = await state(page);
  const cookieGone = await page.evaluate(() => !document.cookie.includes('_ga='));
  check('opting out stops it and removes its cookies', out.off && out.notice === null && out.answer === 'no' && cookieGone);

  await page.reload();
  await page.waitForFunction(() => document.getElementById('version')?.textContent);
  const later = await state(page);
  check('and it stays off on the next visit, with no notice', later.tag === 0 && later.notice === null);

  await page.goto(`${URL}privacy`);
  await page.click('#analytics-choice');
  const again = await state(page);
  await page.click('.consent [data-answer="yes"]');
  const back = await state(page);
  check('the privacy page can turn it back on', /is off for you/.test(again.notice) && back.tag === 1 && !back.off && back.answer === 'yes', again.notice);
  await context.close();

  const quiet = await visit({ signal: true });
  await quiet.page.waitForFunction(() => document.getElementById('version')?.textContent);
  const signalled = await state(quiet.page);
  check('a browser that sends Global Privacy Control is not counted, or asked', signalled.tag === 0 && signalled.notice === null);
  await quiet.context.close();
  return results;
}

// Every page has an address, a title and a description of its own.
async function addresses(browser) {
  const results = [];
  const check = (name, passed, detail = '') => results.push([name, Boolean(passed), String(detail)]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  // these tests never touch the real accounts project
  await context.addInitScript(() => (window.HTB_CONFIG = { firebase: null, analytics: null }));
  const page = await context.newPage();
  const ready = () => page.waitForFunction(() => window.hackingTheBeats?.players.A.ready, null, { timeout: 45000 });
  const head = () => page.evaluate(() => ({ title: document.title, description: document.querySelector('meta[name="description"]').content, path: location.pathname, song: window.hackingTheBeats?.players.A.song?.slug }));

  await page.goto(URL);
  await ready();
  const home = await head();
  check('the home page has its own title and address', home.title.startsWith('Hack The Beats —') && home.path === '/', home.title);

  const target = await page.evaluate(() => {
    const h = window.hackingTheBeats;
    const song = h.app.songs.find((entry) => entry.id !== h.players.A.song.id && !entry.broken && entry.by);
    document.querySelector(`.beat[data-id="${CSS.escape(song.id)}"] .beat__deck[data-deck="A"]`).click();
    return { slug: song.slug, title: song.title, by: song.by };
  });
  await page.waitForFunction((slug) => location.pathname === `/beats/${slug}`, target.slug, { timeout: 15000 });
  await ready();
  const chosen = await head();
  check("choosing a beat gives the page that beat's address, title and description", chosen.title === `${target.title} by ${target.by} — Hack The Beats` && chosen.description.startsWith(`${target.title} by ${target.by}:`), `${chosen.path} · ${chosen.title}`);

  await page.goBack();
  await page.waitForFunction(() => location.pathname === '/');
  const back = await head();
  await page.goForward();
  await page.waitForFunction((slug) => location.pathname === `/beats/${slug}`, target.slug);
  const forward = await head();
  check('back and forward move between them', back.title === home.title && forward.title === chosen.title, `${back.title} ⇄ ${forward.title}`);

  await page.goto(`${URL}beats/${target.slug}`);
  await ready();
  const direct = await head();
  check("a beat's address opens that beat", direct.song === target.slug && direct.title === chosen.title && direct.path === `/beats/${target.slug}`, direct.song);

  // an address with no beat is served by the player, which sends the visitor home and
  // keeps the address out of search results
  await page.goto(`${URL}beats/no-such-beat`);
  await ready();
  const fallback = await head();
  check('an address with no beat goes home', fallback.path === '/' && fallback.title === home.title && (await page.evaluate(() => document.querySelector('meta[name="robots"]')?.content === 'noindex')), fallback.path);

  await page.goto(`${URL}about`);
  const about = { title: await page.title(), beats: await page.locator('.beats a').count(), h1: await page.locator('h1').textContent() };
  await page.goto(`${URL}privacy`);
  const privacy = await page.title();
  check('About and Privacy are pages of their own', about.title.startsWith('About Hack The Beats') && about.h1 === 'About' && privacy.startsWith('Privacy'), `${about.title} · ${privacy}`);
  await page.goto(`${URL}learn/remix`);
  const learn = { title: await page.title(), h1: await page.locator('h1').textContent(), description: await page.evaluate(() => document.querySelector('meta[name="description"]').content) };
  check('the guide\'s pages are pages of their own, each with its title and description', learn.title === 'Remix — Learn — Hack The Beats' && learn.h1 === 'Remix' && learn.description.length > 40, learn.title);

  if (built) {
    // what a crawler that runs no scripts is given
    const text = (path) => fetch(`${URL}${path}`).then((response) => response.text());
    const html = await text(`beats/${target.slug}`);
    const homeHtml = await text('');
    // a site that has been told its address (appOrigin in config.site.json) also says where
    // each page lives and lists them in a sitemap
    const sitemap = await fetch(`${URL}sitemap.xml`).then((response) => (response.ok ? response.text() : null));
    check(
      "a beat's page says what it is before any script runs",
      html.includes(`<title>${target.title} by ${target.by} — Hack The Beats</title>`) && /<pre class="prerender" id="prerender">[^<]*setcp/.test(html) && html.includes('og:title'),
    );
    if (sitemap) check('and where it lives', /<link rel="canonical" href="https:\/\/[^"]+\/beats\//.test(html) && html.includes('application/ld+json'));
    check(
      `every beat is linked from the home page${sitemap ? ', the About page and the sitemap' : ' and the About page'}`,
      about.beats > 0 && homeHtml.split('<a href="beats/').length - 1 === about.beats && (!sitemap || sitemap.split('/beats/').length - 1 === about.beats),
      `${about.beats} beats`,
    );
  }
  await context.close();
  return results;
}

// A built-in beat shared as a mix: its own page's address, with the deck's settings, switches too.
async function sharing(browser) {
  const results = [];
  const check = (name, passed, detail = '') => results.push([name, Boolean(passed), String(detail)]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => (window.HTB_CONFIG = { firebase: null, analytics: null }));
  const page = await context.newPage();
  await page.goto(URL);
  await page.waitForFunction(() => window.hackingTheBeats?.players.A.ready, null, { timeout: 45000 });
  const shared = await page.evaluate(async () => {
    const h = window.hackingTheBeats;
    const A = h.players.A;
    // a beat with a switch (Low Tide's "mood")
    const song = h.app.songs.find((entry) => entry.code?.includes('const mood'));
    if (A.song !== song) document.querySelector(`.beat[data-id="${CSS.escape(song.id)}"] .beat__deck[data-deck="A"]`).click();
    for (let i = 0; i < 200 && !(A.song === song && A.ready); i++) await new Promise((r) => setTimeout(r, 50));
    A.setSwitch(0, 1);
    await new Promise((r) => setTimeout(r, 600));
    document.getElementById('share').click();
    return { link: document.getElementById('share-link').value, slug: song.slug, recipient: document.getElementById('share-recipient').textContent };
  });
  const address = new globalThis.URL(shared.link);
  check("a beat's link is its own page's address, carrying the deck's settings", address.pathname === `/beats/${shared.slug}` && address.hash.startsWith('#mix=') && /no account needed/.test(shared.recipient), shared.link);
  const fresh = await context.newPage();
  await fresh.goto(shared.link);
  await fresh.waitForFunction(() => window.hackingTheBeats?.players.A.ready, null, { timeout: 45000 });
  const opened = await fresh.evaluate(() => ({ value: window.hackingTheBeats.players.A.switches[0]?.value, code: /const mood = 1/.test(window.hackingTheBeats.players.A.code) }));
  check('opening it brings the switches back as they were', opened.value === 1 && opened.code, JSON.stringify(opened));
  await context.close();
  return results;
}

// The guide and the player: an example opened from the guide, the help sheet's way into
// the guide, Learn pages over the player, and "Learn more" beside the controls.
async function learning(browser) {
  const results = [];
  const check = (name, passed, detail = '') => results.push([name, Boolean(passed), String(detail)]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => (window.HTB_CONFIG = { firebase: null, analytics: null }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && !/Failed to load resource/.test(message.text()) && errors.push(message.text()));
  const ready = () => page.waitForFunction(() => window.hackingTheBeats?.players.A.ready, null, { timeout: 45000 });
  const shown = (selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return Boolean(el) && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  }, selector);
  // the Learn pages are built (tools/learn.mjs); until one exists, the lightbox is not asked to show it
  const learnPage = (name) => fetch(`${URL}learn/${name}`).then((response) => response.ok && Boolean(response.headers.get('content-type')?.includes('text/html'))).catch(() => false);
  const learnBuilt = await learnPage('start');
  const performBuilt = await learnPage('perform');
  const skipped = 'learn pages not built yet';

  await page.goto(`${URL}#start=techno`);
  await ready();
  const example = await page.evaluate(() => {
    const A = window.hackingTheBeats.players.A;
    return { source: A.song?.source, title: A.song?.title, hash: location.hash, path: location.pathname, curtain: document.getElementById('curtain-title').textContent };
  });
  check('#start=<example> opens an example from the guide on deck A, behind the curtain', example.source === 'example' && example.title === 'Ballast' && example.hash === '' && example.path === '/' && example.curtain === 'Ballast', JSON.stringify(example));
  await page.click('#curtain-play');
  await page.waitForFunction(() => window.hackingTheBeats.players.A.started, null, { timeout: 45000 });
  await page.waitForTimeout(300);
  check('it plays, and Save a copy is offered', (await page.evaluate(() => window.hackingTheBeats.players.A.started)) && (await shown('#save-copy')));
  await page.click('#edit');
  check('and its code can be edited', await page.evaluate(() => window.hackingTheBeats.players.A.stage.editing));
  await page.click('#edit');

  // the help sheet: the guide in a new tab, or a place to start in the lightbox
  await page.keyboard.press('?');
  const help = await page.evaluate(() => ({ open: document.getElementById('about').open, target: document.querySelector('#about .help__guide .pillbtn')?.getAttribute('target') }));
  check('? opens the help sheet, whose guide button opens a new tab', help.open && help.target === '_blank', JSON.stringify(help));
  // (until the pages are built, the lightbox hands the page to a tab of its own)
  const fallback = learnBuilt ? null : context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
  await page.click('#about a[href="learn/start#listener"]');
  await page.waitForTimeout(600);
  if (fallback) await fallback.then((tab) => tab?.close());
  const started = await page.evaluate(() => ({ help: document.getElementById('about').open, sheet: document.getElementById('page-sheet').open, toc: Boolean(document.querySelector('#page-sheet .readpage__toc')), content: document.querySelector('#page-sheet .sheet__body').classList.contains('learn-content') }));
  check('a place to start closes the help sheet', !started.help, JSON.stringify(started));
  const inView = (id) =>
    page.evaluate((el) => {
      const target = document.getElementById(el);
      const body = document.querySelector('#page-sheet .sheet__body').getBoundingClientRect();
      if (!target) return false;
      const box = target.getBoundingClientRect();
      return box.top >= body.top - 2 && box.top < body.bottom;
    }, id);
  if (learnBuilt) {
    check('and opens that part of the guide over the player, with its sections listed', started.sheet && started.toc && started.content && (await inView('page-listener')), JSON.stringify(started));
    await page.evaluate(() => document.getElementById('page-sheet').close());
  } else {
    check('and opens that part of the guide over the player (skipped)', true, skipped);
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close()));
  }
  // a "Learn more" beside a control opens the part of the guide about it
  if (performBuilt) {
    await page.click('#split');
    await page.click('#empty-b .learnlink');
    await page.waitForTimeout(600);
    check('"Learn more" beside a control opens the part of the guide about it', (await page.evaluate(() => document.getElementById('page-sheet').open)) && (await inView('page-two-decks')));
    await page.evaluate(() => document.getElementById('page-sheet').close());
    await page.click('#split');
  } else {
    check('"Learn more" beside a control opens the part of the guide about it (skipped)', true, skipped);
  }

  // a modifier-click is the browser's: a new tab, and no lightbox
  await page.keyboard.press('?');
  const popup = context.waitForEvent('page', { timeout: 2000 }).catch(() => null);
  await page.click('#about a[href="learn/start#dj"]', { modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  const opened = await popup;
  await page.waitForTimeout(300);
  check('a modifier-click on a guide link is left to the browser', !(await page.evaluate(() => document.getElementById('page-sheet').open)), opened ? 'new tab' : 'no new tab');
  if (opened) await opened.close();
  await page.evaluate(() => document.getElementById('about').close());

  // signed out, an example still plays; changing it asks for an account
  await page.evaluate(() => window.hackingTheBeats.setAccess('preview'));
  await page.evaluate(() => window.hackingTheBeats.openExample('house'));
  await page.waitForFunction(() => window.hackingTheBeats.players.A.song?.title === 'Paper Street' && window.hackingTheBeats.players.A.ready, null, { timeout: 45000 });
  await page.click('#edit');
  const preview = await page.evaluate(() => ({ title: window.hackingTheBeats.players.A.song?.title, account: document.getElementById('account-dialog').open, editing: window.hackingTheBeats.players.A.stage.editing }));
  check('signed out, an example still opens and plays; Edit asks for an account', preview.title === 'Paper Street' && preview.account && !preview.editing, JSON.stringify(preview));
  await page.evaluate(() => document.getElementById('account-dialog').close());
  await page.evaluate(() => window.hackingTheBeats.setAccess('full'));

  check('no errors in the console while learning', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
  return results;
}

// A phone: a touch screen, a narrow window, no keyboard shortcuts to lean on.
// The Learn guide: its pages, the contents, the search and the term drawer, on a desktop and
// on a phone.
async function guide(browser) {
  const results = [];
  const check = (name, passed, detail = '') => results.push([name, Boolean(passed), String(detail)]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => (window.HTB_CONFIG = { firebase: null, analytics: null }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && !/Failed to load resource/.test(message.text()) && errors.push(message.text()));

  await page.goto(`${URL}learn`);
  const landing = await page.evaluate(() => ({
    title: document.title,
    h1: document.querySelector('h1')?.textContent,
    paths: document.querySelectorAll('.path').length,
    nav: document.querySelectorAll('.learnnav__group ol > li').length,
    areas: document.querySelectorAll('.area').length,
  }));
  check('the guide has a landing page with four ways in and every area listed', landing.title.startsWith('Learn —') && landing.paths === 4 && landing.nav >= 8 && landing.areas === landing.nav, JSON.stringify(landing));

  await page.goto(`${URL}learn/perform`);
  const area = await page.evaluate(() => ({
    title: document.title,
    current: document.querySelector('.learnnav [aria-current="page"]')?.textContent,
    h2: document.querySelectorAll('.learn__body h2[id]').length,
    sections: document.querySelectorAll('.learnnav__sections a').length,
    shots: [...document.querySelectorAll('.shot img')].map((img) => img.getAttribute('src')),
    pager: [...document.querySelectorAll('.pager a')].map((link) => link.getAttribute('href')),
    terms: document.querySelectorAll('a.term').length,
    code: document.querySelectorAll('.code .tok-label').length,
  }));
  check(
    'an area page lists its sections in the contents, and has pictures, terms, code and a pager',
    area.title.startsWith('Perform — Learn') && area.current === 'Perform' && area.h2 > 3 && area.sections === area.h2 && area.shots.length > 0 && area.pager.length === 2 && area.terms > 0 && area.code > 0,
    JSON.stringify({ ...area, shots: area.shots.length }),
  );
  const fetched = await page.evaluate(async (urls) => {
    const out = [];
    for (const url of urls) out.push([url, (await fetch(url)).status]);
    return out;
  }, [...area.shots, ...area.pager]);
  check('every picture and link on it answers', fetched.every(([, status]) => status === 200), fetched.filter(([, status]) => status !== 200).map(([url]) => url).join(' '));

  // the contents follow the reading
  await page.evaluate(() => [...document.querySelectorAll('.learn__body h2[id]')].at(-1).scrollIntoView({ behavior: 'instant' }));
  await page.waitForTimeout(600);
  const followed = await page.evaluate(() => ({ active: document.querySelector('.learnnav__sections a.is-active')?.getAttribute('href'), last: '#' + [...document.querySelectorAll('.learn__body h2[id]')].at(-1).id }));
  check('the contents mark the section being read', followed.active === followed.last, JSON.stringify(followed));

  // search: typed, chosen with the keyboard, and reached with /
  await page.click('#q');
  await page.type('#q', 'snapshot');
  const listed = await page.waitForSelector('#search-panel:not([hidden]) .search__result', { timeout: 8000 }).then(() => true, () => false);
  const found = await page.evaluate(() => [...document.querySelectorAll('.search__result .search__title')].map((el) => el.textContent.trim()));
  check('typing in the search box lists snapshots', listed && found.some((title) => /snapshot/i.test(title)), found.slice(0, 3).join(' | '));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const landed = await page.evaluate(() => ({ where: location.pathname + location.hash, panel: document.getElementById('search-panel').hidden }));
  check('choosing a result with the keyboard goes there', /snapshot/.test(landed.where) && landed.panel, JSON.stringify(landed));
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('/');
  check('/ puts the caret in the search box', await page.evaluate(() => document.activeElement?.id === 'q'));
  await page.keyboard.press('Escape');

  // the term drawer
  await page.goto(`${URL}learn/perform`);
  await page.click('a.term');
  const opened = await page.waitForSelector('#termdrawer[open]', { timeout: 8000 }).then(() => true, () => false);
  const drawer = await page.evaluate(() => {
    const el = document.getElementById('termdrawer');
    return { open: el.open, title: el.querySelector('.termdrawer__title').textContent.trim(), words: el.querySelector('.termdrawer__body').textContent.trim().length, more: el.querySelector('[data-act="more"]').getAttribute('href'), modal: el.hasAttribute('data-modal'), focus: document.activeElement?.className };
  });
  check('a dotted term opens the drawer beside the text, with its definition and a way to the full section', opened && drawer.open && drawer.title && drawer.words > 20 && /\/learn\//.test(drawer.more) && !drawer.modal && /termdrawer__title/.test(drawer.focus), JSON.stringify(drawer));
  await page.keyboard.press('Escape');
  check('Esc closes the drawer and hands focus back to the term', await page.evaluate(() => !document.getElementById('termdrawer').open && document.activeElement?.classList.contains('term')));
  // "Read the full section" on a term whose section is on this page
  const sameTerm = await page.evaluate(() => {
    const here = location.pathname;
    return [...document.querySelectorAll('a.term')].find((term) => term.dataset.term === 'snapshot' || term.dataset.term === 'pad')?.dataset.term ?? null;
  });
  if (sameTerm) {
    await page.click(`a.term[data-term="${sameTerm}"]`);
    await page.waitForSelector('#termdrawer[open]', { timeout: 8000 });
    await page.click('#termdrawer [data-act="more"]');
    await page.waitForTimeout(500);
    const jumped = await page.evaluate(() => ({ open: document.getElementById('termdrawer').open, hash: location.hash, focused: document.activeElement?.tagName }));
    check('"Read the full section" closes the drawer and goes to the section', !jumped.open && jumped.hash.length > 1 && /^H[23]$/.test(jumped.focused), JSON.stringify(jumped));
  }
  check('no errors in the console on the guide', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();

  // a phone: the contents behind a button, the drawer as a sheet from the bottom, the search behind a button
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  await phoneContext.addInitScript(() => (window.HTB_CONFIG = { firebase: null, analytics: null }));
  const phone = await phoneContext.newPage();
  await phone.goto(`${URL}learn/perform`);
  check('on a phone the contents are behind a button', await phone.evaluate(() => getComputedStyle(document.getElementById('contents')).display === 'none' && getComputedStyle(document.getElementById('contents-open')).display !== 'none'));
  await phone.tap('#contents-open');
  const sheet = await phone.evaluate(() => ({ open: document.getElementById('contents-sheet').open, links: document.querySelectorAll('#contents-sheet .learnnav__sections a').length }));
  await phone.locator('#contents-sheet .learnnav__sections a').last().tap();
  await phone.waitForTimeout(400);
  const chose = await phone.evaluate(() => ({ open: document.getElementById('contents-sheet').open, hash: location.hash }));
  check('the button opens them, and choosing a section closes them and goes there', sheet.open && sheet.links > 0 && !chose.open && chose.hash.length > 1, JSON.stringify({ sheet, chose }));
  await phone.locator('a.term').first().tap();
  const phoneDrawer = await phone.waitForSelector('#termdrawer[open]', { timeout: 8000 }).then(() => true, () => false);
  const bottom = await phone.evaluate(() => {
    const el = document.getElementById('termdrawer');
    return { modal: el.hasAttribute('data-modal'), top: Math.round(el.getBoundingClientRect().top), bottom: Math.round(el.getBoundingClientRect().bottom), height: window.innerHeight };
  });
  check('a term opens as a sheet from the bottom of the screen', phoneDrawer && bottom.modal && Math.abs(bottom.bottom - bottom.height) <= 12 && bottom.top > bottom.height / 4, JSON.stringify(bottom));
  await phone.evaluate(() => document.getElementById('termdrawer').close());
  await phone.tap('#search-open');
  check('the search opens from its button and takes the bar', await phone.evaluate(() => document.body.classList.contains('is-searching') && getComputedStyle(document.getElementById('q')).display !== 'none'));
  await phoneContext.close();
  return results;
}

async function phone(browser) {
  const results = [];
  const check = (name, passed, detail = '') => results.push([name, Boolean(passed), String(detail)]);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  await context.addInitScript(() => (window.HTB_CONFIG = { firebase: null, analytics: null }));
  const page = await context.newPage();
  await page.goto(URL);
  await page.waitForFunction(() => window.hackingTheBeats?.players.A.ready, null, { timeout: 45000 });
  const shown = (id) => page.evaluate((el) => getComputedStyle(document.getElementById(el)).display !== 'none', id);
  check('on a phone, the song list has a button of its own', await shown('open-list'));
  await page.tap('#open-about');
  check('and the help sheet opens on a tap', await page.evaluate(() => document.getElementById('about').open));
  await page.evaluate(() => document.getElementById('about').close());
  await page.tap('#open-list');
  check('and it opens the list', await page.evaluate(() => window.hackingTheBeats.crate.dialog.open));
  await page.evaluate(() => window.hackingTheBeats.crate.dialog.close());
  await page.tap('#curtain-play');
  await page.waitForFunction(() => window.hackingTheBeats.players.A.started, null, { timeout: 45000 });
  await page.waitForTimeout(500);
  const tapped = await page.evaluate(() => {
    const A = window.hackingTheBeats.players.A;
    const line = [...document.querySelectorAll('#pane-a .cm-line')].find((el) => !el.querySelector('.hb-label, .hb-num'));
    line.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    return { editing: A.stage.editing, status: document.getElementById('status').textContent };
  });
  check('a tap on the code is not taken for editing; Edit is', !tapped.editing && /press Edit/.test(tapped.status), tapped.status);
  await page.tap('#edit');
  check('pressing Edit opens the code for typing', await page.evaluate(() => window.hackingTheBeats.players.A.stage.editing));
  await page.tap('#edit');
  const clear = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const coach = document.getElementById('coach');
    if (coach.hidden) return { open: false };
    const a = box(coach);
    const b = box(document.querySelector('.stagebar'));
    return { open: true, overlap: a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right };
  });
  check('first steps sit clear of the view buttons', clear.open && !clear.overlap, JSON.stringify(clear));
  await page.tap('#map-toggle');
  const mapOpened = await page.evaluate(() => getComputedStyle(document.getElementById('map')).display !== 'none' && document.querySelectorAll('#map .map__item--part').length > 0);
  await page.locator('#map .map__item--part').last().tap();
  await page.waitForTimeout(1400);
  const jumped = await page.evaluate(() => {
    // where the editor has the part's first line, against what is scrolled into view
    const { view } = window.hackingTheBeats.players.A.stage;
    const block = view.lineBlockAt(window.hackingTheBeats.players.A.stage.state.tracks.at(-1).from);
    const top = block.top + view.contentDOM.offsetTop - view.scrollDOM.scrollTop;
    return { closed: getComputedStyle(document.getElementById('map')).display === 'none', inView: top >= 0 && top + block.height <= view.scrollDOM.clientHeight };
  });
  check('on a phone, Map opens the song map; choosing a part jumps there and puts the map away', mapOpened && jumped.closed && jumped.inView, JSON.stringify({ mapOpened, ...jumped }));
  await context.close();
  return results;
}

let failures = 0;
await waitForServer();
for (const name of engines) {
  const engine = playwright[name];
  if (!engine) {
    console.log(`\n${name}: unknown engine`);
    failures++;
    continue;
  }
  console.log(`\n${name}`);
  let browser;
  try {
    // Chromium renders to a silent, virtual output, so its run makes no noise and does not
    // depend on the machine's sound device. Firefox and WebKit have no such switch: they
    // play out loud and need a working output.
    const options = {
      chromium: { args: ['--disable-audio-output'] },
      firefox: { firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } },
    };
    browser = await engine.launch(options[name] || {});
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    // these tests never touch the real accounts project
    await context.addInitScript(() => (window.HTB_CONFIG = { firebase: null, analytics: null }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => message.type() === 'error' && !/Failed to load resource/.test(message.text()) && errors.push(message.text()));

    await page.goto(URL);
    await page.waitForFunction(() => window.hackingTheBeats?.players.A.ready || window.hackingTheBeats?.players.A.failure, null, { timeout: 45000 });
    // before anything plays: the code can already be changed, and the view buttons wait
    const firstScreen = await page.evaluate(() => {
      const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
      return { edit: shown('edit'), follow: shown('follow'), deck: shown('deck'), steps: shown('coach'), tries: shown('tries') };
    });
    const preResults = [
      ['Edit is offered before the first play; the view buttons wait for the music', firstScreen.edit && !firstScreen.follow, JSON.stringify(firstScreen)],
      ['first steps and suggestions wait for the music', !firstScreen.steps && !firstScreen.tries],
    ];
    // the top bar's icon buttons say what they are when the pointer rests on them
    const tips = [];
    for (const id of ['record', 'share', 'open-about']) {
      await page.hover(`#${id}`);
      tips.push(await page.evaluate((el) => getComputedStyle(document.getElementById(el), '::before').content, id));
    }
    await page.mouse.move(700, 450);
    preResults.push(['the song map waits for the music', await page.evaluate(() => getComputedStyle(document.getElementById('map')).display === 'none' && getComputedStyle(document.getElementById('map-toggle')).display === 'none')]);
    preResults.push(['the top bar\'s icon buttons say what they are on hover', tips.join() === '"Record the mix to a file (R)","Share this song","Help and shortcuts (?)"', tips.join(' | ')]);
    await page.click('#curtain-play');
    await page.waitForFunction(() => window.hackingTheBeats.players.A.started, null, { timeout: 45000 });
    await page.waitForTimeout(1500);

    const results = [...preResults, ...(await page.evaluate(scenario))];
    // a wide window: the song map sits in the margin beside the code, with no button
    await page.setViewportSize({ width: 1720, height: 1000 });
    await page.waitForTimeout(400);
    const docked = await page.evaluate(() => {
      const scroller = window.hackingTheBeats.players.A.stage.view.scrollDOM;
      const code = scroller.getBoundingClientRect().left + parseFloat(getComputedStyle(scroller).paddingLeft);
      const map = document.getElementById('map');
      return { docked: document.body.classList.contains('map-docked'), shown: getComputedStyle(map).display !== 'none', button: !document.getElementById('map-toggle').hidden, clear: map.getBoundingClientRect().right <= code };
    });
    results.push(['in a wide window the song map sits beside the code, clear of it', docked.docked && docked.shown && !docked.button && docked.clear, JSON.stringify(docked)]);
    results.push(['no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | ')]);
    results.push(...(await addresses(browser)));
    results.push(...(await sharing(browser)));
    results.push(...(await learning(browser)));
    results.push(...(await guide(browser)));
    // Firefox has no mobile mode in Playwright
    if (name !== 'firefox') results.push(...(await phone(browser)));
    results.push(...(await counting(browser)));
    for (const [step, passed, detail] of results) {
      console.log(`  ${passed ? '✓' : '✗'} ${step}${detail ? `  (${detail})` : ''}`);
      if (!passed) failures++;
    }
  } catch (error) {
    console.log(`  ✗ ${error.message.split('\n')[0]}`);
    failures++;
  } finally {
    await browser?.close();
  }
}

stopServer();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
