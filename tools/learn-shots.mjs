// The pictures in the Learn guide, taken from the player itself. Starts its own server,
// opens the First Light demo in a headless browser, puts the player into each state the
// guide describes and writes images/learn/<name>.png. The names are what the guide's pages
// ask for (<figure data-shot="name">); tools/learn.mjs says which are missing.
//
//   node tools/learn-shots.mjs                      every shot
//   node tools/learn-shots.mjs --only coach,crate   just those
//   node tools/learn-shots.mjs --built              from dist/ (npm run build first)
//   node tools/learn-shots.mjs --phone-only         just the phone shots
//
// Needs `npx playwright install chromium` once. A shot whose set-up fails is reported and
// skipped; the run goes on. The budget is 6 MB in all and 400 KB a file: full-window shots
// are drawn at a lower pixel density (VIEWPORT_DSF) to stay inside it.
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'images/learn');
const PORT = Number(process.env.SHOTS_PORT) || 5197;
const URL = `http://localhost:${PORT}/`;
const DEMO = `${URL}beats/first-light`;
const args = process.argv.slice(2);
const built = args.includes('--built');
const phoneOnly = args.includes('--phone-only');
const onlyArg = args.find((arg) => arg.startsWith('--only'));
const only = onlyArg ? new Set((onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1] || '').split(',').filter(Boolean)) : null;
const wanted = (name) => !only || only.has(name);

// the pixel density of element crops, and of full-window shots (which are large). The
// browser draws everything at DSF; a shot asking for less is scaled down afterwards.
const DSF = 2;
const VIEWPORT_DSF = 1.5;
let scratch = null;
const BUDGET_TOTAL = 6 * 1024 * 1024;
const BUDGET_FILE = 400 * 1024;
const SETTLE = 300;

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
  throw new Error('the server did not start');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

// in the page: wait until `test` holds
const untilInPage = `(test, ms = 15000) => new Promise((resolve, reject) => {
  const end = performance.now() + ms;
  const tick = () => {
    let ok = false;
    try { ok = test(); } catch {}
    if (ok) return resolve(true);
    if (performance.now() > end) return reject(new Error('timed out waiting for ' + test.toString().slice(0, 80)));
    setTimeout(tick, 50);
  };
  tick();
})`;

// The community entry is invented: no real person or song is shown.
const COMMUNITY_MOCK = { shareId: '3f2b8c1e-9a4d-4c7b-8e21-0a1b2c3d4e5f', title: 'Glass Tide', by: 'Ana', ownerName: 'Rowan', bpm: 124, trackCount: 5, blurb: 'A warm one for late crossings.' };

const written = [];
const skipped = [];

/* ---------- one browser page, with helpers ---------- */

async function openPage(browser, { phone = false } = {}) {
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: DSF,
    serviceWorkers: 'block',
    colorScheme: 'dark',
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(() => {
    window.HTB_CONFIG = { firebase: null, analytics: null };
  });
  await context.addInitScript(`window.__until = ${untilInPage};`);
  const page = await context.newPage();
  // no blinking caret, and no status toast, unless a shot asks for it
  const quiet = () => page.addStyleTag({ content: '* { caret-color: transparent !important; } #status { opacity: 0 !important; }' });
  page.on('pageerror', (error) => console.log(`  (page error: ${error.message.split('\n')[0]})`));
  const ready = () => page.waitForFunction(() => window.hackingTheBeats?.players.A.ready || window.hackingTheBeats?.players.A.failure, null, { timeout: 60000 });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, ms) => page.evaluate(({ src, ms }) => window.__until(new Function(`return (${src})`)(), ms), { src: fn.toString(), ms });
  const click = (selector) => page.evaluate((sel) => document.querySelector(sel).click(), selector);
  const hits = () => page.waitForSelector('#pane-a .hb-hit', { timeout: 45000 });
  return { browser, context, page, ready, ev, until, click, hits, quiet };
}

// The same PNG, with its image data deflated as hard as zlib can (the browser's encoder
// settles for less, and these are a third to a half smaller for it).
function recompress(png) {
  const chunks = [];
  let data = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('latin1');
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IDAT') data.push(body);
    else chunks.push({ type, body });
    at += 12 + length;
  }
  const packed = deflateSync(inflateSync(Buffer.concat(data)), { level: 9 });
  const chunk = (type, body) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(typed));
    return Buffer.concat([head, typed, tail]);
  };
  const end = chunks.findIndex((entry) => entry.type === 'IEND');
  const out = [png.subarray(0, 8)];
  chunks.forEach((entry, i) => {
    if (i === end) out.push(chunk('IDAT', packed));
    out.push(chunk(entry.type, entry.body));
  });
  return Buffer.concat(out);
}

