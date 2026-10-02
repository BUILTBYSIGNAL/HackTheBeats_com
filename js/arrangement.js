// The arrangement of a song: how many notes each track plays in each bar.

export const ARRANGEMENT_BARS = 32;

// Counts onsets per bar for every track. Queried in small slices so the page stays responsive.
// Calls onUpdate with the grid as it fills in; returns a function that cancels the work.
export function computeArrangement(tracks, onUpdate) {
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
          grid[t][c] = pattern.queryArc(c, c + 1).filter((hap) => hap.hasOnset()).length;
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
