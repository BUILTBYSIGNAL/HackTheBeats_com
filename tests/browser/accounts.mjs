// Accounts, end to end, against the local Firebase emulators (no real project is touched):
// signing in, songs following the account, sharing by link, the security rules, and the
// link-preview function.
//
//   npm run test:accounts
//
// Needs the Firebase CLI (`npm i -g firebase-tools`), Java for the Firestore emulator, and
// the link-preview function's packages (`npm --prefix functions ci`, once).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5197;
const SITE = `http://localhost:${PORT}/`;
const AUTH = 'http://127.0.0.1:9199';
const FIRESTORE = ['127.0.0.1', 8188];
const CONFIG = {
  firebase: { apiKey: 'demo-key', authDomain: 'demo-htb.firebaseapp.com', projectId: 'demo-htb', appId: 'demo-app' },
  emulators: { auth: AUTH, firestore: FIRESTORE },
  analytics: null,
};
// The same server under its other name is a different origin to a browser, which is all
// the shared-song player needs to be.
const PLAYER = `http://127.0.0.1:${PORT}`;
const SPLIT = { ...CONFIG, appOrigin: `http://localhost:${PORT}`, shareOrigin: PLAYER, linkPreviews: true };
// the link-preview function, as the functions emulator serves it
const FUNCTION = 'http://127.0.0.1:5101/demo-htb/us-central1/sharePage';

// Homebrew's Java is not always on the PATH.
const env = { ...process.env };
if (spawnSync('java', ['-version'], { env }).status !== 0) {
  const brewJava = ['/opt/homebrew/opt/openjdk/bin', '/usr/local/opt/openjdk/bin'].find((dir) => existsSync(dir));
  if (!brewJava) {
    console.error('Java was not found. The Firestore emulator needs it (for example: brew install openjdk).');
    process.exit(1);
  }
  env.PATH = `${brewJava}:${env.PATH}`;
}

const children = [];
const start = (command, args, options = {}) => {
  const child = spawn(command, args, { cwd: root, env, stdio: 'ignore', detached: true, ...options });
  children.push(child);
  return child;
};
const stopAll = () => {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGINT');
    } catch {
      /* already gone */
    }
  }
};
process.on('exit', stopAll);

async function waitFor(url, label, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`${label} did not start`);
}

start(process.execPath, [resolve(root, 'tools/serve.mjs')], { env: { ...env, PORT: String(PORT) } });
if (!existsSync(resolve(root, 'functions/node_modules'))) {
  console.error('The link-preview function has no packages yet: run `npm --prefix functions ci` once.');
  process.exit(1);
}
if (spawnSync(process.execPath, [resolve(root, 'tools/build-functions.mjs')], { cwd: root, stdio: 'inherit' }).status !== 0) process.exit(1);
start('firebase', ['emulators:start', '--only', 'auth,firestore,functions', '--project', 'demo-htb']);
await waitFor(SITE, 'the site');
await waitFor(AUTH, 'the auth emulator');
await waitFor(`http://${FIRESTORE[0]}:${FIRESTORE[1]}/`, 'the Firestore emulator');
await waitFor('http://127.0.0.1:5101/', 'the functions emulator');

const results = [];
const check = (name, passed, detail = '') => {
  results.push([name, Boolean(passed), detail === undefined ? '' : String(detail)]);
};

const browser = await chromium.launch({ args: ['--disable-audio-output'] });
const errors = [];
const arrive = async (page) => {
  await page.waitForFunction(() => window.hackingTheBeats?.players.A.song && window.hackingTheBeats.cloud.ready, null, { timeout: 45000 });
  await page.evaluate(() => window.hackingTheBeats.cloud.ready);
};
async function visitor(url = SITE, config = CONFIG) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript((value) => (window.HTB_CONFIG = value), config);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await arrive(page);
  return page;
}
const settle = (page, ms = 400) => page.waitForTimeout(ms);
// a page that is not expected to load a song (a link that leads nowhere)
async function bare(url, config) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript((value) => (window.HTB_CONFIG = value), config);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.hackingTheBeats?.cloud.ready, null, { timeout: 45000 });
  return page;
}

