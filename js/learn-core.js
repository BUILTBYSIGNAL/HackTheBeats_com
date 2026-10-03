// The Learn guide, from its sources to pages: the pure parts. tools/learn.mjs reads the files
// and calls these; the unit tests call them with strings. No DOM here, and nothing read from
// disk, so it runs in Node and in the browser alike.
//
// An area is an HTML file whose root is <article data-title data-description data-kicker
// data-group>. The conventions its body follows are listed at the top of learn/template.html;
// every one of them is checked here, and each slip is reported as a problem in plain words.
import { tokenizeLines } from './clip-core.js';
import { tokenize } from './learn-search-core.js';

export const AREA_GROUPS = ['Getting started', 'Knowledge base', 'Reference'];
export const LEARN_PATH = '/learn';
export const areaPath = (slug) => (slug ? `${LEARN_PATH}/${slug}` : LEARN_PATH);
export const exampleLink = (id) => `/#start=${encodeURIComponent(id)}`;
export const shotPath = (name) => `/images/learn/${name}.png`;

export const escapeHTML = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rarr: '→', larr: '←', times: '×' };
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

// The attributes of one tag's attribute string: { name: value }, a bare attribute being ''.
export function attrsOf(text) {
  const attrs = {};
  for (const match of String(text ?? '').matchAll(/([a-zA-Z][\w-]*)(?:\s*=\s*"([^"]*)")?/g)) attrs[match[1]] = match[2] ?? '';
  return attrs;
}

// The <article …>…</article> an area or the landing is made of.
export function articleOf(html) {
  const match = /<article\b([^>]*)>([\s\S]*)<\/article>/.exec(html);
  if (!match) return { attrs: {}, inner: '', problems: ['the file has no <article> root'] };
  const attrs = attrsOf(match[1]);
  const problems = [];
  for (const name of ['data-title', 'data-description']) if (!attrs[name]) problems.push(`the <article> has no ${name}`);
  return { attrs, inner: match[2], problems };
}

const HOLD = '\u0000';
const holdMark = (index) => `${HOLD}${index}${HOLD}`;

// Code blocks taken out of the way, so that what is inside them (mini-notation is full of <)
// is never read as markup: { html, blocks: [{ attrs, text }] }. expandCode puts them back.
export function liftCode(html) {
  const blocks = [];
  const lifted = String(html).replace(/<pre class="code"([^>]*)>([\s\S]*?)<\/pre>/g, (match, attrText, text) => {
    blocks.push({ attrs: attrsOf(attrText), text: text.replace(/^\n/, '').replace(/\n[ \t]*$/, '') });
    return holdMark(blocks.length - 1);
  });
  return { html: lifted, blocks };
}

// Everything but the tags, as one line of words.
export function textOf(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// The page's h2 and h3 headings, in order: [{ level, id, title, from, to }]. Every heading
// needs an id of its own (deep links and the help sheet's links depend on them).
export function headingsOf(html) {
  const headings = [];
  const problems = [];
  const seen = new Set();
  for (const match of String(html).matchAll(/<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/g)) {
    const { id } = attrsOf(match[2]);
    const title = textOf(match[3]);
    if (!id) problems.push(`the heading "${title}" has no id`);
    else if (seen.has(id)) problems.push(`two headings share the id "${id}"`);
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) problems.push(`the heading id "${id}" should be lower-case words joined with -`);
    seen.add(id);
    headings.push({ level: Number(match[1]), id: id || '', title, from: match.index, to: match.index + match[0].length });
  }
  return { headings, problems };
}

// What is said under each heading, up to the next one: [{ id, level, title, text }], and the
// words before the first heading as `lede`.
export function sectionsOf(html, headings) {
  const text = String(html);
  const sections = headings.map((heading, index) => ({
    id: heading.id,
    level: heading.level,
    title: heading.title,
    text: textOf(text.slice(heading.to, headings[index + 1]?.from ?? text.length)),
  }));
  return { lede: textOf(text.slice(0, headings[0]?.from ?? text.length)), sections };
}

// Every id a page carries (headings and glossary entries), for links to be checked against.
export function idsOf(html) {
  const ids = new Set();
  for (const match of String(html).matchAll(/\bid="([^"]+)"/g)) ids.add(match[1]);
  return ids;
}

// Every <a …> rewritten the way one tag's attributes ask: `rewrite(attrs) → attrs | null`.
function rewriteLinks(html, rewrite) {
  return String(html).replace(/<a\b([^>]*)>/g, (match, attrText) => {
    const attrs = rewrite(attrsOf(attrText));
    if (!attrs) return match;
    return `<a ${Object.entries(attrs)
      .map(([name, value]) => (value === '' && name !== 'href' ? name : `${name}="${value}"`))
      .join(' ')}>`;
  });
}

const addClass = (attrs, name) => ({ ...attrs, class: attrs.class ? `${attrs.class} ${name}` : name });

// Glossary terms (<a data-term="x">) get their class and their address, and bare
// open-in-the-player links (<a data-start="id">) their address.
export function markTerms(html, glossaryIds, exampleIds = new Set()) {
  const problems = [];
  const used = new Set();
  const marked = rewriteLinks(html, (attrs) => {
    if (attrs['data-term'] !== undefined) {
      const id = attrs['data-term'];
      if (!glossaryIds.has(id)) problems.push(`the term "${id}" is not in the glossary`);
      used.add(id);
      return { ...addClass(attrs, 'term'), href: `${areaPath('glossary')}#${id}` };
    }
    if (attrs['data-start'] !== undefined) {
      const id = attrs['data-start'];
      if (!exampleIds.has(id)) problems.push(`there is no example "${id}" to open in the player`);
      return { ...addClass(attrs, 'code__open'), href: exampleLink(id) };
    }
    return null;
  });
  return { html: marked, problems, used };
}

// Links as authors write them (#id, perform#pads, perform, about, /, https://…) become what
// the page needs (/learn/perform#pads, with target and rel on anything external), and every
// one is checked: `pages` maps a slug to the ids that page has.
export function resolveLinks(html, { area, pages }) {
  const problems = [];
  const own = pages.get(area) || new Set();
  const resolved = rewriteLinks(html, (attrs) => {
    const href = attrs.href;
    if (href === undefined) return null;
    if (href.startsWith('#')) {
      if (!own.has(href.slice(1))) problems.push(`the link "${href}" points at nothing on this page`);
      return null;
    }
    if (/^(https?:)?\/\//.test(href)) {
      return attrs.target === undefined ? { ...attrs, target: '_blank', rel: 'noopener' } : null;
    }
    if (/^(mailto:|tel:)/.test(href)) return null;
    if (href === '/' || href === './' || href.startsWith('/#') || href.startsWith('/beats/') || href === 'about' || href === 'privacy' || href === '/about' || href === '/privacy') {
      return href.startsWith('/') ? null : { ...attrs, href: `/${href}` };
    }
    const match = /^(?:\/learn\/?|learn\/?)?([a-z-]*)(?:#([\w-]+))?$/.exec(href);
    if (!match) {
      problems.push(`the link "${href}" is not an address the guide knows`);
      return null;
    }
    const [, slug, id] = match;
    if (slug === '') {
      // /learn, learn, or just a hash to the landing
      return { ...attrs, href: `${LEARN_PATH}${id ? `#${id}` : ''}` };
    }
    if (!pages.has(slug)) {
      problems.push(`the link "${href}" names an area that does not exist`);
      return null;
    }
    if (id && !pages.get(slug).has(id)) problems.push(`the link "${href}" points at nothing on the ${slug} page`);
    return { ...attrs, href: `${areaPath(slug)}${id ? `#${id}` : ''}` };
  });
  return { html: resolved, problems };
}

// The glossary page's entries: Map id → { title, more, related }
export function glossaryOf(html) {
  const entries = new Map();
  const problems = [];
  for (const match of String(html).matchAll(/<div class="entry"([^>]*)>([\s\S]*?)<\/div>/g)) {
    const attrs = attrsOf(match[1]);
    const title = textOf(/<dt>([\s\S]*?)<\/dt>/.exec(match[2])?.[1] ?? '');
    const more = /class="entry__more"[^>]*>\s*<a\b[^>]*href="([^"]*)"/.exec(match[2])?.[1] ?? null;
    if (!attrs.id) problems.push(`the glossary entry "${title}" has no id`);
    else if (entries.has(attrs.id)) problems.push(`two glossary entries share the id "${attrs.id}"`);
    if (!title) problems.push(`the glossary entry "${attrs.id}" has no <dt>`);
    if (!more) problems.push(`the glossary entry "${attrs.id}" has no "Read the full section" link`);
    entries.set(attrs.id, { title, more, related: (attrs['data-related'] || '').split(/\s+/).filter(Boolean), text: textOf(match[2].replace(/<p class="entry__more">[\s\S]*?<\/p>/, '')) });
  }
  for (const [id, entry] of entries) {
    for (const other of entry.related) if (!entries.has(other)) problems.push(`the glossary entry "${id}" relates to "${other}", which is not an entry`);
  }
  return { entries, problems };
}

// Code as HTML, each token in a span the stylesheet inks the way the stage does.
export function renderCode(code, { lang = 'js' } = {}) {
  if (lang === 'text') return escapeHTML(code);
  return tokenizeLines(code)
    .map(({ from, text, tokens }) => {
      let out = '';
      let at = 0;
      for (const token of tokens) {
        const start = token.from - from;
        const end = token.to - from;
        out += escapeHTML(text.slice(at, start));
        out += `<span class="tok-${token.kind}">${escapeHTML(text.slice(start, end))}</span>`;
        at = end;
      }
      return out + escapeHTML(text.slice(at));
    })
    .join('\n');
}

export const titleIn = (code) => /@title[ \t]+(.+)/.exec(code)?.[1]?.trim() ?? null;

// One code block as the page shows it.
export function codeBlockHTML({ id = null, title = '', code = '', open = false, lang = 'js' }) {
  const bar = title || open ? `<div class="code__bar"><span class="code__title">${escapeHTML(title)}</span>${open && id ? `<a class="code__open" data-start="${escapeHTML(id)}" href="${exampleLink(id)}">Open in the player</a>` : ''}</div>` : '';
  return `<div class="code"${id ? ` data-example="${escapeHTML(id)}"` : ''}>${bar}<pre><code>${renderCode(code, { lang })}</code></pre></div>`;
}

// The lifted code blocks put back, rendered. `examples` maps an id to its code.
export function expandCode(html, blocks, examples = new Map()) {
  const problems = [];
  const expanded = String(html).replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (match, index) => {
    const block = blocks[Number(index)];
    const id = block.attrs['data-example'];
    let code = block.text;
    let title = block.attrs['data-title'] ?? '';
    if (id !== undefined) {
      if (!examples.has(id)) {
        problems.push(`there is no example "${id}" to show`);
        code = '';
      } else {
        code = examples.get(id);
        if (!title) title = titleIn(code) ?? id;
      }
    }
    return codeBlockHTML({ id: id ?? null, title, code, open: block.attrs['data-open'] !== undefined, lang: block.attrs['data-lang'] || 'js' });
  });
  return { html: expanded, problems };
}

// <figure data-shot data-alt> becomes a figure with its picture, sized so the page does not
// jump as it loads. `sizes` maps a shot's name to { width, height }.
export function expandFigures(html, sizes) {
  const problems = [];
  const shots = new Set();
  const expanded = String(html).replace(/<figure\b([^>]*\bdata-shot="([^"]+)"[^>]*)>([\s\S]*?)<\/figure>/g, (match, attrText, name, inner) => {
    const attrs = attrsOf(attrText);
    const alt = attrs['data-alt'] ?? '';
    const size = sizes.get(name);
    shots.add(name);
    if (!size) problems.push(`the picture "${name}" is not in images/learn/`);
    if (!alt) problems.push(`the picture "${name}" has no data-alt`);
    // the pictures are captured at twice the screen's size: shown at most at the size they
    // had on screen, so a small crop stays small
    const dims = size ? ` width="${size.width}" height="${size.height}" style="max-width: ${Math.round(size.width / 2)}px"` : '';
    return `<figure class="shot" data-shot="${escapeHTML(name)}"><img src="${shotPath(name)}" alt="${escapeHTML(alt)}"${dims} loading="lazy" decoding="async" />${inner}</figure>`;
  });
  return { html: expanded, problems, shots };
}

