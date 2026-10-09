import { describe, it, expect } from 'vitest';
import { YawDriftFilter } from './yawDriftFilter';
import { Quat, quatCompose, quatFromAxisAngle, quatAngleBetween, quatInvert, rotateVec, v3, DEG2RAD, RAD2DEG } from '../physics/types';

const HZ = 60;
const yaw = (deg: number) => quatFromAxisAngle(v3(0, 0, 1), deg * DEG2RAD);
const pitch = (deg: number) => quatFromAxisAngle(v3(0, 1, 0), deg * DEG2RAD);
const roll = (deg: number) => quatFromAxisAngle(v3(1, 0, 0), deg * DEG2RAD);

/** Gravity ("down") as seen in the head frame -- what the debris physics depends on. */
const downInHead = (q: Quat) => rotateVec(quatInvert(q), v3(0, 0, -1));
const angleDeg = (a: Quat, b: Quat) => quatAngleBetween(a, b) * RAD2DEG;

/** Feeds the filter samples of `poseAt(seconds)` at 60Hz; returns the last output. */
function run(filter: YawDriftFilter, seconds: number, poseAt: (t: number) => Quat, startS = 0): Quat {
  let out = poseAt(startS);
  for (let i = 0; i <= seconds * HZ; i++) {
    const t = startS + i / HZ;
    out = filter.update(poseAt(t), t * 1000);
  }
  return out;
}

describe('YawDriftFilter', () => {
  it('absorbs slow heading drift while the phone is still', () => {
    const filter = new YawDriftFilter();
    const start = run(filter, 0, () => yaw(0));
    const end = run(filter, 60, (t) => yaw(0.5 * t)); // 0.5°/s drift -> 30° raw
    expect(angleDeg(start, end)).toBeLessThan(0.5);
  });

  it('absorbs drift with the head tilted, without changing the tilt', () => {
    const tilted = quatCompose(roll(30), pitch(-70)); // e.g. reclined and rolled
    const filter = new YawDriftFilter();
    const start = run(filter, 0, () => tilted);
    const end = run(filter, 60, (t) => quatCompose(yaw(0.5 * t), tilted));
    expect(angleDeg(start, end)).toBeLessThan(0.5);
    const g0 = downInHead(start), g1 = downInHead(end);
    expect(Math.acos(Math.min(1, g0[0] * g1[0] + g0[1] * g1[1] + g0[2] * g1[2])) * RAD2DEG).toBeLessThan(0.1);
  });

  it('passes a real head turn through, and keeps holding it', () => {
    const filter = new YawDriftFilter();
    run(filter, 1, () => yaw(0));
    // 90° turn in 0.5s (180°/s), then hold still for 30s.
    const turned = run(filter, 0.5, (t) => yaw(180 * (t - 1)), 1);
    const held = run(filter, 30, () => yaw(90), 1.5);
    expect(angleDeg(turned, yaw(90))).toBeLessThan(3);
    expect(angleDeg(held, turned)).toBeLessThan(0.5);
  });

  it('never alters tilt, even when a slow tilt counts as "still"', () => {
    const filter = new YawDriftFilter();
    let maxTiltErrorDeg = 0;
    for (let i = 0; i <= 20 * HZ; i++) {
      const t = i / HZ;
      const raw = quatCompose(yaw(0.3 * t), pitch(-1 * t)); // 1°/s pitch + yaw drift
      const out = filter.update(raw, t * 1000);
      const a = downInHead(raw), b = downInHead(out);
      maxTiltErrorDeg = Math.max(maxTiltErrorDeg, Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * RAD2DEG);
    }
    expect(maxTiltErrorDeg).toBeLessThan(0.1);
  });
});
