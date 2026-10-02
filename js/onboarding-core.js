// First steps: the short list of things to do that shows someone new what the site is for.
// Which steps there are, which are done, and when the list opens by itself. No imports, so
// it is unit-tested in Node; onboarding.js draws it.

export const VERSION = 1;

// Signed out, the list ends with signing in; with an account, with keeping the song and
// passing it on. "tweak" is one of the song's suggestions or, without any, a change of one's
// own, so it is only offered signed out when the song has suggestions to tap.
export function stepsFor({ access, hasTries }) {
  if (access === 'full') return ['play', 'knob', 'mute', 'tweak', 'save', 'share'];
  return ['play', 'knob', 'mute', ...(hasTries ? ['tweak'] : []), 'signin'];
}

const fresh = () => ({ v: VERSION, done: {}, open: null, never: false, finished: false });

// Whatever was stored (or nothing, or something from an older version) → a usable state.
//   open: null until the list has opened by itself once; then what the visitor left it as
export function normalize(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== VERSION) return fresh();
  const done = {};
  for (const [id, at] of Object.entries(raw.done || {})) if (Number.isFinite(at)) done[id] = at;
  return {
    v: VERSION,
    done,
    open: typeof raw.open === 'boolean' ? raw.open : null,
    never: raw.never === true,
    finished: raw.finished === true,
  };
}

// The first time a step is done is the one remembered.
export function markDone(state, id, now = Date.now()) {
  if (state.done[id]) return state;
  return { ...state, done: { ...state.done, [id]: now } };
}

export function progress(state, ids) {
  const done = ids.filter((id) => state.done[id]).length;
  return { done, total: ids.length, next: ids.find((id) => !state.done[id]) ?? null, complete: done === ids.length };
}

// Someone who has been here before (and so knows how to press play) starts with the list
// closed and that step ticked.
export const isReturning = ({ lastSong, signedIn }) => Boolean(lastSong || signedIn);
export function forVisitor(stored, { lastSong, signedIn }, now = Date.now()) {
  if (stored) return normalize(stored);
  const state = fresh();
  return isReturning({ lastSong, signedIn }) ? { ...markDone(state, 'play', now), open: false } : state;
}

// It opens by itself once, after the first play, and never again unless asked.
export const shouldAutoOpen = (state) => state.open === null && !state.never && !state.finished;
