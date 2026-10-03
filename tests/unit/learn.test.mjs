import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'acorn';
import {
  articleOf,
  attrsOf,
  buildSearchIndex,
  codeBlockHTML,
  expandCode,
  expandFigures,
  glossaryOf,
  headingsOf,
  liftCode,
  markTerms,
  navHTML,
  pagerHTML,
  pngSize,
  renderCode,
  resolveLinks,
  sectionsOf,
  textOf,
} from '../../js/learn-core.js';
import { buildLearn, listAreas } from '../../tools/learn.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('attrsOf reads quoted and bare attributes', () => {
  assert.deepEqual(attrsOf(' class="code" data-open data-title="A &amp; B"'), { class: 'code', 'data-open': '', 'data-title': 'A &amp; B' });
});

test('articleOf wants a root with a title and a description', () => {
  assert.deepEqual(articleOf('<article data-title="T" data-description="D">hi</article>').inner, 'hi');
  assert.equal(articleOf('<article data-title="T">hi</article>').problems.length, 1);
  assert.equal(articleOf('<p>no root</p>').problems.length, 1);
});

test('headingsOf finds levels, ids and titles, and reports a missing or doubled id', () => {
  const { headings, problems } = headingsOf('<h2 id="a">One <code>x</code></h2><p>…</p><h3 id="b">Two</h3><h2>Three</h2><h3 id="a">Four</h3>');
  assert.deepEqual(
    headings.map(({ level, id, title }) => [level, id, title]),
    [
      [2, 'a', 'One x'],
      [3, 'b', 'Two'],
      [2, '', 'Three'],
      [3, 'a', 'Four'],
    ],
  );
  assert.equal(problems.length, 2);
});

test('textOf strips tags and decodes what is written as entities', () => {
  assert.equal(textOf('<p>a &lt;b&gt; &amp; c&nbsp;d</p>  <span>e</span>'), 'a <b> & c d e');
});

test('sectionsOf gives each heading its own words, and the lede before the first', () => {
  const html = '<p class="lede">Hello there.</p><h2 id="a">A</h2><p>one</p><h3 id="b">B</h3><p>two</p><h2 id="c">C</h2><p>three</p>';
  const { lede, sections } = sectionsOf(html, headingsOf(html).headings);
  assert.equal(lede, 'Hello there.');
  assert.deepEqual(
    sections.map((section) => [section.id, section.text]),
    [
      ['a', 'one'],
      ['b', 'two'],
      ['c', 'three'],
    ],
  );
});

test('liftCode takes code out of the way and expandCode puts it back rendered', () => {
  const { html, blocks } = liftCode('<p>x</p><pre class="code" data-title="T">n("<0 2>")\n</pre><pre class="code" data-example="e" data-open></pre>');
  assert.equal(blocks.length, 2);
  assert.ok(!html.includes('<0 2>'));
  const { html: out, problems } = expandCode(html, blocks, new Map([['e', '/*\n  @title Amber\n*/\nDRUMS: s("bd*4")']]));
  assert.deepEqual(problems, []);
  assert.ok(out.includes('&lt;0 2&gt;'), 'the literal text is escaped');
  assert.ok(out.includes('code__title">T<'));
  assert.ok(out.includes('code__title">Amber<'), 'an example is titled from its @title');
  assert.ok(out.includes('href="/#start=e"'), 'data-open gives an Open in the player link');
  assert.ok(expandCode(html, blocks, new Map()).problems.length === 1, 'a missing example is reported');
});

test('renderCode inks tokens like the stage, and leaves plain text alone', () => {
  const html = renderCode('BASS: note("<c2>") // low\nconst x = 1');
  assert.ok(html.includes('<span class="tok-label">BASS</span>'));
  assert.ok(html.includes('<span class="tok-string">&quot;&lt;c2&gt;&quot;</span>'));
  assert.ok(html.includes('<span class="tok-comment">// low</span>'));
  assert.ok(html.includes('<span class="tok-keyword">const</span>'));
  assert.equal(renderCode('a < b', { lang: 'text' }), 'a &lt; b');
  assert.ok(codeBlockHTML({ code: 'x' }).startsWith('<div class="code"><pre><code>'));
});

test('markTerms gives a term its class and address, and knows which terms exist', () => {
  const { html, problems, used } = markTerms('<a data-term="knob">knobs</a> and <a class="x" data-term="nope">no</a> <a data-start="macro">Open</a>', new Set(['knob']), new Set(['macro']));
  assert.ok(html.includes('<a data-term="knob" class="term" href="/learn/glossary#knob">'));
  assert.ok(html.includes('class="code__open"') && html.includes('href="/#start=macro"'));
  assert.deepEqual([...used], ['knob', 'nope']);
  assert.equal(problems.length, 1);
});

test('resolveLinks turns authors\' links into addresses and checks them', () => {
  const pages = new Map([
    ['play', new Set(['knobs'])],
    ['perform', new Set(['pads'])],
  ]);
  const { html, problems } = resolveLinks(
    '<a href="#knobs">1</a> <a href="perform#pads">2</a> <a href="perform">3</a> <a href="about">4</a> <a href="https://strudel.cc">5</a> <a href="learn">6</a> <a href="#gone">7</a> <a href="perform#gone">8</a> <a href="nowhere">9</a> <a href="/learn/play#knobs">10</a>',
    { area: 'play', pages },
  );
  assert.ok(html.includes('href="#knobs"'));
  assert.ok(html.includes('href="/learn/perform#pads"'));
  assert.ok(html.includes('href="/learn/perform">3'));
  assert.ok(html.includes('href="/about"'));
  assert.ok(html.includes('href="https://strudel.cc" target="_blank" rel="noopener"'));
  assert.ok(html.includes('href="/learn">6'));
  assert.ok(html.includes('href="/learn/play#knobs">10'));
  assert.equal(problems.length, 3, problems.join('; '));
});

