import { describe, it, expect } from 'vitest';
import { v3, normalize } from './types';
import { stepCanalith, initialCanalithState, ductTangent } from './canalith';
import { initialCupulolithState, stepCupulolith } from './cupulolith';
import { ALL_EAR_SIDES } from './canal';

const DT = 1 / 120;

describe('stepCupulolith sign parity with stepCanalith at s=0', () => {
  it('matches stepCanalith\'s pinned-at-ampulla flow sign for every (canal, side) in {horizontal, posterior}', () => {
    const gHead = normalize(v3(0.4, -0.6, 0.7));
    for (const canal of ['horizontal', 'posterior'] as const) {
      for (const side of ALL_EAR_SIDES) {
        const { flow: canalithFlow } = stepCanalith(initialCanalithState(), canal, side, gHead, DT);
        const { flow: cupulolithFlow } = stepCupulolith(initialCupulolithState(), canal, side, gHead, 0, DT);
        expect(Math.sign(cupulolithFlow)).toBe(Math.sign(canalithFlow));
      }
    }
  });
});

describe('stepCupulolith persistence', () => {
  it('produces a nonzero, non-decaying flow while attached and gravity stays aligned (unlike canalithiasis, which clears)', () => {
    const tangentAtCupula = ductTangent('posterior', 'right', 0);
    let state = initialCupulolithState();
    let lastFlow = 0;
    for (let i = 0; i < 500; i++) {
      const result = stepCupulolith(state, 'posterior', 'right', tangentAtCupula, 0, DT);
      state = result.state;
      lastFlow = result.flow;
    }
    expect(state.attached).toBe(true);
    expect(lastFlow).toBeGreaterThan(0);
  });

  it('does not detach from gravity alone, no matter how long it is held', () => {
    const tangentAtCupula = ductTangent('horizontal', 'left', 0);
    let state = initialCupulolithState();
    for (let i = 0; i < 5000; i++) {
      state = stepCupulolith(state, 'horizontal', 'left', tangentAtCupula, 0, DT).state;
    }
    expect(state.attached).toBe(true);
  });
});

describe('stepCupulolith detachment', () => {
  it('detaches after a sustained jolt while gravity favors ampullofugal clearance', () => {
    const tangentAtCupula = ductTangent('posterior', 'right', 0);
    let state = initialCupulolithState();
    // Sustain omegaSpeed above threshold for well beyond JOLT_SUSTAIN_TICKS.
    for (let i = 0; i < 50; i++) {
      state = stepCupulolith(state, 'posterior', 'right', tangentAtCupula, 5.0, DT).state;
    }
    expect(state.attached).toBe(false);
  });

  it('does not detach from a brief sub-threshold jolt', () => {
    const tangentAtCupula = ductTangent('posterior', 'right', 0);
    let state = initialCupulolithState();
    for (let i = 0; i < 3; i++) {
      state = stepCupulolith(state, 'posterior', 'right', tangentAtCupula, 5.0, DT).state;
    }
    expect(state.attached).toBe(true);
  });

  it('ignores ticks with an implausibly small velocityDt (sensor-jitter guard)', () => {
    const tangentAtCupula = ductTangent('posterior', 'right', 0);
    let state = initialCupulolithState();
    for (let i = 0; i < 50; i++) {
      state = stepCupulolith(state, 'posterior', 'right', tangentAtCupula, 5.0, 0.0001).state;
    }
    expect(state.attached).toBe(true);
  });
});
