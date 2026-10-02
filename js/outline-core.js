// The song map: the sections of a song's code (setup, knobs and switches, parts, helpers),
// each with a plain description. Every word is assembled from what the code says: the
// sounds it names, the effects it calls, the knobs it uses, the comments its author left.
// Nothing is guessed.
//
// No DOM and no imports: it reads what analyze-core.js found (tracks, sliders, switches,
// comments, meta and the top-level statements in `body`), so it can be unit-tested in Node.
//
//   outlineOf(code, analysis) → [{ id, title, items: [item] }], empty groups left out
//   item: { key, kind, label, from, to, line, endLine, summary, details: [text],
//           note (the author's comment, or null), code (one line of it, or null),
//           track (parts), k (knobs), j (switches), disabled (parts) }

const isNode = (value) => value && typeof value === 'object' && typeof value.type === 'string';

function walk(node, visit, parent = null) {
  if (visit(node, parent) === false) return;
  for (const key in node) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit, node);
    } else if (isNode(value) && key !== 'parent') {
      walk(value, visit, node);
    }
  }
}

/* ---------- words ---------- */

// "a", "a and b", "a, b and c"
export function listOf(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const words = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_+/g, ' ').trim();

// Drum machine sounds by their usual short names, and the built-in synths.
const DRUMS = {
  bd: 'kick',
  sd: 'snare',
  hh: 'hi-hat',
  oh: 'open hat',
  cp: 'clap',
  rim: 'rimshot',
  lt: 'low tom',
  mt: 'mid tom',
  ht: 'high tom',
  cr: 'crash',
  rd: 'ride',
  cb: 'cowbell',
  sh: 'shaker',
  tb: 'tambourine',
  perc: 'percussion',
};
const SYNTHS = {
  sawtooth: 'sawtooth',
  saw: 'sawtooth',
  square: 'square',
  triangle: 'triangle',
  tri: 'triangle',
  sine: 'sine',
  sin: 'sine',
  supersaw: 'supersaw',
  pulse: 'pulse',
};
const NOISE = { white: 'white noise', pink: 'pink noise', brown: 'brown noise', crackle: 'crackle' };

// "RolandTR909" → "909 kit", "LinnDrum" → "Linn Drum kit"
export function kitName(bank) {
  const roland = String(bank).match(/^Roland[A-Za-z]*?(\d{2,4})$/);
  return `${roland ? roland[1] : words(String(bank))} kit`;
}

// The sound names in a mini-notation string: "bd(3,8), [~ cp]*2" → ["bd", "cp"]
export function soundWords(text) {
  const found = [];
  for (const [name] of String(text).matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) if (!found.includes(name)) found.push(name);
  return found;
}

// One sound, said plainly: "kick (bd)", "sawtooth synth", "piano"
function soundPhrase(name) {
  if (DRUMS[name]) return `${DRUMS[name]} (${name})`;
  if (SYNTHS[name]) return `${SYNTHS[name]} synth`;
  return NOISE[name] || name;
}
const shortSound = (name) => DRUMS[name] || (SYNTHS[name] ? `${SYNTHS[name]} synth` : NOISE[name] || name);
const isSynth = (name) => Boolean(SYNTHS[name] || NOISE[name]);

