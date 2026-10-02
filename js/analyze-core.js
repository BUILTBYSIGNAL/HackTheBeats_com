// Static read of a song's source: which tracks it has, where its slider() calls are,
// what they control, and the header metadata. Nothing here evaluates the song.
//
// This file has no imports so it can be unit-tested in Node; analyze.js binds it to the
// parser that ships in the Strudel bundle.

const FREQ_PARAMS = new Set(['lpf', 'hpf', 'bpf', 'cutoff', 'hcutoff', 'bandf', 'lp', 'hp', 'bp', 'ctf', 'djf']);
const SOUND_CALLS = new Set(['s', 'sound']);

const isNode = (value) => value && typeof value === 'object' && typeof value.type === 'string';

function walk(node, visit, ancestors = []) {
  visit(node, ancestors);
  ancestors.push(node);
  for (const key in node) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit, ancestors);
    } else if (isNode(value)) {
      walk(value, visit, ancestors);
    }
  }
  ancestors.pop();
}

// What a value is passed to: `.lpf(x)` → "lpf" (also through `x.range(…)`), `pick(list, x)` → "pick".
function paramOf(node, ancestors) {
  let child = node;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const anc = ancestors[i];
    if (anc.type === 'CallExpression' && anc.arguments.includes(child)) {
      if (anc.callee.type === 'MemberExpression') return anc.callee.property?.name;
      if (anc.callee.type === 'Identifier' && anc.callee.name !== 'slider') return anc.callee.name;
    }
    child = anc;
  }
  return undefined;
}

const words = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_+/g, ' ')
    .trim();

