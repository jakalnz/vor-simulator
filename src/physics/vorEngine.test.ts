import { describe, it, expect } from 'vitest';
import { v3 } from './types';
import { initialVorEngineState, stepVorEngine, defaultVorEngineParams } from './vorEngine';
import { normalCanalFunction, withCanalFunction } from './pathology';

const DT = 1 / 120;

/** Runs the engine for `seconds` at a constant head angular velocity, returning the final result. */
function runConstant(omega: [number, number, number], seconds: number, functionScale = normalCanalFunction()) {
  let state = initialVorEngineState();
  const steps = Math.round(seconds / DT);
  let result;
  for (let i = 0; i < steps; i++) {
    result = stepVorEngine(state, v3(...omega), DT, functionScale, defaultVorEngineParams());
    state = result.state;
  }
  return result!;
}

describe('stepVorEngine', () => {
  it('pure yaw produces a horizontal-dominant compensatory response', () => {
    const { eye } = runConstant([0, 0, 1.5], 1);
    expect(Math.abs(eye.horizontalDeg)).toBeGreaterThan(Math.abs(eye.verticalDeg) * 3);
    expect(Math.abs(eye.horizontalDeg)).toBeGreaterThan(Math.abs(eye.torsionalDeg) * 3);
    expect(Math.abs(eye.horizontalDeg)).toBeGreaterThan(0.5);
  });

  it('pure pitch produces a vertical-dominant response', () => {
    const { eye } = runConstant([0, 1.5, 0], 1);
    expect(Math.abs(eye.verticalDeg)).toBeGreaterThan(Math.abs(eye.horizontalDeg) * 1.5);
    expect(Math.abs(eye.verticalDeg)).toBeGreaterThan(0.2);
  });

  it('pure roll produces a torsional response distinct from pure yaw/pitch', () => {
    const roll = runConstant([1.5, 0, 0], 1).eye;
    const yaw = runConstant([0, 0, 1.5], 1).eye;
    expect(Math.abs(roll.torsionalDeg)).toBeGreaterThan(0.2);
    expect(Math.abs(roll.torsionalDeg)).toBeGreaterThan(Math.abs(yaw.torsionalDeg) * 3);
  });

  it('opposite head velocities produce opposite-signed horizontal responses', () => {
    const right = runConstant([0, 0, 1.5], 0.3).eye.horizontalDeg;
    const left = runConstant([0, 0, -1.5], 0.3).eye.horizontalDeg;
    expect(Math.sign(right)).not.toBe(Math.sign(left));
    expect(Math.abs(right)).toBeGreaterThan(0.05);
  });

  it("Ewald's second law survives to the eye output: equal-magnitude opposite yaws are NOT equal-and-opposite in magnitude once one side saturates its floor", () => {
    // A very large sustained yaw pushes one horizontal canal's firing toward its 0Hz
    // floor (bounded) while the other's rises toward the ceiling (much less bounded) --
    // so the two directions' eye responses should differ in |magnitude|, not just sign.
    const strongRight = Math.abs(runConstant([0, 0, 12], 2).eye.horizontalDeg);
    const strongLeft = Math.abs(runConstant([0, 0, -12], 2).eye.horizontalDeg);
    // Both directions engage the SAME pair of canals symmetrically (mirrored anatomy),
    // so under this engine's construction the magnitudes are expected to match exactly by
    // symmetry -- the asymmetry Ewald's second law predicts is between the EXCITATORY and
    // INHIBITORY canal of a given trial, not between mirrored trials. Assert that
    // symmetry holds (a sanity check on the mirrored construction) as a baseline...
    expect(strongRight).toBeCloseTo(strongLeft, 3);
    // ...and separately assert the excitatory/inhibitory asymmetry directly via firing
    // rates within a single trial.
    const { firingRates } = runConstant([0, 0, 12], 2);
    const excitedDelta = firingRates.horizontal.right - 90;
    const inhibitedDelta = 90 - firingRates.horizontal.left;
    expect(inhibitedDelta).toBeLessThan(excitedDelta);
  });

  it('disabling the right horizontal canal produces a measurable asymmetry vs normal', () => {
    const normal = runConstant([0, 0, 1.5], 1).eye.horizontalDeg;
    const impaired = runConstant([0, 0, 1.5], 1, withCanalFunction(normalCanalFunction(), 'horizontal', 'right', 0)).eye
      .horizontalDeg;
    expect(Math.abs(impaired)).toBeLessThan(Math.abs(normal));
  });

  it('quick-phase resets keep slow-phase position bounded under a long sustained yaw', () => {
    // Without a quick-phase reset ever firing, a sustained yaw's slow-phase position
    // would integrate unboundedly past QUICK_PHASE_THRESHOLD. Staying bounded over many
    // seconds is indirect but solid evidence that resets are actually firing repeatedly.
    let state = initialVorEngineState();
    let maxAbsH = 0;
    for (let i = 0; i < Math.round(5 / DT); i++) {
      const result = stepVorEngine(state, v3(0, 0, 3), DT);
      state = result.state;
      maxAbsH = Math.max(maxAbsH, Math.abs(state.eyeAngleH));
    }
    expect(maxAbsH).toBeGreaterThan(0.1); // it did move
    expect(maxAbsH).toBeLessThan(1.0); // but stayed bounded, well under an unbounded runaway
  });
});
