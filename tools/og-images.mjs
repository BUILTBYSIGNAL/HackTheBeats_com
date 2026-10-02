// Draws the picture a link to the site unfurls with (Open Graph): one per page, 1200×630,
// each with its own title and its own pattern. A beat's card carries the beat's name and
// the punchcard drawn from it, so no two look alike. Rendered with the browser Playwright
// installs; if that is not there, the build goes on without pictures and says so.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { glyphSVG, hash } from '../js/library-core.js';

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// `card`: { kicker, title, detail, seed }
function cardHTML({ kicker, title, detail, seed }) {
  const size = title.length > 34 ? 64 : title.length > 22 ? 84 : title.length > 12 ? 108 : 132;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1200px; height: 630px; overflow: hidden; background: #191919; color: #eceae4; font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif; }
    .card { position: relative; width: 1200px; height: 630px; padding: 56px 64px; display: flex; flex-direction: column; background: radial-gradient(ellipse at 20% 0%, #262626 0%, #191919 60%); }
    .brand { display: flex; align-items: center; gap: 14px; font: 500 20px/1 ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 0.22em; text-transform: uppercase; color: #b9b6ae; }
    .brand svg { width: 30px; height: 30px; }
    .kicker { margin-top: 74px; font: 500 20px/1 ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 0.2em; text-transform: uppercase; color: #ff6b35; }
    h1 { margin-top: 18px; font-weight: 200; font-size: ${size}px; line-height: 1.02; letter-spacing: -0.035em; max-width: 1070px; }
    .detail { margin-top: 20px; font: 400 26px/1.3 ui-monospace, 'SF Mono', Menlo, monospace; color: #9a978f; }
    .glyph { position: absolute; left: 64px; right: 64px; bottom: 86px; height: 92px; color: #eceae4; opacity: 0.9; }
    .glyph svg { width: 100%; height: 100%; }
    .glyph rect:nth-child(7n + 3) { fill: #ff6b35; }
    .foot { position: absolute; left: 64px; right: 64px; bottom: 36px; display: flex; justify-content: space-between; align-items: center; font: 400 18px/1 ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 0.08em; color: #7d7a73; }
    .signal { display: flex; align-items: center; gap: 10px; }
    .signal svg { width: 22px; height: 22px; border-radius: 4px; box-shadow: 0 0 0 1px #3a3a3a; }
    .signal b { font-weight: 500; letter-spacing: 0.16em; color: #b9b6ae; }
  </style></head><body><div class="card">
    <div class="brand">
      <svg viewBox="0 0 20 20"><rect x="1" y="2" width="5" height="4" fill="#eceae4"/><rect x="14" y="2" width="5" height="4" fill="#eceae4" opacity=".45"/><rect x="7.5" y="8" width="5" height="4" fill="#ff6b35"/><rect x="1" y="14" width="5" height="4" fill="#eceae4" opacity=".45"/><rect x="14" y="14" width="5" height="4" fill="#eceae4"/></svg>
      Hacking the Beats
    </div>
    <p class="kicker">${esc(kicker)}</p>
    <h1>${esc(title)}</h1>
    ${detail ? `<p class="detail">${esc(detail)}</p>` : ''}
    <div class="glyph">${glyphSVG(seed, { cols: 64, rows: 4 }).replace(/ width="\d+" height="\d+"/, ' preserveAspectRatio="none"')}</div>
    <div class="foot">
      <span>hackthebeats.com</span>
      <span class="signal"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="5" fill="#181A1F"/><rect x="14" y="7" width="4" height="18" fill="#DD5E2E"/></svg>Built by <b>SIGNAL</b></span>
    </div>
  </div></body></html>`;
}

// cards: [{ file, kicker, title, detail, seed? }] → writes each to outDir/file. Resolves to
// the files written (none if no browser could be started).
export async function renderCards(cards, outDir) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return [];
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    return [];
  }
  const written = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    for (const card of cards) {
      await page.setContent(cardHTML({ ...card, seed: card.seed ?? hash(card.file + card.title) }));
      const path = join(outDir, card.file);
      mkdirSync(dirname(path), { recursive: true });
      await page.screenshot({ path, type: 'png' });
      written.push(card.file);
    }
  } finally {
    await browser.close();
  }
  return written;
}