// Title, credit and notes from the comments that open the song. Understands a block
// header with @title / @by lines, the same tags in line comments, and Strudel's own
// shorthand: // "coastline" @by eddyflux
function parseMeta(code, comments) {
  const meta = { title: null, by: null, notes: [], tries: [] };
  const firstCode = code.search(/^[ \t]*[^\s/*]/m);
  const leading = comments.filter((comment) => firstCode < 0 || comment.start < firstCode);
  for (const comment of leading.length ? leading : comments.filter((c) => c.type === 'Block').slice(0, 1)) {
    for (const raw of comment.value.split('\n')) {
      const line = raw.replace(/^\s*\*?\s?/, '').trim();
      if (!line) continue;
      const shorthand = line.match(/^"([^"]+)"\s+@by\s+(.+)$/);
      const tag = line.match(/^@(\w+)\s+(.+)$/);
      if (shorthand) {
        meta.title ??= shorthand[1].trim();
        meta.by ??= shorthand[2].trim();
      } else if (tag) {
        if (tag[1] === 'title') meta.title ??= tag[2].trim();
        else if (tag[1] === 'by') meta.by ??= tag[2].trim();
        else if (tag[1] === 'try') {
          const item = parseTry(tag[2]);
          if (item) meta.tries.push(item);
        }
      } else {
        meta.notes.push(line);
      }
    }
  }
  const cps = code.match(/setcps\(\s*([\d.]+)\s*\/\s*60\s*\/\s*4\s*\)/i);
  const cpm = code.match(/setcpm\(\s*([\d.]+)\s*\/\s*4\s*\)/i);
  const plain = code.match(/setcps\(\s*(\d*\.?\d+)\s*\)/i);
  meta.bpm = cps ? Number(cps[1]) : cpm ? Number(cpm[1]) : plain ? Math.round(Number(plain[1]) * 240) : null;
  return meta;
}

// "bd*4" → "bd", "~ ~ cp ~" → "cp", "piano:1" → "piano"
const firstSoundWord = (text) => text.match(/[A-Za-z][A-Za-z0-9]*/)?.[0];

function anonymousName(statement) {
  let found;
  walk(statement, (node) => {
    if (found || node.type !== 'CallExpression') return;
    const callee = node.callee.type === 'MemberExpression' ? node.callee.property?.name : node.callee.name;
    const arg = node.arguments[0];
    if (SOUND_CALLS.has(callee) && arg?.type === 'Literal' && typeof arg.value === 'string') {
      found = firstSoundWord(arg.value);
    }
  });
  return found;
}

export const createAnalyzer = (parse) => function analyze(code) {
  const comments = [];
  let ast;
  try {
    ast = parse(code, { ecmaVersion: 2022, allowAwaitOutsideFunction: true, onComment: comments });
  } catch (error) {
    return { error, tracks: [], sliders: [], switches: [], comments, meta: parseMeta(code, comments), body: [] };
  }

  // Tracks: top-level `label: pattern` statements.
  const tracks = [];
  const taken = new Map();
  for (const statement of ast.body) {
    if (statement.type !== 'LabeledStatement') continue;
    const label = statement.label.name;
    const disabled = label.startsWith('_') || label.endsWith('_');
    let name = label.replace(/^_+|_+$/g, '');
    if (name.includes('$') || !name) name = anonymousName(statement) || 'track';
    name = words(name);
    const count = (taken.get(name) || 0) + 1;
    taken.set(name, count);
    const colon = code.indexOf(':', statement.label.end);
    tracks.push({
      index: tracks.length,
      label,
      name: count > 1 ? `${name} ${count}` : name,
      disabled,
      from: statement.start,
      to: statement.end,
      labelFrom: statement.label.start,
      labelTo: colon >= 0 ? colon + 1 : statement.label.end,
      node: statement,
    });
  }
  const trackAt = (pos) => tracks.find((t) => pos >= t.from && pos <= t.to);

  // Sliders, in source order — the same order the transpiler reports them in.
  const sliders = [];
  const constSliders = new Map();
  walk(ast, (node, ancestors) => {
    if (node.type !== 'CallExpression' || node.callee.name !== 'slider' || !node.arguments[0]) return;
    const [value, min, max, step] = node.arguments;
    const parent = ancestors[ancestors.length - 1];
    const constName = parent?.type === 'VariableDeclarator' && parent.init === node ? parent.id.name : null;
    const slider = {
      from: value.start,
      to: value.end,
      value: Number(code.slice(value.start, value.end)),
      min: typeof min?.value === 'number' ? min.value : 0,
      max: typeof max?.value === 'number' ? max.value : 1,
      step: typeof step?.value === 'number' ? step.value : undefined,
      constName,
      params: new Set(),
      tracks: new Set(),
    };
    if (constName) {
      constSliders.set(constName, slider);
    } else {
      const param = paramOf(node, ancestors);
      if (param) slider.params.add(param);
      const track = trackAt(node.start);
      if (track) slider.tracks.add(track.index);
    }
    sliders.push(slider);
  });

  // For `const bright = slider(…)`, find where `bright` is used.
  if (constSliders.size) {
    walk(ast, (node, ancestors) => {
      if (node.type !== 'Identifier' || !constSliders.has(node.name)) return;
      const parent = ancestors[ancestors.length - 1];
      if (parent?.type === 'VariableDeclarator' && parent.id === node) return;
      const slider = constSliders.get(node.name);
      const param = paramOf(node, ancestors);
      if (param) slider.params.add(param);
      const track = trackAt(node.start);
      if (track) slider.tracks.add(track.index);
    });
  }

  sliders.sort((a, b) => a.from - b.from);
  sliders.forEach((slider, k) => {
    slider.k = k;
    const params = [...slider.params];
    const trackNames = [...slider.tracks].map((i) => tracks[i].name);
    slider.isFrequency = params.some((p) => FREQ_PARAMS.has(p));
    slider.taper = slider.isFrequency && slider.min > 0 && slider.max / slider.min >= 4 ? 'log' : 'linear';
    // when the code does not say what the number feeds, show its range instead
    const range = `${slider.min}–${slider.max}`;
    if (slider.constName) {
      slider.title = words(slider.constName);
      slider.sub = params.length ? params.slice(0, 2).join(' · ') : range;
    } else {
      slider.title = trackNames[0] || 'song';
      slider.sub = params[0] || range;
    }
    slider.hint = trackNames.length ? `Shapes ${trackNames.join(', ')}` : 'Shapes the whole song';
  });

  // Switches: a top-level `const voice = 2` whose meaning the song spells out, either in
  // its header ("voice: 0 none, 1 choir, 2 organ") or in a comment beside it ("// 0-2").
  // A switch is a plain number, not a slider, so changing it means re-evaluating the song.
  const meta = parseMeta(code, comments);
  const switches = [];
  ast.body.forEach((statement, at) => {
    if (statement.type !== 'VariableDeclaration') return;
    for (const { id, init } of statement.declarations) {
      if (id.type !== 'Identifier' || init?.type !== 'Literal' || !Number.isInteger(init.value) || init.value < 0) continue;
      const until = ast.body[at + 1]?.start ?? code.length;
      const options = legendFor(id.name, meta.notes) || rangeBeside(statement.end, until, comments);
      if (!options || !options.some((option) => option.value === init.value)) continue;
      switches.push({
        j: switches.length,
        name: id.name,
        title: words(id.name),
        from: init.start,
        to: init.end,
        value: init.value,
        options,
        min: options[0].value,
        max: options[options.length - 1].value,
      });
    }
  });

  // (body: the top-level statements, for the song map in outline-core.js)
  return { tracks, sliders, switches, comments, meta, body: ast.body };
};

/* ---------- suggested changes: @try lines ---------- */

// A song can suggest changes to try, one per line in its opening comment:
//
//   @try Swap to an 808 kit: `RolandTR909` -> `RolandTR808`
//   @try Busier: `hh*8` -> `hh*16`; `bd*4` -> `bd*8`
//   @try Glass bell: `s("triangle")` -> `s("sine")` in BELL
//
// "in BELL" keeps the change to that track. A line that does not read like this is left out.
//   → { label, changes: [{ find, replace }], track } or null
export function parseTry(text) {
  const head = String(text).match(/^(.{1,48}?):\s*(`.*)$/);
  if (!head) return null;
  const label = head[1].trim();
  let rest = head[2];
  const changes = [];
  for (;;) {
    const pair = rest.match(/^`([^`]+)`\s*(?:->|→)\s*`([^`]+)`\s*/);
    if (!pair || pair[1] === pair[2]) return null;
    changes.push({ find: pair[1], replace: pair[2] });
    rest = rest.slice(pair[0].length);
    if (!rest.startsWith(';')) break;
    rest = rest.slice(1).trimStart();
  }
  const scope = rest.match(/^in\s+([A-Za-z_$][\w$]*)\s*$/);
  if (rest && !scope) return null;
  return label ? { label, changes, track: scope ? scope[1] : null } : null;
}

// Every place `needle` is written in [from, to), outside comments (the song's own @try line
// says the same words).
function occurrences(code, needle, [from, to], comments) {
  const found = [];
  for (let at = code.indexOf(needle, from); at >= 0 && at + needle.length <= to; at = code.indexOf(needle, at + needle.length)) {
    const end = at + needle.length;
    if (!comments.some((comment) => at < comment.end && end > comment.start)) found.push({ from: at, to: end });
  }
  return found;
}
const inside = (range, ranges) => ranges.some((outer) => outer.from <= range.from && range.to <= outer.to);
const overlaps = (a, b) => a.from < b.to && b.from < a.to;

// Whether a suggestion is applied, read from the code itself, so it survives knob moves,
// reloads and edits by hand:
//   'off'   every change can be made (the code says `find`)
//   'on'    every change has been made (the code says `replace`)
//   'gone'  neither: the code has moved on, or the change would touch a deck-owned number
// `changes` is the edit that toggles it: [{ from, to, insert }], in order.
export function planTry(code, item, analysis) {
  const gone = { state: 'gone', changes: [] };
  if (!item || analysis.error) return gone;
  let scope = [0, code.length];
  if (item.track) {
    const bare = (label) => label.replace(/^_+|_+$/g, '');
    const track = analysis.tracks.find((entry) => entry.label === item.track || bare(entry.label) === bare(item.track));
    if (!track) return gone;
    scope = [track.from, track.to];
  }
  const comments = analysis.comments || [];
  const numbers = [...analysis.sliders, ...(analysis.switches || [])];
  const states = new Set();
  const edits = [];
  for (const { find, replace } of item.changes) {
    const finds = occurrences(code, find, scope, comments);
    const replaces = occurrences(code, replace, scope, comments);
    if (finds.length && replaces.every((range) => inside(range, finds))) {
      states.add('off');
      edits.push(...finds.map((range) => ({ ...range, insert: replace })));
    } else if (replaces.length && finds.every((range) => inside(range, replaces))) {
      states.add('on');
      edits.push(...replaces.map((range) => ({ ...range, insert: find })));
    } else {
      return gone;
    }
  }
  if (states.size !== 1) return gone;
  edits.sort((a, b) => a.from - b.from);
  if (edits.some((edit, i) => i > 0 && edit.from < edits[i - 1].to)) return gone;
  if (edits.some((edit) => numbers.some((number) => overlaps(edit, number)))) return gone;
  return { state: [...states][0], changes: edits };
}

// The code with the changes made (from planTry).
export function applyChanges(code, changes) {
  let out = code;
  for (const { from, to, insert } of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, from) + insert + out.slice(to);
  return out;
}

// "voice: 0 none, 1 choir" (possibly continued on the next lines) → [{ value, label }]
function legendFor(name, notes) {
  const start = notes.findIndex((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  if (start < 0) return null;
  let text = notes[start].slice(name.length + 1);
  for (let i = start + 1; i < notes.length && /^\d/.test(notes[i]); i++) text += `, ${notes[i]}`;
  return contiguous([...text.matchAll(/(\d+)\s+([^,]+)/g)].map((match) => ({ value: Number(match[1]), label: match[2].trim() })));
}

// `const beat = 0` followed by `// 0-2 …` → [{ value: 0 }, { value: 1 }, { value: 2 }]
function rangeBeside(from, until, comments) {
  const comment = comments.find((c) => c.start >= from && c.start < until);
  const range = comment?.value.match(/^\s*(\d+)\s*[-–]\s*(\d+)/);
  if (!range) return null;
  const options = [];
  for (let value = Number(range[1]); value <= Number(range[2]) && options.length < 64; value++) options.push({ value, label: String(value) });
  return contiguous(options);
}

// a switch needs at least two positions, counting up one at a time
function contiguous(options) {
  if (options.length < 2) return null;
  return options.every((option, i) => i === 0 || option.value === options[i - 1].value + 1) ? options : null;
}

// Number → the text written back into the code. Precision follows the slider's range.
const decimals = (n) => (String(n).split('.')[1] || '').length;

export function sliderText(slider, value) {
  const range = Math.abs(slider.max - slider.min);
  const digits = slider.step ? decimals(slider.step) : range >= 500 ? 0 : range >= 50 ? 1 : range >= 5 ? 2 : 3;
  return String(Number(value.toFixed(digits)));
}

// Number → the readout on the deck.
export function sliderReadout(slider, value) {
  if (slider.isFrequency) {
    return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz` : `${Math.round(value)} Hz`;
  }
  if (slider.step) return value.toFixed(decimals(slider.step));
  const range = Math.abs(slider.max - slider.min);
  return value.toFixed(range >= 50 ? 0 : range >= 5 ? 1 : 2);
}

// Writes saved slider values into the source before it is shown.
export function applySliderValues(code, sliders, values) {
  if (!values || values.length !== sliders.length) return code;
  let out = code;
  for (let k = sliders.length - 1; k >= 0; k--) {
    const slider = sliders[k];
    const value = values[k];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const clamped = Math.min(slider.max, Math.max(slider.min, value));
    out = out.slice(0, slider.from) + sliderText(slider, clamped) + out.slice(slider.to);
  }
  return out;
}

// Writes a saved state ({ sliders, switches }) into the source before it is shown. Either
// list is ignored if it no longer matches the song (the code has changed since).
export function applySaved(code, { sliders, switches = [] }, saved) {
  if (!saved) return code;
  const edits = [];
  if (Array.isArray(saved.sliders) && saved.sliders.length === sliders.length) {
    sliders.forEach((slider, k) => {
      const value = saved.sliders[k];
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      edits.push({ from: slider.from, to: slider.to, text: sliderText(slider, Math.min(slider.max, Math.max(slider.min, value))) });
    });
  }
  if (Array.isArray(saved.switches) && saved.switches.length === switches.length) {
    switches.forEach((item, j) => {
      const value = saved.switches[j];
      if (item.options.some((option) => option.value === value)) edits.push({ from: item.from, to: item.to, text: String(value) });
    });
  }
  let out = code;
  for (const edit of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, edit.from) + edit.text + out.slice(edit.to);
  return out;
}

// The code with every deck-owned number blanked out. Two versions with the same shape
// differ only in knob positions, which take effect without re-evaluating.
export function shapeOf(code, ranges) {
  let out = code;
  for (const { from, to } of [...ranges].sort((a, b) => b.from - a.from)) out = out.slice(0, from) + '#' + out.slice(to);
  return out;
}

// Line numbers (1-based) of `now` that have no partner in `before`: a longest-common-
// subsequence match, after setting aside what the two share at the start and the end.
export function changedLines(before, now) {
  let start = 0;
  while (start < before.length && start < now.length && before[start] === now[start]) start++;
  let endA = before.length;
  let endB = now.length;
  while (endA > start && endB > start && before[endA - 1] === now[endB - 1]) {
    endA--;
    endB--;
  }
  const a = before.slice(start, endA);
  const b = now.slice(start, endB);
  const changed = [];
  if (!b.length) return changed;
  // lengths[i][j]: the longest match between a[i..] and b[j..]
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  }
  for (let i = 0, j = 0; j < b.length; ) {
    if (i < a.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && lengths[i + 1][j] >= lengths[i][j + 1]) {
      i++;
    } else {
      changed.push(start + j + 1);
      j++;
    }
  }
  return changed;
}