// What each effect does, in plain words. `unit` follows a number; `text` turns a written
// value into words; `bare` effects are described without their value.
const FILTER = { word: 'filter', unit: 'Hz' };
const HIGH = { word: 'high-pass', unit: 'Hz' };
const BAND = { word: 'band-pass', unit: 'Hz' };
const ENVELOPE = { word: 'envelope', bare: true };
const EFFECTS = {
  lpf: FILTER,
  cutoff: FILTER,
  lp: FILTER,
  ctf: FILTER,
  hpf: HIGH,
  hcutoff: HIGH,
  hp: HIGH,
  bpf: BAND,
  bandf: BAND,
  bp: BAND,
  lpq: { word: 'resonance' },
  resonance: { word: 'resonance' },
  vowel: { word: 'vowel', text: (value) => value },
  room: { word: 'reverb' },
  size: { word: 'reverb size' },
  roomsize: { word: 'reverb size' },
  delay: { word: 'echo' },
  delaytime: { word: 'echo time' },
  delayfeedback: { word: 'echo feedback' },
  gain: { word: 'volume' },
  postgain: { word: 'volume' },
  velocity: { word: 'volume' },
  crush: { word: 'bit-crush' },
  coarse: { word: 'lo-fi' },
  distort: { word: 'distortion' },
  shape: { word: 'drive' },
  speed: { word: 'pitch' },
  pan: { word: 'pan' },
  jux: { word: 'stereo split', bare: true },
  mask: { word: 'comes and goes', bare: true },
  struct: { word: 'rhythm', bare: true },
  euclid: { word: 'rhythm', bare: true },
  scale: { word: 'key', text: (value) => value.replace(/:/g, ' ') },
  slow: { word: 'stretch', number: (n) => `${n}× slower` },
  fast: { word: 'stretch', number: (n) => `${n}× faster` },
  attack: ENVELOPE,
  decay: ENVELOPE,
  sustain: ENVELOPE,
  release: ENVELOPE,
  adsr: ENVELOPE,
  degradeBy: { word: 'drops notes at random', bare: true },
  degrade: { word: 'drops notes at random', bare: true },
  rev: { word: 'reversed', bare: true },
  ply: { word: 'repeats', number: (n) => `×${n}` },
  chop: { word: 'chopped up', bare: true },
  striate: { word: 'sliced', bare: true },
  phaser: { word: 'phaser' },
};
// The parameter a knob feeds, in words: "lpf" → "filter"
export const effectWord = (param) => EFFECTS[param]?.word || param;

const VISUALS = { punchcard: 'a punchcard', pianoroll: 'a piano roll', scope: 'a scope', tscope: 'a scope', fscope: 'a spectrum', spectrum: 'a spectrum', spiral: 'a spiral', pitchwheel: 'a pitch wheel', wordfall: 'falling words' };
const SOUND_CALLS = new Set(['s', 'sound']);
const NOTE_CALLS = new Set(['note', 'n']);
const TEMPO_CALLS = new Set(['setcps', 'setcpm', 'setCps', 'setCpm']);

/* ---------- reading the code ---------- */

const stringOf = (node) => {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis.map((q) => q.value.cooked).join('');
  return null;
};
const numberOf = (node) => {
  if (node?.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (node?.type === 'UnaryExpression' && node.operator === '-' && typeof node.argument?.value === 'number') return -node.argument.value;
  return null;
};
const calleeName = (call) => (call.callee.type === 'Identifier' ? call.callee.name : call.callee.type === 'MemberExpression' && !call.callee.computed ? call.callee.property?.name : null);

// Every call in a node, in source order: `s("bd")`, `.lpf(cut)` → { name, call }
function callsIn(node) {
  const calls = [];
  walk(node, (child) => {
    if (child.type === 'CallExpression') {
      const name = calleeName(child);
      if (name) calls.push({ name, call: child });
    }
  });
  // in the order they are written: a chain's outer call starts where its first one does
  const at = (call) => (call.callee.type === 'MemberExpression' ? call.callee.property.start : call.start);
  return calls.sort((a, b) => at(a.call) - at(b.call));
}

// The names a node refers to, leaving out property names, object keys and the parameters
// of functions written inside it.
function namesIn(node) {
  const params = new Set();
  walk(node, (child) => {
    if (/Function/.test(child.type)) for (const param of child.params || []) walk(param, (p) => p.type === 'Identifier' && params.add(p.name));
  });
  const names = new Set();
  walk(node, (child, parent) => {
    if (child.type !== 'Identifier' || params.has(child.name)) return;
    if (parent?.type === 'MemberExpression' && parent.property === child && !parent.computed) return;
    if (parent?.type === 'Property' && parent.key === child && !parent.computed && !parent.shorthand) return;
    if (parent?.type === 'LabeledStatement' && parent.label === child) return;
    names.add(child.name);
  });
  return names;
}

function lineIndex(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lineText = (n) => code.slice(starts[n - 1], n < starts.length ? starts[n] - 1 : code.length);
  return { lineOf, lineText, count: starts.length };
}

// A comment's text on one line: "// a note" → "a note"
const commentText = (comment) =>
  comment.value
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, '').trim())
    .filter(Boolean)
    .join(' ');