// A PNG's size from its header, or null.
export function pngSize(bytes) {
  const b = bytes;
  if (!b || b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  const read = (at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
  return { width: read(16), height: read(20) };
}

// The left navigation: the areas in their groups, the current one opened to its sections.
//   areas: [{ slug, title, group }]; current: slug or null (the landing); headings: the page's
export function navHTML(areas, current, headings = []) {
  const groups = AREA_GROUPS.map((group) => ({ group, areas: areas.filter((area) => area.group === group) })).filter((entry) => entry.areas.length);
  const sections = headings
    .filter((heading) => heading.level === 2)
    .map((heading) => `<li><a href="#${heading.id}">${escapeHTML(heading.title)}</a></li>`)
    .join('');
  const item = (area) =>
    `<li${area.slug === current ? ' class="is-current"' : ''}><a href="${areaPath(area.slug)}"${area.slug === current ? ' aria-current="page"' : ''}>${escapeHTML(area.title)}</a>${
      area.slug === current && sections ? `<ol class="learnnav__sections">${sections}</ol>` : ''
    }</li>`;
  return [
    `<p class="learnnav__home"><a href="${LEARN_PATH}"${current === null ? ' aria-current="page"' : ''}>Learn</a></p>`,
    ...groups.map((entry) => `<section class="learnnav__group"><h2 class="learnnav__label">${escapeHTML(entry.group)}</h2><ol>${entry.areas.map(item).join('')}</ol></section>`),
  ].join('\n');
}

// Previous and next, at the end of the page: the landing comes before the first area.
export function pagerHTML(areas, current) {
  const list = [{ slug: null, title: 'Learn' }, ...areas];
  const index = list.findIndex((entry) => entry.slug === current);
  if (index < 0) return '';
  const prev = list[index - 1];
  const next = list[index + 1];
  const link = (entry, label, side) => (entry ? `<a class="pager__${side}" href="${areaPath(entry.slug)}"><span class="pager__kicker">${label}</span><span class="pager__title">${escapeHTML(entry.title)}</span></a>` : `<span class="pager__${side}"></span>`);
  return `<nav class="pager" aria-label="Previous and next">${link(prev, 'Previous', 'prev')}${link(next, 'Next', 'next')}</nav>`;
}

// The landing's list of areas: a card each, with the first sections as links.
//   sections: Map slug → [{ id, title }]
export function areaCardsHTML(areas, sections) {
  const groups = AREA_GROUPS.map((group) => ({ group, areas: areas.filter((area) => area.group === group) })).filter((entry) => entry.areas.length);
  return groups
    .map(
      (entry) =>
        `<section class="areas" aria-label="${escapeHTML(entry.group)}"><h2 class="areas__label">${escapeHTML(entry.group)}</h2><div class="areas__grid">${entry.areas
          .map(
            (area) =>
              `<article class="area"><h3 class="area__title"><a href="${areaPath(area.slug)}">${escapeHTML(area.title)}</a></h3><p class="area__text">${escapeHTML(area.description)}</p>${
                (sections.get(area.slug) || []).length
                  ? `<ol class="area__sections">${(sections.get(area.slug) || [])
                      .slice(0, 4)
                      .map((section) => `<li><a href="${areaPath(area.slug)}#${section.id}">${escapeHTML(section.title)}</a></li>`)
                      .join('')}</ol>`
                  : ''
              }</article>`,
          )
          .join('')}</div></section>`,
    )
    .join('\n');
}

// The first `max` characters, cut at a word.
export function snippet(text, max = 160) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[\s,;:.]+$/, '')}…`;
}

const uniqueWords = (...texts) => [...new Set(tokenize(texts.join(' ')))].join(' ');

// What the search box looks through: one entry per page, section, glossary term and key.
//   pages: [{ slug, path, title, lede, sections: [{ id, level, title, text }] }]
//   glossary: [{ id, title, text }]; keys: [{ title, text }]
export function buildSearchIndex({ version = '', areas = [], pages = [], glossary = [], keys = [] }) {
  const entries = [];
  for (const page of pages) {
    entries.push({ u: page.path, a: page.slug ?? '', t: page.title, k: 'page', l: 1, s: snippet(page.lede), w: uniqueWords(page.title, page.lede) });
    for (const section of page.sections) {
      entries.push({ u: `${page.path}#${section.id}`, a: page.slug ?? '', t: section.title, k: 'section', l: section.level, s: snippet(section.text), w: uniqueWords(section.title, section.text) });
    }
  }
  for (const entry of glossary) {
    entries.push({ u: `${areaPath('glossary')}#${entry.id}`, a: 'glossary', t: entry.title, k: 'term', l: 3, s: snippet(entry.text), w: uniqueWords(entry.title, entry.text) });
  }
  for (const key of keys) {
    entries.push({ u: `${areaPath('reference')}#keys`, a: 'reference', t: key.title, k: 'key', l: 3, s: snippet(key.text), w: uniqueWords(key.title, key.text) });
  }
  return { version, areas: areas.map((area) => ({ slug: area.slug, title: area.title })), entries };
}

// The rows of a <dl class="keys">: [{ title, text }]
export function keyRowsOf(html) {
  const rows = [];
  for (const match of String(html).matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) rows.push({ title: textOf(match[1]), text: textOf(match[2]) });
  return rows;
}
