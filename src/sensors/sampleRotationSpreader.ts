import { Vec3, v3 } from '../physics/types';

/**
 * Spreads each sensor sample's rotation evenly over the physics ticks until the next
 * sample is due, instead of delivering it all on the one tick the sample lands.
 *
 * Why: device orientation events arrive slower than the 120Hz physics (often ~60Hz). A
 * sample's angular velocity was applied for a single tick and then read as zero until
 * the next sample, so the cupula integrated only part of each real movement -- about half
 * on a 60Hz phone -- and the gyro-mode VOR came out correspondingly weak.
 *
 * Every sample's rotation is queued and released in full, so the total rotation fed to
 * the VOR engine is exactly what the sensor reported, at the cost of up to one sample
 * interval (~16ms) of latency.
 */
export class SampleRotationSpreader {
  /** Body-frame rotation vector (rad) not yet delivered. */
  private pending: Vec3 = v3(0, 0, 0);
  /** Time left to deliver `pending` over (s). */
  private pendingSeconds = 0;

  /** Longest span one sample's rotation is spread over -- after a gap in sensor events
   * (e.g. the tab was hidden), deliver the rotation briskly rather than as a slow drift. */
  static readonly MAX_SPREAD_S = 0.1;

  /**
   * One physics tick. `sampleOmega`/`sampleDt` are the latest sample's angular velocity
   * and the real time it was measured over; `isNewSample` is true only on the tick that
   * sample arrived. Returns this tick's angular velocity (rad/s).
   */
  step(sampleOmega: Vec3, sampleDt: number, isNewSample: boolean, dt: number): Vec3 {
    if (isNewSample) {
      for (let k = 0; k < 3; k++) this.pending[k] += sampleOmega[k] * sampleDt;
      this.pendingSeconds = Math.min(sampleDt, SampleRotationSpreader.MAX_SPREAD_S);
    }
    // The last tick of a span (or a tick with nothing due) releases everything left.
    const fraction = this.pendingSeconds > dt ? dt / this.pendingSeconds : 1;
    const step = v3(this.pending[0] * fraction, this.pending[1] * fraction, this.pending[2] * fraction);
    for (let k = 0; k < 3; k++) this.pending[k] -= step[k];
    this.pendingSeconds = Math.max(0, this.pendingSeconds - dt);
    return v3(step[0] / dt, step[1] / dt, step[2] / dt);
  }

  reset(): void {
    this.pending = v3(0, 0, 0);
    this.pendingSeconds = 0;
  }
}
