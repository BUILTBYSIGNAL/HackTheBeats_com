// Video clips, the pure part: which kind of file this browser can make and how big, how long
// a clip can be, which bar it starts on, which tokens are lit in each frame, and where
// everything sits in the picture. No DOM and no imports, so all of it is unit-tested in Node
// (tests/unit/clip.test.mjs); js/clip.js draws and records.

/* ---------- the file ---------- */

// Best first. MP4 (H.264 and AAC) is what every app takes and phones encode in hardware;
// WebM is the fallback where there is no H.264 encoder.
export const MIME_TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

// The first type this browser's MediaRecorder can write, or null if it can write none.
export function pickMimeType(isTypeSupported) {
  if (typeof isTypeSupported !== 'function') return null;
  for (const type of MIME_TYPES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      /* a browser that throws here cannot write it */
    }
  }
  return null;
}

export const isMp4 = (type) => /^video\/mp4/i.test(type || '');
export const fileExtension = (type) => (isMp4(type) ? 'mp4' : 'webm');

// The two shapes at full size. `safe` is how far in from each edge the words and the code
// stay: on TikTok and Reels a vertical video has the app's own buttons and captions over
// its top ~150px, bottom ~400px and right ~150px. `title` is the largest and smallest
// title size; `code` the code sizes tried (largest first) and the one used when the song
// does not fit at any of them.
export const FORMATS = {
  '9:16': {
    id: '9:16',
    label: 'Vertical 9:16',
    width: 1080,
    height: 1920,
    safe: { top: 150, right: 150, bottom: 400, left: 72 },
    title: { max: 86, min: 46 },
    code: { sizes: [36, 34, 32, 30, 28, 26], fallback: 28 },
  },
  '1:1': {
    id: '1:1',
    label: 'Square 1:1',
    width: 1080,
    height: 1080,
    safe: { top: 64, right: 72, bottom: 64, left: 72 },
    title: { max: 72, min: 40 },
    code: { sizes: [30, 28, 26, 24], fallback: 24 },
  },
};
const formatOf = (id) => FORMATS[id] || FORMATS['9:16'];

// The video's size in pixels: full size for MP4, two thirds for WebM (which is encoded in
// software, and would struggle to keep up at 1080p). Always even, as encoders want.
export function resolutionFor(format, type) {
  const { width, height } = formatOf(format);
  const scale = isMp4(type) ? 1 : 2 / 3;
  const even = (n) => Math.round((n * scale) / 2) * 2;
  return { width: even(width), height: even(height), scale: even(width) / width };
}

// Where each part of the picture goes, in full-size pixels (multiply by the scale from
// resolutionFor). Words and code stay inside the safe area; the scope of the whole mix
// may run under the apps' captions, since nothing is lost if it is covered.
export function frameLayout(format) {
  const f = formatOf(format);
  const { top, right, bottom, left } = f.safe;
  const width = f.width - left - right;
  // the title, then the credit line, then a bar for each bar of the clip
  const titleMax = f.title.max;
  const header = { x: left, y: top + 18, w: width, h: titleMax + 90, creditY: titleMax + 42, barsY: titleMax + 76, title: f.title };
  const footer = { x: left, y: f.height - bottom - 58, w: width, h: 40 };
  const scope = f.id === '9:16' ? { x: 0, y: f.height - bottom + 36, w: f.width, h: bottom - 112 } : { x: left, y: footer.y - 92, w: width, h: 72 };
  const codeTop = header.y + header.h + 30;
  const codeBottom = (f.id === '9:16' ? footer.y : scope.y) - 26;
  const code = { x: left, y: codeTop, w: width, h: codeBottom - codeTop, sizes: f.code.sizes, fallback: f.code.fallback };
  return { width: f.width, height: f.height, safe: f.safe, header, code, scope, footer };
}

// "hacking-the-beats Low Tide clip 2026-10-02-18-40.mp4", like the WAV recordings.
export function clipFilename({ title, type, date = new Date() } = {}) {
  const name = String(title || '').replace(/[^\w\- ]+/g, '').replace(/\s+/g, ' ').trim() || 'clip';
  const stamp = date.toISOString().slice(0, 16).replace(/[T:]/g, '-');
  return `hacking-the-beats ${name} clip ${stamp}.${fileExtension(type)}`;
}

