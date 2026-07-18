import { Vec3, dot, RAD2DEG } from './types';
import { CanalType, EarSide, CANAL_PLANE_NORMAL, AMPULLOFUGAL_IS_EXCITATORY, AMPULLOFUGAL_SIGN, ALL_CANAL_TYPES, ALL_EAR_SIDES } from './canal';
import { updateCupula } from './cupula';
import { firingRate, FiringRateParams } from './firingRate';
import { CanalFunction, scaleFiring, normalCanalFunction } from './pathology';
import {
  TAU_CUPULA,
  QUICK_PHASE_THRESHOLD,
  QUICK_PHASE_RESET_AMOUNT,
  GAIN_VOR_FIRING,
  FIRING_BASELINE_HZ,
  FIRING_CEILING_HZ,
  FIRING_GAIN_HZ_PER_RAD_S,
} from './params';

export type PerCanalSide<T> = Record<CanalType, Record<EarSide, T>>;

export interface EyeMovementComponents {
  /** Rotation about the vertical (superior-inferior) axis -- clinical "horizontal" eye movement, degrees. */
  horizontalDeg: number;
  /** Rotation about the interaural (left-right) axis -- clinical "vertical" eye movement, degrees. Positive = up. */
  verticalDeg: number;
  /** Rotation about the naso-occipital (line-of-sight) axis -- clinical "torsional" eye movement, degrees. */
  torsionalDeg: number;
}

export interface VorEngineState {
  cupula: PerCanalSide<number>;
  /** Slow-phase eye position accumulators, radians, one per clinical axis (see EyeMovementComponents). */
  eyeAngleH: number;
  eyeAngleV: number;
  eyeAngleT: number;
}

export function initialVorEngineState(): VorEngineState {
  const cupula = {} as PerCanalSide<number>;
  for (const canal of ALL_CANAL_TYPES) {
    cupula[canal] = { left: 0, right: 0 } as Record<EarSide, number>;
  }
  return { cupula, eyeAngleH: 0, eyeAngleV: 0, eyeAngleT: 0 };
}

/**
 * Sign relating a canal's firing-rate delta (fired - baseline, positive = excited) back
 * to the head angular velocity COMPONENT ALONG THAT CANAL'S OWN AXIS that produced it:
 * delta[c][s] is an increasing function of CANAL_EXCITATION_SIGN[c][s] * dot(omega, n).
 * Composes AMPULLOFUGAL_IS_EXCITATORY's canal-type polarity (applied in firingRate) with
 * AMPULLOFUGAL_SIGN's per-(canal,side) geometric sign (canal.ts) -- see that file's own
 * doc comment for the derivation of each factor.
 */
function canalExcitationSign(canal: CanalType, side: EarSide): 1 | -1 {
  const excitatoryPolarity = AMPULLOFUGAL_IS_EXCITATORY[canal] ? 1 : -1;
  return (excitatoryPolarity * AMPULLOFUGAL_SIGN[canal][side]) as 1 | -1;
}

const DEFAULT_FIRING_PARAMS: FiringRateParams = {
  baselineHz: FIRING_BASELINE_HZ,
  ceilingHz: FIRING_CEILING_HZ,
  gainHzPerRadS: FIRING_GAIN_HZ_PER_RAD_S,
};

export interface VorEngineParams {
  firing: FiringRateParams;
  tauCupula: number;
  gainVorFiring: number;
}

export function defaultVorEngineParams(): VorEngineParams {
  return { firing: DEFAULT_FIRING_PARAMS, tauCupula: TAU_CUPULA, gainVorFiring: GAIN_VOR_FIRING };
}

export interface VorEngineStepResult {
  state: VorEngineState;
  /** This tick's per-canal firing rates, Hz, AFTER pathology function-scaling (see
   * pathology.ts's scaleFiring) -- deliberately the scaled value, not the raw
   * cupula-driven one, so a disabled/impaired canal's visualization (canalScene.ts's
   * excitation/inhibition color coding, ui/canalHexPlot.ts) actually shows the reduced
   * output, not what that canal WOULD have fired absent the pathology. */
  firingRates: PerCanalSide<number>;
  eye: EyeMovementComponents;
}

/**
 * Bilateral 6-canal VOR step: projects head angular velocity onto each of the 6
 * (canal, side) plane normals, runs the Steinhausen cupula filter and Ewald firing-rate
 * stage independently per canal, applies pathology function-scaling, then sums each
 * canal's contribution into a single compensatory eye angular velocity vector (in
 * HeadFrame), integrates it per clinical axis (horizontal/vertical/torsional), and fires
 * an independent quick-phase reset per axis once its slow-phase position exceeds
 * QUICK_PHASE_THRESHOLD.
 *
 * Each canal's own contribution to the eye velocity vector is
 * -canalExcitationSign(c,s) * n[c][s] * delta[c][s] * gainVorFiring -- i.e. a rotation
 * about that canal's own axis, sized by how far its firing rate has moved from baseline,
 * in the direction that would compensate for (be opposite to) the head rotation that
 * caused the excitation. Summing this contribution across all 6 canals and reading off
 * the resulting vector's raw X/Y/Z components as torsional/vertical/horizontal is the
 * direct many-canal generalization of this app's original single-canal
 * decomposeEyeMovement (which projected one canal's eyeAngle*n onto the same three axes) --
 * for a scenario where only one canal is significantly driven, the two are equivalent.
 */
