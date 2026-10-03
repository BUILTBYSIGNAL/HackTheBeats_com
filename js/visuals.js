// Canvas visuals outside the code: master scope, spectrum, level meter and the arrangement
// ribbon (which tracks play in which bar) of the deck in focus.
import { master } from './master.js';
import { ARRANGEMENT_BARS } from './arrangement.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fit(canvas) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return ratio;
}

// Layout of the ribbon in CSS pixels; the open view leaves room for bar numbers on top.
export const RIBBON = { gapX: 2, groupGap: 6, header: 14, rowGap: 2 };

export const visuals = {
  scope: null,
  spectrum: null,
  ribbon: null,
  meter: null,
  getPlayer: () => null,
  anyPlaying: () => false,
  colors: {},
  open: false,
  hover: null,
  // bars picked on the strip to trim (trim.js): { from, to, row } (row null: every track)
  selection: null,
  ribbonKey: '',

  start({ scope, spectrum, ribbon, meter, getPlayer, anyPlaying }) {
    Object.assign(this, { scope, spectrum, ribbon, meter, getPlayer, anyPlaying });
    this.colors = { ink: css('--hb-ink'), dim: css('--hb-ink-5'), mid: css('--hb-ink-3'), accent: css('--hb-accent'), bg: css('--hb-bg-deep') };
    window.addEventListener('resize', () => this.invalidate());
    const loop = () => {
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },

  invalidate() {
    this.ribbonKey = '';
  },

  frame() {
    const playing = this.anyPlaying();
    const wave = playing ? master.waveform() : null;
    this.drawScope(wave);
    this.drawSpectrum(playing ? master.spectrum() : null);
    if (this.meter) {
      this.meter.style.setProperty('--level', (wave ? master.peak(wave) : 0).toFixed(3));
      this.meter.classList.toggle('is-limiting', playing && master.reduction() > 2);
    }

    const player = this.getPlayer();
    if (!player) return;
    const column = this.columnOf(player);
    // redraw only when something visible changed
    const selection = this.selection ? `${this.selection.from}-${this.selection.to}-${this.selection.row}` : '';
    const key = `${player.id}|${player.song?.id}|${column}|${player.started}|${this.hover}|${this.open}|${selection}|${this.ribbon?.clientWidth}x${this.ribbon?.clientHeight}`;
    if (key !== this.ribbonKey || this.gridVersion !== player.grid) {
      this.ribbonKey = key;
      this.gridVersion = player.grid;
      this.drawRibbon(player, column);
    }
  },

  // The bar of the strip that is playing. A trimmed song loops sooner than the strip is long.
  columnOf(player) {
    const bar = Math.floor(player.position());
    const length = player.loopLength?.() ?? ARRANGEMENT_BARS;
    return ((bar % length) + length) % length;
  },

  drawScope(wave) {
    const canvas = this.scope;
    if (!canvas || !canvas.clientWidth) return;
    const ratio = fit(canvas);
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1.25 * ratio;
    ctx.strokeStyle = wave ? this.colors.ink : this.colors.dim;
    ctx.beginPath();
    if (!wave) {
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
    } else {
      // start on a rising zero crossing so the trace stands still
      let offset = 0;
      for (let i = 1; i < wave.length / 2; i++) {
        if (wave[i - 1] < 0 && wave[i] >= 0) {
          offset = i;
          break;
        }
      }
      const span = wave.length / 2;
      for (let x = 0; x <= width; x += ratio) {
        const sample = wave[offset + Math.floor((x / width) * span)] || 0;
        const y = height / 2 - sample * height * 0.46;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  },

  drawSpectrum(bins) {
    const canvas = this.spectrum;
    if (!canvas || !canvas.clientWidth) return;
    const ratio = fit(canvas);
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const bars = 28;
    const gap = 2 * ratio;
    const barWidth = (width - gap * (bars - 1)) / bars;
    for (let b = 0; b < bars; b++) {
      let level = 0;
      if (bins) {
        // log-spaced bands from roughly 45 Hz to 16 kHz
        const first = 2;
        const ratioAcross = (bins.length * 0.68) / first;
        const from = Math.floor(first * Math.pow(ratioAcross, b / bars));
        const to = Math.max(from + 1, Math.floor(first * Math.pow(ratioAcross, (b + 1) / bars)));
        for (let i = from; i < to && i < bins.length; i++) level = Math.max(level, bins[i]);
        level /= 255;
      }
      const h = Math.max(ratio, level * height);
      ctx.fillStyle = level > 0.02 ? this.colors.ink : this.colors.dim;
      ctx.globalAlpha = level > 0.02 ? 0.35 + level * 0.65 : 1;
      ctx.fillRect(b * (barWidth + gap), height - h, barWidth, h);
    }
    ctx.globalAlpha = 1;
  },

  // Column geometry in CSS pixels, shared by drawing and by clicks.
  columns(widthCss) {
    const { gapX, groupGap } = RIBBON;
    const groups = ARRANGEMENT_BARS / 8 - 1;
    const cell = (widthCss - gapX * (ARRANGEMENT_BARS - 1) - groupGap * groups) / ARRANGEMENT_BARS;
    const left = (c) => c * (cell + gapX) + Math.floor(c / 8) * groupGap;
    return { cell, left };
  },

  // Which bar of the ribbon a pointer is over, or null.
  columnAt(clientX) {
    const canvas = this.ribbon;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const { cell, left } = this.columns(rect.width);
    for (let c = 0; c < ARRANGEMENT_BARS; c++) {
      if (x >= left(c) - 1 && x <= left(c) + cell + 1) return c;
    }
    return null;
  },

  // The bar of the strip nearest a pointer, even between bars or past either end (for drags).
  columnNear(clientX) {
    const canvas = this.ribbon;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const { left } = this.columns(rect.width);
    let best = 0;
    for (let c = 0; c < ARRANGEMENT_BARS; c++) if (x >= left(c) - 1) best = c;
    return best;
  },

  // Where a bar of the strip starts, in CSS pixels from the canvas's left edge.
  columnLeft(column) {
    const canvas = this.ribbon;
    return canvas ? this.columns(canvas.getBoundingClientRect().width).left(column) : 0;
  },

  // Which track's row of the open strip a pointer is over: a row index, 'header' for the bar
  // numbers, or null when the strip is closed (it shows no names, so there are no rows to pick).
  rowAt(clientY, rows) {
    const canvas = this.ribbon;
    if (!canvas || !this.open || !rows) return null;
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    if (y < RIBBON.header) return 'header';
    const pitch = (rect.height - RIBBON.header + RIBBON.rowGap) / rows;
    return Math.max(0, Math.min(rows - 1, Math.floor((y - RIBBON.header) / pitch)));
  },

  drawRibbon(player, column) {
    const canvas = this.ribbon;
    if (!canvas || !canvas.clientWidth) return;
    const ratio = fit(canvas);
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const grid = player.grid;
    const { cell, left } = this.columns(canvas.clientWidth);
    const cellW = cell * ratio;
    const header = this.open ? RIBBON.header * ratio : 0;

    if (this.open) {
      ctx.fillStyle = this.colors.mid;
      ctx.font = `${10 * ratio}px ui-monospace, Menlo, monospace`;
      ctx.textBaseline = 'top';
      for (let c = 0; c < ARRANGEMENT_BARS; c += 8) ctx.fillText(String(c + 1), left(c) * ratio, 0);
    }
    if (!grid || !grid.length) return;

    const rows = grid.length;
    const gapY = (this.open ? RIBBON.rowGap : rows > 8 ? 1 : 2) * ratio;
    const cellH = Math.max(ratio, (height - header - gapY * (rows - 1)) / rows);
    grid.forEach((row, r) => {
      const peak = Math.max(1, ...row);
      const audible = player.mixer.audible(r);
      const y = header + r * (cellH + gapY);
      for (let c = 0; c < ARRANGEMENT_BARS; c++) {
        const x = left(c) * ratio;
        const density = row[c] / peak;
        if (density <= 0) {
          ctx.globalAlpha = 0.45;
          ctx.fillStyle = this.colors.dim;
          ctx.fillRect(x, y + cellH / 2 - ratio / 2, cellW, ratio);
          continue;
        }
        const live = c === column && audible && player.started;
        ctx.fillStyle = live ? this.colors.accent : this.colors.ink;
        ctx.globalAlpha = live ? 1 : audible ? 0.16 + density * 0.34 : 0.07;
        ctx.fillRect(x, y, cellW, cellH);
      }
    });
    ctx.globalAlpha = 1;

    // where playback is (or will start from), and the bar under the pointer
    const outline = (c, color, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = ratio;
      ctx.strokeRect(left(c) * ratio - ratio, header - ratio / 2, cellW + 2 * ratio, height - header);
      ctx.globalAlpha = 1;
    };
    if (!player.started && column > 0) outline(column, this.colors.accent, 0.9);
    if (this.hover !== null && this.hover !== column && !this.selection) outline(this.hover, this.colors.ink, 0.55);

    // a trimmed song loops before the strip ends: mark where, and dim the bars that repeat
    const length = player.loopLength?.() ?? ARRANGEMENT_BARS;
    if (length < ARRANGEMENT_BARS) {
      const x = left(length) * ratio - (RIBBON.gapX * ratio) / 2 - ratio;
      ctx.fillStyle = this.colors.accent;
      ctx.fillRect(x, header, 2 * ratio, height - header);
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = this.colors.bg;
      ctx.fillRect(x + 2 * ratio, header, width - x - 2 * ratio, height - header);
      ctx.globalAlpha = 1;
    }

    // bars picked to trim: a band over the bars, or over one track's row
    const pick = this.selection;
    if (pick) {
      const [a, b] = [Math.min(pick.from, pick.to), Math.max(pick.from, pick.to)];
      const x = left(a) * ratio - ratio;
      const w = (left(b) - left(a)) * ratio + cellW + 2 * ratio;
      let y = header;
      let h = height - header;
      if (pick.row !== null && grid.length) {
        y = header + pick.row * (cellH + gapY) - ratio;
        h = cellH + 2 * ratio;
      }
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = this.colors.accent;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.colors.accent;
      ctx.lineWidth = ratio;
      ctx.strokeRect(x, y, w, h);
    }
  },
};
