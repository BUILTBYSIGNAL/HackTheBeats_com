// The arrangement of a song: how many notes each track plays in each bar.
import { sourceBar } from './trim-core.js';

export const ARRANGEMENT_BARS = 32;

// Counts onsets per bar for every track. Queried in small slices so the page stays responsive.
// Calls onUpdate with the grid as it fills in; returns a function that cancels the work.
// `segments` is the song's trim (trim-core.js), if it has one: each bar of the strip then
// shows the bar of the song it plays.
export function computeArrangement(tracks, onUpdate, segments = null) {
  const grid = tracks.map(() => new Float32Array(ARRANGEMENT_BARS));
  let cancelled = false;
  let t = 0;
  let c = 0;
  const work = () => {
    if (cancelled) return;
    const started = performance.now();
    while (t < tracks.length && performance.now() - started < 6) {
      const pattern = tracks[t].pattern;
      if (pattern) {
        try {
          const bar = sourceBar(segments, c);
          grid[t][c] = pattern.queryArc(bar, bar + 1).filter((hap) => hap.hasOnset()).length;
        } catch {
          grid[t][c] = 0;
        }
      }
      if (++c >= ARRANGEMENT_BARS) {
        c = 0;
        t++;
      }
    }
    onUpdate(grid);
    if (t < tracks.length) setTimeout(work, 0);
  };
  setTimeout(work, 0);
  return () => (cancelled = true);
}
