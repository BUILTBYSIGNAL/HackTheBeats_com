// What a shared song's own address (/s/<uuid>) answers with, before any script runs: the
// player's page with the song's title, description and picture, so a link pasted into a
// chat unfurls as that song. Everything the link-preview function (functions/) does is
// here, as plain logic, so it is unit-tested in Node with a pretend database.
import { SITE_NAME, creditLine, remixLine, noteSummary, sharePath } from './routes-core.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const esc = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// "/s/<uuid>" → { shareId, asset: 'page' }, "/s/<uuid>/card.png" → { shareId, asset: 'card' }
export function parseSharePath(path) {
  const found = new RegExp(`^/s/(${UUID})(/card\\.png)?/?$`).exec(path || '');
  return found ? { shareId: found[1], asset: found[2] ? 'card' : 'page' } : null;
}

// The address a page is answered for: the host it was asked for when that is one of the
// site's own, otherwise the player's (so a forged Host header cannot point a card elsewhere).
export function originFor(host, { appOrigin = '', shareOrigin = '' } = {}) {
  const own = [shareOrigin, appOrigin].filter(Boolean).map((address) => new URL(address));
  const match = own.find((url) => url.host === host);
  return (match || own[0])?.origin || `https://${host}`;
}

// song: { title, by, ownerName, bpm, trackCount, notes, from, updatedAt }
export function pageMeta(song, { origin, shareId }) {
  const credit = song.by ? `${song.title} by ${song.by}` : song.title;
  const sharer = song.ownerName ? ` shared by ${song.ownerName}` : '';
  const facts = [song.bpm ? `${Math.round(song.bpm)} bpm` : null, song.trackCount > 1 ? `${song.trackCount} tracks` : null].filter(Boolean).join(', ');
  const remix = song.from?.title ? `${remixLine(song.from)}.` : '';
  const description = [`A live-coded song${sharer}.`, facts ? `${facts[0].toUpperCase()}${facts.slice(1)}.` : '', remix, noteSummary(song.notes, 120), 'Play it in your browser.']
    .filter(Boolean)
    .join(' ');
  return {
    title: `${credit} — ${SITE_NAME}`,
    description,
    url: `${origin}${sharePath(shareId)}`,
    image: `${origin}${sharePath(shareId)}/card.png?v=${Number(song.updatedAt || 0).toString(36)}`,
    imageAlt: `"${song.title}", a live-coded song on ${SITE_NAME}`,
    curtainTitle: song.title,
    curtainBy: creditLine({ by: song.by, ownerName: song.ownerName, bpm: song.bpm }),
  };
}

// A link that leads nowhere (closed, never was, or a typo): nothing about it is said.
export function closedMeta(origin) {
  return {
    title: `A shared song — ${SITE_NAME}`,
    description: `${SITE_NAME}: live-coded music you can watch, mix and edit, in your browser.`,
    url: `${origin}/`,
    image: `${origin}/og/home.png`,
    imageAlt: SITE_NAME,
  };
}

// The markers the player's page must carry for this to work (checked when it is built).
export const MARKERS = ['<!--seo-->', '<!--prerender-->', '<body data-transport="idle" data-focus="A">', '<p class="curtain__title" id="curtain-title">&nbsp;</p>', '<p class="curtain__by" id="curtain-by"></p>'];

// The player's page (index.html) with `meta` written in.
export function renderSharePage(template, meta) {
  const tags = [
    ['property', 'og:site_name', SITE_NAME],
    ['property', 'og:type', 'website'],
    ['property', 'og:title', meta.title],
    ['property', 'og:description', meta.description],
    ['property', 'og:url', meta.url],
    ['property', 'og:image', meta.image],
    ['property', 'og:image:type', 'image/png'],
    ['property', 'og:image:width', '1200'],
    ['property', 'og:image:height', '630'],
    ['property', 'og:image:alt', meta.imageAlt],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', meta.title],
    ['name', 'twitter:description', meta.description],
    ['name', 'twitter:image', meta.image],
    ['name', 'robots', 'noindex'],
  ]
    .map(([kind, key, value]) => `<meta ${kind}="${key}" content="${esc(value)}" />`)
    .join('\n    ');
  let html = template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(meta.description)}" />`)
    .replace('<!--seo-->', tags)
    .replace('<!--prerender-->', '')
    .replace('<body data-transport="idle" data-focus="A">', '<body class="is-preview is-guest" data-transport="idle" data-focus="A">');
  if (meta.curtainTitle) {
    html = html
      .replace('<p class="curtain__title" id="curtain-title">&nbsp;</p>', `<p class="curtain__title" id="curtain-title">${esc(meta.curtainTitle)}</p>`)
      .replace('<p class="curtain__by" id="curtain-by"></p>', `<p class="curtain__by" id="curtain-by">${esc(meta.curtainBy)}</p>`);
  }
  return html;
}

// What the picture shows.
export function cardFor(song, { appOrigin = '' } = {}) {
  return {
    kicker: song.from?.title ? 'A remix' : 'A shared song',
    title: song.title,
    detail: creditLine({ by: song.by, ownerName: song.ownerName, bpm: song.bpm }),
    from: remixLine(song.from),
    seed: song.seed,
    rows: song.trackCount,
    host: appOrigin ? new URL(appOrigin).host : 'hackthebeats.com',
  };
}

// How long a browser (max-age) and the hosting's own cache (s-maxage) keep each answer. A
// link switched off can show its title for up to five minutes, and its picture for fifteen.
const CACHE = { page: 'public, max-age=60, s-maxage=300', card: 'public, max-age=600, s-maxage=900', gone: 'public, max-age=60, s-maxage=60' };
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "frame-ancestors 'self'",
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Robots-Tag': 'noindex',
};
const HTML = 'text/html; charset=utf-8';

// One request → { status, headers, body }.
//   request: { method, path, host }
//   lookup(shareId) → the song if its link is live, null if not; throws if the database
//     could not be reached
//   renderCard(card) → PNG bytes;  template: the player's page;  site: { appOrigin, shareOrigin }
export async function answer({ method = 'GET', path = '/', host = '' }, { lookup, renderCard, template, site = {} }) {
  const head = method === 'HEAD';
  const reply = (status, headers, body = '') => ({ status, headers: { ...SECURITY, ...headers }, body: head ? '' : body });
  if (method !== 'GET' && !head) return reply(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'Method not allowed');
  const origin = originFor(host, site);
  const asked = parseSharePath(path);
  let song = null;
  if (asked) {
    try {
      song = await lookup(asked.shareId);
    } catch {
      // a person still gets a page that works; a link preview is not handed a wrong card
      return reply(503, { 'Content-Type': HTML, 'Cache-Control': 'no-store', 'Retry-After': '30' }, renderSharePage(template, closedMeta(origin)));
    }
  }
  const fallbackCard = () => reply(302, { Location: `${origin}/og/home.png`, 'Cache-Control': CACHE.gone });
  if (!song) return asked?.asset === 'card' ? fallbackCard() : reply(404, { 'Content-Type': HTML, 'Cache-Control': CACHE.gone }, renderSharePage(template, closedMeta(origin)));
  if (asked.asset === 'card') {
    try {
      return reply(200, { 'Content-Type': 'image/png', 'Cache-Control': CACHE.card }, await renderCard(cardFor(song, site)));
    } catch {
      return fallbackCard();
    }
  }
  return reply(200, { 'Content-Type': HTML, 'Cache-Control': CACHE.page }, renderSharePage(template, pageMeta(song, { origin, shareId: asked.shareId })));
}