// A PNG scaled down by `factor`, drawn through a canvas in a scratch page of the browser.
async function shrink(browser, png, factor) {
  scratch ??= await browser.newPage();
  const dataUrl = await scratch.evaluate(
    ({ src, factor }) =>
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(image.width * factor);
          canvas.height = Math.round(image.height * factor);
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        };
        image.onerror = () => reject(new Error('could not decode the shot'));
        image.src = src;
      }),
    { src: `data:image/png;base64,${png.toString('base64')}`, factor },
  );
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// `target`: a selector, 'viewport', { selector, clip: { x, y, width, height } } (a crop of
// the element, in CSS pixels from its top left), { clip } in page pixels, or { viewport:
// true }. Any object form takes `dsf` for a lower pixel density; 'viewport' is drawn at
// VIEWPORT_DSF.
async function capture(p, name, target) {
  const path = join(outDir, `${name}.png`);
  await sleep(SETTLE);
  const options = { type: 'png', animations: 'disabled' };
  let png;
  let dsf = DSF;
  if (target === 'viewport' || target.viewport) {
    dsf = target.dsf ?? VIEWPORT_DSF;
    png = await p.page.screenshot(options);
  } else if (typeof target === 'string' || (target.selector && !target.clip)) {
    const selector = typeof target === 'string' ? target : target.selector;
    dsf = target.dsf ?? DSF;
    const locator = p.page.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout: 5000 });
    png = await locator.screenshot(options);
  } else if (target.selector) {
    dsf = target.dsf ?? DSF;
    const box = await p.page.locator(target.selector).first().boundingBox();
    if (!box) throw new Error(`${target.selector} has no box`);
    const clip = { x: box.x + (target.clip.x || 0), y: box.y + (target.clip.y || 0), width: Math.min(target.clip.width ?? box.width, box.width), height: Math.min(target.clip.height ?? box.height, box.height) };
    png = await p.page.screenshot({ ...options, clip });
  } else if (target.clip) {
    dsf = target.dsf ?? DSF;
    png = await p.page.screenshot({ ...options, clip: target.clip });
  } else {
    throw new Error('unknown target');
  }
  if (dsf < DSF) png = await shrink(p.browser, png, dsf / DSF);
  png = recompress(png);
  writeFileSync(path, png);
  const size = png.length;
  written.push({ name, size });
  console.log(`  ${name}.png  ${kb(size)}${size > BUDGET_FILE ? '  (over the per-file budget)' : ''}`);
}

// Runs one entry of the table: set up, shoot each target, tear down (always).
async function run(p, entry) {
  const names = Object.keys(entry.targets).filter(wanted);
  if (!names.length) return;
  const done = new Set();
  try {
    await entry.setup?.();
    for (const name of names) {
      if (entry.between?.[name]) await entry.between[name]();
      await capture(p, name, entry.targets[name]);
      done.add(name);
    }
  } catch (error) {
    const reason = error.message.split('\n')[0];
    const left = names.filter((name) => !done.has(name));
    console.log(`  skipped ${left.join(', ')}: ${reason}`);
    left.forEach((name) => skipped.push({ name, reason }));
  } finally {
    try {
      await entry.teardown?.();
    } catch (error) {
      console.log(`  (teardown of ${names.join(', ')} failed: ${error.message.split('\n')[0]})`);
    }
  }
}

/* ---------- the desktop shots ---------- */

