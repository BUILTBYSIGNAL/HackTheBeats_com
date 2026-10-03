// The Learn guide, assembled from its sources: learn/template.html (the chrome),
// learn/landing.html, learn/areas/NN-<slug>.html, learn/examples/*.strudel and
// images/learn/*.png. The dev server calls buildLearn() on every request for /learn*, the
// site build writes its pages to dist/, and the unit tests run it over the real tree as the
// content check. Nothing it makes is committed.
//
//   node tools/learn.mjs          list the pages and anything that should be fixed
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  AREA_GROUPS,
  LEARN_PATH,
  areaCardsHTML,
  areaPath,
  articleOf,
  buildSearchIndex,
  escapeHTML,
  expandCode,
  expandFigures,
  glossaryOf,
  headingsOf,
  idsOf,
  keyRowsOf,
  liftCode,
  markTerms,
  navHTML,
  pagerHTML,
  pngSize,
  resolveLinks,
  sectionsOf,
} from '../js/learn-core.js';
import { SITE_NAME } from '../js/routes-core.js';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const replaceOnce = (html, from, to, what) => {
  if (!html.includes(from)) throw new Error(`learn: could not find ${what} in learn/template.html`);
  return html.replace(from, () => to);
};

// The areas, in order: [{ order, slug, file, title, description, kicker, group, inner, problems }]
export function listAreas(root = here) {
  const dir = join(root, 'learn/areas');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /^\d\d-[a-z-]+\.html$/.test(file))
    .sort()
    .map((file) => {
      const [, order, slug] = /^(\d\d)-([a-z-]+)\.html$/.exec(file);
      const { attrs, inner, problems } = articleOf(readFileSync(join(dir, file), 'utf8'));
      const group = attrs['data-group'] || 'Knowledge base';
      if (!AREA_GROUPS.includes(group)) problems.push(`data-group "${group}" is not one of ${AREA_GROUPS.join(', ')}`);
      return { order: Number(order), slug, file: `learn/areas/${file}`, title: attrs['data-title'] || slug, description: attrs['data-description'] || '', kicker: attrs['data-kicker'] || group, group, inner, problems };
    });
}

// Every example song: Map id → code
export function listExamples(root = here) {
  const dir = join(root, 'learn/examples');
  const examples = new Map();
  if (!existsSync(dir)) return examples;
  for (const file of readdirSync(dir).filter((name) => /^[a-z0-9-]+\.strudel$/.test(name)).sort()) {
    examples.set(file.replace(/\.strudel$/, ''), readFileSync(join(dir, file), 'utf8'));
  }
  return examples;
}

// Every screenshot's size: Map name → { width, height }
export function listShots(root = here) {
  const dir = join(root, 'images/learn');
  const sizes = new Map();
  if (!existsSync(dir)) return sizes;
  for (const file of readdirSync(dir).filter((name) => /^[a-z0-9-]+\.png$/.test(name))) {
    const size = pngSize(readFileSync(join(dir, file)));
    if (size) sizes.set(file.replace(/\.png$/, ''), size);
  }
  return sizes;
}

