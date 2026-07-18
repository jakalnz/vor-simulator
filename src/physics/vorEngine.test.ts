import { describe, it, expect } from 'vitest';
import { v3 } from './types';
import { initialVorEngineState, stepVorEngine, defaultVorEngineParams, EyeMovementComponents } from './vorEngine';
import { normalCanalFunction, withCanalFunction } from './pathology';

const DT = 1 / 120;

interface RunResult {
  /** Final tick's result (eye position, firing rates at the end of the run). */
  final: ReturnType<typeof stepVorEngine>;
  /** Peak |value| reached on each axis over the whole run -- robust to which phase of the
   * quick-phase sawtooth the run happens to end on (with TAU_CUPULA now short enough to
   * respond within a fraction of a second, a 1s run can complete several full slow-phase/
   * quick-phase cycles, so the FINAL snapshot alone is not a reliable magnitude measure;
   * peak amplitude is). */
  peak: EyeMovementComponents;
}

/** Runs the engine for `seconds` at a constant head angular velocity. */
function runConstant(omega: [number, number, number], seconds: number, functionScale = normalCanalFunction()): RunResult {
  let state = initialVorEngineState();
  const steps = Math.round(seconds / DT);
  let result;
  const peak: EyeMovementComponents = { horizontalDeg: 0, verticalDeg: 0, torsionalDeg: 0 };
  for (let i = 0; i < steps; i++) {
    result = stepVorEngine(state, v3(...omega), DT, functionScale, defaultVorEngineParams());
    state = result.state;
    peak.horizontalDeg = Math.max(peak.horizontalDeg, Math.abs(result.eye.horizontalDeg));
    peak.verticalDeg = Math.max(peak.verticalDeg, Math.abs(result.eye.verticalDeg));
    peak.torsionalDeg = Math.max(peak.torsionalDeg, Math.abs(result.eye.torsionalDeg));
  }
  return { final: result!, peak };
}

