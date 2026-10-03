import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetState } from '../../js/share-sheet-core.js';

const own = { kind: 'own', accounts: true, title: 'Glass Tide', host: 'play.example.org', sharer: 'Rowan', synced: true };

test('my own song, not shared yet: a switch and no link', () => {
  const view = sheetState({ ...own, shared: false });
  assert.deepEqual(view.toggle, { on: false, disabled: false });
  assert.equal(view.link, null);
  assert.equal(view.warning, null);
});

test('my own song, shared: the link, and what they will find', () => {
  const view = sheetState({ ...own, shared: true, link: 'https://play.example.org/#song=x' });
  assert.equal(view.toggle.on, true);
  assert.equal(view.link.text, 'https://play.example.org/#song=x');
  assert.match(view.link.note, /latest saved version/);
  assert.match(view.recipient, /"Glass Tide" on play\.example\.org, shared by Rowan/);
});

test('while the link is being made, or the account was not reached, it says so', () => {
  assert.equal(sheetState({ ...own, shared: true, busy: true }).link.pending, true);
  assert.equal(sheetState({ ...own, shared: true, busy: true }).toggle.disabled, true);
  assert.match(sheetState({ ...own, shared: true, link: 'x', synced: false }).link.note, /could not be reached/);
});

test('unsaved changes: offered to save first, or to share what was saved', () => {
  const view = sheetState({ ...own, shared: true, link: 'x', edited: true });
  assert.equal(view.warning.primary.action, 'save-share');
  assert.equal(view.warning.secondary.action, 'dismiss');
  assert.equal(sheetState({ ...own, shared: true, link: 'x', edited: true, dismissed: true }).warning, null);
});

test('a song the site switched off cannot be shared again', () => {
  const view = sheetState({ ...own, shared: false, blocked: true });
  assert.deepEqual(view.toggle, { on: false, disabled: true });
  assert.match(view.note, /switched sharing off/);
  assert.equal(view.link, null);
});

test('without accounts there is nothing to switch on', () => {
  const view = sheetState({ ...own, accounts: false });
  assert.equal(view.toggle, null);
  assert.match(view.note, /needs accounts/);
});

test("a site beat: the sheet says so, and leads with a copy of one's own", () => {
  const view = sheetState({ kind: 'beat', title: 'Amber', accounts: true, link: 'https://example.org/beats/amber#mix=abc', audience: 'everyone' });
  assert.match(view.intro, /"Amber" is one of the site's beats/);
  assert.equal(view.offer.action, 'save-new-share');
  assert.match(view.offer.text, /its own title and picture/);
  assert.equal(view.toggle, null);
  assert.match(view.link.note, /^Or share the beat itself: .*knob and switch positions/);
  assert.match(view.recipient, /no account needed/);
  assert.match(sheetState({ kind: 'beat', title: 'Amber', accounts: true, link: 'x', audience: 'members' }).recipient, /sign in/);
  // with changes on the deck, the copy takes them along; the beat's own link does not
  const edited = sheetState({ kind: 'beat', title: 'Amber', accounts: true, link: 'x', edited: true });
  assert.match(edited.offer.text, /with your changes/);
  assert.match(edited.link.note, /without your changes/);
  assert.equal(edited.warning, null);
});

test('a site beat only you can play gets no link, and says why', () => {
  const view = sheetState({ kind: 'beat', title: 'Amber', accounts: true, link: 'x', audience: 'admin' });
  assert.equal(view.link, null);
  assert.match(view.recipient, /Only you can play this beat/);
  assert.equal(view.offer.action, 'save-new-share');
});

test('without accounts, a site beat is shared as a mix, and changes are kept first', () => {
  const view = sheetState({ kind: 'beat', title: 'Amber', accounts: false, link: 'x', audience: 'everyone' });
  assert.equal(view.offer, null);
  assert.match(view.link.note, /^This link: /);
  assert.equal(sheetState({ kind: 'beat', title: 'Amber', accounts: false, link: 'x', edited: true }).warning.primary.action, 'save-new');
});

test("someone else's song is shared by its own link", () => {
  const view = sheetState({ kind: 'theirs', link: 'https://play.example.org/#song=y', ownerName: 'Ana' });
  assert.match(view.link.note, /Ana's song/);
  assert.equal(sheetState({ kind: 'theirs', link: 'y', edited: true }).warning.primary.action, 'save-new-share');
});

test('a song no longer in My songs is kept before it is shared', () => {
  const view = sheetState({ kind: 'loose' });
  assert.equal(view.warning.primary.action, 'save-new');
  assert.equal(view.link, null);
});

test('my own song, while shared, can be offered to the community shelf', () => {
  const view = sheetState({ ...own, shared: true, link: 'x' });
  assert.deepEqual({ on: view.feature.on, disabled: view.feature.disabled }, { on: false, disabled: false });
  assert.match(view.feature.note, /title, your name and its header notes appear under From the community\. Untick to withdraw it\./);
  assert.equal(sheetState({ ...own, shared: true, link: 'x', featurable: true }).feature.on, true);
  assert.equal(sheetState({ ...own, shared: true, busy: true, featurable: true }).feature.disabled, true);
  // not while it is private, switched off by the site, or anywhere without accounts
  assert.equal(sheetState({ ...own, shared: false, featurable: true }).feature, null);
  assert.equal(sheetState({ ...own, shared: false, blocked: true, featurable: true }).feature, null);
  assert.equal(sheetState({ ...own, accounts: false, shared: true }).feature, null);
  // a link from before links were UUIDs has no entry the shelf could name: the sharing switch stays
  const old = sheetState({ ...own, shared: true, link: 'x', oldLink: true });
  assert.equal(old.feature, null);
  assert.equal(old.toggle.on, true);
  assert.equal(old.link.text, 'x');
  assert.equal(sheetState({ kind: 'beat', title: 'Amber', accounts: true, link: 'x', audience: 'everyone' }).feature, null);
  assert.equal(sheetState({ kind: 'theirs', link: 'y', ownerName: 'Ana' }).feature, null);
});
