// The picture a shared song's link unfurls with: 1200×630, in the same look as the cards the
// build draws for the site's own pages (tools/og-images.mjs), as SVG. The link-preview
// function (functions/) turns it into a PNG with the fonts it carries. No imports beyond
// another pure module, so it is unit-tested in Node.
import { glyphSVG } from './library-core.js';

export const WIDTH = 1200;
export const HEIGHT = 630;
const INK = '#eceae4';
const ACCENT = '#ff6b35';
const SANS = 'Inter';
const MONO = 'JetBrains Mono';

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Whether the fonts the picture carries can draw this text (Latin, Greek, Cyrillic and
// common punctuation). Anything else is left to the page's own title.
export const coverable = (text) => /^[\u0000-ɏͰ-ϿЀ-ӿ -⁯€™]*$/.test(String(text));

// About how wide `text` is in Inter at `size` px: close enough to wrap a title.
export function textWidth(text, size) {
  let em = 0;
  for (const char of String(text)) {
    if (char === ' ') em += 0.26;
    else if (/[iljtf.,:;'!|()[\]]/.test(char)) em += 0.3;
    else if (/[mwMW@]/.test(char)) em += 0.86;
    else if (/[A-Z]/.test(char)) em += 0.66;
    else if (/[0-9]/.test(char)) em += 0.58;
    else em += 0.53;
  }
  return em * size;
}

// A title as lines no wider than `width` at `size` px, breaking at spaces; a single word
// longer than the line is cut with an ellipsis.
export function wrapTitle(title, size, width = 1070) {
  const lines = [];
  let line = '';
  for (const word of String(title).trim().split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.map((text) => (textWidth(text, size) <= width ? text : ellipsize(text, size, width)));
}

function ellipsize(text, size, width) {
  let cut = text;
  while (cut.length > 1 && textWidth(`${cut}…`, size) > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

// The largest title size whose lines fit the space between the kicker and the details.
export function fitTitle(title, room) {
  for (const size of [132, 108, 84, 64]) {
    const lines = wrapTitle(title, size);
    if (lines.length * size * 1.04 <= room && lines.length <= 2) return { size, lines };
  }
  const lines = wrapTitle(title, 52);
  if (lines.length <= 2) return { size: 52, lines };
  return { size: 52, lines: [lines[0], ellipsize(`${lines[1]} ${lines.slice(2).join(' ')}`, 52, 1070)] };
}

// card: { kicker, title, detail, from, seed, rows, host } → SVG text
export function cardSVG({ kicker = 'A shared song', title = 'Untitled', detail = '', from = '', seed = 1, rows = 4, host = 'hackthebeats.com' } = {}) {
  const shown = coverable(title) ? title : 'A song made in code';
  const room = from ? 150 : 180;
  const { size, lines } = fitTitle(shown, room);
  let y = 180;
  const parts = [];
  parts.push(`<text x="64" y="${y}" font-family="${MONO}" font-weight="500" font-size="20" letter-spacing="4" fill="${ACCENT}">${esc(String(kicker).toUpperCase())}</text>`);
  y += 18;
  for (const line of lines) {
    y += size * 1.02;
    parts.push(`<text x="60" y="${y.toFixed(1)}" font-family="${SANS}" font-weight="200" font-size="${size}" letter-spacing="${(-0.035 * size).toFixed(2)}" fill="${INK}">${esc(line)}</text>`);
  }
  if (detail && coverable(detail)) {
    // clear of the title's descenders, which grow with it
    y += Math.max(20, size * 0.26) + 26;
    parts.push(`<text x="64" y="${y.toFixed(1)}" font-family="${MONO}" font-size="26" fill="#9a978f">${esc(detail)}</text>`);
  }
  if (from && coverable(from)) {
    y += 14 + 22;
    parts.push(`<text x="64" y="${y.toFixed(1)}" font-family="${MONO}" font-size="22" fill="#7d7a73">${esc(from)}</text>`);
  }
  // the punchcard: drawn from the song, so no two links look alike
  let n = 0;
  const glyph = glyphSVG(seed, { cols: 64, rows: Math.min(6, Math.max(3, rows)) })
    .replace(/<svg viewBox="([^"]+)"[^>]*>/, (_, box) => `<svg x="64" y="452" width="1072" height="92" viewBox="${box}" preserveAspectRatio="none" fill="${INK}" opacity="0.9">`)
    .replace(/<rect /g, () => (n++ % 7 === 2 ? `<rect fill="${ACCENT}" ` : '<rect '));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs><radialGradient id="bg" cx="20%" cy="0%" r="90%"><stop offset="0" stop-color="#262626"/><stop offset="0.6" stop-color="#191919"/></radialGradient></defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#191919"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <g transform="translate(64 56) scale(1.5)"><rect x="1" y="2" width="5" height="4" fill="${INK}"/><rect x="14" y="2" width="5" height="4" fill="${INK}" opacity=".45"/><rect x="7.5" y="8" width="5" height="4" fill="${ACCENT}"/><rect x="1" y="14" width="5" height="4" fill="${INK}" opacity=".45"/><rect x="14" y="14" width="5" height="4" fill="${INK}"/></g>
  <text x="108" y="78" font-family="${MONO}" font-weight="500" font-size="20" letter-spacing="4.4" fill="#b9b6ae">HACK THE BEATS</text>
  ${parts.join('\n  ')}
  ${glyph}
  <text x="64" y="600" font-family="${MONO}" font-size="18" letter-spacing="1.4" fill="#7d7a73">${esc(host)}</text>
  <g transform="translate(940 583)"><rect width="22" height="22" rx="4" fill="#181A1F" stroke="#3a3a3a"/><rect x="9.6" y="4.8" width="2.8" height="12.4" fill="#DD5E2E"/></g>
  <text x="972" y="600" font-family="${MONO}" font-size="18" letter-spacing="1.4" fill="#7d7a73">Built by <tspan font-weight="500" fill="#b9b6ae" letter-spacing="2.9">SIGNAL</tspan></text>
</svg>`;
}
