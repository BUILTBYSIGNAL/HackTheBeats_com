import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, scoreEntry, search, groupByArea, highlight } from '../../js/learn-search-core.js';

const index = {
  areas: [
    { slug: 'play', title: 'Play with a beat' },
    { slug: 'perform', title: 'Perform' },
    { slug: 'glossary', title: 'Glossary' },
  ],
  entries: [
    { u: '/learn/perform#snapshots', a: 'perform', t: 'Snapshots', k: 'section', l: 2, s: 'Press the dot on a channel', w: 'snapshot capture bar pad channel wav' },
    { u: '/learn/glossary#snapshot', a: 'glossary', t: 'Snapshot', k: 'term', l: 3, s: 'A recording of one channel', w: 'snapshot recording channel bar pad' },
    { u: '/learn/play#knobs', a: 'play', t: 'Knobs', k: 'section', l: 2, s: 'A slider is a knob', w: 'knob slider number code reset' },
    { u: '/learn/reference#keys', a: 'reference', t: 'Ctrl+Enter', k: 'key', l: 3, s: 'Run the edited code', w: 'run edited code update' },
  ],
};

test('tokenize splits, lowers, drops the little words, and takes the s off plurals', () => {
  assert.deepEqual(tokenize('Ctrl+Enter'), ['ctrl', 'enter']);
  assert.deepEqual(tokenize('The Snapshots of a bar'), ['snapshot', 'bar']);
  assert.deepEqual(tokenize('@try lines'), ['try', 'line']);
  assert.deepEqual(tokenize('bass'), ['bass']);
  assert.deepEqual(tokenize('Café'), ['cafe']);
  assert.deepEqual(tokenize(''), []);
});

test('a whole word in the title beats a prefix, and a title beats the body', () => {
  const terms = ['snapshot'];
  const section = scoreEntry(index.entries[0], terms);
  const term = scoreEntry(index.entries[1], terms);
  assert.ok(section > 0 && term > 0);
  assert.ok(term > section, 'glossary terms are favoured');
  assert.equal(scoreEntry(index.entries[2], terms), 0);
  assert.ok(scoreEntry(index.entries[2], ['kno']) > 0, 'a prefix matches');
});

test('every word must match', () => {
  assert.ok(search(index, 'snapshot wav').length === 1);
  assert.equal(search(index, 'snapshot zebra').length, 0);
  assert.equal(search(index, '').length, 0);
  assert.equal(search(index, 'the of').length, 0);
});

test('search finds the section and the glossary term for "snapshot"', () => {
  const found = search(index, 'snapshot').map((result) => result.entry.u);
  assert.deepEqual(found, ['/learn/glossary#snapshot', '/learn/perform#snapshots']);
  assert.equal(search(index, 'ctrl').length, 1);
  assert.equal(search(index, 'snap', { limit: 1 }).length, 1);
});

test('results group in the order of the areas', () => {
  const groups = groupByArea(search(index, 'snapshot'), index.areas);
  assert.deepEqual(
    groups.map((group) => [group.area, group.title, group.results.length]),
    [
      ['perform', 'Perform', 1],
      ['glossary', 'Glossary', 1],
    ],
  );
});

test('highlight marks whole words and prefixes, and escapes markup', () => {
  assert.equal(highlight('Snapshots & <bars>', ['snapshot']), '<mark>Snapshots</mark> &amp; &lt;bars&gt;');
  assert.equal(highlight('a knob', ['kno']), 'a <mark>knob</mark>');
  assert.equal(highlight('plain', []), 'plain');
});
