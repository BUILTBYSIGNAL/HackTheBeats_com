import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIME_TYPES,
  pickMimeType,
  fileExtension,
  FORMATS,
  resolutionFor,
  frameLayout,
  clipFilename,
  describeClip,
  siteAddress,
  audibleCycle,
  nextBarLine,
  clipPhase,
  lengthOptions,
  defaultBars,
  HapWindow,
  tokenizeLines,
  lineIndexAt,
  wrapLine,
  layoutCode,
  rectsFor,
  spanOf,
  fitCode,
  ClipCamera,
  viewTop,
  fitTitle,
} from '../../js/clip-core.js';

// an invented song, for the code-drawing tests
const SONG = `/*
  @title Paper Kites
  @by Nobody In Particular
*/
setcps(96/60/4)
const air = slider(0.4, 0, 1)

KEYS: note("<c3 eb3 g3 bb3>*2").s("triangle").gain(air)
  ._punchcard()
// a quiet line
HATS: s("hh*8").gain(.35)`;

/* ---------- the file ---------- */

test('the best type the browser can write is chosen, in order', () => {
  assert.equal(pickMimeType(() => true), MIME_TYPES[0]);
  assert.equal(pickMimeType((type) => type.startsWith('video/webm')), 'video/webm;codecs=vp9,opus');
  assert.equal(pickMimeType((type) => type === 'video/webm;codecs=vp8,opus' || type === 'video/webm'), 'video/webm;codecs=vp8,opus');
  assert.equal(pickMimeType((type) => type === 'video/mp4'), 'video/mp4');
  assert.equal(pickMimeType(() => false), null);
  assert.equal(pickMimeType(undefined), null);
  // a browser that throws for a type it does not know simply cannot write it
  assert.equal(pickMimeType((type) => (type.includes('avc1') ? (() => { throw new Error('no'); })() : type === 'video/webm')), 'video/webm');
});

test('MP4 is made at full size, WebM at 720p; both shapes', () => {
  assert.deepEqual(resolutionFor('9:16', 'video/mp4;codecs=avc1,mp4a.40.2'), { width: 1080, height: 1920, scale: 1 });
  assert.deepEqual(resolutionFor('1:1', 'video/mp4'), { width: 1080, height: 1080, scale: 1 });
  const webm = resolutionFor('9:16', 'video/webm;codecs=vp8,opus');
  assert.equal(webm.width, 720);
  assert.equal(webm.height, 1280);
  assert.ok(Math.abs(webm.scale - 2 / 3) < 1e-9);
  assert.deepEqual(resolutionFor('1:1', 'video/webm').width, 720);
  // an unknown shape is the vertical one
  assert.equal(resolutionFor('4:3', 'video/mp4').height, 1920);
  assert.equal(fileExtension('video/mp4;codecs=avc1'), 'mp4');
  assert.equal(fileExtension('video/webm;codecs=vp9,opus'), 'webm');
});

test('in 9:16 the words and code keep clear of the apps\' buttons and captions', () => {
  const layout = frameLayout('9:16');
  const inside = (box) => box.x >= 72 && box.x + box.w <= 1080 - 150 && box.y >= 150 && box.y + box.h <= 1920 - 400;
  assert.ok(inside(layout.header), JSON.stringify(layout.header));
  assert.ok(inside(layout.code), JSON.stringify(layout.code));
  assert.ok(inside(layout.footer), JSON.stringify(layout.footer));
  assert.ok(layout.code.y >= layout.header.y + layout.header.h);
  assert.ok(layout.code.y + layout.code.h <= layout.footer.y);
  assert.ok(layout.code.h > 800);
  assert.equal(FORMATS['9:16'].label, 'Vertical 9:16');
});

test('the square shape stacks header, code, scope and footer inside its margins', () => {
  const layout = frameLayout('1:1');
  const order = [layout.header, layout.code, layout.scope, layout.footer];
  for (let k = 1; k < order.length; k++) assert.ok(order[k].y >= order[k - 1].y + order[k - 1].h, `part ${k} overlaps`);
  assert.ok(layout.footer.y + layout.footer.h <= 1080 - 64);
  assert.ok(layout.code.h > 400);
});

