import { quat } from 'gl-matrix';
import { Quat, quatCompose, quatInvert, quatIdentity, quatAngleBetween } from '../physics/types';

/**
 * Heading-drift suppression for the phone gyroscope.
 *
 * Browsers' `deviceorientation` heading (alpha) is integrated from the gyroscope without
 * a compass on Android (and starts from an arbitrary zero on iOS), so it drifts -- the
 * model slowly rotated about the vertical with the phone lying still, and because head
 * velocity is derived from orientation changes, that drift also fed the canals as a slow
 * steady yaw (a faint false nystagmus). Tilt (pitch/roll) is gravity-referenced by the
 * sensor fusion and doesn't drift.
 *
 * So: whenever the device is essentially STILL, any change in heading is drift, and is
 * absorbed into a correction rotation about the world vertical. Only the twist about the
 * vertical is absorbed -- tilt passes through untouched (so gravity in the head frame,
 * and therefore the BPPV debris physics, is never altered) -- and real head movements,
 * which are far faster than STILL_RATE_RAD_S, pass through unchanged. Unlike slowly
 * re-centring the heading, this never unwinds a turn the user is deliberately holding
 * (e.g. Dix-Hallpike's 45° head turn).
 *
 * Quaternions here map the head frame into the sensor's world frame (z up), the same
 * convention as DeviceOrientationSource's `latestRaw`.
 */
export class YawDriftFilter {
  private correction: Quat = quatIdentity();
  private prevRaw: Quat | null = null;
  private prevTimeMs = 0;
  /** Smoothed angular speed (rad/s) -- single noisy samples shouldn't flip stillness. */
  private smoothedSpeed = 0;

  /** Below this (smoothed) angular speed the device counts as still. ~3°/s: drift is a
   * fraction of a degree per second, while VOR-relevant head movements are tens to
   * hundreds of degrees per second. */
  static readonly STILL_RATE_RAD_S = (3 * Math.PI) / 180;
  /** Smoothing time constant for the speed estimate. */
  static readonly SPEED_SMOOTHING_S = 0.25;

  /** Feeds one raw sample; returns the drift-corrected orientation. */
  update(raw: Quat, timeMs: number): Quat {
    if (this.prevRaw) {
      const dt = (timeMs - this.prevTimeMs) / 1000;
      if (dt > 0) {
        const speed = quatAngleBetween(this.prevRaw, raw) / dt;
        const k = Math.min(1, dt / YawDriftFilter.SPEED_SMOOTHING_S);
        this.smoothedSpeed += (speed - this.smoothedSpeed) * k;
        if (this.smoothedSpeed < YawDriftFilter.STILL_RATE_RAD_S) {
          // World-frame change since the last sample, and its twist about world z.
          const delta = quatCompose(raw, quatInvert(this.prevRaw));
          const twist = twistAboutZ(delta);
          // Renormalized: thousands of tiny float32 compositions would otherwise drift
          // off unit length.
          this.correction = quat.normalize(quat.create(), quatCompose(this.correction, quatInvert(twist)));
        }
      }
    }
    this.prevRaw = raw;
    this.prevTimeMs = timeMs;
    return quatCompose(this.correction, raw);
  }

  reset(): void {
    this.correction = quatIdentity();
    this.prevRaw = null;
    this.smoothedSpeed = 0;
  }
}

/** Twist component of rotation q about the world z axis (swing-twist decomposition):
 * the part of q that is a pure rotation about z. gl-matrix layout is [x, y, z, w]. */
function twistAboutZ(q: Quat): Quat {
  const z = q[2];
  const w = q[3];
  const len = Math.hypot(z, w);
  if (len < 1e-12) return quatIdentity(); // a 180° rotation about a horizontal axis
  return quat.fromValues(0, 0, z / len, w / len);
}