// "MP4 · 1080 × 1920 · 4.2 MB · 16 s"
export function describeClip({ type, width, height, size = 0, seconds = 0 } = {}) {
  const kind = isMp4(type) ? 'MP4' : 'WebM';
  const bytes = size >= 1048576 * 0.1 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${kind} · ${width} × ${height} · ${bytes} · ${Math.max(1, Math.round(seconds))} s`;
}

// The address written at the foot of the clip: a built-in beat's own page, or the site.
export function siteAddress(origin, slug = null) {
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {
    return '';
  }
  return slug ? `${host}/beats/${slug}` : host;
}

/* ---------- time ---------- */

// The cycle being heard right now. Strudel's scheduler queries a little ahead of the sound
// (its `latency`), and its clock reads one tick behind where it has queried to; the haps it
// sends out at cycle c are heard `latency` seconds after the tick that queried them. So
// what plays at this moment is (latency - tick) seconds behind scheduler.now().
export function audibleCycle({ now, cps, latency = 0.1, tick = 0.05 }) {
  return now - (latency - tick) * cps;
}

// The first bar line at least `lead` cycles after `cycle`, in the scheduler's cycles. The
// song's bars are the scheduler's cycles moved by `shift` (a deck's seek offset and nudge),
// so the bar line is where cycle + shift is a whole number.
export function nextBarLine(cycle, { shift = 0, lead = 0 } = {}) {
  return Math.ceil(cycle + lead + shift - 1e-9) - shift;
}

// Where a clip is: counting in (and how many beats are left), recording (which bar, and how
// far through), or done.
export function clipPhase({ now, start, bars }) {
  if (now < start) return { phase: 'count-in', beats: Math.max(1, Math.ceil((start - now) * 4 - 1e-9)), bar: 0, progress: 0 };
  if (now < start + bars) return { phase: 'recording', beats: 0, bar: Math.floor(now - start) + 1, progress: (now - start) / bars };
  return { phase: 'done', beats: 0, bar: bars, progress: 1 };
}

export const BAR_CHOICES = [4, 8, 16, 32];

// The lengths offered at this tempo: those that last between 5 and 90 seconds. If none does
// (a very fast or very slow song), the one closest to that range.
export function lengthOptions(cps, { choices = BAR_CHOICES, min = 5, max = 90 } = {}) {
  const rate = cps > 0 ? cps : 0.5;
  const all = choices.map((bars) => ({ bars, seconds: bars / rate }));
  const fit = all.filter(({ seconds }) => seconds >= min - 1e-9 && seconds <= max + 1e-9);
  if (fit.length) return fit;
  const distance = ({ seconds }) => (seconds < min ? min - seconds : seconds - max);
  return [all.reduce((best, option) => (distance(option) < distance(best) ? option : best))];
}

// The length offered first: the one nearest 20 seconds.
export function defaultBars(cps, options = lengthOptions(cps)) {
  return options.reduce((best, option) => (Math.abs(option.seconds - 20) < Math.abs(best.seconds - 20) ? option : best)).bars;
}

/* ---------- what is lit ---------- */

// The tokens lit in one frame. Haps come in as plain data, in cycles:
//   { begin, end, ids: ['12:15', …], track }      (ids are the stage's "from:to")
// Each hap is counted once however many frames see it, and stays lit until it ends, or for
// `hold` seconds at least, so a short note is never lost between two frames.
export class HapWindow {
  constructor({ hold = 0.09 } = {}) {
    this.hold = hold;
    this.reset();
  }

  reset() {
    this.live = new Map();
    // track → the cycle its latest note began on
    this.onsets = new Map();
    this.at = null;
  }

  // `haps`: what the pattern holds between the last frame and `now`. Returns the lit ids.
  update(haps, now, cps) {
    // the clock went back (the deck stopped and started again): start afresh
    if (this.at !== null && now < this.at - 1e-6) this.reset();
    this.at = now;
    const hold = this.hold * (cps > 0 ? cps : 0.5);
    for (const hap of haps) {
      if (!(hap.begin <= now)) continue;
      const ids = hap.ids || [];
      const key = `${hap.begin}|${hap.track ?? ''}|${ids.join(',')}`;
      if (this.live.has(key)) continue;
      const until = Math.max(hap.end, hap.begin + hold);
      if (until <= now) continue;
      this.live.set(key, { ids, until });
      if (hap.track != null && !(this.onsets.get(hap.track) >= hap.begin)) this.onsets.set(hap.track, hap.begin);
    }
    const lit = new Set();
    for (const [key, entry] of this.live) {
      if (entry.until <= now) this.live.delete(key);
      else for (const id of entry.ids) lit.add(id);
    }
    return lit;
  }

  // 0..1: a track's pulse, 1 on each note and fading over about a quarter of a second.
  level(track, now, cps) {
    const at = this.onsets.get(track);
    if (at === undefined || !(cps > 0)) return 0;
    const seconds = (now - at) / cps;
    return seconds < 0 ? 0 : Math.exp(-seconds * 9);
  }
}

/* ---------- the code as text to draw ---------- */

const KEYWORDS = new Set(['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'yield']);
const ATOMS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[\w$]/;
const DIGIT = /[0-9]/;

// The code split into lines of coloured tokens, with offsets into the whole code:
//   [{ from, to, text, tokens: [{ from, to, kind }] }]
// kind is one of comment, string, number, keyword, label, name, property, punct. Spaces are
// left out: in a monospaced picture a token's column is its offset from the line's start.
export function tokenizeLines(code) {
  const text = String(code ?? '');
  const tokens = [];
  const n = text.length;
  let previous = null;
  let i = 0;
  const add = (from, to, kind) => {
    tokens.push({ from, to, kind });
    previous = { from, to, kind, char: text[to - 1] };
  };
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    const start = i;
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end;
      add(start, i, 'comment');
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      add(start, i, 'comment');
    } else if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < n && text[i] !== c && (c === '`' || text[i] !== '\n')) i += text[i] === '\\' ? 2 : 1;
      i = Math.min(n, text[i] === c ? i + 1 : i);
      add(start, i, 'string');
    } else if (DIGIT.test(c) || (c === '.' && DIGIT.test(text[i + 1] || '') && !(previous && previous.to === i && IDENT.test(previous.char)))) {
      i++;
      while (i < n && /[\w.]/.test(text[i]) && !(text[i] === '.' && !DIGIT.test(text[i + 1] || ''))) i++;
      add(start, i, 'number');
    } else if (IDENT_START.test(c)) {
      while (i < n && IDENT.test(text[i])) i++;
      const word = text.slice(start, i);
      const afterDot = previous && previous.kind === 'punct' && previous.char === '.' && previous.to === start;
      let kind = 'name';
      if (afterDot) kind = 'property';
      else if (ATOMS.has(word)) kind = 'number';
      else if (KEYWORDS.has(word)) kind = 'keyword';
      else if (!text.slice(text.lastIndexOf('\n', start - 1) + 1, start).trim() && /^[ \t]*:(?!:)/.test(text.slice(i, i + 40))) kind = 'label';
      add(start, i, kind);
    } else {
      i++;
      add(start, i, 'punct');
    }
  }

  // into lines; comments and template strings that run over several lines are cut at each break
  const lines = [];
  let from = 0;
  let t = 0;
  for (;;) {
    const end = text.indexOf('\n', from);
    const to = end < 0 ? n : end;
    const own = [];
    while (t < tokens.length && tokens[t].to <= from) t++;
    for (let k = t; k < tokens.length && tokens[k].from < to; k++) {
      const token = tokens[k];
      const a = Math.max(token.from, from);
      const b = Math.min(token.to, to);
      if (b > a) own.push({ from: a, to: b, kind: token.kind });
    }
    lines.push({ from, to, text: text.slice(from, to), tokens: own });
    if (end < 0) break;
    from = end + 1;
  }
  return lines;
}

