import { describe, it, expect } from 'vitest';
import { SampleRotationSpreader } from './sampleRotationSpreader';
import { v3 } from '../physics/types';

const DT = 1 / 120;

describe('SampleRotationSpreader', () => {
  it('delivers each 60Hz sample in full, spread over the two ticks until the next one', () => {
    const spreader = new SampleRotationSpreader();
    const omega = v3(0, 0, 2); // rad/s, steady turn
    let delivered = 0;
    const perTick: number[] = [];
    for (let tick = 0; tick < 120; tick++) {
      const isNew = tick % 2 === 0; // a sample every other tick = 60Hz
      const w = spreader.step(isNew ? omega : v3(0, 0, 0), 1 / 60, isNew, DT);
      delivered += w[2] * DT;
      perTick.push(w[2]);
    }
    // 1s of a 2 rad/s turn: the full 2 rad (the old per-tick scheme delivered half).
    expect(delivered).toBeCloseTo(2, 6);
    // Steady velocity every tick, not 4 rad/s / 0 rad/s alternating.
    for (const w of perTick) expect(w).toBeCloseTo(2, 6);
  });

  it('releases a sample after a long gap briskly, not as a slow drift', () => {
    const spreader = new SampleRotationSpreader();
    // One sample covering a 2s gap (e.g. a hidden tab): 0.5 rad of rotation.
    let delivered = 0;
    let ticks = 0;
    let w = spreader.step(v3(0.25, 0, 0), 2, true, DT);
    while (Math.abs(w[0]) > 0) {
      delivered += w[0] * DT;
      ticks++;
      w = spreader.step(v3(0, 0, 0), 2, false, DT);
    }
    expect(delivered).toBeCloseTo(0.5, 6);
    expect(ticks * DT).toBeLessThanOrEqual(SampleRotationSpreader.MAX_SPREAD_S + DT);
  });
});
