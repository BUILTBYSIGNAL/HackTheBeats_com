// Key names as the visitor's own keyboard has them: ⌘ and ⌥ on a Mac, Ctrl and Alt
// everywhere else. No imports, so it is unit-tested in Node.

// Macs, iPads and iPhones (an iPad with a keyboard has ⌘ too).
export const isApple = (platform = '') => /mac|iphone|ipad|ipod/i.test(platform);

export function keyLabels(apple) {
  return apple
    ? { mod: '⌘', alt: '⌥', run: '⌘↩', save: '⌘S', stop: '⌘.' }
    : { mod: 'Ctrl', alt: 'Alt', run: 'Ctrl+Enter', save: 'Ctrl+S', stop: 'Ctrl+.' };
}

// "Run the edited code (Ctrl+Enter)" → "Run the edited code (⌘↩)" on a Mac.
export function localizeKeys(text, apple) {
  if (!apple) return text;
  return String(text)
    .replace(/Ctrl\+Enter/g, '⌘↩')
    .replace(/Ctrl\+/g, '⌘')
    .replace(/Alt\+/g, '⌥');
}