// The line holding an offset into the code (binary search over tokenizeLines' result).
export function lineIndexAt(lines, offset) {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].from <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// `)` or a name followed by `.method`: where a long chain wraps best, as on the stage
const CHAIN = /[)\]\w"'`]\.(?=[A-Za-z_$])/g;

// One line cut into rows of at most `cols` characters. Rows after the first hang `hang`
// characters in from the line's own indentation, and break before `.method` in a chain,
// or after a space or a comma, where they can.
//   → [{ start, end, indent }]   (offsets into the line; indent in characters)
export function wrapLine(text, cols, { hang = 2 } = {}) {
  const width = Math.max(8, Math.floor(cols));
  if (text.length <= width) return [{ start: 0, end: text.length, indent: 0 }];
  const lead = text.length - text.trimStart().length;
  const indent = Math.min(lead + hang, Math.floor(width / 2));
  const breaks = new Set();
  CHAIN.lastIndex = 0;
  let match;
  while ((match = CHAIN.exec(text))) breaks.add(match.index + 1);
  for (let k = lead; k < text.length; k++) if (text[k] === ' ' || text[k] === ',') breaks.add(k + 1);

  const rows = [];
  let start = 0;
  let room = width;
  let rowIndent = 0;
  while (text.length - start > room) {
    const limit = start + room;
    let end = -1;
    for (let k = limit; k > start + Math.floor(room * 0.4); k--) {
      if (breaks.has(k)) {
        end = k;
        break;
      }
    }
    if (end < 0) end = limit;
    rows.push({ start, end, indent: rowIndent });
    start = end;
    while (start < text.length && text[start] === ' ') start++;
    rowIndent = indent;
    room = width - indent;
  }
  if (start < text.length) rows.push({ start, end: text.length, indent: rowIndent });
  return rows;
}

