import { describe, it, expect } from 'vitest';
import { buildDixHallpike } from './dixHallpike';
import { buildEpley } from './epley';
import { buildBbqRoll } from './bbqRoll';
import { buildRollTest } from './rollTest';
import { buildSemont } from './semont';
import { buildZuma } from './zuma';
import { sitUpFrom } from './poses';
import { quatCompose, quatInvert, quatFromAxisAngle, rotateVec, v3, DEG2RAD, Quat } from '../physics/types';

const ALL_MANEUVERS = (['left', 'right'] as const).flatMap((side) => [
  buildDixHallpike(side),
  buildEpley(side),
  buildBbqRoll(side),
  buildRollTest(side),
  buildSemont(side, false),
  buildSemont(side, true),
  buildZuma(side),
]);

/** World-frame rotation axis (unit) and angle (rad) taking pose a to pose b. */
function rotationBetween(a: Quat, b: Quat): { axis: number[]; angle: number } {
  const d = quatCompose(b, quatInvert(a));
  const w = Math.min(1, Math.abs(d[3]));
  const s = Math.sqrt(Math.max(1e-12, 1 - w * w));
  const sign = d[3] < 0 ? -1 : 1;
  return { axis: [(sign * d[0]) / s, (sign * d[1]) / s, (sign * d[2]) / s], angle: 2 * Math.acos(w) };
}

describe('sitUpFrom', () => {
  it('ends with the top of the head vertical, rotating about a horizontal axis only', () => {
    const lying = quatCompose(quatFromAxisAngle(v3(1, 0, 0), 70 * DEG2RAD), quatFromAxisAngle(v3(0, 0, 1), 30 * DEG2RAD));
    const seated = sitUpFrom(lying);
    const top = rotateVec(seated, v3(0, 0, 1));
    expect(top[2]).toBeCloseTo(1, 6);
    expect(Math.abs(rotationBetween(lying, seated).axis[2])).toBeLessThan(1e-6);
  });
});

describe('maneuver sit-ups', () => {
  for (const maneuver of ALL_MANEUVERS) {
    it(`${maneuver.name}: getting up from lying is a single arc with no yaw`, () => {
      const wps = maneuver.waypoints;
      // The getting-up move: the last segment that ends with the head upright (top
      // within 30° of vertical) after starting from a lying pose (top more than 45° off).
      const isUp = (q: Quat) => rotateVec(q, v3(0, 0, 1))[2] > Math.cos(30 * DEG2RAD);
      let checked = false;
      for (let i = wps.length - 1; i > 0 && !checked; i--) {
        if (isUp(wps[i].quat) && rotateVec(wps[i - 1].quat, v3(0, 0, 1))[2] < Math.cos(45 * DEG2RAD)) {
          const { axis } = rotationBetween(wps[i - 1].quat, wps[i].quat);
          expect(Math.abs(axis[2]), `"${wps[i].label}" axis z`).toBeLessThan(0.01);
          checked = true;
        }
      }
      expect(checked, 'found a sit-up segment').toBe(true);
    });
  }
});
