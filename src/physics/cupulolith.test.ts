import { describe, it, expect } from 'vitest';
import { v3, normalize, angularVelocityBody, rotateVec, quatInvert, quatFromAxisAngle, DEG2RAD } from './types';
import { stepCanalith, initialCanalithState, ductTangent } from './canalith';
import { initialCupulolithState, stepCupulolith } from './cupulolith';
import { ALL_EAR_SIDES } from './canal';
import { G_WORLD } from './params';

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

  it('does not detach from a single anomalously long-duration sample (e.g. gyro resumed after being paused/backgrounded)', () => {
    // Regression test for a reported live bug: cupulolithiasis detached the instant it
    // was selected, before the clot marker had moved at all. Root cause -- one tick with
    // a large velocityDt (a real clock gap after a pause/resume, common right after
    // toggling a pathology or the gyro) could single-handedly satisfy the whole
    // JOLT_SUSTAIN_SECONDS requirement, since the leaky bucket added velocityDt uncapped.
    const tangentAtCupula = ductTangent('posterior', 'right', 0);
    const state = stepCupulolith(initialCupulolithState(), 'posterior', 'right', tangentAtCupula, 1.5, 0.5).state;
    expect(state.attached).toBe(true);
  });

  it('detaches from a genuine sustained swing even when sampled sparsely (real gyro poll rate), which a consecutive-tick counter could not', () => {
    // Regression test for a reported live bug: a brisk ~180deg/s, 1-second swing produced
    // no detachment in gyro mode. Root cause -- physics ticks at 120Hz, but real
    // deviceorientation events (and this simulation) arrive far less often; between
    // samples the orientation (and thus |omegaBody|) reads ~0, so a model requiring N
    // CONSECUTIVE high-speed ticks could never accumulate a streak longer than 1, no
    // matter how long the real swing lasted. The leaky-bucket jitterSeconds accumulator
    // must still cross JOLT_SUSTAIN_SECONDS here.
    const GYRO_SAMPLE_INTERVAL_S = 0.05; // ~20Hz, a realistic deviceorientation poll rate
    const SWING_DURATION_S = 1.0;
    const SWING_TOTAL_DEG = 180;
    const PHYSICS_DT = 1 / 120;

    let state = initialCupulolithState();
    let prevQHeadForVelocity = quatFromAxisAngle(v3(1, 0, 0), 0);
    let prevSampleTimeS = 0;
    let currentSampleQ = prevQHeadForVelocity;
    let nextSampleAtS = GYRO_SAMPLE_INTERVAL_S;

    const totalTicks = Math.ceil(SWING_DURATION_S / PHYSICS_DT);
    for (let i = 0; i < totalTicks && state.attached; i++) {
      const tS = (i + 1) * PHYSICS_DT;
      let velocityDt = PHYSICS_DT;
      if (tS >= nextSampleAtS) {
        const angleDeg = (tS / SWING_DURATION_S) * SWING_TOTAL_DEG;
        currentSampleQ = quatFromAxisAngle(v3(1, 0, 0), angleDeg * DEG2RAD);
        velocityDt = tS - prevSampleTimeS;
        prevSampleTimeS = tS;
        nextSampleAtS += GYRO_SAMPLE_INTERVAL_S;
      }
      const omega = angularVelocityBody(prevQHeadForVelocity, currentSampleQ, velocityDt);
      prevQHeadForVelocity = currentSampleQ;
      const speed = Math.hypot(omega[0], omega[1], omega[2]);
      const gHead = rotateVec(quatInvert(currentSampleQ), v3(...G_WORLD));
      state = stepCupulolith(state, 'posterior', 'right', gHead, speed, velocityDt).state;
    }

    expect(state.attached).toBe(false);
  });
});

describe('cupulolithiasis -> canalithiasis conversion on detachment (main.ts wiring contract)', () => {
  it('detached debris starts free-floating from the cupula (s=0) and continues under stepCanalith exactly like canalithiasis would', () => {
    // main.ts's stepPhysicsOnce doesn't run stepCanalith itself until the tick AFTER
    // cupulolithDetached flips true (see its own doc comment) -- this test exercises the
    // same two-stage sequence directly against the physics primitives, confirming the
    // detached clot's onward journey is byte-identical to a canalithiasis clot that
    // started at s=0, which is the whole point of converting rather than inventing a
    // second "cleared" concept for cupulolithiasis. (Whether it goes on to fully clear
    // into the utricle depends on the duct's curvature under a HELD constant gravity
    // direction -- see canalith.test.ts's own settled-at-a-boundary test for that
    // separately-covered behavior; this test only needs to show the CONVERSION starts
    // from the right place and evolves via the same stepCanalith physics.)
    const tangentAtCupula = ductTangent('posterior', 'right', 0);

    let cState = initialCupulolithState();
    for (let i = 0; i < 50; i++) {
      cState = stepCupulolith(cState, 'posterior', 'right', tangentAtCupula, 5.0, DT).state;
    }
    expect(cState.attached).toBe(false);

    // Conversion: a fresh canalith state, starting at the cupula end -- and it should
    // immediately start moving under the SAME gravity that drove the cupulolithiasis flow
    // (a duct-curvature equilibrium point other than s=0 exists, matching the physical
    // duct's real shape, so debris need not necessarily reach the far end here).
    let kState = initialCanalithState();
    expect(kState.s).toBe(0);
    for (let i = 0; i < 50; i++) {
      kState = stepCanalith(kState, 'posterior', 'right', tangentAtCupula, DT).state;
    }
    expect(kState.s).toBeGreaterThan(0);
  });
});