test('a clip is named after the song, and says what it is', () => {
  const date = new Date('2026-03-04T05:06:07Z');
  assert.equal(clipFilename({ title: 'Paper Kites', type: 'video/mp4', date }), 'hacking-the-beats Paper Kites clip 2026-03-04-05-06.mp4');
  assert.equal(clipFilename({ title: 'What?! / Why', type: 'video/webm', date }), 'hacking-the-beats What Why clip 2026-03-04-05-06.webm');
  assert.equal(clipFilename({ title: '', type: 'video/webm', date }), 'hacking-the-beats clip clip 2026-03-04-05-06.webm');
  assert.equal(describeClip({ type: 'video/mp4;codecs=avc1', width: 1080, height: 1920, size: 4.24 * 1048576, seconds: 16.2 }), 'MP4 · 1080 × 1920 · 4.2 MB · 16 s');
  assert.equal(describeClip({ type: 'video/webm', width: 720, height: 720, size: 30000, seconds: 0.4 }), 'WebM · 720 × 720 · 29 KB · 1 s');
});

test("the address at the foot is the beat's own page, or the site", () => {
  assert.equal(siteAddress('https://beats.example.org', 'paper-kites'), 'beats.example.org/beats/paper-kites');
  assert.equal(siteAddress('http://localhost:5173', null), 'localhost:5173');
  assert.equal(siteAddress('', 'x'), '');
});

/* ---------- time ---------- */

test('what is heard runs behind the scheduler by its latency less one tick', () => {
  assert.ok(Math.abs(audibleCycle({ now: 10, cps: 0.5 }) - (10 - 0.05 * 0.5)) < 1e-12);
  assert.ok(Math.abs(audibleCycle({ now: 3, cps: 1, latency: 0.2, tick: 0.05 }) - 2.85) < 1e-12);
});

test('the next bar line comes after the count-in, and follows a deck that was moved', () => {
  assert.equal(nextBarLine(2.3), 3);
  assert.equal(nextBarLine(2.3, { lead: 0.8 }), 4);
  assert.equal(nextBarLine(3, { lead: 0 }), 3);
  // a deck nudged by a tenth of a bar has its bar lines a tenth earlier on its clock
  assert.ok(Math.abs(nextBarLine(2.3, { shift: 0.1 }) - 2.9) < 1e-9);
  // seeking adds whole bars, which moves nothing
  assert.equal(nextBarLine(2.3, { shift: 8 }), 3);
  // tiny rounding errors do not skip a bar
  assert.equal(nextBarLine(2.9999999999, {}), 3);
});

test('a clip counts in by beats, then counts its bars', () => {
  assert.deepEqual(clipPhase({ now: 1.3, start: 2, bars: 4 }), { phase: 'count-in', beats: 3, bar: 0, progress: 0 });
  assert.equal(clipPhase({ now: 1.99, start: 2, bars: 4 }).beats, 1);
  const during = clipPhase({ now: 4.5, start: 2, bars: 4 });
  assert.equal(during.phase, 'recording');
  assert.equal(during.bar, 3);
  assert.equal(during.progress, 0.625);
  assert.equal(clipPhase({ now: 6, start: 2, bars: 4 }).phase, 'done');
});

test('lengths between 5 and 90 seconds are offered, the one nearest 20 first', () => {
  // 120 bpm: a bar is 2 seconds
  assert.deepEqual(lengthOptions(0.5).map((o) => o.bars), [4, 8, 16, 32]);
  assert.equal(defaultBars(0.5), 8);
  // 200 bpm: 4 bars is under 5 seconds
  const fast = lengthOptions(200 / 240);
  assert.deepEqual(fast.map((o) => o.bars), [8, 16, 32]);
  assert.equal(defaultBars(200 / 240), 16);
  // 60 bpm: 32 bars would be over two minutes
  assert.deepEqual(lengthOptions(0.25).map((o) => o.bars), [4, 8, 16]);
  assert.equal(defaultBars(0.25), 4);
  // something is always offered
  assert.deepEqual(lengthOptions(20).map((o) => o.bars), [32]);
  assert.deepEqual(lengthOptions(0.01).map((o) => o.bars), [4]);
  assert.equal(lengthOptions(0)[0].seconds, 8);
});

/* ---------- what is lit ---------- */

test('a hap lights its tokens once, and stays lit until it ends', () => {
  const window = new HapWindow();
  const hap = { begin: 1, end: 1.25, ids: ['10:12'], track: 0 };
  assert.deepEqual([...window.update([hap], 1.02, 0.5)], ['10:12']);
  // the same hap seen again by the next query is not counted twice
  window.update([hap], 1.05, 0.5);
  assert.equal(window.live.size, 1);
  assert.equal(window.update([], 1.2, 0.5).has('10:12'), true);
  assert.equal(window.update([], 1.25, 0.5).size, 0);
});

