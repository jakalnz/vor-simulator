import { describe, it, expect } from 'vitest';
import { v3, normalize, quatFromAxisAngle, rotateVec, quatInvert, quatCompose } from './types';
import { initialCanalithState, stepCanalith, sMax, ductTangent } from './canalith';
import { initialVorEngineState, stepVorEngine, defaultVorEngineParams } from './vorEngine';
import { normalCanalFunction } from './pathology';
import { G_WORLD } from './params';

const DT = 1 / 60;

describe('stepCanalith', () => {
  it('debris moves toward the end of the duct whose tangent aligns with gravity, and stops there', () => {
    // A fixed, arbitrary "head down" gravity direction in HeadFrame -- not tuned to any
    // particular canal, just needs to have a nonzero component along the posterior duct's
    // tangent somewhere along its length (true for any non-degenerate direction, since the
    // duct is not straight).
    const gHead = normalize(v3(0.5, 0.3, -0.8));
    let state = initialCanalithState();
    for (let i = 0; i < 2000; i++) {
      state = stepCanalith(state, 'posterior', 'right', gHead, DT).state;
    }
    // Should have settled at a boundary (0 or sMax), since a constant gravity direction
    // drives debris monotonically toward whichever end has a gravity-aligned tangent,
    // where it then clamps.
    const max = sMax('posterior', 'right');
    const settledAtBoundary = state.s === 0 || Math.abs(state.s - max) < 1e-9;
    expect(settledAtBoundary).toBe(true);

    // Once settled, further stepping shouldn't move it any further.
    const sBefore = state.s;
    state = stepCanalith(state, 'posterior', 'right', gHead, DT).state;
    expect(state.s).toBeCloseTo(sBefore, 9);
  });

  it('flow sign matches the tangent direction (ampullofugal-positive, s increasing)', () => {
    const tangentAtStart = ductTangent('posterior', 'right', 0);
    // Gravity pointing exactly along the ampullofugal tangent at s=0 should immediately
    // produce positive dsdt (debris pushed toward the utricle), hence positive flow --
    // the same ampullofugal-positive sign convention vorEngine.ts uses for rotational flow.
    const { flow } = stepCanalith(initialCanalithState(), 'posterior', 'right', tangentAtStart, DT);
    expect(flow).toBeGreaterThan(0);
  });
});

describe('BPPV end-to-end clinical sign check (right posterior canalithiasis, Dix-Hallpike-like tilt)', () => {
  it('produces a sustained slow-phase eye response with the head held still', () => {
    // Approximate right Dix-Hallpike final position: head turned ~45 deg toward the right
    // shoulder then reclined ~30 deg below horizontal, right-ear-down. Built as a rotation
    // from upright (identity) rather than asserting exact clinical degrees -- this test's
    // purpose is to confirm gravity-driven debris in the posterior canal produces a
    // sustained (non-zero, non-decaying-to-zero) compensatory eye response via the full
    // stepVorEngine pipeline, not to pin an exact angle.
    const qYaw = quatFromAxisAngle(v3(0, 0, 1), (-45 * Math.PI) / 180);
    const qPitchBack = quatFromAxisAngle(v3(0, 1, 0), (30 * Math.PI) / 180);
    // Compose: pitch-back applied after yaw (outer * inner).
    const composed = quatCompose(qPitchBack, qYaw);
    const gHead = rotateVec(quatInvert(composed), v3(...G_WORLD));

    let canalithState = initialCanalithState();
    let vorState = initialVorEngineState();
    let lastEye = { horizontalDeg: 0, verticalDeg: 0, torsionalDeg: 0 };
    for (let i = 0; i < 600; i++) {
      const { state: nextCanalith, flow } = stepCanalith(canalithState, 'posterior', 'right', gHead, DT);
      canalithState = nextCanalith;
      const debrisFlow = { posterior: { right: flow } } as never;
      const result = stepVorEngine(vorState, v3(0, 0, 0), DT, normalCanalFunction(), defaultVorEngineParams(), debrisFlow);
      vorState = result.state;
      lastEye = result.eye;
    }

    // With the head held perfectly still (omega=0 throughout), any eye deviation at all
    // must have come from the debris-driven flow, not head rotation -- confirms the
    // additive debrisFlow path actually reaches the eye output through the full pipeline.
    const magnitude = Math.abs(lastEye.verticalDeg) + Math.abs(lastEye.torsionalDeg);
    expect(magnitude).toBeGreaterThan(0.01);
  });
});
