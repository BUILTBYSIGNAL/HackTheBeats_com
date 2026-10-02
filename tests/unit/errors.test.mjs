import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { explainError } from '../../js/errors-core.js';

// the parser's own message for a piece of code
const messageFor = (code) => {
  try {
    parse(code, { ecmaVersion: 2022 });
  } catch (error) {
    return error.message;
  }
  return null;
};

test("the parser's mistakes are explained, with the line they are on", () => {
  const cases = [
    ['DRUMS: s("bd*4)\n', /quote on line 1/],
    ['const a = 1\nDRUMS: s("bd*4"\n.gain(0.5)\nconst b = 2', /out of place on line 4/],
    ['const a = 1\nconst a = 2', /name a is given twice/],
    ['const t = `abc', /backtick/],
    ['/* notes', /never ends/],
  ];
  for (const [code, hint] of cases) {
    const message = messageFor(code);
    const explained = explainError(message);
    assert.match(explained.hint, hint, message);
  }
  assert.deepEqual(
    (({ line, column }) => ({ line, column }))(explainError(messageFor('const a = 1\nconst a = 2'))),
    { line: 2, column: 6 },
  );
});

test('mistakes found while running are explained too', () => {
  assert.match(explainError('drumz is not defined').hint, /Nothing called drumz/);
  assert.match(explainError('s(...).fastt is not a function').hint, /no function called fastt\(\)/);
  assert.match(explainError("Cannot read properties of undefined (reading 'gain')").hint, /before it has a value/);
  assert.match(explainError('Assignment to constant variable.').hint, /const cannot be changed/);
  const mini = explainError('[mini] parse error at line 3: Expected "]" but end of input found.');
  assert.match(mini.hint, /pattern in quotes on line 3/);
  assert.equal(mini.line, 3);
});

test('a message we know nothing about is passed on as it is', () => {
  assert.deepEqual(explainError('Something unusual happened'), { hint: null, line: null, column: null });
  assert.equal(explainError(undefined).hint, null);
});