test('a very short note is held for about 90ms, so it is never lost between frames', () => {
  const window = new HapWindow({ hold: 0.09 });
  const blip = { begin: 2, end: 2.004, ids: ['20:22'], track: 1 };
  // half a cycle a second: 90ms is 0.045 cycles
  assert.equal(window.update([blip], 2.01, 0.5).has('20:22'), true);
  assert.equal(window.update([], 2.04, 0.5).has('20:22'), true);
  assert.equal(window.update([], 2.05, 0.5).has('20:22'), false);
});

test('haps that have not started yet, or are long over, are not lit', () => {
  const window = new HapWindow();
  assert.equal(window.update([{ begin: 3, end: 3.2, ids: ['1:2'] }], 2.9, 0.5).size, 0);
  assert.equal(window.update([{ begin: 1, end: 1.1, ids: ['3:4'] }], 2.95, 0.5).size, 0);
});

test('tracks pulse on each note and fade; the clock going back starts afresh', () => {
  const window = new HapWindow();
  window.update([{ begin: 4, end: 4.5, ids: [], track: 2 }], 4, 0.5);
  assert.equal(window.level(2, 4, 0.5), 1);
  assert.ok(window.level(2, 4.1, 0.5) < 0.2);
  assert.equal(window.level(5, 4.1, 0.5), 0);
  window.update([], 1, 0.5);
  assert.equal(window.level(2, 1, 0.5), 0);
  assert.equal(window.live.size, 0);
});

/* ---------- the code as text ---------- */

test('the code is split into lines of coloured tokens', () => {
  const lines = tokenizeLines(SONG);
  assert.equal(lines.length, SONG.split('\n').length);
  const kinds = (n) => lines[n].tokens.map((token) => `${token.kind}:${SONG.slice(token.from, token.to)}`);
  // the header comment runs over four lines and is cut at each break
  assert.deepEqual(kinds(0), ['comment:/*']);
  assert.deepEqual(kinds(1), ['comment:  @title Paper Kites']);
  assert.deepEqual(kinds(5), ['keyword:const', 'name:air', 'punct:=', 'name:slider', 'punct:(', 'number:0.4', 'punct:,', 'number:0', 'punct:,', 'number:1', 'punct:)']);
  assert.deepEqual(kinds(7).slice(0, 6), ['label:KEYS', 'punct::', 'name:note', 'punct:(', 'string:"<c3 eb3 g3 bb3>*2"', 'punct:)']);
  assert.ok(kinds(7).includes('property:s'));
  assert.deepEqual(kinds(8), ['punct:.', 'property:_punchcard', 'punct:(', 'punct:)']);
  assert.deepEqual(kinds(9), ['comment:// a quiet line']);
  assert.ok(kinds(10).includes('number:.35'));
  assert.equal(lines[10].text, 'HATS: s("hh*8").gain(.35)');
  assert.equal(lineIndexAt(lines, SONG.indexOf('HATS')), 10);
  assert.equal(lineIndexAt(lines, 0), 0);
});

test('labels are only labels at the start of a line; true and false read as values', () => {
  const lines = tokenizeLines('$: s("bd")\nconst x = { a: 1 }\nlet on = true');
  assert.equal(lines[0].tokens[0].kind, 'label');
  assert.equal(lines[1].tokens.find((token) => token.kind === 'label'), undefined);
  assert.equal(lines[2].tokens.at(-1).kind, 'number');
});

test('long lines wrap before a .method, hanging in from their indentation', () => {
  const text = '  note("c3 e3 g3").s("sawtooth").lpf(800).room(0.4).gain(0.6)';
  const rows = wrapLine(text, 30);
  assert.ok(rows.length > 1);
  assert.equal(rows[0].start, 0);
  assert.equal(rows[0].indent, 0);
  for (const row of rows.slice(1)) {
    assert.equal(row.indent, 4);
    assert.equal(text[row.start], '.');
  }
  for (const row of rows) assert.ok(row.end - row.start + row.indent <= 30, JSON.stringify(row));
  assert.equal(rows.at(-1).end, text.length);
  // every character is in exactly one row
  assert.equal(rows.map((row) => text.slice(row.start, row.end)).join(''), text);
  assert.deepEqual(wrapLine('short', 30), [{ start: 0, end: 5, indent: 0 }]);
  // nothing to break at: cut where it must be cut
  const solid = wrapLine('x'.repeat(50), 20);
  assert.deepEqual(solid.map((row) => row.end - row.start), [20, 18, 12]);
});