// a line of code that was commented out is not a note about anything
const looksLikeCode = (text) => /^\.|^[\w$]+\s*[(=]|^[A-Z_$][\w$]*\s*:\s*\S+\(|[;{}]$/.test(text);
const clip = (text, length = 160) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);

/* ---------- the outline ---------- */

export function outlineOf(code, analysis) {
  if (!analysis || analysis.error) return [];
  const { tracks = [], sliders = [], switches = [], comments = [], meta = {}, body = [] } = analysis;
  const { lineOf, lineText, count } = lineIndex(code);
  const firstCode = body[0]?.start ?? code.length;
  const notes = comments.filter((comment) => comment.start >= firstCode);

  // The comment an author left about a stretch of code: on the line just before it, on
  // its own lines, or on the line just after it (when a blank line follows).
  const noteFor = (from, to) => {
    const first = lineOf(from);
    const last = lineOf(to);
    // a comment with nothing but space before it on its line
    const own = (comment) => !code.slice(code.lastIndexOf('\n', comment.start - 1) + 1, comment.start).trim();
    const before = [];
    for (let line = first - 1; line >= 1; ) {
      const comment = notes.find((c) => lineOf(c.end) === line && own(c));
      if (!comment) break;
      before.unshift(comment);
      line = lineOf(comment.start) - 1;
    }
    const inside = notes.filter((c) => c.start >= from && lineOf(c.start) <= last);
    const after = notes.filter((c) => lineOf(c.start) === last + 1 && own(c) && (lineOf(c.end) >= count || !lineText(lineOf(c.end) + 1).trim()));
    for (const group of [before, inside, after]) {
      const text = group.map(commentText).filter((t) => t && !looksLikeCode(t)).join(' ');
      if (text) return clip(text);
    }
    return null;
  };
  const firstLine = (from) => clip(lineText(lineOf(from)).trim(), 72);
  const place = (from, to) => ({ from, to, line: lineOf(from), endLine: lineOf(Math.max(from, to - 1)) });

  /* top-level names: knobs, switches and helpers, and what each refers to */
  const switchNames = new Set(switches.map((item) => item.name));
  const declared = new Map();
  for (const statement of body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations) {
        if (declarator.id.type !== 'Identifier') continue;
        const name = declarator.id.name;
        const init = declarator.init;
        const kind = init?.type === 'CallExpression' && init.callee.name === 'slider' ? 'knob' : switchNames.has(name) ? 'switch' : 'helper';
        declared.set(name, { name, kind, statement, init, refs: init ? namesIn(init) : new Set() });
      }
    } else if (statement.type === 'FunctionDeclaration' && statement.id) {
      const refs = namesIn(statement.body);
      for (const param of statement.params) walk(param, (p) => p.type === 'Identifier' && refs.delete(p.name));
      declared.set(statement.id.name, { name: statement.id.name, kind: 'helper', statement, init: statement, refs });
    }
  }
  for (const entry of declared.values()) entry.refs = new Set([...entry.refs].filter((name) => declared.has(name) && name !== entry.name));

  // The parts: each labelled track, or (with none) the pattern the song ends on.
  const parts = tracks.map((track) => ({ track, node: track.node, from: track.from, to: track.to }));
  if (!parts.length) {
    const last = [...body].reverse().find((statement) => statement.type === 'ExpressionStatement' && !isSetup(statement));
    if (last) parts.push({ track: null, node: last, from: last.start, to: last.end });
  }

  // name → the parts that use it, and for each part the helper it came through (if any)
  const users = new Map([...declared.keys()].map((name) => [name, new Map()]));
  parts.forEach((part, p) => {
    const direct = [...namesIn(part.node)].filter((name) => declared.has(name));
    const queue = direct.map((name) => [name, null]);
    while (queue.length) {
      const [name, via] = queue.shift();
      const seen = users.get(name);
      if (seen.has(p)) continue;
      seen.set(p, via);
      for (const ref of declared.get(name).refs) queue.push([ref, via ?? name]);
    }
  });
  const partName = (p) => parts[p].track?.name ?? 'the pattern';
  const usedBy = (name) => [...users.get(name).keys()].map(partName);

  // A value passed to an effect, in words: "1800 Hz", "on the cut knob", "from key"
  const refPhrase = (name) => {
    const entry = declared.get(name);
    if (!entry) return null;
    if (entry.kind === 'knob') return `on the ${words(name)} knob`;
    if (entry.kind === 'switch') return `by the ${words(name)} switch`;
    return `from \`${name}\``;
  };
  const valuePhrase = (effect, arg) => {
    if (!arg) return '';
    const number = numberOf(arg);
    if (number !== null) return effect.bare ? '' : effect.number ? effect.number(number) : effect.unit ? `${number} ${effect.unit}` : String(number);
    const text = stringOf(arg);
    if (text !== null) return effect.text ? effect.text(text) : '';
    const inline = sliders.find((slider) => !slider.constName && slider.from >= arg.start && slider.to <= arg.end);
    if (inline) return `on the ${inline.title} knob`;
    for (const name of namesIn(arg)) {
      const phrase = refPhrase(name);
      if (phrase) return phrase;
    }
    return '';
  };

  // What a pattern plays and does to its sound, from the calls in it.
  const describe = (node, from, to) => {
    const calls = callsIn(node);
    const sounds = [];
    const kits = [];
    let notes = false;
    const effects = new Map();
    const visuals = [];
    for (const { name, call } of calls) {
      const arg = call.arguments[0];
      if (SOUND_CALLS.has(name)) {
        const text = stringOf(arg);
        if (text) for (const sound of soundWords(text)) if (!sounds.includes(sound)) sounds.push(sound);
      } else if (NOTE_CALLS.has(name)) {
        notes = true;
      } else if (name === 'bank') {
        const text = stringOf(arg);
        if (text && !kits.includes(kitName(text))) kits.push(kitName(text));
      } else if (EFFECTS[name]) {
        const effect = EFFECTS[name];
        const value = valuePhrase(effect, arg);
        const known = effects.get(effect.word);
        if (known === undefined || (!known && value)) effects.set(effect.word, value);
      } else {
        const visual = VISUALS[name.replace(/^_/, '')];
        const drawn = visual && (name.startsWith('_') ? `${visual} under its code` : `${visual} across the stage`);
        if (drawn && !visuals.includes(drawn)) visuals.push(drawn);
      }
    }
    const kit = kits.length ? listOf(kits) : null;
    let sound = null;
    let summary = '';
    if (notes) {
      const played = sounds.length ? (sounds.every(isSynth) ? ` on a ${listOf(sounds.map(shortSound))}` : `, played on ${listOf(sounds.map(soundPhrase))}`) : '';
      sound = `Notes${played}${kit ? `, ${kit}` : ''}`;
      summary = ['notes', sounds.length ? listOf(sounds.map(shortSound)) : null].filter(Boolean).join(' · ');
    } else if (sounds.length) {
      sound = `Sounds: ${listOf(sounds.slice(0, 8).map(soundPhrase))}${sounds.length > 8 ? ' and more' : ''}${kit ? `, from the ${kit}` : ''}`;
      summary = [kit, sounds.slice(0, 4).map(shortSound).join(', ')].filter(Boolean).join(' · ');
    }
    const details = [];
    if (sound) details.push(sound);
    if (effects.size) details.push(`Effects: ${[...effects].map(([word, value]) => (value ? `${word} ${value}` : word)).join(', ')}`);
    // knobs and switches it uses, written in it or reached through a helper
    const p = parts.findIndex((part) => part.node === node);
    const reached = (kind) =>
      [...declared.values()]
        .filter((entry) => entry.kind === kind && (p >= 0 ? users.get(entry.name).has(p) : namesIn(node).has(entry.name)))
        .map((entry) => {
          const via = p >= 0 ? users.get(entry.name).get(p) : null;
          const what = kind === 'knob' ? sliders.find((slider) => slider.constName === entry.name)?.params : null;
          const fed = what ? [...new Set([...what].map(effectWord))].filter((word) => word !== words(entry.name)) : [];
          return `${words(entry.name)}${fed.length ? ` (${fed.join(', ')})` : ''}${via ? ` through \`${via}\`` : ''}`;
        });
    const knobs = [...reached('knob'), ...sliders.filter((slider) => !slider.constName && slider.from >= from && slider.to <= to).map((slider) => `${slider.title}${slider.params.size ? ` (${[...new Set([...slider.params].map(effectWord))].join(', ')})` : ''}`)];
    if (knobs.length) details.push(`${knobs.length > 1 ? 'Knobs' : 'Knob'}: ${knobs.join(', ')}`);
    const flips = reached('switch');
    if (flips.length) details.push(`${flips.length > 1 ? 'Switches' : 'Switch'}: ${flips.join(', ')}`);
    if (visuals.length) details.push(`Draws ${listOf(visuals)}`);
    return { details, summary, effects };
  };

  /* setup: the header, the tempo, the sample packs */
  const setup = [];
  const header = comments.filter((comment) => comment.start < firstCode);
  if (header.length && (meta.title || meta.by || meta.notes?.length || meta.tries?.length)) {
    const from = header[0].start;
    const to = header[header.length - 1].end;
    const details = [];
    if (meta.title) details.push(`Title: ${meta.title}`);
    if (meta.by) details.push(`By: ${meta.by}`);
    const legends = switches.filter((item) => meta.notes.some((line) => line.toLowerCase().startsWith(`${item.name.toLowerCase()}:`)));
    if (legends.length) details.push(`Spells out the ${listOf(legends.map((item) => item.title))} ${legends.length > 1 ? 'switches' : 'switch'}`);
    if (meta.tries?.length) details.push(`${meta.tries.length} ${meta.tries.length === 1 ? 'change' : 'changes'} to try (@try)`);
    if (meta.notes?.length) details.push("Its other lines are the song's About text");
    setup.push({ key: 'header', kind: 'header', label: 'Header', ...place(from, to), summary: [meta.title, meta.by && `by ${meta.by}`].filter(Boolean).join(' · ') || 'notes about the song', details, note: null, code: null });
  }
  const tempo = body.find((statement) => TEMPO_CALLS.has(setupCall(statement)?.name));
  if (tempo) {
    const call = code.slice(tempo.start, tempo.end).replace(/;$/, '');
    setup.push({
      key: 'tempo',
      kind: 'tempo',
      label: 'Tempo',
      ...place(tempo.start, tempo.end),
      summary: meta.bpm ? `${meta.bpm} bpm` : 'set in the code',
      details: [meta.bpm ? `${meta.bpm} beats a minute, set by \`${call}\`` : `Set by \`${call}\``, "The deck's Tempo knob speeds it up or slows it down from there"],
      note: noteFor(tempo.start, tempo.end),
      code: null,
    });
  }
  const packs = body.filter((statement) => setupCall(statement)?.name === 'samples');
  if (packs.length) {
    const said = packs.map((statement) => {
      const [what, base] = setupCall(statement).call.arguments;
      const text = stringOf(what);
      if (text !== null) return text.startsWith('github:') ? `${text.slice(7)} (GitHub)` : text;
      if (what?.type === 'ObjectExpression') return `${what.properties.length} ${what.properties.length === 1 ? 'sound' : 'sounds'}${stringOf(base) ? ` from ${stringOf(base)}` : ''}`;
      return 'a pack named in the code';
    });
    const first = packs[0];
    const last = packs[packs.length - 1];
    setup.push({
      key: 'samples',
      kind: 'samples',
      label: packs.length > 1 ? 'Sample packs' : 'Sample pack',
      ...place(first.start, last.end),
      summary: packs.length > 1 ? `${packs.length} packs` : said[0],
      details: [`Loads ${listOf(said)}`, 'Sounds the parts name are looked up in these, and in the packs every song has'],
      note: noteFor(first.start, last.end),
      code: null,
    });
  }

  /* knobs and switches, in the order they are written */
  const statementAt = (pos) => body.find((statement) => statement.start <= pos && pos <= statement.end);
  const controls = [];
  sliders.forEach((slider) => {
    const statement = slider.constName ? declared.get(slider.constName)?.statement : null;
    const from = statement ? statement.start : slider.from;
    const to = statement ? statement.end : slider.to;
    const params = [...slider.params];
    const feeds = [...new Set(params.map(effectWord))];
    const shapes = slider.constName && declared.has(slider.constName) ? usedBy(slider.constName) : [...slider.tracks].map((i) => tracks[i]?.name).filter(Boolean);
    const details = [`A knob from ${slider.min} to ${slider.max}${slider.step ? ` in steps of ${slider.step}` : ''}, now ${slider.value}`];
    if (params.length) details.push(`Turns the ${listOf(feeds)} (${params.map((param) => `\`${param}\``).join(', ')})`);
    details.push(shapes.length ? `Shapes ${listOf(shapes)}` : slider.hint);
    controls.push({
      key: `knob:${slider.k}`,
      kind: 'knob',
      label: slider.title,
      k: slider.k,
      ...place(from, to),
      summary: [feeds.join(', ') || `${slider.min}–${slider.max}`, shapes.length ? shapes.slice(0, 2).join(', ') + (shapes.length > 2 ? '…' : '') : null].filter(Boolean).join(' · '),
      details,
      note: noteFor(from, to),
      code: firstLine(from),
    });
  });
  switches.forEach((item) => {
    const statement = statementAt(item.from) || { start: item.from, end: item.to };
    const now = item.options.find((option) => option.value === item.value);
    const named = item.options.some((option) => option.label !== String(option.value));
    const shapes = declared.has(item.name) ? usedBy(item.name) : [];
    const through = declared.has(item.name) ? [...new Set([...users.get(item.name).values()].filter(Boolean))] : [];
    const details = [
      named ? `A switch: ${item.options.map((option) => `${option.value} ${option.label}`).join(', ')}` : `A switch from ${item.min} to ${item.max}`,
      `Now ${item.value}${named && now ? ` (${now.label})` : ''}. Turning it runs the song again`,
    ];
    if (shapes.length) details.push(`Shapes ${listOf(shapes)}${through.length ? ` through ${listOf(through.map((name) => `\`${name}\``))}` : ''}`);
    controls.push({
      key: `switch:${item.j}`,
      kind: 'switch',
      label: item.title,
      j: item.j,
      ...place(statement.start, statement.end),
      summary: named ? item.options.map((option) => option.label).join(' / ') : `${item.min}–${item.max}`,
      details,
      note: noteFor(statement.start, statement.end),
      code: firstLine(statement.start),
    });
  });
  controls.sort((a, b) => a.from - b.from);

  /* parts */
  const partItems = parts.map((part) => {
    const { details, summary } = describe(part.node, part.from, part.to);
    if (part.track?.disabled) details.push(`Starts muted: its label is written \`${part.track.label}\``);
    return {
      key: part.track ? `part:${part.track.index}` : 'pattern',
      kind: 'part',
      label: part.track ? part.track.name : 'The pattern',
      track: part.track ? part.track.index : null,
      disabled: Boolean(part.track?.disabled),
      ...place(part.from, part.to),
      summary: summary || (part.track ? '' : 'everything that plays'),
      details,
      note: noteFor(part.from, part.to),
      code: null,
    };
  });

  /* helpers: anything else declared at the top that a part uses */
  const helpers = [];
  for (const entry of declared.values()) {
    if (entry.kind !== 'helper' || !users.get(entry.name).size) continue;
    const shapes = usedBy(entry.name);
    const direct = parts.filter((part, p) => users.get(entry.name).get(p) === null).length;
    const { statement, init } = entry;
    const details = [];
    if (statement.type === 'FunctionDeclaration' || /Function/.test(init?.type || '')) {
      const params = (init.params || []).filter((param) => param.type === 'Identifier').map((param) => param.name);
      details.push(`A function${params.length ? ` of ${listOf(params.map((param) => `\`${param}\``))}` : ''}`);
    } else if (init?.type === 'MemberExpression' && init.computed && init.object.type === 'ArrayExpression') {
      const by = [...namesIn(init.property)].map((name) => refPhrase(name)?.replace(/^(on|by|from) /, '')).filter(Boolean);
      details.push(`One of ${init.object.elements.length} choices${by.length ? `, picked by ${listOf(by)}` : ''}`);
    } else if (stringOf(init) !== null || numberOf(init) !== null) {
      details.push(`The value \`${clip(code.slice(init.start, init.end), 40)}\``);
    } else if (init?.type === 'ArrayExpression') {
      details.push(`A list of ${init.elements.length}`);
    }
    // what it plays and does, then the knobs, switches and other helpers it leans on
    const target = statement.type === 'FunctionDeclaration' ? statement : init;
    if (target) details.push(...describe(target, target.start, target.end).details.filter((line) => !/^(Knobs?|Switch(es)?):/.test(line)));
    const uses = [...entry.refs].map((name) => refPhrase(name).replace(/^(on|by|from) /, '')).filter((phrase) => !details[0]?.includes(phrase));
    if (uses.length) details.push(`Uses ${listOf(uses)}`);
    details.push(`Used by ${listOf(shapes)}${direct < shapes.length ? ' (some through other helpers)' : ''}`);
    helpers.push({
      key: `helper:${entry.name}`,
      kind: 'helper',
      label: entry.name,
      ...place(statement.start, statement.end),
      summary: shapes.length === 1 ? `used by ${shapes[0]}` : `used by ${shapes.length} parts`,
      details,
      note: noteFor(statement.start, statement.end),
      code: firstLine(statement.start),
    });
  }

  return [
    { id: 'setup', title: 'Setup', items: setup },
    { id: 'controls', title: 'Knobs and switches', items: controls },
    { id: 'parts', title: 'Parts', items: partItems },
    { id: 'helpers', title: 'Helpers', items: helpers },
  ].filter((group) => group.items.length);
}

// `setcps(…)`, `samples(…)` or `await samples(…)` on a line of its own → { name, call }
function setupCall(statement) {
  if (statement.type !== 'ExpressionStatement') return null;
  const expression = statement.expression.type === 'AwaitExpression' ? statement.expression.argument : statement.expression;
  if (expression?.type !== 'CallExpression' || expression.callee.type !== 'Identifier') return null;
  return { name: expression.callee.name, call: expression };
}
const isSetup = (statement) => {
  const name = setupCall(statement)?.name;
  return TEMPO_CALLS.has(name) || name === 'samples' || name === 'hush';
};

// Every item, in the order the map lists them.
export const itemsOf = (groups) => groups.flatMap((group) => group.items);
