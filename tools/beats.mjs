// Shared by the dev server and the manifest builder: lists the song files in beats/.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SONG_FILE = /\.(json|strudel|str|js|mjs|txt)$/i;
const RESERVED = new Set(['index.json', 'titles.json']);

export function listBeats(dir) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SONG_FILE.test(entry.name) && !RESERVED.has(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // titles.json is an optional sidecar that names songs without an @title
  return { files, titles: existsSync(join(dir, 'titles.json')) };
}
