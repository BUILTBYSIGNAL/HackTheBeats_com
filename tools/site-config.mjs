// Shared by the dev server and the build: this site's own settings, kept out of the code
// in config.site.json at the top of the project (see config.site.example.json).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The settings, or null when the project has none (the site then runs without accounts).
export function readSiteConfig(project) {
  const file = join(project, 'config.site.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`config.site.json is not valid JSON: ${error.message}`);
  }
}

// What the page loads as site-config.js. Anything already set (by a test) wins.
export const siteConfigScript = (settings) => `globalThis.HTB_CONFIG = { ...${JSON.stringify(settings)}, ...globalThis.HTB_CONFIG };\n`;