async function desktop(browser) {
  const p = await openPage(browser);
  const { page, ev, until, click } = p;
  const h = (fn, arg) => ev(fn, arg);

  const open = async () => {
    await page.goto(DEMO);
    await p.ready();
    await p.quiet();
    const slug = await ev(() => window.hackingTheBeats.players.A.song?.slug);
    if (slug !== 'first-light') throw new Error(`First Light did not open (deck A has ${slug})`);
  };
  // back to First Light, playing, after a shot that changed the song
  const reopenFirstLight = async () => {
    await ev(() => {
      const w = window.hackingTheBeats;
      const song = w.app.songs.find((s) => s.slug === 'first-light');
      document.querySelector(`.beat[data-id="${CSS.escape(song.id)}"] .beat__deck[data-deck="A"]`).click();
    });
    await until(() => window.hackingTheBeats.players.A.song?.slug === 'first-light' && window.hackingTheBeats.players.A.ready, 30000);
    await until(() => window.hackingTheBeats.players.A.started, 30000);
    await page.waitForSelector('#pane-a .hb-hit', { timeout: 30000 });
  };
  // the code as it was saved, then playing again
  const revert = async () => {
    await ev(() => {
      const A = window.hackingTheBeats.players.A;
      if (A.edited || A.dirty) document.getElementById('revert').click();
    });
    await until(() => window.hackingTheBeats.players.A.ready && !window.hackingTheBeats.players.A.edited, 20000);
    await until(() => window.hackingTheBeats.players.A.started, 20000);
    await ev(() => window.hackingTheBeats.players.A.stage.editing && document.getElementById('edit').click());
  };
  const edit = async () => {
    await ev(() => !window.hackingTheBeats.players.A.stage.editing && document.getElementById('edit').click());
    await until(() => window.hackingTheBeats.players.A.stage.editing);
  };
  const insertAtTop = async (text) => {
    await ev((text) => window.hackingTheBeats.players.A.mirror.editor.dispatch({ changes: { from: 0, insert: text }, userEvent: 'input.type' }), text);
  };
  // a real drag across the arrangement strip, from bar `from` to bar `to` (counted from 1)
  const dragBars = async (from, to, row = null) => {
    const box = await page.locator('#ribbon').boundingBox();
    const x = (bar) => box.x + (box.width * (bar - 0.5)) / 32;
    let y = box.y + box.height / 2;
    if (row !== null) {
      // the first y the strip counts as that track's row
      const offset = await ev(
        ({ row, top, height }) => {
          const w = window.hackingTheBeats;
          const rows = w.players.A.mixer.tracks.length;
          const ys = [];
          for (let y = 0; y < height; y++) if (w.visuals.rowAt(top + y, rows) === row) ys.push(y);
          if (!ys.length) throw new Error(`no row ${row} on the strip`);
          return ys[Math.floor(ys.length / 2)];
        },
        { row, top: box.y, height: box.height },
      );
      y = box.y + offset;
    }
    await page.mouse.move(x(from), y);
    await page.mouse.down();
    await page.mouse.move(x(from + 1), y, { steps: 4 });
    await page.mouse.move(x(to), y, { steps: 10 });
    await page.mouse.up();
    await page.waitForSelector('#trimbar:not([hidden])', { timeout: 5000 });
  };
  const ribbonOpen = (open) => ev((open) => document.getElementById('ribbon-row').classList.contains('is-open') !== open && document.getElementById('ribbon-toggle').click(), open);
  const cancelTrim = () => ev(() => window.hackingTheBeats.trim.act('cancel'));
  const clipOfLine = async (needle, { above = 100, height = 260 } = {}) => {
    // the pane cropped around the line that holds `needle`
    const y = await ev(({ needle, above }) => {
      const A = window.hackingTheBeats.players.A;
      const at = A.code.indexOf(needle);
      if (at < 0) throw new Error(`the code has no "${needle}"`);
      const view = A.stage.view;
      const block = view.lineBlockAt(at);
      view.scrollDOM.scrollTop = Math.max(0, block.top - above - 10);
      return block.top - view.scrollDOM.scrollTop + view.contentDOM.offsetTop;
    }, { needle, above });
    await sleep(200);
    return { selector: '#pane-a', clip: { y: Math.max(0, y - above), height } };
  };
  // one crop around several elements (a bar and the toolbar floating over it, say)
  const unionClip = (selectors, pad = 0) =>
    ev(({ selectors, pad }) => {
      const boxes = selectors.map((sel) => document.querySelector(sel)).filter((el) => el && !el.hidden).map((el) => el.getBoundingClientRect()).filter((box) => box.width && box.height);
      if (!boxes.length) throw new Error(`nothing to crop among ${selectors.join(', ')}`);
      const left = Math.max(0, Math.min(...boxes.map((box) => box.left)) - pad);
      const top = Math.max(0, Math.min(...boxes.map((box) => box.top)) - pad);
      const right = Math.min(innerWidth, Math.max(...boxes.map((box) => box.right)) + pad);
      const bottom = Math.min(innerHeight, Math.max(...boxes.map((box) => box.bottom)) + pad);
      return { clip: { x: left, y: top, width: right - left, height: bottom - top } };
    }, { selectors, pad });

  console.log('\ndesktop 1440×900');
  await open();
  let featuredWas;

  /* before anything plays */
  const prePlay = [
    { targets: { curtain: { selector: '#curtain', dsf: VIEWPORT_DSF }, 'first-screen': 'viewport' } },
    {
      setup: () => h(() => window.hackingTheBeats.setAccess('preview')),
      targets: { 'signed-out-first-screen': 'viewport', 'signed-out-intro': '#intro' },
      teardown: () => h(() => window.hackingTheBeats.setAccess('full')),
    },
    {
      setup: async () => {
        featuredWas = await h(() => {
          const w = window.hackingTheBeats;
          const was = w.app.songs.map((s) => Boolean(s.featured));
          w.app.songs.forEach((s) => (s.featured = true));
          w.setAccess('preview');
          return was;
        });
        await page.waitForSelector('#featured-picks:not([hidden])', { timeout: 3000 });
      },
      targets: { 'featured-chips': '.decks' },
      teardown: () =>
        h((was) => {
          const w = window.hackingTheBeats;
          w.app.songs.forEach((s, i) => (s.featured = was[i]));
          w.setAccess('full');
        }, featuredWas),
    },
    {
      // a beat that is not featured, chosen signed out: the stage says it needs an account
      setup: async () => {
        await h(() => {
          const w = window.hackingTheBeats;
          w.setAccess('preview');
          const locked = w.app.songs.find((s) => s.source === 'beats' && !s.featured && !s.broken);
          if (!locked) throw new Error('every beat is featured');
          w.crate.open('A');
          document.querySelector(`.beat[data-id="${CSS.escape(locked.id)}"] .beat__main`).click();
        });
        await page.waitForSelector('#locked:not([hidden])', { timeout: 3000 });
      },
      targets: { 'locked-beat': '#locked' },
      teardown: async () => {
        await h(() => {
          window.hackingTheBeats.crate.dialog.open && window.hackingTheBeats.crate.dialog.close();
          window.hackingTheBeats.setAccess('full');
        });
        await page.goto(DEMO);
        await p.ready();
        await p.quiet();
      },
    },
    {
      setup: async () => {
        await h(() => {
          window.hackingTheBeats.setAccess('preview');
          document.getElementById('edit').click();
        });
        await page.waitForSelector('#account-dialog[open]', { timeout: 3000 });
      },
      targets: { 'account-dialog': '#account-dialog' },
      teardown: () =>
        h(() => {
          document.getElementById('account-dialog').close();
          window.hackingTheBeats.setAccess('full');
        }),
    },
    {
      // someone else's song: the curtain credits who shared it; untrusted, the gate asks first
      setup: async () => {
        await h(() => {
          const A = window.hackingTheBeats.players.A;
          return A.load({ ...A.song, id: 'example-shared', source: 'shared', ownerName: 'Rowan' }, { trust: true });
        });
        await until(() => window.hackingTheBeats.players.A.ready, 30000);
      },
      targets: { 'curtain-shared-by': { selector: '#curtain', dsf: VIEWPORT_DSF }, 'gate-shared': '#gate' },
      between: {
        'gate-shared': async () => {
          await h(() => {
            const A = window.hackingTheBeats.players.A;
            return A.load({ ...A.song }, { trust: false });
          });
          await page.waitForSelector('#gate:not([hidden])', { timeout: 5000 });
        },
      },
      teardown: async () => {
        await page.goto(DEMO);
        await p.ready();
        await p.quiet();
      },
    },
  ];
  for (const entry of prePlay) await run(p, entry);

  /* play */
  await page.click('#curtain-play');
  await p.hits();
  await h(() => {
    window.hackingTheBeats.master.setVolume(0.03);
    window.hackingTheBeats.onboarding.setOpen(false);
  });
  await sleep(1500);

  let padShot = null;
  let snapId = null;
  let madeSong = null;

  const playing = [
    { targets: { 'player-overview': 'viewport', topbar: 'header.topbar', 'topbar-actions': '.actions' } },
    {
      setup: () => h(() => !window.hackingTheBeats.app.follow && document.getElementById('follow').click()),
      targets: { 'stage-lit': '#pane-a' },
    },
    {
      setup: async () => {
        await h(() => {
          const w = window.hackingTheBeats;
          if (w.app.follow) document.getElementById('follow').click();
          w.players.A.stage.view.scrollDOM.scrollTop = 0;
        });
        await page.waitForSelector('#pane-a .cm-slider input', { timeout: 5000 });
      },
      targets: { 'stage-inline-sliders': () => clipOfLine('= slider(', { above: 60, height: 240 }) },
    },
    { targets: { stagebar: '.stagebar' } },
    { setup: edit, targets: { 'stagebar-editing': '.stagebar' }, teardown: () => h(() => window.hackingTheBeats.players.A.stage.editing && document.getElementById('edit').click()) },
    {
      setup: async () => {
        await edit();
        await insertAtTop('// a thought\n');
        await click('#update');
        await until(() => !window.hackingTheBeats.players.A.dirty && window.hackingTheBeats.players.A.edited, 10000);
        await h(() => (window.hackingTheBeats.players.A.stage.view.scrollDOM.scrollTop = 0));
        await page.waitForSelector('#pane-a .cm-line.hb-changed', { timeout: 5000 });
      },
      targets: { 'stagebar-unsaved': '.stagebar', 'code-changed-lines': '#pane-a' },
      teardown: revert,
    },
    {
      setup: async () => {
        await edit();
        await insertAtTop('const oops = (\n');
        await h(() => window.hackingTheBeats.players.A.update());
        await page.waitForSelector('#notice:not([hidden])', { timeout: 5000 });
      },
      targets: { 'notice-error': '#notice' },
      teardown: async () => {
        await h(() => {
          const A = window.hackingTheBeats.players.A;
          A.mirror.editor.dispatch({ changes: { from: 0, to: 'const oops = (\n'.length, insert: '' }, userEvent: 'input.type' });
          return A.update();
        });
        await revert();
      },
    },
    {
      targets: { tries: '#tries', 'tries-on': '#tries' },
      between: {
        'tries-on': async () => {
          await click('#tries .tries__chip');
          await page.waitForSelector('#tries .tries__chip[aria-pressed="true"]', { timeout: 10000 });
        },
      },
      teardown: async () => {
        await h(() => document.querySelector('#tries .tries__chip[aria-pressed="true"]')?.click());
        await until(() => !document.querySelector('#tries .tries__chip[aria-pressed="true"]'), 10000);
      },
    },
    {
      setup: async () => {
        await h(() => !document.body.classList.contains('map-docked') && document.getElementById('map-toggle').click());
        await page.waitForSelector('#map .map__item--part', { timeout: 5000 });
      },
      targets: { 'song-map': '#map', 'song-map-card': () => unionClip(['#map', '#map-card'], 8) },
      between: {
        'song-map-card': async () => {
          await h(() => {
            const last = [...document.querySelectorAll('#map .map__item--part')].at(-1);
            last.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          });
          await page.waitForSelector('#map-card:not([hidden])', { timeout: 3000 });
        },
      },
      teardown: () => h(() => window.hackingTheBeats.songMap.setOpen(false)),
    },
    { targets: { arrangement: '#ribbon-row', 'arrangement-open': '#ribbon-row' }, between: { 'arrangement-open': () => ribbonOpen(true) }, teardown: () => ribbonOpen(false) },
    { setup: () => dragBars(9, 16), targets: { 'arrangement-trimbar': () => unionClip(['#ribbon-row', '#trimbar']) }, teardown: cancelTrim },
    {
      setup: async () => {
        await ribbonOpen(true);
        await sleep(300);
        await dragBars(9, 16, 1);
      },
      targets: { 'arrangement-silence': () => unionClip(['#ribbon-row', '#trimbar']) },
      teardown: async () => {
        await cancelTrim();
        await ribbonOpen(false);
      },
    },
    {
      setup: async () => {
        await dragBars(9, 16);
        await click('#trimbar [data-act="cut"]');
        await until(() => window.hackingTheBeats.players.A.code.includes('all(x => arrange(') && !window.hackingTheBeats.players.A.dirty, 15000);
      },
      targets: { 'arrangement-cut-code': () => clipOfLine('all(x => arrange(') },
      teardown: async () => {
        await h(() => document.querySelector('#trimbar [data-act="undo"]')?.click());
        await sleep(500);
        await revert();
      },
    },
    { targets: { 'deck-knobs': '.panel--knobs', 'deck-knob': '#knobs .knob' } },
    {
      setup: async () => {
        await h(() => {
          const w = window.hackingTheBeats;
          const song = w.app.songs.find((s) => s.code?.includes('const mood'));
          if (!song) throw new Error('no beat with a switch');
          document.querySelector(`.beat[data-id="${CSS.escape(song.id)}"] .beat__deck[data-deck="A"]`).click();
        });
        await until(() => window.hackingTheBeats.players.A.code.includes('const mood') && window.hackingTheBeats.players.A.ready, 30000);
        await page.waitForSelector('#knobs .knob--switch', { timeout: 5000 });
        await sleep(800);
      },
      targets: { 'deck-switch': '#knobs .knob--switch' },
      teardown: reopenFirstLight,
    },
    { targets: { 'deck-mixer': '.panel--mixer', 'deck-strip': '#strips .strip' } },
    {
      setup: () =>
        h(() => {
          const A = window.hackingTheBeats.players.A;
          A.mixer.setMute(1, true);
          A.mixer.setSolo(0, true);
        }),
      targets: { 'deck-mixer-mute-solo': '.panel--mixer' },
      teardown: () =>
        h(() => {
          const A = window.hackingTheBeats.players.A;
          A.mixer.setMute(1, false);
          A.mixer.setSolo(0, false);
        }),
    },
    {
      // a sound the packs do not have: the strip says so
      setup: async () => {
        await edit();
        await h(() => {
          const A = window.hackingTheBeats.players.A;
          const at = A.mirror.code.indexOf('s("bd');
          if (at < 0) throw new Error('no s("bd in the code');
          A.mirror.editor.dispatch({ changes: { from: at, to: at + 's("bd'.length, insert: 's("nosuchkick' }, userEvent: 'input.type' });
        });
        await click('#update');
        await page.waitForSelector('#strips .strip.is-missing', { timeout: 15000 });
        await sleep(500);
      },
      targets: { 'deck-strip-missing': '#strips .strip.is-missing' },
      teardown: revert,
    },
    {
      targets: { 'deck-capture-length': '#cap-length', 'deck-capture-armed': '#strips .strip:has(.strip__action[data-state="armed"])' },
      between: {
        'deck-capture-armed': async () => {
          await h(() => {
            const w = window.hackingTheBeats;
            w.snapshots.arm(w.players.A, 0, 8);
          });
          await page.waitForSelector('#strips .strip__action[data-state="armed"]', { timeout: 5000 });
        },
      },
      teardown: () => h(() => window.hackingTheBeats.snapshots.cancel()),
    },
    {
      targets: { 'deck-pads': '.panel--pads', 'deck-pad-latched': '[data-learn-shot="pad"]' },
      between: {
        'deck-pad-latched': async () => {
          padShot = await h(() => {
            const w = window.hackingTheBeats;
            if (!w.deck.latch) document.getElementById('pads-latch').click();
            const pad = w.deck.pads.get('w');
            pad.el.dataset.learnShot = 'pad';
            pad.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            pad.el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
            return pad.isOn();
          });
          if (!padShot) throw new Error('the pad did not latch');
        },
      },
      teardown: () =>
        h(() => {
          const w = window.hackingTheBeats;
          const pad = w.deck.pads.get('w');
          delete pad.el.dataset.learnShot;
          if (pad.isOn()) pad.release();
          if (w.deck.latch) document.getElementById('pads-latch').click();
        }),
    },
    {
      // one bar of the first channel, captured onto a snapshot pad
      setup: async () => {
        await h(() => {
          const w = window.hackingTheBeats;
          w.snapshots.arm(w.players.A, 0, 1);
        });
        await until(() => Boolean(window.hackingTheBeats.snapshots.at(0)), 20000);
        snapId = await h(() => {
          const w = window.hackingTheBeats;
          w.deck.showBank('snaps');
          return w.snapshots.at(0).id;
        });
        await sleep(400);
      },
      targets: { 'deck-snaps': '#snaps', 'snapshot-sheet': '#snap-sheet' },
      between: {
        'snapshot-sheet': async () => {
          await h((id) => window.hackingTheBeats.deck.openSnapMenu(id), snapId);
          await page.waitForSelector('#snap-sheet[open]', { timeout: 3000 });
        },
      },
      teardown: () =>
        h((id) => {
          const w = window.hackingTheBeats;
          document.getElementById('snap-sheet').open && document.getElementById('snap-sheet').close();
          if (id) w.snapshots.remove(id);
          w.deck.showBank('fx');
        }, snapId),
    },
    { targets: { 'deck-master': '.panel--master', 'deck-mixrow': '.mixrow' } },
    {
      setup: async () => {
        await h(() => !window.hackingTheBeats.app.split && document.getElementById('split').click());
        await page.waitForSelector('#empty-b', { state: 'visible', timeout: 3000 });
      },
      targets: { 'deck-b-empty': '#empty-b' },
      teardown: () => h(() => window.hackingTheBeats.app.split && document.getElementById('split').click()),
    },
    {
      setup: async () => {
        await h(() => {
          const w = window.hackingTheBeats;
          const song = w.app.songs.find((s) => s.slug === 'clockwork') || w.app.songs.find((s) => s.slug !== 'first-light' && !s.broken && s.trackCount > 0);
          document.querySelector(`.beat[data-id="${CSS.escape(song.id)}"] .beat__deck[data-deck="B"]`).click();
        });
        await until(() => window.hackingTheBeats.players.B.ready, 30000);
        await click('#play-b');
        await until(() => window.hackingTheBeats.players.B.started, 30000);
        await h(() => !window.hackingTheBeats.app.split && document.getElementById('split').click());
        await page.waitForSelector('#pane-b .hb-hit', { timeout: 15000 });
        await sleep(1000);
      },
      // (two panes of lit code: the busiest picture, so a little less dense)
      targets: { 'decks-two': '.decks', 'split-view': { viewport: true, dsf: 1.25 } },
      teardown: () =>
        h(() => {
          const w = window.hackingTheBeats;
          w.players.B.stop();
          if (w.app.split) document.getElementById('split').click();
        }),
    },
    {
      setup: async () => {
        await click('#gallery');
        await page.waitForFunction(() => document.body.classList.contains('is-gallery'), null, { timeout: 3000 });
        await sleep(700);
      },
      targets: { gallery: 'viewport' },
      teardown: async () => {
        await click('#hud-exit');
        await page.waitForFunction(() => !document.body.classList.contains('is-gallery'), null, { timeout: 3000 });
      },
    },
    {
      setup: async () => {
        await h(() => window.hackingTheBeats.onboarding.setOpen(true));
        await page.waitForSelector('#coach:not([hidden])', { timeout: 3000 });
      },
      targets: { coach: '#coach', 'coach-end': '#coach' },
      between: {
        'coach-end': async () => {
          await h(() => {
            const w = window.hackingTheBeats;
            for (const id of ['play', 'knob', 'mute', 'tweak', 'save', 'share']) w.onboarding.done(id);
            w.onboarding.setOpen(true);
          });
          await page.waitForSelector('#coach-end:not([hidden])', { timeout: 3000 });
        },
      },
      teardown: () =>
        h(() => {
          const w = window.hackingTheBeats;
          w.onboarding.restart();
          w.onboarding.setOpen(false);
        }),
    },
    {
      setup: async () => {
        await h(() => window.hackingTheBeats.crate.open('A'));
        await page.waitForSelector('#crate[open]', { timeout: 3000 });
      },
      targets: { crate: '#crate', 'crate-starters': '#crate', 'crate-song-menu': '#crate' },
      between: {
        'crate-starters': async () => {
          await click('#song-new');
          await page.waitForSelector('#starters .starter', { state: 'visible', timeout: 3000 });
        },
        'crate-song-menu': async () => {
          await click('.starter[data-starter="loop"]');
          await until(() => window.hackingTheBeats.players.A.own && window.hackingTheBeats.players.A.ready, 20000);
          madeSong = await h(() => {
            const w = window.hackingTheBeats;
            if (w.players.A.stage.editing) document.getElementById('edit').click();
            const id = w.players.A.song.id;
            w.crate.open('A');
            document.querySelector(`.beat[data-id="${CSS.escape(id)}"] .beat__tool`).click();
            return id;
          });
          await page.waitForSelector('#crate .beat__menu', { timeout: 3000 });
        },
      },
      teardown: async () => {
        await h((id) => {
          const w = window.hackingTheBeats;
          w.crate.dialog.open && w.crate.dialog.close();
          if (id) w.songs.remove(id);
        }, madeSong);
        await reopenFirstLight();
      },
    },
    {
      setup: async () => {
        await h((mock) => {
          const w = window.hackingTheBeats;
          w.crate.render({ mine: w.songs.list(), beats: w.app.songs, community: [mock] }, (song) => w.thumbs.get(song));
          w.crate.open('A');
        }, COMMUNITY_MOCK);
        await page.waitForSelector('#community-section:not([hidden])', { timeout: 3000 });
      },
      targets: { 'community-shelf': '#community-section' },
      teardown: () =>
        h(() => {
          const w = window.hackingTheBeats;
          w.crate.dialog.open && w.crate.dialog.close();
          w.crate.render({ mine: w.songs.list(), beats: w.app.songs, community: w.app.community || [] }, (song) => w.thumbs.get(song));
          w.crate.setLoaded({ A: w.players.A.song?.id, B: w.players.B.song?.id });
        }),
    },
    {
      setup: async () => {
        await click('#share');
        await page.waitForSelector('#share-sheet[open]', { timeout: 3000 });
      },
      targets: { 'share-sheet': '#share-sheet' },
      teardown: () => h(() => document.getElementById('share-sheet').open && document.getElementById('share-close').click()),
    },
    {
      setup: async () => {
        await h(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true })));
        await page.waitForSelector('#clip[open]', { timeout: 3000 });
      },
      targets: { 'clip-sheet': '#clip' },
      teardown: () => h(() => document.getElementById('clip').open && document.getElementById('clip-close').click()),
    },
    {
      setup: async () => {
        await edit();
        await insertAtTop('// a thought\n');
        await click('#update');
        await until(() => !window.hackingTheBeats.players.A.dirty && window.hackingTheBeats.players.A.edited, 10000);
        await h(() => {
          const w = window.hackingTheBeats;
          const other = w.app.songs.find((s) => s.slug !== 'first-light' && !s.broken);
          document.querySelector(`.beat[data-id="${CSS.escape(other.id)}"] .beat__main`).click();
        });
        await page.waitForSelector('#unsaved-dialog[open]', { timeout: 3000 });
      },
      targets: { 'unsaved-dialog': '#unsaved-dialog' },
      teardown: async () => {
        await h(() => document.getElementById('unsaved-dialog').open && document.getElementById('unsaved-cancel').click());
        await sleep(200);
        await revert();
      },
    },
    {
      setup: async () => {
        await click('#open-about');
        await page.waitForSelector('#about[open]', { timeout: 3000 });
      },
      targets: { 'help-sheet': '#about', 'help-sheet-keys': '#about dl.keys', 'help-sheet-midi': () => midiClip() },
      teardown: () => h(() => document.getElementById('about').open && document.getElementById('about').close()),
    },
    {
      setup: () => page.waitForSelector('#coach-toggle:not([hidden])', { timeout: 3000 }),
      targets: { 'ribbon-tools': '.ribbon__tools' },
    },
    {
      setup: async () => {
        await click('#open-about');
        await page.waitForSelector('#about[open]', { timeout: 3000 });
        await click('#about a[href="learn/start#listener"]');
        await page.waitForSelector('#page-sheet[open] .readpage__toc', { timeout: 10000 });
        await sleep(600);
      },
      targets: { 'learn-lightbox': '#page-sheet' },
      teardown: () =>
        h(() => {
          document.getElementById('page-sheet').open && document.getElementById('page-sheet').close();
          document.getElementById('about').open && document.getElementById('about').close();
        }),
    },
    {
      // an example from the guide, opened the way the guide opens it, and played
      setup: async () => {
        await page.goto(`${URL}#start=code-becomes-controls`);
        await p.ready();
        await p.quiet();
        await until(() => window.hackingTheBeats.players.A.song?.source === 'example', 10000);
        await page.click('#curtain-play');
        await p.hits();
        await h(() => {
          window.hackingTheBeats.master.setVolume(0.03);
          window.hackingTheBeats.onboarding.setOpen(false);
        });
        await sleep(1500);
      },
      targets: { 'example-on-deck': 'viewport' },
    },
  ];

  // the MIDI block of the help sheet: its heading down to its note
  const midiClip = async () => {
    await h(() => {
      const heading = [...document.querySelectorAll('#about h3')].find((el) => /MIDI/.test(el.textContent));
      heading.scrollIntoView({ block: 'start' });
      document.querySelector('#about .sheet__body').scrollTop -= 16;
    });
    await sleep(200);
    return page.evaluate(() => {
      const heading = [...document.querySelectorAll('#about h3')].find((el) => /MIDI/.test(el.textContent));
      const note = document.getElementById('midi-status').parentElement.querySelector('#midi-clear').closest('.sheet__row').nextElementSibling;
      const body = document.querySelector('#about .sheet__body').getBoundingClientRect();
      const top = heading.getBoundingClientRect().top;
      const bottom = note.getBoundingClientRect().bottom;
      return { clip: { x: body.left, y: top - 12, width: body.width, height: bottom - top + 24 } };
    });
  };

  for (const entry of playing) {
    // a target given as a function is worked out at shooting time
    for (const [name, target] of Object.entries(entry.targets)) {
      if (typeof target === 'function') {
        const before = entry.between?.[name];
        entry.between = {
          ...entry.between,
          [name]: async () => {
            await before?.();
            entry.targets[name] = await target();
          },
        };
      }
    }
    await run(p, entry);
  }
  await p.context.close();
}

