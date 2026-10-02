// The link-preview function. A shared song's own address on the player (/s/<uuid>) is
// answered here, with the player's page carrying the song's title, description and
// picture, so a link pasted into a chat unfurls as that song. Everything it decides is in
// js/share-page-core.js; this file connects that to the database and to a PNG renderer.
// tools/build-functions.mjs bundles it, with the site's own modules, into dist/.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { onRequest } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { Resvg } from '@resvg/resvg-js';
import { parse } from 'acorn';
import { createAnalyzer } from '../../js/analyze-core.js';
import { createLibrary } from '../../js/library-core.js';
import { isLive, cleanFrom } from '../../js/songs-core.js';
import { answer } from '../../js/share-page-core.js';
import { cardSVG } from '../../js/card-core.js';

initializeApp();
const db = getFirestore();
const library = createLibrary(createAnalyzer(parse));
const here = (name) => new URL(name, import.meta.url);
const template = readFileSync(here('player.html'), 'utf8');
const site = JSON.parse(readFileSync(here('site.json'), 'utf8'));
// the picture's fonts travel with the function: a server has none of its own
const fontFiles = ['Inter-ExtraLight.ttf', 'JetBrainsMono-Regular.ttf', 'JetBrainsMono-Medium.ttf'].map((name) => fileURLToPath(here(`../fonts/${name}`)));
const ID = /^[A-Za-z0-9_-]{1,128}$/;

// The song a link names, if the link is live. This reads past the database's rules, so it
// checks what they would: the song is shared, not switched off by the site, and this is
// its current link (an old one stays closed even if its record was left behind).
async function lookup(shareId) {
  const share = await db.doc(`shares/${shareId}`).get();
  if (!share.exists) return null;
  const { owner, song } = share.data();
  if (!ID.test(owner || '') || !ID.test(song || '')) return null;
  const snapshot = await db.doc(`users/${owner}/songs/${song}`).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (!isLive({ shared: data.shared, blocked: data.blocked, shareId: data.shareId }, shareId)) return null;
  const described = library.describeSong({ id: song, code: typeof data.code === 'string' ? data.code : '' }, 'shared');
  return {
    title: described.untitled && typeof data.title === 'string' ? data.title : described.title,
    by: described.by,
    bpm: described.bpm,
    trackCount: described.trackCount,
    notes: described.notes,
    seed: described.seed,
    ownerName: typeof data.ownerName === 'string' ? data.ownerName : '',
    from: cleanFrom(data.from),
    updatedAt: Number(data.updatedAt) || 0,
  };
}

const renderCard = (card) =>
  new Resvg(cardSVG(card), { fitTo: { mode: 'width', value: 1200 }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();

export const sharePage = onRequest({ region: 'us-central1', memory: '512MiB', cpu: 1, concurrency: 40, timeoutSeconds: 10, maxInstances: 10 }, async (req, res) => {
  const result = await answer({ method: req.method, path: req.path, host: req.get('x-forwarded-host') || req.get('host') || '' }, { lookup, renderCard, template, site });
  res.status(result.status).set(result.headers).send(result.body);
});
