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
const PORT = 5199;
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

  // sharing an edited beat: the sheet says the changes are not in the link, and offers to keep them
  document.getElementById('share').click();
  const sheet = { open: document.getElementById('share-sheet').open, warning: !document.getElementById('share-warning').hidden && document.getElementById('share-warning-go').textContent, link: document.getElementById('share-link').value };
  document.getElementById('share-warning-skip').click();
  const skipped = document.getElementById('share-warning').hidden;
  document.getElementById('share-close').click();
  check('sharing an edited beat warns that the changes are not in the link', sheet.open && sheet.warning === 'Save as my song and share' && /\/beats\/[a-z0-9-]+#mix=/.test(sheet.link) && skipped, JSON.stringify(sheet));

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

  // New offers a choice of starting points
  const before = h.songs.list().length;
  h.crate.open('A');
  document.getElementById('song-new').click();
  const offered = [...document.querySelectorAll('#starters .starter')].map((button) => button.dataset.starter);
  document.querySelector('.starter[data-starter="loop"]').click();
  const started = await until(() => A.own && A.ready && h.songs.list().length === before + 1, 15000);
  check('New offers starting points, and the drum loop is a song of my own to edit', started && offered.join() === 'loop,full' && A.mixer.tracks.length === 1 && A.stage.editing && !h.crate.dialog.open, offered.join());
  if (A.stage.editing) document.getElementById('edit').click();

  document.getElementById('gallery').click();
  await sleep(200);
  check('gallery hides the controls', document.body.classList.contains('is-gallery') && getComputedStyle(document.getElementById('deck')).display === 'none');
  document.getElementById('hud-exit').click();

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
  check('the home page has its own title and address', home.title.startsWith('Hacking the Beats —') && home.path === '/', home.title);

  const target = await page.evaluate(() => {
    const h = window.hackingTheBeats;
    const song = h.app.songs.find((entry) => entry.id !== h.players.A.song.id && !entry.broken && entry.by);
    document.querySelector(`.beat[data-id="${CSS.escape(song.id)}"] .beat__deck[data-deck="A"]`).click();
    return { slug: song.slug, title: song.title, by: song.by };
  });
  await page.waitForFunction((slug) => location.pathname === `/beats/${slug}`, target.slug, { timeout: 15000 });
  await ready();
  const chosen = await head();
  check("choosing a beat gives the page that beat's address, title and description", chosen.title === `${target.title} by ${target.by} — Hacking the Beats` && chosen.description.startsWith(`${target.title} by ${target.by}:`), `${chosen.path} · ${chosen.title}`);

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
  check('About and Privacy are pages of their own', about.title.startsWith('About Hacking the Beats') && about.h1 === 'About' && privacy.startsWith('Privacy'), `${about.title} · ${privacy}`);

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
      html.includes(`<title>${target.title} by ${target.by} — Hacking the Beats</title>`) && /<pre class="prerender" id="prerender">[^<]*setcp/.test(html) && html.includes('og:title'),
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

// A phone: a touch screen, a narrow window, no keyboard shortcuts to lean on.
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
    await page.click('#curtain-play');
    await page.waitForFunction(() => window.hackingTheBeats.players.A.started, null, { timeout: 45000 });
    await page.waitForTimeout(1500);

    const results = [...preResults, ...(await page.evaluate(scenario))];
    results.push(['no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | ')]);
    results.push(...(await addresses(browser)));
    results.push(...(await sharing(browser)));
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
