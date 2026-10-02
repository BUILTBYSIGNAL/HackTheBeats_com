import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isApple, keyLabels, localizeKeys } from '../../js/keys-core.js';

test('Macs, iPads and iPhones have ⌘; the rest have Ctrl', () => {
  for (const platform of ['MacIntel', 'macOS', 'iPhone', 'iPad']) assert.equal(isApple(platform), true, platform);
  for (const platform of ['Win32', 'Windows', 'Linux x86_64', 'Android', '', undefined]) assert.equal(isApple(platform), false, String(platform));
});

test('key labels follow the keyboard', () => {
  assert.equal(keyLabels(true).run, '⌘↩');
  assert.equal(keyLabels(true).mod, '⌘');
  assert.equal(keyLabels(false).run, 'Ctrl+Enter');
  assert.equal(keyLabels(false).stop, 'Ctrl+.');
});

test('hints are rewritten for a Mac, and left alone elsewhere', () => {
  assert.equal(localizeKeys('Run the edited code (Ctrl+Enter)', true), 'Run the edited code (⌘↩)');
  assert.equal(localizeKeys('Save over this song (Ctrl+S)', true), 'Save over this song (⌘S)');
  assert.equal(localizeKeys('Alt+Enter also runs it', true), '⌥Enter also runs it');
  assert.equal(localizeKeys('Run the edited code (Ctrl+Enter)', false), 'Run the edited code (Ctrl+Enter)');
});
