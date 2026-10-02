// Service worker: lets the site and every sound it has played work again without a network.
//
//   this site's own files   network first, falling back to the last copy seen
//   sample audio            cache first (those files do not change)
//   sample pack listings    served from cache at once, refreshed in the background
const VERSION = 'v0.8.0';
const SHELL = `hb-shell-${VERSION}`;
// sample audio outlives a release: it is kept under a name that does not change
const SOUNDS = 'hb-sounds-1';
const SOUND_HOSTS = new Set(['raw.githubusercontent.com', 'felixroos.github.io', 'shabda.ndre.gr']);

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('hb-') && name !== SHELL && name !== SOUNDS) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

const store = async (cacheName, request, response) => {
  if (response && (response.ok || response.type === 'opaque')) {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone()).catch(() => {});
  }
  return response;
};

async function networkFirst(request) {
  try {
    return await store(SHELL, request, await fetch(request));
  } catch (error) {
    const cached = (await caches.match(request)) || (request.mode === 'navigate' && (await caches.match('./')));
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  return (await caches.match(request)) || store(SOUNDS, request, await fetch(request));
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fresh = fetch(request)
    .then((response) => store(SOUNDS, request, response))
    .catch(() => null);
  return cached || (await fresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Firebase's own pages (the sign-in handler) are left to the network
  if (url.origin === self.location.origin && url.pathname.startsWith('/__/')) return;
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (SOUND_HOSTS.has(url.hostname)) {
    event.respondWith(url.pathname.endsWith('.json') ? staleWhileRevalidate(request) : cacheFirst(request));
  }
});
