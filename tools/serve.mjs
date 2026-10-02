// Zero-dependency dev server. Serves the project as static files and answers
// /beats/index.json from the folder contents, so dropping a file into beats/ is enough.
// /site-config.js is answered from config.site.json, when the project has one.
//
// Only this machine can reach it. The folder it serves holds things that are nobody else's
// business (songs of your own, the site's settings), so it listens on the loopback
// addresses, answers only to names that cannot be pointed here from outside, and never
// hands out a dotfile.
//
//   PORT=5173             the port to listen on
//   SERVE_HOST=0.0.0.0    listen on the network too (to try the site on a phone, say)
//   SERVE=dist            serve the built site (npm run build) instead, exactly as it is
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { listBeats } from './beats.mjs';
import { readSiteConfig, siteConfigScript } from './site-config.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(project, process.env.SERVE || '.');
const port = Number(process.env.PORT) || 5173;
// (not HOST: some shells export that with the machine's own name in it)
const open = process.env.SERVE_HOST || '';
// `localhost` is 127.0.0.1 to some programs and ::1 to others, so both are listened on
const addresses = open ? [open] : ['127.0.0.1', '::1'];

// The names this server answers to. A page on another site can point a name of its own at
// this machine, and so read what is served here; it cannot do that with `localhost` or
// with a bare number.
const named = (host = '') => {
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name.endsWith('.localhost') || isIP(name) !== 0 || (open !== '' && name === open.toLowerCase());
};
// Never served, whatever is asked for: dotfiles (.git, .private-terms, .firebaserc), the
// private/ folder, the site's own settings, and the logs the Firebase emulators leave behind.
const withheld = (path) => {
  const parts = relative(root, path).split(sep);
  return parts.some((part) => part.startsWith('.')) || parts[0].toLowerCase() === 'private' || /^config\.site\.json$|-debug\.log$/i.test(basename(path));
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.strudel': 'text/plain; charset=utf-8',
  '.str': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

function answer(req, res) {
  if (!named(req.headers.host)) return send(res, 403, 'Forbidden');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (pathname === '/beats/index.json' && root === project) {
    return send(res, 200, JSON.stringify(listBeats(join(root, 'beats'))), TYPES['.json']);
  }
  // this site's own settings, when the project has any (config.site.json)
  if (pathname === '/site-config.js' && root === project) {
    try {
      const settings = readSiteConfig(project);
      if (settings) return send(res, 200, siteConfigScript(settings), TYPES['.js']);
    } catch (error) {
      console.error(error.message);
      return send(res, 500, `console.error(${JSON.stringify(error.message)});`, TYPES['.js']);
    }
  }
  // Clean addresses, as the hosted site has them: /about is about.html, and a beat's own
  // address (/beats/<slug>) is the player, which reads the address to pick the song.
  const candidates = [pathname.endsWith('/') ? pathname + 'index.html' : pathname, `${pathname}.html`];
  if (/^\/beats\/[a-z0-9-]+$/.test(pathname)) candidates.push('/index.html');
  let file;
  let stat;
  for (const candidate of candidates) {
    const path = normalize(join(root, candidate));
    if (path !== root && !path.startsWith(root + sep)) return send(res, 403, 'Forbidden');
    if (withheld(path)) continue;
    try {
      const found = statSync(path);
      if (found.isFile()) {
        file = path;
        stat = found;
        break;
      }
    } catch {
      /* try the next one */
    }
  }
  if (!file) {
    try {
      return send(res, 404, readFileSync(join(root, '404.html')), TYPES['.html']);
    } catch {
      return send(res, 404, 'Not found');
    }
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] || (extname(file) ? 'application/octet-stream' : TYPES['.txt']),
    'content-length': stat.size,
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

addresses.forEach((address, i) => {
  const server = createServer(answer);
  server.on('error', (error) => {
    // a machine without IPv6 has no ::1 to listen on; 127.0.0.1 is enough there
    if (address === '::1' && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')) return;
    throw error;
  });
  server.listen(port, address, () => {
    if (i === 0) console.log(`Hacking the Beats → http://localhost:${port}${open ? `  (open to the network: SERVE_HOST=${open})` : ''}`);
  });
});