try {
  /* ---------- without an account: the small player ---------- */
  const one = await visitor();
  check('the account button appears when accounts are configured', await one.evaluate(() => !document.getElementById('account').hidden));
  const shown = (page, id) => page.evaluate((el) => getComputedStyle(document.getElementById(el)).display !== 'none', id);
  const wall = await one.evaluate(() => {
    const h = window.hackingTheBeats;
    return { access: h.app.access, featured: h.players.A.song.featured, ready: h.players.A.ready, inert: getComputedStyle(document.querySelector('#pane-a .cm-content')).pointerEvents };
  });
  // the code can be clicked (labels mute, numbers find their knob) but not typed into
  check('signed out, the site starts as the featured beat and an introduction', wall.access === 'preview' && (await shown(one, 'intro')) && !(await shown(one, 'deck')) && wall.inert === 'auto', JSON.stringify(wall));
  await one.click('#curtain-play');
  await one.waitForFunction(() => window.hackingTheBeats.players.A.started, null, { timeout: 30000 });
  check('the featured beat plays without an account', wall.featured && wall.ready);

  // once it plays, the knobs, channels and pads are theirs; what needs an account stays out of sight
  await settle(one);
  const controls = await one.evaluate(async () => {
    const h = window.hackingTheBeats;
    const A = h.players.A;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const hidden = (id) => getComputedStyle(document.getElementById(id)).display === 'none';
    const out = { hidden: ['chip-b', 'record', 'share', 'midi-button', 'split'].filter(hidden), mixrow: getComputedStyle(document.querySelector('.mixrow')).display === 'none' };
    if (A.sliders.length) {
      h.deck.knobs[0].set(A.sliders[0].min, { silent: false });
      await sleep(400);
      out.kept = JSON.parse(localStorage.getItem('hacking-the-beats:v1') || '{}').songs?.[A.song.id]?.sliders?.[0] === A.sliders[0].value;
    } else out.kept = true;
    const label = document.querySelector('#pane-a .hb-label');
    label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    const index = Number(label.dataset.track);
    out.labelMutes = A.mixer.tracks[index].mute;
    A.mixer.setMute(index, false);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    out.keyMutes = A.mixer.tracks[0].mute;
    A.mixer.setMute(0, false);
    out.unsavedDot = document.getElementById('chip-a').classList.contains('is-unsaved');
    document.getElementById('edit').click();
    out.editAsks = document.getElementById('account-dialog').open && !A.stage.editing;
    document.getElementById('account-dialog').close();
    return out;
  });
  check(
    'signed out, the knobs, channels and pads work once it plays; the rest waits for an account',
    (await shown(one, 'deck')) && controls.hidden.length === 5 && controls.mixrow && controls.kept && controls.labelMutes && controls.keyMutes && !controls.unsavedDot && controls.editAsks,
    JSON.stringify(controls),
  );

  // a suggestion can be tried without an account: nothing is kept, and nothing is said to be unsaved
  const tried = await one.evaluate(async () => {
    const h = window.hackingTheBeats;
    const A = h.players.A;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const chip = () => document.querySelector('#tries .tries__chip');
    if (!chip()) return { none: true };
    const original = A.code;
    chip().click();
    for (let i = 0; i < 80 && chip()?.getAttribute('aria-pressed') !== 'true'; i++) await sleep(100);
    const on = { changed: A.code !== original, dot: document.getElementById('chip-a').classList.contains('is-unsaved'), save: !document.getElementById('save-new').hidden };
    chip().click();
    for (let i = 0; i < 80 && chip()?.getAttribute('aria-pressed') !== 'false'; i++) await sleep(100);
    const steps = [...document.querySelectorAll('.coach__step')].map((li) => li.dataset.step + (li.classList.contains('is-done') ? '+' : ''));
    return { ...on, back: A.code === original && !A.edited, steps };
  });
  check('signed out, a suggestion can be tried, with nothing to save', !tried.none && tried.changed && !tried.dot && !tried.save && tried.back, JSON.stringify(tried));
  check('signed out, the first steps end with signing in', tried.steps?.join() === 'play+,knob+,mute+,tweak+,signin', tried.steps?.join());

  const lockedBeat = await one.evaluate(() => {
    const h = window.hackingTheBeats;
    const song = h.app.songs.find((entry) => !entry.featured && !entry.broken);
    document.querySelector(`.beat[data-id="${CSS.escape(song.id)}"] .beat__main`).click();
    return { id: song.id, slug: song.slug, title: song.title };
  });
  await settle(one);
  const locked = await one.evaluate(() => {
    const h = window.hackingTheBeats;
    h.players.B.load && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    return { panel: !document.getElementById('locked').hidden, title: document.getElementById('locked-title').textContent, path: location.pathname, stopped: !h.players.A.started, tab: document.title, onDeck: h.players.A.song.featured, deckB: h.players.B.song };
  });
  check('any other beat is described and asks for sign-in', locked.panel && locked.title === lockedBeat.title && locked.path === `/beats/${lockedBeat.slug}` && locked.stopped && locked.onDeck && !locked.deckB && locked.tab.startsWith(lockedBeat.title), JSON.stringify(locked));

  /* ---------- person one ---------- */
  // a song made before signing in joins the account on sign-in
  const first = await one.evaluate(() => {
    const h = window.hackingTheBeats;
    return h.songs.createBlank().id;
  });
  await one.evaluate(() => window.hackingTheBeats.cloud.signInForTest({ sub: 'one', email: 'one@example.com', name: 'One Tester' }));
  await one.waitForFunction(() => window.hackingTheBeats.cloud.user && window.hackingTheBeats.songs.list().length === 1);
  await one.waitForFunction((id) => window.hackingTheBeats.players.A.song?.id === id && window.hackingTheBeats.players.A.ready, lockedBeat.id, { timeout: 30000 });
  const unlocked = await one.evaluate(() => ({ access: window.hackingTheBeats.app.access, panel: !document.getElementById('locked').hidden, standard: !window.hackingTheBeats.cloud.user.admin && document.getElementById('open-admin').hidden }));
  check('signing in opens the whole site, and the beat that was asked for, without a reload', unlocked.access === 'full' && !unlocked.panel && (await shown(one, 'deck')) && !(await shown(one, 'intro')), JSON.stringify(unlocked));
  check('a new account is a standard user', unlocked.standard);
  const stepsIn = await one.evaluate(() => [...document.querySelectorAll('.coach__step')].map((li) => li.dataset.step + (li.classList.contains('is-done') ? '+' : '')));
  // (this account already holds a song of its own, made before signing in: that step is done)
  check('with an account the first steps go on to keeping and sharing, and remember what was done', stepsIn.join() === 'play+,knob+,mute+,tweak+,save+,share', stepsIn.join());
  await one.evaluate(() => window.hackingTheBeats.songs.flush());
  const afterSignIn = await one.evaluate(async () => {
    const h = window.hackingTheBeats;
    return { remote: (await h.cloud.listSongs()).map((s) => s.id), initial: document.getElementById('account-initial').textContent, synced: h.songs.list()[0].synced };
  });
  check('signing in shows who is signed in', afterSignIn.initial === 'O', afterSignIn.initial);
  check('a song made while signed out is added to the account', afterSignIn.remote.length === 1 && afterSignIn.remote[0] === first && afterSignIn.synced);

  // editing the song on a deck saves it to the account
  await one.evaluate(async (id) => {
    const h = window.hackingTheBeats;
    const A = h.players.A;
    document.querySelector(`.beat[data-id="${id}"] .beat__deck[data-deck="A"]`).click();
    while (!(A.song?.id === id && A.ready)) await new Promise((r) => setTimeout(r, 50));
    const view = A.mirror.editor;
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\nEXTRA: s("hh*2").gain(0.2)\n' } });
    await A.update();
    document.getElementById('save').click();
  }, first);
  await settle(one, 1200);
  await one.evaluate(() => window.hackingTheBeats.songs.flush());
  const edited = await one.evaluate(async () => (await window.hackingTheBeats.cloud.listSongs())[0].code.includes('EXTRA:'));
  check('edits to my own song are saved to the account when I press Save', edited);

  // the share sheet: changes not yet saved are kept first, then the link is made
  const sheet = await one.evaluate(async (id) => {
    const h = window.hackingTheBeats;
    const A = h.players.A;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const view = A.mirror.editor;
    view.dispatch({ changes: { from: view.state.doc.length, insert: '// saved by sharing\n' } });
    document.getElementById('share').click();
    const before = { open: document.getElementById('share-sheet').open, warning: document.getElementById('share-warning-go').textContent, toggle: !document.getElementById('share-toggle-row').hidden };
    document.getElementById('share-warning-go').click();
    for (let i = 0; i < 100 && !document.getElementById('share-link').value.includes('#song='); i++) await sleep(100);
    const after = { link: document.getElementById('share-link').value, recipient: document.getElementById('share-recipient').textContent, edited: A.edited, shared: h.songs.get(id).shared };
    document.getElementById('share-close').click();
    const remote = (await h.cloud.listSongs()).find((song) => song.id === id);
    h.songs.setShared(id, false);
    await h.songs.flush();
    return { before, after, saved: remote.code.includes('saved by sharing') && remote.shared };
  }, first);
  check(
    'sharing a song with unsaved changes saves them first, then gives the link',
    sheet.before.open && sheet.before.warning === 'Save and share' && sheet.before.toggle && /#song=[0-9a-f-]{36}$/.test(sheet.after.link) && !sheet.after.edited && sheet.after.shared && sheet.saved && /shared by One Tester/.test(sheet.after.recipient),
    JSON.stringify(sheet),
  );

  // sharing
  const links = await one.evaluate(async (id) => {
    const h = window.hackingTheBeats;
    h.songs.setShared(id, true);
    const secret = h.songs.createBlank();
    await h.songs.flush();
    const url = new URL(location.origin);
    url.hash = `song=${h.cloud.user.uid}~${secret.id}`;
    return { shared: h.songs.shareLink(id), secret: url.href, uid: h.cloud.user.uid, secretId: secret.id, count: (await h.cloud.listSongs()).length };
  }, first);
  const UUID = /#song=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  check('a shared song gets a link that is a UUID and names nobody', UUID.test(links.shared || '') && !links.shared.includes(links.uid) && !links.shared.includes(first), links.shared);

  /* ---------- person two, in another browser ---------- */
  // here the main site also plays shared songs (no separate player address), so it asks
  // for an account first
  const two = await visitor(links.shared);
  await settle(two, 1200);
  const asked = await two.evaluate(() => ({ dialog: document.getElementById('account-dialog').open, gated: window.hackingTheBeats.players.A.gated, waiting: Boolean(window.hackingTheBeats.app.pendingShared) }));
  check('a shared song on the main site waits for sign-in', asked.dialog && !asked.gated && asked.waiting, JSON.stringify(asked));
  await two.evaluate(() => window.hackingTheBeats.cloud.signInForTest({ sub: 'two', email: 'two@example.com', name: 'Two Tester' }));
  await two.waitForFunction(() => window.hackingTheBeats.players.A.gated, null, { timeout: 15000 });
  const gate = await two.evaluate(() => {
    const A = window.hackingTheBeats.players.A;
    return { shown: !document.getElementById('gate').hidden, by: document.getElementById('gate-by').textContent, ready: A.ready, code: A.code.includes('EXTRA:'), source: A.song.source, dialog: document.getElementById('account-dialog').open };
  });
  check("then someone else's shared song is shown but not run", gate.shown && !gate.ready && gate.code && gate.source === 'shared' && !gate.dialog, gate.by);
  await two.click('#gate-run');
  await two.waitForFunction(() => window.hackingTheBeats.players.A.ready, null, { timeout: 30000 });
  await two.click('#curtain-play');
  await two.waitForFunction(() => window.hackingTheBeats.players.A.started, null, { timeout: 30000 });
  check('it runs once the listener says so', true);

  // the security rules, tried directly as person two
  const rules = await two.evaluate(async ({ uid, secretId, sharedId, shareId }) => {
    const fb = await import('/vendor/firebase.bundle.js');
    const db = fb.getFirestore();
    const me = fb.getAuth().currentUser.uid;
    const song = (overrides = {}) => ({ code: 's("bd")', title: 'x', createdAt: 1, updatedAt: 1, shared: false, mixer: [], ownerName: 'Two', ...overrides });
    const attempt = async (action) => {
      try {
        await action();
        return 'allowed';
      } catch (error) {
        return error.code || String(error);
      }
    };
    return {
      readShared: await attempt(() => fb.getDoc(fb.doc(db, 'users', uid, 'songs', sharedId))),
      readPrivate: await attempt(() => fb.getDoc(fb.doc(db, 'users', uid, 'songs', secretId))),
      listOthers: await attempt(() => fb.getDocs(fb.collection(db, 'users', uid, 'songs'))),
      writeOthers: await attempt(() => fb.setDoc(fb.doc(db, 'users', uid, 'songs', 'planted'), song())),
      overwriteShared: await attempt(() => fb.setDoc(fb.doc(db, 'users', uid, 'songs', sharedId), song())),
      deleteOthers: await attempt(() => fb.deleteDoc(fb.doc(db, 'users', uid, 'songs', sharedId))),
      takeDownOthers: await attempt(() => fb.updateDoc(fb.doc(db, 'users', uid, 'songs', sharedId), { shared: false, blocked: true })),
      writeOwn: await attempt(() => fb.setDoc(fb.doc(db, 'users', me, 'songs', 'mine'), song())),
      writeOwnBlocked: await attempt(() => fb.setDoc(fb.doc(db, 'users', me, 'songs', 'born-blocked'), song({ blocked: true }))),
      writeOwnHuge: await attempt(() => fb.setDoc(fb.doc(db, 'users', me, 'songs', 'huge'), song({ code: 'x'.repeat(200001) }))),
      writeOwnExtraField: await attempt(() => fb.setDoc(fb.doc(db, 'users', me, 'songs', 'extra'), { ...song(), admin: true })),
      writeOwnWithFrom: await attempt(() => fb.setDoc(fb.doc(db, 'users', me, 'songs', 'remix'), song({ from: { title: 'Paper Kite', ownerName: 'One', shareId: '00000000-0000-4000-8000-00000000000a' } }))),
      writeOwnFromWithOwner: await attempt(() => fb.setDoc(fb.doc(db, 'users', me, 'songs', 'remix-2'), song({ from: { title: 'Paper Kite', owner: uid } }))),
      writeOwnFromHuge: await attempt(() => fb.setDoc(fb.doc(db, 'users', me, 'songs', 'remix-3'), song({ from: { title: 'x'.repeat(201) } }))),
      writeOwnFromNotAMap: await attempt(() => fb.setDoc(fb.doc(db, 'users', me, 'songs', 'remix-4'), song({ from: 'Paper Kite' }))),
      writeElsewhere: await attempt(() => fb.setDoc(fb.doc(db, 'anything', 'else'), { a: 1 })),
      makeSelfAdmin: await attempt(() => fb.setDoc(fb.doc(db, 'admins', me), {})),
      listEveryonesShared: await attempt(() => fb.getDocs(fb.query(fb.collectionGroup(db, 'songs'), fb.where('shared', '==', true)))),
      writeBeat: await attempt(() => fb.setDoc(fb.doc(db, 'beats', 'mine'), { code: 'x', title: 'x', slug: 'x', order: 1, featured: true, hidden: false, createdAt: 1, updatedAt: 1 })),
      writeCatalog: await attempt(() => fb.setDoc(fb.doc(db, 'catalog', 'public'), { beats: [], updatedAt: 1 })),
      listShares: await attempt(() => fb.getDocs(fb.collection(db, 'shares'))),
      shareForSomeoneElse: await attempt(() => fb.setDoc(fb.doc(db, 'shares', '00000000-0000-4000-8000-000000000001'), { owner: uid, song: secretId, createdAt: 1 })),
      shareWithAName: await attempt(() => fb.setDoc(fb.doc(db, 'shares', 'my-song'), { owner: me, song: 'mine', createdAt: 1 })),
      hijackShare: await attempt(() => fb.setDoc(fb.doc(db, 'shares', shareId), { owner: me, song: 'mine', createdAt: 1 })),
      deleteOthersShare: await attempt(() => fb.deleteDoc(fb.doc(db, 'shares', shareId))),
    };
  }, { uid: links.uid, secretId: links.secretId, sharedId: first, shareId: links.shared.split('#song=')[1] });
  const denied = (value) => value === 'permission-denied';
  check('rules: anyone with the link can read a shared song', rules.readShared === 'allowed', rules.readShared);
  check("rules: nobody else can read a private song", denied(rules.readPrivate), rules.readPrivate);
  check("rules: nobody else can list a person's songs", denied(rules.listOthers) && denied(rules.listEveryonesShared), `${rules.listOthers} / ${rules.listEveryonesShared}`);
  check("rules: nobody else can write into a person's account", denied(rules.writeOthers) && denied(rules.overwriteShared) && denied(rules.deleteOthers) && denied(rules.takeDownOthers), `${rules.writeOthers} / ${rules.overwriteShared} / ${rules.deleteOthers} / ${rules.takeDownOthers}`);
  check('rules: a person can save their own song', rules.writeOwn === 'allowed', rules.writeOwn);
  check('rules: oversized or malformed songs are refused', denied(rules.writeOwnHuge) && denied(rules.writeOwnExtraField) && denied(rules.writeOwnBlocked), `${rules.writeOwnHuge} / ${rules.writeOwnExtraField} / ${rules.writeOwnBlocked}`);
  check('rules: a standard user cannot make themselves admin, or publish beats', denied(rules.makeSelfAdmin) && denied(rules.writeBeat) && denied(rules.writeCatalog), `${rules.makeSelfAdmin} / ${rules.writeBeat} / ${rules.writeCatalog}`);
  check('rules: share links cannot be listed, forged, taken over or removed by someone else', denied(rules.listShares) && denied(rules.shareForSomeoneElse) && denied(rules.shareWithAName) && denied(rules.hijackShare) && denied(rules.deleteOthersShare), `${rules.listShares} / ${rules.shareForSomeoneElse} / ${rules.shareWithAName} / ${rules.hijackShare} / ${rules.deleteOthersShare}`);
  check('rules: the rest of the database is closed', denied(rules.writeElsewhere), rules.writeElsewhere);
  check(
    'rules: a copy can say where it came from, but never whose account it was in',
    rules.writeOwnWithFrom === 'allowed' && denied(rules.writeOwnFromWithOwner) && denied(rules.writeOwnFromHuge) && denied(rules.writeOwnFromNotAMap),
    `${rules.writeOwnWithFrom} / ${rules.writeOwnFromWithOwner} / ${rules.writeOwnFromHuge} / ${rules.writeOwnFromNotAMap}`,
  );

  // keeping a copy of the shared song
  await two.click('#save-copy');
  await settle(two);
  await two.evaluate(() => window.hackingTheBeats.songs.flush());
  const copy = await two.evaluate(async () => {
    const h = window.hackingTheBeats;
    const remote = (await h.cloud.listSongs()).find((s) => s.code.includes('EXTRA:'));
    return { own: h.players.A.own, mine: h.songs.list().length, remote: Boolean(remote), from: remote?.from, curtainFrom: document.getElementById('curtain-from').textContent };
  });
  check('"Save a copy" puts a shared song in my own account', copy.own && copy.remote, JSON.stringify(copy));
  check('the copy credits the song it came from, in the account too', copy.from?.ownerName === 'One Tester' && /^[0-9a-f-]{36}$/.test(copy.from?.shareId || '') && !JSON.stringify(copy.from).includes(links.uid), JSON.stringify(copy.from));

  // a private song's link opens nothing, even for someone signed in
  await two.goto(links.secret);
  await two.waitForFunction(() => !document.getElementById('gone').hidden, null, { timeout: 15000 }).catch(() => {});
  const blocked = await two.evaluate(() => ({ gated: window.hackingTheBeats.players.A.gated, gone: !document.getElementById('gone').hidden, title: document.getElementById('gone-title').textContent }));
  check('a private song cannot be opened by its link, and the page says so', !blocked.gated && blocked.gone && /no longer works/.test(blocked.title), JSON.stringify(blocked));

  // switching sharing off closes the link
  await one.evaluate(async (id) => {
    window.hackingTheBeats.songs.setShared(id, false);
    await window.hackingTheBeats.songs.flush();
  }, first);
  const closed = await two.evaluate(async ({ uid, id, shareId }) => ({ song: await window.hackingTheBeats.cloud.getShared(uid, id), link: await window.hackingTheBeats.cloud.getShare(shareId) }), { uid: links.uid, id: first, shareId: links.shared.split('#song=')[1] });
  check('switching sharing off closes the link for good', closed.song === null && closed.link === null);

  // signing out and in again
  await one.evaluate(async () => {
    await window.hackingTheBeats.songs.flush();
    await window.hackingTheBeats.cloud.signOut();
  });
  await one.waitForFunction(() => !window.hackingTheBeats.cloud.user && window.hackingTheBeats.app.access === 'preview');
  await one.waitForFunction(() => window.hackingTheBeats.players.A.song?.featured, null, { timeout: 15000 });
  await settle(one);
  const out = await one.evaluate(() => ({ mine: window.hackingTheBeats.songs.list().length, stored: JSON.parse(localStorage.getItem('hacking-the-beats:songs') || '[]').length, path: location.pathname }));
  check("signing out removes the account's songs from the browser", out.mine === 0 && out.stored === 0, JSON.stringify(out));
  check('signing out goes back to the featured beat, with its controls but no second deck', (await shown(one, 'intro')) && (await shown(one, 'deck')) && !(await shown(one, 'chip-b')) && !(await shown(one, 'record')) && out.path === '/');
  await one.evaluate(() => window.hackingTheBeats.cloud.signInForTest({ sub: 'one', email: 'one@example.com', name: 'One Tester' }));
  await one.waitForFunction((count) => window.hackingTheBeats.songs.list().length === count, links.count, { timeout: 15000 });
  check('signing in again brings them back', true, `${links.count} songs`);

  // deleting
  const remaining = await one.evaluate(async (id) => {
    const h = window.hackingTheBeats;
    h.songs.remove(id);
    await new Promise((r) => setTimeout(r, 800));
    return (await h.cloud.listSongs()).map((s) => s.id);
  }, links.secretId);
  check('deleting a song removes it from the account', !remaining.includes(links.secretId) && remaining.includes(first));

  // the real sign-in button, through the emulator's stand-in for Google's account chooser
  const three = await visitor();
  const [popup] = await Promise.all([three.waitForEvent('popup'), three.click('#intro-sign-in')]);
  // the emulator's page can take a click before its script is listening: press until the form opens
  await popup.waitForLoadState('load');
  for (let i = 0; i < 10 && !(await popup.isVisible('#email-input')); i++) {
    await popup.click('#add-account-button');
    await popup.waitForTimeout(500);
  }
  await popup.fill('#email-input', 'three@example.com');
  await popup.fill('#display-name-input', 'Three Tester');
  await popup.click('#sign-in');
  await three.waitForFunction(() => window.hackingTheBeats.cloud.user, null, { timeout: 20000 });
  await three.waitForFunction(() => window.hackingTheBeats.app.access === 'full');
  const signedIn = await three.evaluate(() => ({ user: Boolean(window.hackingTheBeats.cloud.user?.email), button: document.getElementById('account').classList.contains('is-signed-in') }));
  check('the "Sign in with Google" button signs in through the pop-up', signedIn.user && signedIn.button && (await shown(three, 'deck')), JSON.stringify(signedIn));
  await three.click('#account');
  await three.click('#sign-out');
  await three.waitForFunction(() => !window.hackingTheBeats.cloud.user, null, { timeout: 10000 });
  check('"Sign out" signs out', true);

  /* ---------- with a separate address for shared songs ---------- */

  const owner = await visitor(SITE, SPLIT);
  await owner.evaluate(() => window.hackingTheBeats.cloud.signInForTest({ sub: 'one', email: 'one@example.com', name: 'One Tester' }));
  await owner.waitForFunction((id) => window.hackingTheBeats.songs.get(id), first, { timeout: 15000 });
  const playerLink = await owner.evaluate(async (id) => {
    const h = window.hackingTheBeats;
    h.songs.setShared(id, true);
    await h.songs.flush();
    return h.songs.shareLink(id);
  }, first);
  const SONG_ADDRESS = /\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  check("sharing again makes a new link: the song's own address on the player", playerLink?.startsWith(`${PLAYER}/s/`) && SONG_ADDRESS.test(playerLink) && !playerLink.includes(links.shared.split('#song=')[1]), playerLink);

  /* ---------- the link-preview function ---------- */
  // a song with a title that has to be escaped, shared by person one
  const preview = await owner.evaluate(async () => {
    const h = window.hackingTheBeats;
    const song = h.songs.create({ code: '/*\n  @title Glass & <Tide> "one"\n  @by Test Person\n  A note about it.\n*/\nsetcps(120/60/4)\nDRUMS: s("bd*4")\nHATS: s("hh*8")\n' });
    h.songs.setShared(song.id, true);
    await h.songs.flush();
    return { id: song.id, shareId: h.songs.get(song.id).shareId, uid: h.cloud.user.uid };
  });
  // the emulator can take a moment to load the function the first time
  const ask = async (path, options = {}) => {
    for (let i = 0; i < 20; i++) {
      try {
        const response = await fetch(`${FUNCTION}${path}`, { redirect: 'manual', ...options });
        if (response.status !== 500 || i === 19) return response;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  const page = await ask(`/s/${preview.shareId}`);
  const html = await page.text();
  check(
    "a shared song's address is answered with its own title, description and picture",
    page.status === 200 &&
      html.includes('<title>Glass &amp; &lt;Tide&gt; &quot;one&quot; by Test Person — Hacking the Beats</title>') &&
      html.includes('<meta name="twitter:card" content="summary_large_image" />') &&
      new RegExp(`og:image" content="[^"]+/s/${preview.shareId}/card\\.png\\?v=`).test(html) &&
      /s-maxage/.test(page.headers.get('cache-control')) &&
      page.headers.get('x-robots-tag') === 'noindex',
    `${page.status} ${page.headers.get('cache-control')}`,
  );
  check('the page gives away neither the code nor whose account it is in', !html.includes('setcps(120') && !html.includes(preview.uid) && !html.includes(preview.id) && !html.includes('<Tide>'));
  const card = await ask(`/s/${preview.shareId}/card.png`);
  const png = Buffer.from(await card.arrayBuffer());
  check(
    'and its picture is a 1200×630 PNG',
    card.status === 200 && card.headers.get('content-type') === 'image/png' && png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630,
    `${card.status} ${png.length} bytes`,
  );
  const head = await ask(`/s/${preview.shareId}`, { method: 'HEAD' });
  check('a HEAD request is answered without a body', head.status === 200 && (await head.text()) === '');
  const junk = await ask('/s/hello');
  check('an address that is not a link is answered with nothing about any song', junk.status === 404);
  await owner.evaluate(async (id) => {
    window.hackingTheBeats.songs.setShared(id, false);
    await window.hackingTheBeats.songs.flush();
  }, preview.id);
  const closedPage = await ask(`/s/${preview.shareId}`);
  const closedHtml = await closedPage.text();
  const closedCard = await ask(`/s/${preview.shareId}/card.png`);
  check(
    'once sharing is off, the address says nothing about the song, and the picture is the general one',
    closedPage.status === 404 && !closedHtml.includes('Glass') && !closedHtml.includes('Test Person') && closedCard.status === 302 && /\/og\/home\.png$/.test(closedCard.headers.get('location') || ''),
    `${closedPage.status} / ${closedCard.status}`,
  );

  // sharing from a site beat: the sheet says what it is, and leads with a copy of one's own,
  // whose link is the song's own address (with its own preview)
  const fromBeat = await owner.evaluate(async () => {
    const h = window.hackingTheBeats;
    const A = h.players.A;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const beat = h.app.songs.find((song) => song.featured);
    if (A.song?.id !== beat.id) document.querySelector(`.beat[data-id="${CSS.escape(beat.id)}"] .beat__deck[data-deck="A"]`).click();
    for (let i = 0; i < 200 && !(A.song?.id === beat.id && A.ready); i++) await sleep(50);
    const before = h.songs.list().length;
    document.getElementById('share').click();
    const sheet = { intro: document.getElementById('share-intro').textContent, offer: document.getElementById('share-offer-go').textContent, beatLink: document.getElementById('share-link').value };
    document.getElementById('share-offer-go').click();
    for (let i = 0; i < 100 && !document.getElementById('share-link').value.includes('/s/'); i++) await sleep(100);
    const link = document.getElementById('share-link').value;
    document.getElementById('share-close').click();
    const copy = A.song;
    return { ...sheet, link, own: A.own, shared: h.songs.get(copy.id)?.shared, from: copy.from, added: h.songs.list().length - before, beat: beat.title, copyId: copy.id };
  });
  check(
    "sharing from a site beat offers a copy of one's own, whose link is its own address",
    /one of the site's beats/.test(fromBeat.intro) && fromBeat.offer === 'Save as my song and share' && /\/beats\//.test(fromBeat.beatLink) && SONG_ADDRESS.test(fromBeat.link) && fromBeat.own && fromBeat.shared && fromBeat.added === 1 && fromBeat.from?.title === fromBeat.beat,
    JSON.stringify(fromBeat),
  );
  await owner.evaluate(async (id) => {
    window.hackingTheBeats.songs.remove(id);
    await window.hackingTheBeats.songs.flush();
  }, fromBeat.copyId);

  // a link that names nothing: the player says so, and offers no copy to take home
  const nowhere = await bare(`${PLAYER}/#song=00000000-0000-4000-8000-0000000000ff`, SPLIT);
  await nowhere.waitForFunction(() => !document.getElementById('gone').hidden, null, { timeout: 15000 }).catch(() => {});
  const lost = await nowhere.evaluate(() => ({ gone: !document.getElementById('gone').hidden, go: document.getElementById('gone-go').textContent, keep: getComputedStyle(document.getElementById('intro-sign-in')).display !== 'none' }));
  check("on the player, a link that leads nowhere says so", lost.gone && lost.go === 'Listen to the featured beat' && !lost.keep, JSON.stringify(lost));
  await nowhere.context().close();

  // an old link stays closed, even if its record was left behind when sharing went back on
  const stale = await owner.evaluate(async ({ id, old }) => {
    await window.hackingTheBeats.cloud.saveShare(old, id);
    return window.hackingTheBeats.songs.get(id).shareId !== old;
  }, { id: first, old: links.shared.split('#song=')[1] });
  const leftover = await bare(`${PLAYER}/#song=${links.shared.split('#song=')[1]}`, SPLIT);
  await leftover.waitForFunction(() => !document.getElementById('gone').hidden, null, { timeout: 15000 }).catch(() => {});
  check('an old link stays closed, even if its record lingers', stale && (await leftover.evaluate(() => !document.getElementById('gone').hidden && !window.hackingTheBeats.players.A.song)));
  await leftover.context().close();
  await owner.evaluate((old) => window.hackingTheBeats.cloud.deleteShare(old), links.shared.split('#song=')[1]);

  // someone with no account follows the link
  const stranger = await visitor(playerLink, SPLIT);
  await stranger.waitForFunction(() => window.hackingTheBeats.players.A.song?.source === 'shared' && window.hackingTheBeats.players.A.ready, null, { timeout: 30000 });
  await stranger.click('#curtain-play');
  await stranger.waitForFunction(() => window.hackingTheBeats.players.A.started, null, { timeout: 30000 });
  await settle(stranger);
  const playing = await stranger.evaluate(() => {
    const h = window.hackingTheBeats;
    const hidden = (selector) => getComputedStyle(document.querySelector(selector)).display === 'none';
    const label = document.querySelector('#pane-a .hb-label');
    label?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    const muted = label ? h.players.A.mixer.tracks[Number(label.dataset.track)].mute : true;
    return {
      hidden: ['#chip-b', '#record', '#share', '.mixrow', '.stagebar', '#tries', '#coach'].filter(hidden).length,
      muted,
      by: document.getElementById('curtain-by').textContent,
      intro: document.getElementById('intro-now').textContent,
      stored: Object.keys(localStorage).filter((key) => key.startsWith('hacking-the-beats')),
    };
  });
  check('a shared song plays for someone who is not signed in, with its knobs, channels and pads', (await shown(stranger, 'intro')) && (await shown(stranger, 'deck')) && playing.hidden === 7 && playing.muted, JSON.stringify(playing));
  check('the player says who shared it, and keeps nothing', /shared by One Tester/.test(playing.by) && /One Tester shared/.test(playing.intro) && !playing.stored.includes('hacking-the-beats:songs'), JSON.stringify(playing));
  await stranger.click('#intro-sign-in');
  await stranger.waitForURL((url) => url.origin === new URL(SITE).origin, { timeout: 15000 });
  await arrive(stranger);
  await stranger.waitForFunction(() => window.hackingTheBeats.app.pendingShared, null, { timeout: 15000 });
  check('"Edit a copy" takes them to the main site, which asks them to sign in', await stranger.evaluate(() => document.getElementById('account-dialog').open && !window.hackingTheBeats.players.A.gated));

  // a signed-in listener with a song of their own follows a link on the main address
  const listener = await visitor(SITE, SPLIT);
  await listener.evaluate(async () => {
    const h = window.hackingTheBeats;
    await h.cloud.signInForTest({ sub: 'two', email: 'two@example.com', name: 'Two Tester' });
    h.songs.createBlank();
    await h.songs.flush();
  });
  const session = await listener.evaluate(async () => ((await indexedDB.databases?.()) || []).some((db) => db.name === 'firebaseLocalStorageDb'));
  check('(the main address does hold my session and my songs)', session && (await listener.evaluate(() => window.hackingTheBeats.songs.list().length >= 1)));
  await listener.goto(`${SITE}#song=${links.uid}~${first}`);
  await listener.waitForURL((url) => url.origin === PLAYER, { timeout: 15000 });
  await arrive(listener);
  await listener.waitForFunction(() => window.hackingTheBeats.players.A.song?.source === 'shared' && window.hackingTheBeats.players.A.ready, null, { timeout: 30000 });
  const guest = await listener.evaluate(async () => {
    const h = window.hackingTheBeats;
    const databases = (await indexedDB.databases?.()) || [];
    return {
      guest: h.site.guest,
      access: h.app.access,
      gated: h.players.A.gated,
      code: h.players.A.code.includes('EXTRA:'),
      user: h.cloud.user,
      keep: document.getElementById('intro-sign-in').textContent,
      mine: h.songs.list().length,
      stored: localStorage.getItem('hacking-the-beats:songs'),
      // where Firebase keeps a signed-in session
      authStore: databases.some((db) => db.name === 'firebaseLocalStorageDb'),
      hash: location.hash,
    };
  });
  check('a shared song opens on the player, ready to play', guest.guest && guest.access === 'preview' && !guest.gated && guest.code && guest.hash.startsWith('#song='), JSON.stringify({ guest: guest.guest, gated: guest.gated }));
  check('the player has no account and none of my songs', guest.user === null && !(await shown(listener, 'account')) && guest.mine === 0 && guest.stored === null && !guest.authStore, JSON.stringify(guest));
  check('the player does not offer editing, only a copy to take home', !(await shown(listener, 'edit')) && guest.keep === 'Edit a copy', guest.keep);

  // taking a copy home: back on the main address, signed in, and asked before it runs
  await listener.click('#intro-sign-in');
  await listener.waitForURL((url) => url.origin === new URL(SITE).origin, { timeout: 15000 });
  await arrive(listener);
  await listener.waitForFunction(() => window.hackingTheBeats.players.A.gated, null, { timeout: 15000 });
  const home = await listener.evaluate(() => ({ user: window.hackingTheBeats.cloud.user?.email, gate: !document.getElementById('gate').hidden, ready: window.hackingTheBeats.players.A.ready }));
  check('signed in, "Edit a copy" opens the song on the main site, behind the question', home.user === 'two@example.com' && home.gate && !home.ready, JSON.stringify(home));
  const runLabel = await listener.textContent('#gate-run');
  const songsBefore = await listener.evaluate(() => window.hackingTheBeats.songs.list().length);
  await listener.click('#gate-run');
  await listener.waitForFunction(() => window.hackingTheBeats.players.A.ready && window.hackingTheBeats.players.A.own, null, { timeout: 30000 });
  const keptCopy = await listener.evaluate(() => ({ mine: window.hackingTheBeats.songs.list().length, from: window.hackingTheBeats.players.A.song.from }));
  check('there, one click runs it and keeps a copy that credits the original', runLabel === 'Run and keep a copy' && keptCopy.mine === songsBefore + 1 && keptCopy.from?.ownerName === 'One Tester', JSON.stringify({ runLabel, ...keptCopy }));

  // the player's address is only for shared songs
  await listener.goto(`${PLAYER}/`);
  await listener.waitForURL((url) => url.origin === new URL(SITE).origin, { timeout: 15000 });
  check("the player's address with no song goes to the main site", true);

  /* ---------- the admin, and beats in the database ---------- */

  // An admin is an account with a marker document in admins/, which nobody can write from
  // the site. The Firebase console makes one; here the emulator's owner access does.
  const rest = (path, options = {}) => fetch(`http://${FIRESTORE[0]}:${FIRESTORE[1]}/v1/projects/demo-htb/databases/(default)/documents/${path}`, { ...options, headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' } });
  const chief = await visitor();
  await chief.evaluate(() => window.hackingTheBeats.cloud.signInForTest({ sub: 'chief', email: 'chief@example.com', email_verified: true, name: 'The Chief' }));
  await chief.waitForFunction(() => window.hackingTheBeats.cloud.user && window.hackingTheBeats.app.access === 'full');
  const plain = await chief.evaluate(async () => {
    const h = window.hackingTheBeats;
    const fb = await import('/vendor/firebase.bundle.js');
    // nobody can make themselves an admin
    const selfMade = await fb.setDoc(fb.doc(fb.getFirestore(), 'admins', h.cloud.user.uid), {}).then(() => true, () => false);
    return { uid: h.cloud.user.uid, admin: h.cloud.user.admin, selfMade };
  });
  await rest(`admins/${plain.uid}`, { method: 'PATCH', body: JSON.stringify({ fields: {} }) });
  await chief.reload();
  await arrive(chief);
  const marked = await chief.waitForFunction(() => window.hackingTheBeats.cloud.user?.admin, null, { timeout: 15000 }).then(() => true, () => false);
  check('an account is the admin once it has a marker, and cannot give itself one', plain.admin === false && plain.selfMade === false && marked, JSON.stringify(plain));

  // the first publication: the beats the site came with, in one press
  await chief.click('#account');
  await chief.click('#open-admin');
  await chief.waitForFunction(() => !document.getElementById('admin-seed').hidden, null, { timeout: 15000 });
  const before = await chief.evaluate(() => ({ count: window.hackingTheBeats.app.songs.length, featured: window.hackingTheBeats.app.songs.find((song) => song.featured).title }));
  await chief.click('#admin-seed');
  await chief.waitForFunction(() => document.getElementById('admin-status').textContent.includes("Published the site's"), null, { timeout: 20000 });
  // the site reads the beats back from the database
  await chief.waitForFunction(() => window.hackingTheBeats.app.libraryMode === 'database', null, { timeout: 15000 });
  const seeded = await chief.evaluate(async () => {
    const h = window.hackingTheBeats;
    const catalog = await h.cloud.getCatalog();
    return { count: h.admin.beats.length, mine: h.app.songs.filter((song) => song.audience === 'admin').length, public: catalog.beats.map((entry) => entry.title), ids: h.admin.beats.map((entry) => entry.id), mode: h.app.libraryMode, button: document.getElementById('admin-seed').hidden };
  });
  check("the admin puts the site's own beats into an empty database in one press", seeded.count === before.count && seeded.mode === 'database' && seeded.button, `${seeded.count} beats`);
  check('only the featured beat is told to anyone else; the rest are the admin\'s own', seeded.public.join() === before.featured && seeded.mine === before.count - 1, seeded.public.join());
  // put the database back as it was for what follows
  for (const id of seeded.ids) await rest(`beats/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await rest('catalog/public', { method: 'DELETE' });

  const boss = await visitor();
  await boss.evaluate(() => window.hackingTheBeats.cloud.signInForTest({ sub: 'boss', email: 'boss@example.com', name: 'The Boss' }));
  await boss.waitForFunction(() => window.hackingTheBeats.cloud.user);
  const bossUid = await boss.evaluate(() => window.hackingTheBeats.cloud.user.uid);
  // a second admin, made the way the Firebase console makes one: a marker document
  const made = await rest(`admins/${bossUid}`, { method: 'PATCH', body: JSON.stringify({ fields: {} }) });
  await boss.reload();
  await arrive(boss);
  await boss.waitForFunction(() => window.hackingTheBeats.cloud.user?.admin, null, { timeout: 15000 });
  await boss.click('#account');
  check('an admin is told so, and offered the admin sheet', made.ok && (await boss.evaluate(() => !document.getElementById('open-admin').hidden && /admin/i.test(document.getElementById('account-count').textContent))));
  await boss.click('#open-admin');

  const beat = (title, note) => `/*\n  @title ${title}\n  ${note}\n*/\nsetcps(120/60/4)\nconst cut = slider(900, 200, 4000)\nLOW: note("c2*4").s("square").lpf(cut).gain(0.4)\nHIGH: note("c4 e4 g4 e4").s("triangle").gain(0.3)\n`;
  const seed = { t1: { code: beat('Alpha', 'The first one.'), created_at: 1 }, t2: { code: beat('Beta', 'The second one.'), created_at: 2 }, t3: { code: beat('Gamma', 'The third one.'), created_at: 3 } };
  const status = (text) => boss.waitForFunction((want) => document.getElementById('admin-status').textContent.includes(want), text, { timeout: 15000 });
  const row = (id) => boss.locator(`#admin-beats .admin__row[data-id="${id}"]`);
  await boss.setInputFiles('#admin-file', { name: 'seed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(seed)) });
  await status('Added 3 beats');
  await row('t2').getByRole('button', { name: 'Featured' }).click();
  await status('"Beta" is now the featured beat');
  await row('t1').getByRole('button', { name: 'Members' }).click();
  await status('"Alpha" is open to members');
  await row('t2').getByRole('button', { name: '↑' }).click();
  await status('Moved "Beta"');
  const managed = await boss.evaluate(async () => {
    const h = window.hackingTheBeats;
    const catalog = await h.cloud.getCatalog();
    return { order: h.admin.beats.map((entry) => entry.id), catalog: catalog.beats.map((entry) => `${entry.id}${entry.featured ? '*' : ''}`), noCode: !JSON.stringify(catalog).includes('setcps'), mode: h.app.libraryMode };
  });
  check('the admin adds beats, features one, opens one to members and reorders them', managed.order.join() === 't2,t1,t3' && managed.catalog.join() === 't2*,t1' && managed.noCode, JSON.stringify(managed));

  // what a visitor with no account is given now
  const passerby = await visitor();
  const given = await passerby.evaluate(async () => {
    const h = window.hackingTheBeats;
    const fb = await import('/vendor/firebase.bundle.js');
    const db = fb.getFirestore();
    const attempt = async (action) => {
      try {
        const result = await action();
        return result?.exists && !result.exists() ? 'missing' : 'allowed';
      } catch (error) {
        return error.code || String(error);
      }
    };
    return {
      mode: h.app.libraryMode,
      songs: h.app.songs.map((song) => `${song.title}:${song.code ? 'code' : 'no code'}`),
      onDeck: h.players.A.song.title,
      featured: await attempt(() => fb.getDoc(fb.doc(db, 'beats', 't2'))),
      other: await attempt(() => fb.getDoc(fb.doc(db, 'beats', 't1'))),
      hidden: await attempt(() => fb.getDoc(fb.doc(db, 'beats', 't3'))),
      list: await attempt(() => fb.getDocs(fb.collection(db, 'beats'))),
      catalog: await attempt(() => fb.getDoc(fb.doc(db, 'catalog', 'public'))),
    };
  });
  check('signed out, only the featured beat arrives with its code', given.mode === 'database' && given.songs.join() === 'Beta:code,Alpha:no code' && given.onDeck === 'Beta', JSON.stringify(given.songs));
  check('rules: signed out, the database gives the catalog and the featured beat, nothing else', given.catalog === 'allowed' && given.featured === 'allowed' && denied(given.other) && denied(given.hidden) && denied(given.list), JSON.stringify(given));
  // the starter: a new member's own copy of the featured beat
  await passerby.evaluate(() => document.querySelector('.beat[data-id="t1"] .beat__main').click());
  await settle(passerby);
  await passerby.evaluate(() => window.hackingTheBeats.cloud.signInForTest({ sub: 'std', email: 'std@example.com', name: 'Standard User' }));
  await passerby.waitForFunction(() => window.hackingTheBeats.players.A.song?.id === 't1' && window.hackingTheBeats.players.A.ready, null, { timeout: 30000 });
  const member = await passerby.evaluate(async () => {
    const h = window.hackingTheBeats;
    const fb = await import('/vendor/firebase.bundle.js');
    const db = fb.getFirestore();
    const attempt = async (action) => {
      try {
        await action();
        return 'allowed';
      } catch (error) {
        return error.code || String(error);
      }
    };
    const featured = h.app.songs.find((song) => song.featured);
    return {
      songs: h.app.songs.map((song) => `${song.title}:${song.code ? 'code' : 'no code'}`),
      admin: h.cloud.user.admin,
      mine: h.songs.list().map((song) => song.title),
      starterIsACopy: h.songs.list()[0]?.code.replace('@title User demo', `@title ${featured.title}`) === featured.code,
      membersOnly: await attempt(() => fb.getDocs(fb.query(fb.collection(db, 'beats'), fb.where('members', '==', true)))),
      hidden: await attempt(() => fb.getDoc(fb.doc(db, 'beats', 't3'))),
      listAll: await attempt(() => fb.getDocs(fb.collection(db, 'beats'))),
      write: await attempt(() => fb.updateDoc(fb.doc(db, 'beats', 't1'), { hidden: true })),
    };
  });
  check('signed in, a member gets the featured beat and those opened to members', member.songs.join() === 'Beta:code,Alpha:code' && member.admin === false, JSON.stringify(member.songs));
  check('a new member is given "User demo": their own copy of the featured beat', member.mine.join() === 'User demo' && member.starterIsACopy, member.mine.join());
  check("rules: a member cannot read the admin's own beats or change any beat", member.membersOnly === 'allowed' && denied(member.hidden) && denied(member.listAll) && denied(member.write), JSON.stringify(member));

  // the admin adds one of their own songs: it is theirs alone until opened to members
  const added = await boss.evaluate(() => window.hackingTheBeats.songs.createBlank().id);
  await boss.click('[data-admin-tab="beats"]');
  await boss.waitForFunction((id) => [...document.getElementById('admin-song').options].some((option) => option.value === id), added);
  await boss.selectOption('#admin-song', added);
  await boss.click('#admin-publish');
  await status('Added "New song"');
  await passerby.reload();
  await arrive(passerby);
  const kept = await passerby.evaluate(() => window.hackingTheBeats.app.songs.map((song) => song.title).join());
  const bossSees = await boss.evaluate(() => window.hackingTheBeats.app.songs.map((song) => `${song.title}:${song.audience}`).join());
  await boss.locator('#admin-beats .admin__row', { hasText: 'New song' }).getByRole('button', { name: 'Members' }).click();
  await status('"New song" is open to members');
  await passerby.reload();
  await arrive(passerby);
  const opened = await passerby.evaluate(() => window.hackingTheBeats.app.songs.map((song) => song.title).join());
  check("a beat the admin adds is theirs alone until they open it to members", kept === 'Beta,Alpha' && opened === 'Beta,Alpha,New song' && bossSees === 'Beta:everyone,Alpha:members,Gamma:admin,New song:admin', `${kept} → ${opened} · ${bossSees}`);

  // the admin takes a shared song down
  await boss.click('[data-admin-tab="shared"]');
  await boss.waitForFunction((id) => document.querySelector(`#admin-shared .admin__row[data-id="${id}"]`), first, { timeout: 15000 });
  const takeDown = boss.locator(`#admin-shared .admin__row[data-id="${first}"]`).getByRole('button');
  await takeDown.click();
  await takeDown.click();
  await status('Sharing is off');
  const gone = await passerby.evaluate(({ uid, id }) => window.hackingTheBeats.cloud.getShared(uid, id), { uid: links.uid, id: first });
  const again = await owner.evaluate(async (id) => {
    const h = window.hackingTheBeats;
    const fb = await import('/vendor/firebase.bundle.js');
    // the owner's browser still thinks the song is shared; the next save finds out
    h.songs.update(id, { code: `${h.songs.get(id).code}\n// one more change` });
    await h.songs.flush();
    const local = h.songs.get(id);
    h.songs.setShared(id, true);
    await h.songs.flush();
    const remote = await h.cloud.getOwn(id);
    let forced;
    try {
      await fb.updateDoc(fb.doc(fb.getFirestore(), 'users', h.cloud.user.uid, 'songs', id), { shared: true, blocked: false });
      forced = 'allowed';
    } catch (error) {
      forced = error.code;
    }
    return { local: { shared: local.shared, blocked: local.blocked }, remote: { shared: remote.shared, blocked: remote.blocked, saved: remote.code.includes('one more change') }, forced };
  }, first);
  check('the admin can switch a shared song off, which closes its link', gone === null);
  check('its owner keeps the song and can still save it, but cannot share it again', again.local.blocked && !again.local.shared && again.remote.blocked && !again.remote.shared && again.remote.saved && denied(again.forced), JSON.stringify(again));

  check('no errors on any page', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  check('the test ran to the end', false, error.message.split('\n').slice(0, 4).join(' / '));
} finally {
  await browser.close();
  stopAll();
}

let failures = 0;
for (const [name, passed, detail] of results) {
  console.log(`${passed ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures++;
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
