import { describe, it, expect } from 'vitest';
import { buildEpley } from './epley';
import { ManeuverPlayer } from './playback';
import { rotateVec, v3 } from '../physics/types';

const RAD2DEG = 180 / Math.PI;

describe('Epley final sit-up', () => {
  for (const side of ['right', 'left'] as const) {
    it(`${side}: the nose arcs from down to horizontal with no sideways swing`, () => {
      const player = new ManeuverPlayer(buildEpley(side));
      const sitUp = player.chapters[player.chapters.length - 1];
      expect(sitUp.label).toBe('Sit up');

      const noseAt = (t: number) => {
        player.scrubTo(t);
        return rotateVec(player.currentOrientation(), v3(1, 0, 0));
      };
      const heading = (n: ArrayLike<number>) => Math.atan2(n[1], n[0]) * RAD2DEG;
      const elevation = (n: ArrayLike<number>) => Math.asin(n[2]) * RAD2DEG;

      const start = noseAt(sitUp.t);
      expect(elevation(start)).toBeLessThan(-60); // starts nose-down
      let previousElevation = elevation(start);
      for (let i = 1; i <= 20; i++) {
        const nose = noseAt(sitUp.t + ((player.duration - sitUp.t) * i) / 20);
        expect(Math.abs(heading(nose) - heading(start))).toBeLessThan(0.5); // no swing
        expect(elevation(nose)).toBeGreaterThan(previousElevation); // only rises
        previousElevation = elevation(nose);
      }
      expect(Math.abs(previousElevation)).toBeLessThan(0.5); // ends level
    });
  }
});
