// Searching the Learn guide: the words of a query and of the index, and how an entry scores.
// No imports, so it runs in the browser (js/learn.js), in the build (the index's word lists)
// and in the unit tests.

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'it', 'is', 'as', 'at', 'for', 'with', 'by', 'that', 'this', 'its', 'be']);

// "Ctrl+Enter" → ["ctrl", "enter"]; "Snapshots" → ["snapshot"]; "@try" → ["try"]
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !STOP.has(word))
    .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
}

// How well one entry answers the query's words: every word must be found (in the title or in
// the entry's own words), the title counting more than the body and a whole word more than
// the start of one. Glossary terms and main sections are favoured a little.
//   entry: { t: title, k: 'page' | 'section' | 'term' | 'key', l: heading level, w: 'its unique words' }
export function scoreEntry(entry, terms) {
  const title = tokenize(entry.t);
  const words = String(entry.w || '').split(' ');
  let score = 0;
  for (const term of terms) {
    let best = 0;
    for (const word of title) {
      if (word === term) best = Math.max(best, 8);
      else if (word.startsWith(term)) best = Math.max(best, 5);
    }
    if (best < 8) {
      for (const word of words) {
        if (word === term) best = Math.max(best, 3);
        else if (word.startsWith(term)) best = Math.max(best, 1.5);
      }
    }
    if (!best) return 0;
    score += best;
  }
  if (entry.k === 'term') score *= 1.4;
  if (entry.l === 2) score *= 1.1;
  return score;
}

// The best entries for a query, best first: [{ entry, score }]
export function search(index, query, { limit = 12 } = {}) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  return (index?.entries || [])
    .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.t.localeCompare(b.entry.t))
    .slice(0, limit);
}

// Results in the guide's own order of areas: [{ area, title, results }]
export function groupByArea(results, areas) {
  const order = (areas || []).map((area) => area.slug);
  const titles = new Map((areas || []).map((area) => [area.slug, area.title]));
  const groups = new Map();
  for (const result of results) {
    const slug = result.entry.a;
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug).push(result);
  }
  return [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([area, found]) => ({ area, title: titles.get(area) || area, results: found }));
}

const escapeHTML = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The text as HTML, with every word that answers the query wrapped in <mark>.
export function highlight(text, terms) {
  const wanted = (terms || []).filter(Boolean);
  return escapeHTML(text).replace(/[A-Za-z0-9][\w'@-]*/g, (word) => {
    const [token] = tokenize(word);
    return token && wanted.some((term) => token === term || token.startsWith(term)) ? `<mark>${word}</mark>` : word;
  });
}