export function stepVorEngine(
  state: VorEngineState,
  headAngularVelocityBody: Vec3,
  dt: number,
  functionScale: CanalFunction = normalCanalFunction(),
  params: VorEngineParams = defaultVorEngineParams()
): VorEngineStepResult {
  const cupula = {} as PerCanalSide<number>;
  const firingRates = {} as PerCanalSide<number>;
  let eyeOmegaX = 0;
  let eyeOmegaY = 0;
  let eyeOmegaZ = 0;

  for (const canal of ALL_CANAL_TYPES) {
    cupula[canal] = {} as Record<EarSide, number>;
    firingRates[canal] = {} as Record<EarSide, number>;
    for (const side of ALL_EAR_SIDES) {
      const n = CANAL_PLANE_NORMAL[canal][side];
      const omegaProj = dot(headAngularVelocityBody, n);
      const flow = AMPULLOFUGAL_SIGN[canal][side] * omegaProj;
      const beta = updateCupula(state.cupula[canal][side], flow, dt, params.tauCupula);
      cupula[canal][side] = beta;

      const fired = firingRate(beta, canal, params.firing);
      const scaledFired = scaleFiring(fired, functionScale[canal][side]);
      firingRates[canal][side] = scaledFired;
      const delta = scaledFired - params.firing.baselineHz;

      const sign = canalExcitationSign(canal, side);
      const contribScale = -sign * delta * params.gainVorFiring;
      eyeOmegaX += contribScale * n[0];
      eyeOmegaY += contribScale * n[1];
      eyeOmegaZ += contribScale * n[2];
    }
  }

  // eyeOmegaX/Y/Z are the raw HeadFrame components of the compensatory eye angular
  // velocity vector (already anti-parallel to head angular velocity by construction --
  // see contribScale's derivation above). Converting each to the clinical H/V/T sign
  // convention eyeScene.ts expects ("verticalDeg positive = up", "torsionalDeg positive =
  // CCW as seen from the front", "horizontalDeg positive = screen-right for a rightward
  // head turn's compensation") requires checking each axis independently against that
  // convention, NOT assuming the OLD single-canal debris-driven vor.ts's per-axis
  // negation choices carry over -- that older eyeAngle was a fundamentally different
  // quantity (gravity/debris-driven, run through its own e1/e2 handedness machinery), so
  // its empirically-tuned negations don't necessarily apply to this head-velocity-driven
  // vector. Re-derived directly from v = omega x r (HeadFrame +X anterior, +Y left,
  // +Z superior) for all three axes:
  //  - Horizontal (Z, yaw): a rightward head turn compensates toward HeadFrame +Y (left),
  //    which -- via the mirrored examiner-view convention eyeScene.ts already uses --
  //    reads as screen-right, matching "positive = screen-right". No negation needed.
  //  - Torsional (X, roll): a right-ear-down head roll (positive omega_x) needs a CCW
  //    (examiner-view) counter-roll to compensate, matching "positive = CCW". Needs a
  //    negation (confirmed by direct derivation, not just carried over from old code).
  //  - Vertical (Y, pitch): a nose-down head pitch (positive omega_y) produces gaze
  //    compensation toward HeadFrame +Z (up) -- but the OLD code's un-negated n[1]
  //    convention (carried over here originally) instead reported that as NEGATIVE
  //    (down), causing the eyes to visually pitch WITH the head instead of against it
  //    (reported by a live user: "when the head tilts down, the eyes tilt down"). Fixed
  //    by negating: positive eyeAngleV now correctly means up.
  let eyeAngleT = state.eyeAngleT + -eyeOmegaX * dt;
  let eyeAngleV = state.eyeAngleV + -eyeOmegaY * dt;
  let eyeAngleH = state.eyeAngleH + eyeOmegaZ * dt;

  if (Math.abs(eyeAngleT) > QUICK_PHASE_THRESHOLD) eyeAngleT -= Math.sign(eyeAngleT) * QUICK_PHASE_RESET_AMOUNT;
  if (Math.abs(eyeAngleV) > QUICK_PHASE_THRESHOLD) eyeAngleV -= Math.sign(eyeAngleV) * QUICK_PHASE_RESET_AMOUNT;
  if (Math.abs(eyeAngleH) > QUICK_PHASE_THRESHOLD) eyeAngleH -= Math.sign(eyeAngleH) * QUICK_PHASE_RESET_AMOUNT;

  return {
    state: { cupula, eyeAngleH, eyeAngleV, eyeAngleT },
    firingRates,
    eye: {
      horizontalDeg: eyeAngleH * RAD2DEG,
      verticalDeg: eyeAngleV * RAD2DEG,
      torsionalDeg: eyeAngleT * RAD2DEG,
    },
  };
}
