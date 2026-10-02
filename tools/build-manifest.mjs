// Writes beats/index.json so a plain static host can discover the songs.
// Run with `npm run beats` after adding or removing files in beats/.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { listBeats } from './beats.mjs';

const beatsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../beats');
const manifest = listBeats(beatsDir);
writeFileSync(resolve(beatsDir, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ beats/index.json — ${manifest.files.length} file(s): ${manifest.files.join(', ')}`);