function assemble(template, { title, description, crumb, article, nav, pager }) {
  let html = template;
  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHTML(title)}</title>`);
  html = html.replace(/<meta name="description" content="[^"]*" \/>/, () => `<meta name="description" content="${escapeHTML(description)}" />`);
  html = replaceOnce(html, '<!--nav-->', nav, 'the <!--nav--> marker');
  html = replaceOnce(html, '<!--crumb-->', crumb, 'the <!--crumb--> marker');
  html = replaceOnce(html, '<!--article-->', article, 'the <!--article--> marker');
  html = replaceOnce(html, '<!--pager-->', pager, 'the <!--pager--> marker');
  return html;
}

// Builds every page of the guide.
//   → { areas, pages: [{ slug, path, file, title, description, kind, html }], search, examples, problems }
export function buildLearn(root = here) {
  const problems = [];
  const where = (file, list) => problems.push(...list.map((problem) => `${file}: ${problem}`));
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const template = read('learn/template.html');
  const areas = listAreas(root);
  if (!areas.length) problems.push('learn/areas/ has no NN-<slug>.html files');
  const examples = listExamples(root);
  const sizes = listShots(root);
  const landing = articleOf(read('learn/landing.html'));
  where('learn/landing.html', landing.problems);

  // pass 1: what every page has, so links between pages can be checked
  const docs = [];
  const ids = new Map();
  for (const area of areas) {
    where(area.file, area.problems);
    const { html, blocks } = liftCode(area.inner);
    const { headings, problems: found } = headingsOf(html);
    where(area.file, found);
    ids.set(area.slug, idsOf(html));
    docs.push({ ...area, lifted: html, blocks, headings });
  }
  const landingLifted = liftCode(landing.inner);
  ids.set('', idsOf(landingLifted.html));

  const glossaryDoc = docs.find((doc) => doc.slug === 'glossary');
  const glossary = glossaryDoc ? glossaryOf(glossaryDoc.lifted) : { entries: new Map(), problems: ['there is no glossary area (learn/areas/NN-glossary.html)'] };
  where(glossaryDoc?.file ?? 'learn/areas', glossary.problems);
  const glossaryIds = new Set(glossary.entries.keys());
  const exampleIds = new Set(examples.keys());

  // the player's own shortcut list, kept in index.html between <!--keys--> markers
  const keysBlock = /<!--keys-->([\s\S]*?)<!--\/keys-->/.exec(read('index.html'))?.[1] ?? null;

  const usedTerms = new Set();
  const usedShots = new Set();
  const sectionsByArea = new Map();
  const pages = [];
  const indexPages = [];

  const render = (doc, slug) => {
    let html = doc.lifted;
    const file = doc.file;
    if (html.includes('<!--keys-->')) {
      if (keysBlock) html = html.replace('<!--keys-->', () => keysBlock);
      else {
        problems.push(`${file}: wants the player's keys, but index.html has no <!--keys--> markers`);
        html = html.replace('<!--keys-->', '');
      }
    }
    const marked = markTerms(html, glossaryIds, exampleIds);
    where(file, marked.problems);
    for (const term of marked.used) usedTerms.add(term);
    const linked = resolveLinks(marked.html, { area: slug, pages: ids });
    where(file, linked.problems);
    const figured = expandFigures(linked.html, sizes);
    where(file, figured.problems);
    for (const shot of figured.shots) usedShots.add(shot);
    const coded = expandCode(figured.html, doc.blocks, examples);
    where(file, coded.problems);
    const { headings } = headingsOf(coded.html);
    const { lede, sections } = sectionsOf(coded.html, headings);
    return { html: coded.html, headings, lede, sections };
  };

  for (const doc of docs) {
    const { html, headings, lede, sections } = render(doc, doc.slug);
    sectionsByArea.set(doc.slug, headings.filter((heading) => heading.level === 2).map(({ id, title }) => ({ id, title })));
    const path = areaPath(doc.slug);
    pages.push({
      slug: doc.slug,
      path,
      file: `learn/${doc.slug}.html`,
      title: doc.title,
      description: doc.description,
      kind: 'area',
      html: assemble(template, {
        title: `${doc.title} — Learn — ${SITE_NAME}`,
        description: doc.description,
        crumb: `<p class="kicker">${escapeHTML(doc.kicker)}</p><h1>${escapeHTML(doc.title)}</h1>`,
        article: html,
        nav: navHTML(areas, doc.slug, headings),
        pager: pagerHTML(areas, doc.slug),
      }),
    });
    indexPages.push({ slug: doc.slug, path, title: doc.title, lede, sections: doc.slug === 'glossary' ? [] : sections });
  }

  // the landing: its own words, then a card for every area
  const landingDoc = { file: 'learn/landing.html', lifted: landingLifted.html.replace('<!--areas-->', () => areaCardsHTML(areas, sectionsByArea)), blocks: landingLifted.blocks };
  const home = render(landingDoc, '');
  const landingTitle = landing.attrs['data-title'] || 'Learn';
  pages.unshift({
    slug: null,
    path: LEARN_PATH,
    file: 'learn.html',
    title: landingTitle,
    description: landing.attrs['data-description'] || '',
    kind: 'landing',
    html: assemble(template, {
      title: `Learn — ${SITE_NAME}`,
      description: landing.attrs['data-description'] || '',
      crumb: `<p class="kicker">The guide</p><h1>${escapeHTML(landingTitle)}</h1>`,
      article: home.html,
      nav: navHTML(areas, null, []),
      pager: pagerHTML(areas, null),
    }),
  });
  indexPages.unshift({ slug: '', path: LEARN_PATH, title: landingTitle, lede: home.lede, sections: [] });

  // the glossary's words and the keys, for the search
  const glossaryEntries = [...glossary.entries.entries()].map(([id, entry]) => ({ id, title: entry.title, text: entry.text }));
  const keys = keysBlock ? keyRowsOf(keysBlock) : [];
  const version = /VERSION = '([^']+)'/.exec(read('js/version.js'))?.[1] ?? '';
  const search = buildSearchIndex({ version, areas, pages: indexPages, glossary: glossaryEntries, keys });

  for (const id of glossaryIds) if (!usedTerms.has(id) && !['glossary'].includes(id)) problems.push(`learn/areas: the glossary entry "${id}" is never linked from the guide (mark its first use with data-term)`);
  for (const name of sizes.keys()) if (!usedShots.has(name)) problems.push(`images/learn/${name}.png is not shown anywhere in the guide`);
  const size = JSON.stringify(search).length;
  if (size > 150_000) problems.push(`the search index is ${Math.round(size / 1024)} KB; keep it under 150 KB`);

  return { areas, pages, search, examples, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = buildLearn(here);
  console.log(`${built.pages.length} pages: ${built.pages.map((page) => page.path).join(', ')}`);
  console.log(`${built.examples.size} examples, ${built.search.entries.length} search entries (${Math.round(JSON.stringify(built.search).length / 1024)} KB)`);
  for (const problem of built.problems) console.log(`  ✗ ${problem}`);
  if (built.problems.length) process.exitCode = 1;
  else console.log('  ✓ nothing to fix');
}