// The whole code laid out in rows. `visuals` are inline visuals, drawn under a line and
// `height` rows tall: [{ line, height, id }]. Every row has a `y`, in rows from the top.
//   → { rows, code, lineRows, height, cols }
//   rows: { kind: 'code', line, from, to, indent, y } | { kind: 'visual', line, id, y, height }
export function layoutCode(lines, { cols, visuals = [], hang = 2 } = {}) {
  const under = new Map();
  for (const visual of visuals) {
    if (!under.has(visual.line)) under.set(visual.line, []);
    under.get(visual.line).push(visual);
  }
  const rows = [];
  const code = [];
  const lineRows = [];
  let y = 0;
  lines.forEach((line, index) => {
    lineRows.push(rows.length);
    for (const part of wrapLine(line.text, cols, { hang })) {
      const row = { kind: 'code', line: index, from: line.from + part.start, to: line.from + part.end, indent: part.indent, y };
      rows.push(row);
      code.push(row);
      y += 1;
    }
    for (const visual of under.get(index) || []) {
      rows.push({ kind: 'visual', line: index, id: visual.id, y, height: visual.height });
      y += visual.height;
    }
  });
  return { rows, code, lineRows, height: y, cols };
}

// The boxes that cover the code from `from` to `to`, one per row it falls on:
//   [{ y, x, w }]   (y in rows, x and w in characters)
export function rectsFor(layout, from, to) {
  const rows = layout.code;
  const rects = [];
  if (!(to > from) || !rows.length) return rects;
  // the first row that ends after `from`
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].to <= from) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo; k < rows.length && rows[k].from < to; k++) {
    const row = rows[k];
    const a = Math.max(from, row.from);
    const b = Math.min(to, row.to);
    if (b > a) rects.push({ y: row.y, x: row.indent + (a - row.from), w: b - a });
  }
  return rects;
}

// From the top of one line to the bottom of another, inline visuals under it included.
export function spanOf(layout, firstLine, lastLine) {
  const rows = layout.rows;
  const first = rows[layout.lineRows[firstLine]];
  const after = layout.lineRows[lastLine + 1];
  const last = rows[(after ?? rows.length) - 1];
  if (!first || !last) return null;
  return { top: first.y, bottom: last.y + (last.kind === 'visual' ? last.height : 1) };
}

