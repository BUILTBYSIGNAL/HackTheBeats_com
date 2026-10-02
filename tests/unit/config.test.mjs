import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeOf } from '../../js/config.js';

const two = { appOrigin: 'https://example.org', shareOrigin: 'https://play.example.org' };
const at = (origin) => ({ origin, hostname: new URL(origin).hostname });

test("each of the site's two addresses knows which one it is", () => {
  assert.deepEqual(placeOf(two, at('https://example.org')), { split: true, guest: false, stray: '' });
  assert.deepEqual(placeOf(two, at('https://play.example.org')), { split: true, guest: true, stray: '' });
});

test('the same files at any other address on the internet are a stray copy, sent home', () => {
  for (const origin of ['https://example.web.app', 'https://example-play.firebaseapp.com', 'https://www.example.org', 'http://example.org']) {
    assert.deepEqual(placeOf(two, at(origin)), { split: false, guest: false, stray: 'https://example.org' }, origin);
  }
});

test('an address written with a slash on the end is the same address', () => {
  const slashed = { appOrigin: 'https://example.org/', shareOrigin: 'https://play.example.org/' };
  // (taken literally, the site would be a stray copy of itself and never stop going home)
  assert.deepEqual(placeOf(slashed, at('https://example.org')), { split: true, guest: false, stray: '' });
  assert.deepEqual(placeOf(slashed, at('https://play.example.org')), { split: true, guest: true, stray: '' });
  assert.equal(placeOf(slashed, at('https://example.web.app')).stray, 'https://example.org');
});

test('a copy on this machine or this network is left alone, and so is a site with one address', () => {
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173', 'http://app.localhost:8080', 'http://192.168.1.20:5173']) {
    assert.deepEqual(placeOf(two, at(origin)), { split: false, guest: false, stray: '' }, origin);
  }
  assert.deepEqual(placeOf({ appOrigin: 'https://example.org', shareOrigin: '' }, at('https://example.web.app')), { split: false, guest: false, stray: '' });
  // the build and the tests have no address at all
  assert.deepEqual(placeOf(two), { split: false, guest: false, stray: '' });
});
