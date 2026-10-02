// What went wrong with a song, in words a person new to code can act on. The browser's own
// message is kept as well: this only adds a hint in front of it. No imports, so it is
// unit-tested in Node.

// "Unexpected token (12:4)" → { line: 12, column: 4 }; "[mini] parse error at line 3: …" → { line: 3 }
function placeOf(message) {
  const at = message.match(/\((\d+):(\d+)\)\s*$/);
  if (at) return { line: Number(at[1]), column: Number(at[2]) };
  const line = message.match(/\bat line (\d+)/);
  return line ? { line: Number(line[1]), column: null } : { line: null, column: null };
}

const onLine = (line) => (line ? ` on line ${line}` : '');

// Each rule: a pattern on the browser's message, and the hint it earns.
const RULES = [
  [/^Unterminated string constant/, (m, at) => `A quote${onLine(at.line)} is opened but never closed. Strings start and end with the same mark: "…" or '…'.`],
  [/^Unterminated template/, (m, at) => `A backtick (\`)${onLine(at.line)} is opened but never closed.`],
  [/^Unterminated comment/, (m, at) => `A comment that starts with /*${onLine(at.line)} never ends. Close it with */.`],
  [/^Unterminated regular expression/, (m, at) => `A stray slash (/)${onLine(at.line)} is being read as the start of something. Check for a missing quote or bracket just before it.`],
  [/^Unexpected character '(.)'/, (m, at) => `The character ${m[1]}${onLine(at.line)} does not belong there.`],
  [/^Unexpected token/, (m, at) => `Something is out of place${onLine(at.line)}. Often it is a missing comma, bracket or quote just before that point.`],
  [/^Identifier '([^']+)' has already been declared/, (m) => `The name ${m[1]} is given twice. Each const needs a name of its own.`],
  [/\[mini\] parse error/, (m, at) => `A pattern in quotes${onLine(at.line)} has a mistake in it, like a bracket that is opened and never closed.`],
  [/^sound (\S+) not found/, (m) => `There is no sound called "${m[1]}" in the loaded sample packs. Check its spelling.`],
  [/^(\S+) is not defined/, (m) => `Nothing called ${m[1]} exists. Names are case-sensitive: check the spelling.`],
  [/(?:^|\.)(\w+) is not a function/, (m) => `There is no function called ${m[1]}(). Check its spelling, or whether it belongs on a pattern.`],
  [/^Cannot read propert(?:y|ies) of (?:undefined|null)/, () => 'Something is used before it has a value. Check the names on that line.'],
  [/^Assignment to constant variable/, () => 'A const cannot be changed once it is set. Give the new value a name of its own.'],
  [/^missing \) after argument list/, () => 'A bracket is missing: every ( needs a ).'],
];

// message → { hint, line, column }; hint is null for a message we have nothing to add to.
export function explainError(message) {
  const text = String(message ?? '').trim();
  const at = placeOf(text);
  for (const [pattern, hint] of RULES) {
    const match = text.match(pattern);
    if (match) return { hint: hint(match, at), ...at };
  }
  return { hint: null, ...at };
}