test('the layout puts inline visuals under their line, and finds the boxes for a token', () => {
  const lines = tokenizeLines(SONG);
  const layout = layoutCode(lines, { cols: 30, visuals: [{ line: 8, height: 2.5, id: 'v1' }] });
  const visual = layout.rows.find((row) => row.kind === 'visual');
  assert.equal(visual.line, 8);
  assert.equal(visual.id, 'v1');
  const next = layout.rows[layout.rows.indexOf(visual) + 1];
  assert.equal(next.y, visual.y + 2.5);
  assert.equal(next.line, 9);
  // a token on one row: one box, at its column
  const at = SONG.indexOf('"hh*8"');
  const [box] = rectsFor(layout, at, at + 6);
  const row = layout.code.find((entry) => entry.from <= at && entry.to > at);
  assert.deepEqual(box, { y: row.y, x: row.indent + at - row.from, w: 6 });
  // a range over a wrap: one box per row
  const keys = SONG.indexOf('KEYS');
  assert.ok(rectsFor(layout, keys, keys + 60).length >= 2);
  assert.deepEqual(rectsFor(layout, 5, 5), []);
  // a track's span includes the visual under its last line
  const span = spanOf(layout, 7, 8);
  assert.equal(span.top, layout.rows[layout.lineRows[7]].y);
  assert.equal(span.bottom, visual.y + 2.5);
});

test('the code is drawn as big as it can be while it all fits, and smaller songs get bigger type', () => {
  const lines = tokenizeLines(SONG);
  const roomy = fitCode(lines, { width: 858, height: 1200, visuals: [{ line: 8, id: 'v1', aspect: 60 / 640 }] });
  assert.equal(roomy.size, 36);
  assert.equal(roomy.fits, true);
  assert.equal(roomy.cols, Math.floor(858 / (36 * 0.6)));
  const drawn = roomy.visuals.get('v1');
  assert.ok(Math.abs(drawn.width - 858) < 1e-9);
  assert.ok(Math.abs(drawn.height - 858 * (60 / 640)) < 1e-9);
  // a song much longer than the box falls back to a readable size, and the view follows
  const long = tokenizeLines(Array.from({ length: 200 }, (_, k) => `$: s("bd*${k % 8}")`).join('\n'));
  const tight = fitCode(long, { width: 858, height: 600 });
  assert.equal(tight.fits, false);
  assert.equal(tight.size, 28);
  // a square visual is kept from filling the screen
  const tall = fitCode(lines, { width: 858, height: 1200, visuals: [{ line: 8, id: 's', aspect: 1 }] });
  assert.ok(tall.visuals.get('s').height <= 4.5 * tall.lineHeight + 1e-9);
});

/* ---------- the camera ---------- */

test('the camera moves to a track that has just come in, then tours the ones playing', () => {
  const camera = new ClipCamera({ dwell: 2 });
  assert.equal(camera.pick(0.2, []), null);
  assert.equal(camera.pick(1.1, [0, 1]), 0);
  // same bar: no change of mind
  assert.equal(camera.pick(1.9, [1]), 0);
  assert.equal(camera.pick(2, [0, 1]), 0);
  assert.equal(camera.pick(3, [0, 1]), 1);
  // a newcomer is shown straight away
  assert.equal(camera.pick(4, [0, 1, 3]), 3);
  // a track that stops is left for one that plays
  assert.equal(camera.pick(5, [0, 1]), 0);
});

test('the view glides, and never runs past the ends of the code', () => {
  assert.equal(viewTop({ top: 40, view: 20, total: 18 }), 0);
  assert.equal(viewTop({ top: 40, view: 20, total: 100 }), 40 - 2.4);
  assert.equal(viewTop({ top: 95, view: 20, total: 100 }), 80);
  assert.equal(viewTop({ top: 1, view: 20, total: 100 }), 0);
  const camera = new ClipCamera();
  assert.equal(camera.glide(10, 0.033), 10);
  const step = camera.glide(20, 0.033);
  assert.ok(step > 10 && step < 20);
  assert.ok(camera.glide(20, 10) > 19.99);
});

/* ---------- words ---------- */

test('a title is drawn as big as fits, then shortened', () => {
  // a pretend font: every character is half the size wide
  const measure = (text, size) => text.length * size * 0.5;
  assert.deepEqual(fitTitle('Paper Kites', 1000, measure), { text: 'Paper Kites', size: 84 });
  const mid = fitTitle('A Much Longer Invented Title', 1000, measure);
  assert.ok(mid.size < 84 && mid.size >= 44 && measure(mid.text, mid.size) <= 1000);
  assert.equal(mid.text, 'A Much Longer Invented Title');
  const long = fitTitle('An Invented Title That Goes On And On And On Well Past Any Edge', 600, measure);
  assert.equal(long.size, 44);
  assert.ok(long.text.endsWith('…'));
  assert.ok(measure(long.text, 44) <= 600);
});
