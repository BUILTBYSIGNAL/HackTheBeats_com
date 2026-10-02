import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answer, parseSharePath, originFor, pageMeta, closedMeta, renderSharePage, MARKERS } from '../../js/share-page-core.js';

const template = readFileSync('index.html', 'utf8');
const site = { appOrigin: 'https://example.org', shareOrigin: 'https://play.example.org' };
const UUID = '0b9c7a1e-4f3d-4c2b-9a8e-1d2c3b4a5f6e';
const song = { title: 'Glass & <Tide> "one"', by: 'Test Person', ownerName: 'Rowan', bpm: 120, trackCount: 5, notes: ['A note about it.'], seed: 7, updatedAt: 1790000000000, from: null };

// a pretend database and picture maker
const deps = (found = song, { fail = false, card = 'PNG' } = {}) => {
  const asked = [];
  return {
    asked,
    template,
    site,
    lookup: async (id) => {
      asked.push(id);
      if (fail) throw new Error('unavailable');
      return found;
    },
    renderCard: async () => {
      if (card instanceof Error) throw card;
      return card;
    },
  };
};

test("the player's page carries every marker the function writes into", () => {
  for (const marker of MARKERS) assert.ok(template.includes(marker), marker);
});

test('addresses: a song, its picture, and nothing else', () => {
  assert.deepEqual(parseSharePath(`/s/${UUID}`), { shareId: UUID, asset: 'page' });
  assert.deepEqual(parseSharePath(`/s/${UUID}/card.png`), { shareId: UUID, asset: 'card' });
  for (const path of ['/s/hello', `/s/${UUID}/other.png`, '/', `/beats/${UUID}`]) assert.equal(parseSharePath(path), null, path);
});

test("a forged host cannot point the page anywhere but the site's own addresses", () => {
  assert.equal(originFor('play.example.org', site), 'https://play.example.org');
  assert.equal(originFor('example.org', site), 'https://example.org');
  assert.equal(originFor('evil.example.com', site), 'https://play.example.org');
});

test("a live link's page is the song's own: escaped title, description, picture, noindex", async () => {
  const result = await answer({ path: `/s/${UUID}`, host: 'play.example.org' }, deps());
  assert.equal(result.status, 200);
  assert.match(result.headers['Cache-Control'], /s-maxage=300/);
  assert.equal(result.headers['X-Robots-Tag'], 'noindex');
  const html = result.body;
  assert.match(html, /<title>Glass &amp; &lt;Tide&gt; &quot;one&quot; by Test Person — Hacking the Beats<\/title>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/play\.example\.org\/s\/[0-9a-f-]{36}\/card\.png\?v=[0-9a-z]+" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(html, /<meta name="robots" content="noindex" \/>/);
  assert.match(html, /<meta name="description" content="A live-coded song shared by Rowan\. 120 bpm, 5 tracks\. A note about it\. Play it in your browser\." \/>/);
  assert.match(html, /<body class="is-preview is-guest"/);
  assert.match(html, /id="curtain-title">Glass &amp; &lt;Tide&gt; &quot;one&quot;</);
  assert.doesNotMatch(html, /<Tide>/);
});

test('a remix says what it is a remix of', () => {
  const meta = pageMeta({ ...song, from: { title: 'Paper Kite', ownerName: 'Ana' } }, { origin: 'https://play.example.org', shareId: UUID });
  assert.match(meta.description, /Remix of "Paper Kite" by Ana\./);
});

test('a closed, unknown or malformed link says nothing about the song, and is not cached long', async () => {
  const closed = await answer({ path: `/s/${UUID}`, host: 'play.example.org' }, deps(null));
  assert.equal(closed.status, 404);
  assert.match(closed.headers['Cache-Control'], /s-maxage=60/);
  assert.doesNotMatch(closed.body, /Glass|Rowan|Test Person/);
  assert.match(closed.body, /og\/home\.png/);
  const junk = deps();
  const malformed = await answer({ path: '/s/hello', host: 'play.example.org' }, junk);
  assert.equal(malformed.status, 404);
  assert.equal(junk.asked.length, 0, 'nothing is looked up for an address that is not a link');
});

test('the picture: a PNG for a live link, the general picture otherwise', async () => {
  const card = await answer({ path: `/s/${UUID}/card.png`, host: 'play.example.org' }, deps(song, { card: 'PNG-BYTES' }));
  assert.equal(card.status, 200);
  assert.equal(card.headers['Content-Type'], 'image/png');
  assert.equal(card.body, 'PNG-BYTES');
  const gone = await answer({ path: `/s/${UUID}/card.png`, host: 'play.example.org' }, deps(null));
  assert.equal(gone.status, 302);
  assert.equal(gone.headers.Location, 'https://play.example.org/og/home.png');
  const broken = await answer({ path: `/s/${UUID}/card.png`, host: 'play.example.org' }, deps(song, { card: new Error('no fonts') }));
  assert.equal(broken.status, 302);
});

test('when the database cannot be reached, a person still gets a page and nothing is cached', async () => {
  const result = await answer({ path: `/s/${UUID}`, host: 'play.example.org' }, deps(song, { fail: true }));
  assert.equal(result.status, 503);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.match(result.body, /<body class="is-preview is-guest"/);
});

test('HEAD answers without a body; other methods are refused', async () => {
  const head = await answer({ method: 'HEAD', path: `/s/${UUID}`, host: 'play.example.org' }, deps());
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await answer({ method: 'POST', path: `/s/${UUID}` }, deps())).status, 405);
});

test('the closed page is the plain player, with its own generic tags', () => {
  const html = renderSharePage(template, closedMeta('https://play.example.org'));
  assert.match(html, /<title>A shared song — Hacking the Beats<\/title>/);
  assert.match(html, /id="curtain-title">&nbsp;</);
});
