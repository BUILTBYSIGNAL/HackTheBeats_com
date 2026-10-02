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

test('a built-in beat is shared as a mix, and says who can play it', () => {
  const view = sheetState({ kind: 'beat', link: 'https://example.org/beats/amber#mix=abc', audience: 'everyone' });
  assert.equal(view.toggle, null);
  assert.match(view.link.note, /knob and switch positions/);
  assert.match(view.recipient, /no account needed/);
  assert.match(sheetState({ kind: 'beat', link: 'x', audience: 'members' }).recipient, /sign in/);
  assert.match(sheetState({ kind: 'beat', link: 'x', audience: 'admin' }).recipient, /Only you/);
  assert.equal(sheetState({ kind: 'beat', link: 'x', edited: true }).warning.primary.action, 'save-new-share');
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