// The biggest code size (in px) at which the whole song fits the box, or the fallback size
// when it does not (the view then follows the music). Inline visuals keep their shape and
// are never drawn taller than `visualRows` rows.
//   visuals: [{ line, id, aspect }]   (aspect = height / width)
//   → { size, cols, lineHeight, charWidth, layout, fits, visuals: Map(id → { width, height }) }
export function fitCode(lines, { width, height, charRatio = 0.6, lineRatio = 1.6, sizes = [36, 34, 32, 30, 28, 26], fallback = 28, visuals = [], visualRows = 4.5 } = {}) {
  const attempt = (size) => {
    const charWidth = size * charRatio;
    const lineHeight = size * lineRatio;
    const cols = Math.max(12, Math.floor(width / charWidth));
    const drawn = new Map();
    const placed = visuals.map((visual) => {
      const tallest = visualRows * lineHeight;
      const w = Math.min(width, tallest / Math.max(visual.aspect, 1e-3));
      const h = w * visual.aspect;
      drawn.set(visual.id, { width: w, height: h });
      // a little air above and below, as on the stage
      return { line: visual.line, id: visual.id, height: (h + lineHeight * 0.5) / lineHeight };
    });
    const layout = layoutCode(lines, { cols, visuals: placed });
    return { size, cols, lineHeight, charWidth, layout, fits: layout.height * lineHeight <= height, visuals: drawn };
  };
  for (const size of sizes) {
    const result = attempt(size);
    if (result.fits) return result;
  }
  return attempt(fallback);
}

/* ---------- the camera ---------- */

// Follows the music through code that does not fit, like the stage's camera (js/camera.js):
// it moves to a track that has just come in, and otherwise tours the tracks that are
// playing, a couple of bars on each.
export class ClipCamera {
  constructor({ dwell = 2 } = {}) {
    this.dwell = dwell;
    this.reset();
  }

  reset() {
    this.bar = null;
    this.current = null;
    this.switchedAt = 0;
    this.active = new Set();
    this.top = null;
  }

  // Once a frame: the bar now and the tracks heard in about the last bar. Returns the track
  // to show (or null before any has played). It only thinks once per bar.
  pick(bar, active) {
    const whole = Math.floor(bar);
    if (whole === this.bar) return this.current;
    this.bar = whole;
    if (!active.length) return this.current;
    const starting = this.current === null;
    const newcomers = active.filter((index) => !this.active.has(index));
    this.active = new Set(active);
    let next = null;
    if (newcomers.length && !starting) next = newcomers[0];
    else if (starting || !active.includes(this.current) || whole - this.switchedAt >= this.dwell) next = active.find((index) => index > (this.current ?? -1)) ?? active[0];
    if (next !== null && next !== this.current) {
      this.current = next;
      this.switchedAt = whole;
    }
    return this.current;
  }

  // Glide the top of the view (in rows) towards `target`, `dt` seconds after the last frame.
  glide(target, dt, speed = 3.5) {
    if (this.top === null || !Number.isFinite(this.top)) this.top = target;
    else this.top += (target - this.top) * (1 - Math.exp(-Math.max(0, dt) * speed));
    return this.top;
  }
}

// Where the top of the view should be (in rows) to show something starting at `top`, a
// little way down the view, without running past either end of the code.
export function viewTop({ top, view, total, align = 0.12 }) {
  if (total <= view) return 0;
  return Math.min(Math.max(0, top - view * align), total - view);
}

/* ---------- words ---------- */

// The biggest size, from `max` down to `min`, at which the title fits `maxWidth`; below that
// it is shortened with an ellipsis. `measure(text, size)` gives a width.
export function fitTitle(text, maxWidth, measure, { max = 84, min = 44, step = 2 } = {}) {
  const title = String(text || '').trim();
  for (let size = max; size >= min; size -= step) {
    if (measure(title, size) <= maxWidth) return { text: title, size };
  }
  let cut = title;
  while (cut.length > 1 && measure(`${cut}…`, min) > maxWidth) cut = cut.slice(0, -1);
  return { text: cut === title ? title : `${cut.trimEnd()}…`, size: min };
}
