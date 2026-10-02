// A mix as a link: the song, its knob positions, the channel mix and the tempo, packed into
// the URL's hash. This file has no imports so it can be unit-tested in Node.

const round = (value, digits) => Number(Number(value).toFixed(digits));

// state: { song, sliders: number[], mixer: [{ mute, solo, gain }], tempo }
export function encodeMix(state) {
  const compact = {
    s: state.song,
    k: (state.sliders || []).map((value) => round(value, 4)),
    // per channel: level, then 1 = muted, 2 = solo
    m: (state.mixer || []).map(({ gain, mute, solo }) => [round(gain, 2), (mute ? 1 : 0) + (solo ? 2 : 0)]),
    t: round(state.tempo ?? 1, 3),
  };
  const json = JSON.stringify(compact);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Returns null for anything that is not a well-formed mix.
export function decodeMix(text) {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const compact = JSON.parse(new TextDecoder().decode(bytes));
    if (!compact || typeof compact.s !== 'string') return null;
    const sliders = Array.isArray(compact.k) ? compact.k.filter((value) => typeof value === 'number' && Number.isFinite(value)) : [];
    const mixer = Array.isArray(compact.m)
      ? compact.m
          .filter((entry) => Array.isArray(entry) && Number.isFinite(entry[0]))
          .map(([gain, flags]) => ({ gain: Math.min(1.25, Math.max(0, gain)), mute: Boolean(flags & 1), solo: Boolean(flags & 2) }))
      : [];
    const tempo = Number.isFinite(compact.t) ? Math.min(1.25, Math.max(0.75, compact.t)) : 1;
    return { song: compact.s, sliders, mixer, tempo };
  } catch {
    return null;
  }
}

export function mixFromHash(hash) {
  const match = /[#&]mix=([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? decodeMix(match[1]) : null;
}

export function linkForMix(state, base) {
  const url = new URL(base);
  url.hash = `mix=${encodeMix(state)}`;
  return url.href;
}
