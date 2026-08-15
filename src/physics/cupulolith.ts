import { Vec3, dot } from './types';
import { CanalType, EarSide } from './canal';
import { ductTangent } from './canalith';
import {
  CUPULOLITH_FLOW_GAIN,
  JOLT_SPEED_THRESHOLD_RAD_S,
  JOLT_SUSTAIN_SECONDS,
  JOLT_LEAK_TAU_S,
  JOLT_MIN_VELOCITY_DT_S,
  JOLT_MAX_SAMPLE_CONTRIBUTION_S,
} from './params';

/**
 * Cupulolithiasis (otoconia debris adherent directly to the cupula, rather than
 * free-floating in the duct -- contrast canalith.ts's mobile-debris model). Unlike
 * canalithiasis there is no arc position to track: the mass sits AT the cupula, so its
 * gravity torque is just gravity's component along the cupula's own ampullofugal
 * tangent (ductTangent(canal, side, 0), the same tangent canalith.ts already uses to
 * keep driving flow when debris is pinned at s=0 -- see stepCanalith's doc comment,
 * "pressed up against it"). This deliberately does NOT use CANAL_PLANE_NORMAL: that's
 * the canal's ROTATION axis, perpendicular to the plane the cupula actually bends in,
 * and using it would put the maximal gravity stimulus at upright/neutral head position
 * instead of supine/positional -- the opposite of the clinical picture (persistent
 * POSITIONAL nystagmus, provoked by e.g. the supine roll test, not by standing still).
 *
 * `jitterSeconds` is a leaky-bucket accumulator of real time spent with |omegaBody| above
 * JOLT_SPEED_THRESHOLD_RAD_S -- a sustained-angular-speed proxy for a genuine liberatory
 * "jolt" (a raw frame-to-frame acceleration spike can't be used here: ManeuverPlayer
 * slerps linearly between waypoints, so angular velocity is piecewise-constant per
 * segment and acceleration spikes at every waypoint boundary regardless of how brisk
 * that segment actually is -- see maneuvers/playback.ts). Deliberately a LEAKY
 * ACCUMULATOR, not a consecutive-tick counter: real device `deviceorientation` events
 * arrive well below the 120Hz physics tick rate, so between samples the orientation (and
 * thus |omegaBody|) reads near-zero even mid-swing -- a consecutive-tick counter resets
 * to 0 on every one of those in-between ticks and can then never accumulate a multi-tick
 * streak no matter how long a genuine swing is sustained (confirmed empirically: this was
 * the reported live bug, cupulolithiasis not detaching in gyro mode). Summing each
 * above-threshold sample's own real time span and decaying (not hard-resetting) below
 * threshold lets several genuine samples spread across sparse polling still add up to a
 * real sustained duration -- see params.ts's JOLT_SUSTAIN_SECONDS/JOLT_LEAK_TAU_S.
 */
export interface CupulolithState {
  attached: boolean;
  /** Leaky-bucket accumulated real seconds |omegaBody| has spent above
   * JOLT_SPEED_THRESHOLD_RAD_S -- see this interface's own doc comment. */
  jitterSeconds: number;
}

export function initialCupulolithState(): CupulolithState {
  return { attached: true, jitterSeconds: 0 };
}

export interface CupulolithStepResult {
  state: CupulolithState;
  flow: number;
}

/**
 * Advances one canal's cupulolithiasis debris state by one physics tick.
 *
 * gHead is gravity's direction in HeadFrame this tick (same convention as
 * canalith.ts's stepCanalith). omegaSpeed is |omegaBody| (rad/s) for this tick, and
 * velocityDt is the actual elapsed time that omegaBody was computed over (see
 * main.ts's stepPhysicsOnce) -- ticks whose velocityDt falls below
 * JOLT_MIN_VELOCITY_DT_S are treated as unreliable timestamp samples (real device
 * gyro jitter/quantization can otherwise masquerade as a huge instantaneous angular
 * speed) and are skipped entirely (neither adding to nor decaying jitterSeconds) --
 * a single noisy sample shouldn't fabricate OR cancel an otherwise-genuine sustained
 * swing.
 */
export function stepCupulolith(
  state: CupulolithState,
  canal: CanalType,
  side: EarSide,
  gHead: Vec3,
  omegaSpeed: number,
  velocityDt: number
): CupulolithStepResult {
  if (!state.attached) return { state, flow: 0 };

  let jitterSeconds = state.jitterSeconds;
  if (velocityDt >= JOLT_MIN_VELOCITY_DT_S) {
    jitterSeconds =
      omegaSpeed > JOLT_SPEED_THRESHOLD_RAD_S
        ? jitterSeconds + Math.min(velocityDt, JOLT_MAX_SAMPLE_CONTRIBUTION_S)
        : jitterSeconds * Math.exp(-velocityDt / JOLT_LEAK_TAU_S);
  }

  const tangent = ductTangent(canal, side, 0);
  const gravityAlignment = dot(gHead, tangent);

  // Clearance direction check mirrors canalith.ts's own ampullofugal-positive
  // convention: a sustained jolt only detaches the clump while gravity is actively
  // pulling it ampullofugally (gravityAlignment > 0) -- the same direction that would
  // carry free debris toward the utricle in the canalithiasis model. A jolt held in the
  // opposite orientation just agitates a mass gravity is pressing back onto the cupula.
  const detach = jitterSeconds >= JOLT_SUSTAIN_SECONDS && gravityAlignment > 0;
  if (detach) {
    return { state: { attached: false, jitterSeconds: 0 }, flow: 0 };
  }

  const flow = CUPULOLITH_FLOW_GAIN * gravityAlignment;
  return { state: { attached: true, jitterSeconds }, flow };
}