/* ---------- the phone shots ---------- */

async function phone(browser) {
  const p = await openPage(browser, { phone: true });
  const { page, ev, until } = p;
  console.log('\nphone 390×844');
  try {
    await page.goto(DEMO);
    await p.ready();
    await p.quiet();
  } catch (error) {
    console.log(`  skipped the phone shots: ${error.message.split('\n')[0]}`);
    await p.context.close();
    return;
  }
  await run(p, { targets: { 'phone-first-screen': 'viewport' } });
  await run(p, {
    setup: async () => {
      await page.tap('#curtain-play');
      await until(() => window.hackingTheBeats.players.A.started, 45000);
      await p.hits();
      await ev(() => {
        window.hackingTheBeats.master.setVolume(0.03);
        window.hackingTheBeats.onboarding.setOpen(false);
      });
      await sleep(1500);
    },
    targets: { 'phone-player': 'viewport', 'phone-topbar': 'header.topbar' },
  });
  await run(p, {
    setup: async () => {
      await page.tap('#map-toggle');
      await page.waitForSelector('#map .map__item--part', { timeout: 5000 });
    },
    // (the map is a sheet over the code: the whole screen shows where it sits)
    targets: { 'phone-map': 'viewport' },
    teardown: () => ev(() => window.hackingTheBeats.songMap.setOpen(false)),
  });
  await run(p, { targets: { 'phone-deck-tabs': '.deck' } });
  await run(p, {
    setup: async () => {
      await page.tap('#edit');
      await until(() => window.hackingTheBeats.players.A.stage.editing);
    },
    targets: { 'phone-edit': '.stagebar' },
    teardown: () => ev(() => window.hackingTheBeats.players.A.stage.editing && document.getElementById('edit').click()),
  });
  await p.context.close();
}

/* ---------- run ---------- */

mkdirSync(outDir, { recursive: true });
await waitForServer();
const browser = await chromium.launch({ args: ['--disable-audio-output'] });
try {
  if (!phoneOnly) await desktop(browser);
  await phone(browser);
} finally {
  await scratch?.close();
  await browser.close();
}
stopServer();

const total = written.reduce((sum, file) => sum + file.size, 0);
const big = written.filter((file) => file.size > BUDGET_FILE);
console.log(`\n${written.length} picture(s), ${kb(total)} in all`);
if (big.length) console.log(`over ${kb(BUDGET_FILE)} each: ${big.map((file) => `${file.name} (${kb(file.size)})`).join(', ')}`);
if (total > BUDGET_TOTAL) console.log(`WARNING: ${kb(total)} is over the ${kb(BUDGET_TOTAL)} budget. Lower VIEWPORT_DSF, or drop a full-window shot.`);
if (skipped.length) {
  console.log(`\nskipped:`);
  for (const { name, reason } of skipped) console.log(`  ${name}: ${reason}`);
}
process.exit(0);
