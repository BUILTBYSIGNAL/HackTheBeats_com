import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardSVG, wrapTitle, fitTitle, textWidth, coverable, WIDTH, HEIGHT } from '../../js/card-core.js';

test('a card is a 1200×630 picture, the same every time for the same song', () => {
  const card = cardSVG({ title: 'Paper Kite', detail: 'by Ana · 120 bpm', seed: 42 });
  assert.equal(WIDTH, 1200);
  assert.equal(HEIGHT, 630);
  assert.match(card, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630"/);
  assert.equal(card, cardSVG({ title: 'Paper Kite', detail: 'by Ana · 120 bpm', seed: 42 }));
  assert.notEqual(card, cardSVG({ title: 'Paper Kite', detail: 'by Ana · 120 bpm', seed: 43 }));
});

test('what a song says about itself cannot break out of the picture', () => {
  const card = cardSVG({ title: '</text><script>alert(1)</script>', detail: 'by "Ana" & co', from: 'Remix of <b>x</b>' });
  assert.doesNotMatch(card, /<script|<b>/);
  assert.match(card, /&lt;\/text&gt;&lt;script&gt;/);
  assert.match(card, /by &quot;Ana&quot; &amp; co/);
});

test('a long title wraps to two lines at most, smaller as it grows', () => {
  assert.equal(fitTitle('Kite', 180).size, 132);
  const long = fitTitle('A very long title that goes on and on past any sensible length for a song', 180);
  assert.ok(long.lines.length <= 2);
  assert.ok(long.size < 132);
  for (const line of wrapTitle('Words that wrap across the card at this size', 108)) assert.ok(textWidth(line, 108) <= 1070, line);
  assert.match(wrapTitle('Supercalifragilisticexpialidocious'.repeat(3), 132)[0], /…$/);
});

test('text the fonts cannot draw gives way to a plain title', () => {
  assert.equal(coverable('Glass Tide — Café Ελλάδα Привет'), true);
  assert.equal(coverable('夜の歌'), false);
  assert.equal(coverable('Beat 🎵'), false);
  assert.match(cardSVG({ title: '夜の歌' }), /A song made in code/);
});
