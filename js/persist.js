// Remembers control positions per song. Storage can be unavailable (private windows,
// blocked site data), so every access is guarded and the app works without it.
const KEY = 'hacking-the-beats:v1';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function write(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable: nothing to do */
  }
}

let cache = read();
let timer;
const flush = () => {
  clearTimeout(timer);
  timer = setTimeout(() => write(cache), 250);
};

export const persist = {
  song(id) {
    return cache.songs?.[id] || null;
  },
  saveSong(id, state) {
    cache.songs = { ...cache.songs, [id]: state };
    flush();
  },
  clearSong(id) {
    if (cache.songs?.[id]) {
      delete cache.songs[id];
      flush();
    }
  },
  get(key, fallback) {
    return cache[key] ?? fallback;
  },
  set(key, value) {
    cache[key] = value;
    flush();
  },
};
