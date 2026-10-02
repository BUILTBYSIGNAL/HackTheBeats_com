// Miniature punchcards for the beats list, drawn from what each song actually plays:
// one row per track, four bars across. Songs are probed quietly in the background (see
// runtime.probe) and the result is cached in the browser.
import { runtime } from './runtime.js';
import { soundKey } from './mixer.js';

const COLS = 64;
const BARS = 4;
const WINDOWS = [0, 8, 16, 24];
const KEY = 'hacking-the-beats:thumbs';
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}
const cache = readCache();
function writeCache() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable or full: thumbnails are simply recomputed next time */
  }
}

const onsets = (pattern, from) => {
  try {
    return pattern.queryArc(from, from + BARS).filter((hap) => hap.hasOnset());
  } catch {
    return [];
  }
};

// One window of the song → rows of per-step note counts.
function gridAt(patterns, from) {
  let rows;
  if (patterns.length > 1) {
    rows = patterns.map((pattern) => onsets(pattern, from));
  } else {
    // a song without labelled tracks: one row per sound instead
    const bySound = new Map();
    for (const hap of onsets(patterns[0], from)) {
      const key = soundKey(hap.value) ?? String(hap.value?.note ?? hap.value?.n ?? '');
      if (!bySound.has(key)) bySound.set(key, []);
      bySound.get(key).push(hap);
    }
    rows = [...bySound.values()].slice(0, 10);
  }
  let lit = 0;
  const grid = rows.map((haps) => {
    const cells = new Float32Array(COLS);
    for (const hap of haps) {
      const col = Math.floor(((hap.whole.begin.valueOf() - from) / BARS) * COLS);
      if (col >= 0 && col < COLS) cells[col]++;
    }
    for (const count of cells) if (count) lit++;
    return cells;
  });
  return { grid, lit };
}

function toSVG(grid) {
  const cellW = 3;
  const gapX = 1;
  const cellH = 6;
  const gapY = 2;
  let rects = '';
  grid.forEach((cells, row) => {
    const peak = Math.max(1, ...cells);
    let run = null;
    const flush = () => {
      if (!run) return;
      const x = run.start * (cellW + gapX);
      const width = (run.end - run.start + 1) * (cellW + gapX) - gapX;
      rects += `<rect x="${x}" y="${row * (cellH + gapY)}" width="${width}" height="${cellH}" opacity="${run.opacity}"/>`;
      run = null;
    };
    for (let col = 0; col < COLS; col++) {
      if (!cells[col]) {
        flush();
        continue;
      }
      // three shades are enough at this size
      const opacity = [0.45, 0.7, 1][Math.min(2, Math.floor((cells[col] / peak) * 3))];
      if (run && run.opacity === opacity && run.end === col - 1) run.end = col;
      else {
        flush();
        run = { start: col, end: col, opacity };
      }
    }
    flush();
  });
  const width = COLS * (cellW + gapX) - gapX;
  const height = Math.max(1, grid.length) * (cellH + gapY) - gapY;
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" fill="currentColor" aria-hidden="true">${rects}</svg>`;
}

async function draw(song) {
  const patterns = await runtime.probe(song.code);
  if (!patterns.length) return null;
  let best = null;
  for (const from of WINDOWS) {
    const started = performance.now();
    const candidate = gridAt(patterns, from);
    if (!best || candidate.lit > best.lit) best = candidate;
    // a song that is expensive to query gets one look, not four
    if (performance.now() - started > 60) break;
    await pause();
  }
  return best && best.lit ? toSVG(best.grid) : null;
}

export const thumbs = {
  get(song) {
    return cache[song.seed] || null;
  },

  // Works through the songs one at a time, calling onReady(song, svg) for each new picture.
  // `busy()` lets the caller hold this back while a deck is loading.
  async build(songs, onReady, busy = () => false) {
    let dirty = false;
    for (const song of songs) {
      if (cache[song.seed] || song.broken) continue;
      while (busy()) await pause(500);
      try {
        const svg = await draw(song);
        if (svg) {
          cache[song.seed] = svg;
          dirty = true;
          onReady(song, svg);
        }
      } catch (error) {
        console.warn(`[thumbs] could not draw ${song.title}`, error);
      }
      await pause(120);
    }
    if (dirty) {
      // forget pictures of songs that are no longer in the folder
      const wanted = new Set(songs.map((song) => String(song.seed)));
      for (const seed of Object.keys(cache)) if (!wanted.has(seed)) delete cache[seed];
      writeCache();
    }
  },
};