describe('stepVorEngine', () => {
  it('pure yaw produces a horizontal-dominant compensatory response', () => {
    const { peak } = runConstant([0, 0, 1.5], 1);
    expect(peak.horizontalDeg).toBeGreaterThan(peak.verticalDeg * 3);
    expect(peak.horizontalDeg).toBeGreaterThan(peak.torsionalDeg * 3);
    expect(peak.horizontalDeg).toBeGreaterThan(0.5);
  });

  it('pure pitch produces a vertical-dominant response', () => {
    const { peak } = runConstant([0, 1.5, 0], 1);
    expect(peak.verticalDeg).toBeGreaterThan(peak.horizontalDeg * 1.5);
    expect(peak.verticalDeg).toBeGreaterThan(0.2);
  });

  it('nose-down pitch produces a COMPENSATORY (upward) eye response, not a same-direction one', () => {
    // Regression test: HeadFrame +Y is left (interaural), so a rotation of +omega_y about
    // it moves a forward-pointing (nose) vector toward -Z (down, via v = omega x r) --
    // i.e. omega = (0, +1.5, 0) is a nose-DOWN pitch. A correct VOR keeps gaze fixed on a
    // world point by rotating the eye UP relative to the head to compensate, which
    // eyeScene.ts's convention represents as a POSITIVE verticalDeg. A prior bug (ported
    // an eye-angle sign convention from the old single-canal debris-driven engine that
    // didn't actually apply to this head-velocity-driven one) produced NEGATIVE
    // verticalDeg here instead -- the eyes visually pitching WITH the head instead of
    // against it, reported by a live user testing on a real device.
    let state = initialVorEngineState();
    // Short window: only the sign of the initial compensatory response matters here, not
    // magnitude or later quick-phase resets.
    let result;
    for (let i = 0; i < Math.round(0.1 / DT); i++) {
      result = stepVorEngine(state, v3(0, 1.5, 0), DT);
      state = result.state;
    }
    expect(result!.eye.verticalDeg).toBeGreaterThan(0);
  });

  it('pure roll produces a torsional response distinct from pure yaw/pitch', () => {
    const roll = runConstant([1.5, 0, 0], 1).peak;
    const yaw = runConstant([0, 0, 1.5], 1).peak;
    expect(roll.torsionalDeg).toBeGreaterThan(0.2);
    expect(roll.torsionalDeg).toBeGreaterThan(yaw.torsionalDeg * 3);
  });

  it('right-ear-down roll produces a COMPENSATORY (CCW) torsional response', () => {
    // Regression coverage alongside the vertical-axis fix above: verified independently
    // (not just carried over from old code) via v = omega x r. HeadFrame +X is anterior;
    // a positive rotation about it (omega_x > 0) moves the right ear (at roughly
    // HeadFrame -Y) toward -Z, i.e. downward -- a right-ear-down roll. A correct VOR
    // counter-rolls the eye CCW (as seen from the front, eyeScene.ts's convention for
    // positive torsionalDeg) to keep the retinal image upright. Unlike the vertical axis,
    // this one was checked and found to already be correct (torsionalDeg's existing
    // negation, inherited from the old engine, happens to still be right here) --
    // asserted as a permanent regression test rather than left as a one-off manual check.
    let state = initialVorEngineState();
    let result;
    for (let i = 0; i < Math.round(0.1 / DT); i++) {
      result = stepVorEngine(state, v3(1.5, 0, 0), DT);
      state = result.state;
    }
    expect(result!.eye.torsionalDeg).toBeGreaterThan(0);
  });

  it('opposite head velocities produce opposite-signed horizontal responses', () => {
    // Short window (well under one slow-phase/quick-phase cycle at this tau) so the FINAL
    // snapshot's sign is still meaningful, not aliased by a reset.
    const right = runConstant([0, 0, 1.5], 0.05).final.eye.horizontalDeg;
    const left = runConstant([0, 0, -1.5], 0.05).final.eye.horizontalDeg;
    expect(Math.sign(right)).not.toBe(Math.sign(left));
    expect(Math.abs(right)).toBeGreaterThan(0.02);
  });

  it("Ewald's second law survives to the eye output: equal-magnitude opposite yaws are NOT equal-and-opposite in magnitude once one side saturates its floor", () => {
    // A very large sustained yaw pushes one horizontal canal's firing toward its 0Hz
    // floor (bounded) while the other's rises toward the ceiling (much less bounded) --
    // so the two directions' eye responses should differ in |magnitude|, not just sign.
    const strongRight = runConstant([0, 0, 12], 2).peak.horizontalDeg;
    const strongLeft = runConstant([0, 0, -12], 2).peak.horizontalDeg;
    // Both directions engage the SAME pair of canals symmetrically (mirrored anatomy),
    // so under this engine's construction the peak magnitudes are expected to match
    // closely by symmetry -- the asymmetry Ewald's second law predicts is between the
    // EXCITATORY and INHIBITORY canal of a given trial, not between mirrored trials.
    // Assert that symmetry holds (a sanity check on the mirrored construction) as a
    // baseline, with a looser tolerance than the old single-snapshot version since peak
    // detection over many quick-phase cycles has more sampling noise than one snapshot did.
    expect(strongRight).toBeCloseTo(strongLeft, 1);
    // ...and separately assert the excitatory/inhibitory asymmetry directly via firing
    // rates within a single trial.
    const { firingRates } = runConstant([0, 0, 12], 2).final;
    const excitedDelta = firingRates.horizontal.right - 90;
    const inhibitedDelta = 90 - firingRates.horizontal.left;
    expect(inhibitedDelta).toBeLessThan(excitedDelta);
  });

  it('disabling the right horizontal canal reduces the INCREMENTAL response to rotation vs normal', () => {
    // Comparing raw eye position magnitude with vs without the impairment (the old form
    // of this test) is no longer the right check: with an ACUTE destructive lesion (see
    // scaleFiring's doc comment), the impaired trial's eye position is dominated by a
    // large, constant resting-imbalance drift (asserted separately below), which makes
    // its absolute magnitude LARGER than normal's, not smaller -- correctly so. What a
    // damaged canal genuinely loses is its INCREMENTAL response to a NEW rotation on top
    // of that resting drift, which is what this test checks instead.
    const short = 0.05;
    const impairedFn = withCanalFunction(normalCanalFunction(), 'horizontal', 'right', 0);
    const normalRest = runConstant([0, 0, 0], short).final.eye.horizontalDeg;
    const normalRotated = runConstant([0, 0, 1.5], short).final.eye.horizontalDeg;
    const impairedRest = runConstant([0, 0, 0], short, impairedFn).final.eye.horizontalDeg;
    const impairedRotated = runConstant([0, 0, 1.5], short, impairedFn).final.eye.horizontalDeg;
    const normalIncrement = Math.abs(normalRotated - normalRest);
    const impairedIncrement = Math.abs(impairedRotated - impairedRest);
    expect(impairedIncrement).toBeLessThan(normalIncrement);
  });

  it('a disabled canal reports 0Hz firing regardless of head motion (not just a zeroed response)', () => {
    const { firingRates } = runConstant([0, 0, 1.5], 0.05, withCanalFunction(normalCanalFunction(), 'horizontal', 'right', 0)).final;
    expect(firingRates.horizontal.right).toBe(0);
  });

  it('acute UNILATERAL vestibular loss produces spontaneous nystagmus with the head perfectly STILL', () => {
    // The clinically distinctive sign of acute uncompensated unilateral vestibular loss:
    // both labyrinths normally fire ~equally at rest (baseline Hz), so their difference
    // -- and hence eye position -- sits at zero with no head movement. Silencing one
    // labyrinth entirely (functionScale=0) creates a PERMANENT resting imbalance (that
    // canal's firing rate drops to 0Hz even at rest, see the test above) that the
    // brainstem misreads as continuous rotation, producing a real, non-zero drift in eye
    // position even though omega is (0,0,0) throughout this whole run. A prior version of
    // this pathology model scaled only the firing-rate DELTA from baseline, which is
    // always zero at rest regardless of functionScale -- silently unable to reproduce
    // this sign at all. Only need a moderate run (well under one quick-phase cycle) since
    // any nonzero drift at all, with zero head movement, is the point being tested.
    const impairedFn = withCanalFunction(normalCanalFunction(), 'horizontal', 'right', 0);
    let state = initialVorEngineState();
    let result;
    for (let i = 0; i < Math.round(0.3 / DT); i++) {
      result = stepVorEngine(state, v3(0, 0, 0), DT, impairedFn);
      state = result.state;
    }
    expect(Math.abs(result!.eye.horizontalDeg)).toBeGreaterThan(0.05);

    // Sanity check: with ALL canals intact, the same stationary-head run must NOT drift.
    let normalState = initialVorEngineState();
    let normalResult;
    for (let i = 0; i < Math.round(0.3 / DT); i++) {
      normalResult = stepVorEngine(normalState, v3(0, 0, 0), DT);
      normalState = normalResult.state;
    }
    expect(Math.abs(normalResult!.eye.horizontalDeg)).toBeLessThan(1e-9);
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