test('glossaryOf reads entries and reports what is missing', () => {
  const { entries, problems } = glossaryOf(
    '<dl class="glossary"><div class="entry" id="a" data-related="b"><dt>A</dt><dd><p>one</p><p class="entry__more"><a href="play#x">Read</a></p></dd></div><div class="entry" id="b"><dt>B</dt><dd><p>two</p></dd></div></dl>',
  );
  assert.deepEqual([...entries.keys()], ['a', 'b']);
  assert.equal(entries.get('a').more, 'play#x');
  assert.equal(entries.get('a').text, 'A one');
  assert.deepEqual(entries.get('a').related, ['b']);
  assert.equal(problems.length, 1, 'b has no full-section link');
});

test('expandFigures makes a sized, lazy picture, and reports one that is not there', () => {
  const sizes = new Map([['deck-pads', { width: 800, height: 300 }]]);
  const { html, problems } = expandFigures('<figure data-shot="deck-pads" data-alt="Pads"><figcaption>c</figcaption></figure><figure data-shot="nope" data-alt=""></figure>', sizes);
  assert.ok(html.includes('<img src="/images/learn/deck-pads.png" alt="Pads" width="800" height="300" style="max-width: 400px" loading="lazy" decoding="async" />'));
  assert.ok(html.includes('<figcaption>c</figcaption></figure>'));
  assert.equal(problems.length, 2);
});

test('pngSize reads the header', () => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x01, 0x00, 0, 0, 0, 0x80]);
  assert.deepEqual(pngSize(bytes), { width: 256, height: 128 });
  assert.equal(pngSize(new Uint8Array(10)), null);
});

test('navHTML opens the current area, and pagerHTML knows the ends', () => {
  const areas = [
    { slug: 'start', title: 'Start', group: 'Getting started' },
    { slug: 'play', title: 'Play', group: 'Knowledge base' },
  ];
  const nav = navHTML(areas, 'play', [{ level: 2, id: 'knobs', title: 'Knobs' }]);
  assert.ok(nav.includes('aria-current="page">Play</a><ol class="learnnav__sections"><li><a href="#knobs">Knobs</a>'));
  assert.ok(!nav.includes('aria-current="page">Start'));
  assert.ok(navHTML(areas, null).includes('href="/learn" aria-current="page"'));
  assert.ok(pagerHTML(areas, null).includes('href="/learn/start"') && !pagerHTML(areas, null).includes('pager__prev" href'));
  assert.ok(pagerHTML(areas, 'play').includes('href="/learn/start"') && !pagerHTML(areas, 'play').includes('pager__next" href'));
});

test('buildSearchIndex makes an entry for pages, sections, terms and keys', () => {
  const index = buildSearchIndex({
    version: '1',
    areas: [{ slug: 'play', title: 'Play' }],
    pages: [{ slug: 'play', path: '/learn/play', title: 'Play', lede: 'hello', sections: [{ id: 'knobs', level: 2, title: 'Knobs', text: 'turn one' }] }],
    glossary: [{ id: 'knob', title: 'Knob', text: 'a knob' }],
    keys: [{ title: 'Space', text: 'Play or stop' }],
  });
  assert.deepEqual(
    index.entries.map((entry) => [entry.u, entry.k]),
    [
      ['/learn/play', 'page'],
      ['/learn/play#knobs', 'section'],
      ['/learn/glossary#knob', 'term'],
      ['/learn/reference#keys', 'key'],
    ],
  );
  assert.equal(index.entries[1].w, 'knob turn one');
});

/* ---------- the real guide: everything in learn/ must hold together ---------- */

test('the guide builds with nothing to fix', () => {
  const built = buildLearn(root);
  assert.deepEqual(built.problems, []);
  assert.ok(built.pages.length >= 2);
  for (const page of built.pages) {
    assert.ok(page.html.includes('<!--seo-->'), `${page.path} keeps the seo marker for the site build`);
    assert.ok(page.html.includes('<main class="learn__body learn-content" id="article"'), `${page.path} has the article the lightbox shows`);
    assert.ok(/<title>[^<]+<\/title>/.test(page.html) && /<meta name="description" content="[^"]+"/.test(page.html), `${page.path} has a title and a description`);
  }
  assert.ok(JSON.stringify(built.search).length < 150_000, 'the search index stays small');
});

test('every area has a title, a description and sections; the slugs are the planned ones', () => {
  const areas = listAreas(root);
  assert.deepEqual(
    areas.map((area) => area.slug),
    ['start', 'play', 'perform', 'remix', 'build', 'share', 'reference', 'glossary'],
  );
  for (const area of areas) {
    assert.ok(area.title && area.description, `${area.file} has a title and a description`);
    assert.ok(headingsOf(liftCode(area.inner).html).headings.length > 0 || area.slug === 'glossary', `${area.file} has sections`);
  }
});

test('every example song parses and carries a title', () => {
  const dir = join(root, 'learn/examples');
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.strudel'))) {
    const code = readFileSync(join(dir, file), 'utf8');
    assert.doesNotThrow(() => parse(code, { ecmaVersion: 'latest', sourceType: 'module' }), file);
    assert.ok(/@title\s+\S/.test(code), `${file} has an @title`);
  }
});
