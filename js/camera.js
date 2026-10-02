// The camera: when "follow" is on, the code glides to whichever track has just come in, and
// otherwise tours the tracks that are playing, a couple of bars on each.

const DWELL_BARS = 2;

export class Camera {
  constructor(player) {
    this.player = player;
    this.enabled = false;
    this.reset();
  }

  reset() {
    this.bar = -1;
    this.current = null;
    this.switchedAt = 0;
    this.active = new Set();
  }

  // Called every frame while the deck plays; does its thinking once per bar.
  tick() {
    if (!this.enabled) return;
    const { player } = this;
    const now = player.now();
    const bar = Math.floor(now);
    if (bar === this.bar) return;
    this.bar = bar;

    const { stage, mixer } = player;
    // focus mode pins the view; someone scrolling or editing by hand is left alone
    if (stage.focus !== null || stage.handsOff || stage.editing) return;

    const active = mixer.tracks.filter((track) => mixer.audible(track.index) && track.lastOnset >= now - 1.25).map((track) => track.index);
    if (!active.length) return;
    const starting = this.current === null;
    const newcomers = active.filter((index) => !this.active.has(index));
    this.active = new Set(active);

    let next = null;
    if (newcomers.length && !starting) {
      next = newcomers[0];
    } else if (starting || !active.includes(this.current) || bar - this.switchedAt >= DWELL_BARS) {
      next = active.find((index) => index > (this.current ?? -1)) ?? active[0];
    }
    if (next === null || next === this.current) return;
    this.current = next;
    this.switchedAt = bar;
    stage.scrollToTrack(next);
  }
}
