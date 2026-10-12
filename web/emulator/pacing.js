// Keep host work bounded even when firmware enters a more expensive path.
// This changes only instruction batch sizes, never the board's virtual clock.
export const FRAME_INTERVAL = 1000 / 60;
export class ExecutionSlice {
  constructor(now = () => performance.now()) { this.now = now; this.rate = 1000; this.previousCount = 1000; }
  run(machine, deadline = this.now() + 4) {
    while (this.now() < deadline) {
      const start = this.now(), remaining = deadline - start;
      if (remaining < .25) break;
      const count = Math.max(1, Math.min(machine.debug.enabled ? 1000 : 50000, this.previousCount * 2,
        Math.floor(this.rate * Math.min(2, remaining))));
      machine.run(count);
      this.rate = count / Math.max(.01, this.now() - start); this.previousCount = count;
      if (machine.error || machine.board.poweredOff || machine.debug.stoppedAt !== null) return false;
    }
    return true;
  }
}

// A busy or hidden tab needs only the newest snapshot when it can paint again.
export function frameRenderer(render, schedule = callback => requestAnimationFrame(callback)) {
  let pending = false, latest;
  return state => {
    latest = state;
    if (pending) return;
    pending = true;
    schedule(() => { pending = false; render(latest); });
  };
}
