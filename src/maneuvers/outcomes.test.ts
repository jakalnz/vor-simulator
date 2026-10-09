import { describe, it, expect } from 'vitest';
import { ManeuverPlayer } from './playback';
import { Maneuver } from './types';
import { buildEpley } from './epley';
import { buildSemont } from './semont';
import { buildBbqRoll } from './bbqRoll';
import { initialCanalithState, stepCanalith, sMax } from '../physics/canalith';
import { G_WORLD } from '../physics/params';
import { CanalType } from '../physics/canal';
import { rotateVec, quatInvert, v3 } from '../physics/types';

/** Plays `maneuver` through the canalithiasis physics exactly as main.ts does (fixed
 * 120Hz steps) and returns where the debris ends: 0 = ampulla, 1 = in the utricle. */
function finalDebrisFraction(maneuver: Maneuver, canal: CanalType, side: 'left' | 'right'): number {
  const player = new ManeuverPlayer(maneuver);
  player.play();
  let state = initialCanalithState();
  while (!player.isFinished()) {
    const gHead = rotateVec(quatInvert(player.currentOrientation()), v3(...G_WORLD));
    state = stepCanalith(state, canal, side, gHead, 1 / 120).state;
    player.tick(1 / 120);
  }
  return state.s / sMax(canal, side);
}

describe('repositioning maneuvers clear canalithiasis into the utricle', () => {
  for (const side of ['right', 'left'] as const) {
    it(`Epley clears ${side} posterior canal debris`, () => {
      expect(finalDebrisFraction(buildEpley(side), 'posterior', side)).toBeGreaterThan(0.99);
    });
    it(`Semont-plus clears ${side} posterior canal debris`, () => {
      expect(finalDebrisFraction(buildSemont(side, true), 'posterior', side)).toBeGreaterThan(0.99);
    });
    it(`BBQ roll clears ${side} horizontal canal debris`, () => {
      expect(finalDebrisFraction(buildBbqRoll(side), 'horizontal', side)).toBeGreaterThan(0.99);
    });
  }
});

describe('Semont-plus flip', () => {
  it('swings through sitting, not through head-down', () => {
    const player = new ManeuverPlayer(buildSemont('right', true));
    let maxTilt = 0;
    for (let t = 32.5; t <= 33.5; t += 0.05) {
      player.scrubTo(t);
      const top = rotateVec(player.currentOrientation(), v3(0, 0, 1));
      maxTilt = Math.max(maxTilt, Math.acos(Math.max(-1, Math.min(1, top[2]))));
    }
    // Starts and ends 30° below horizontal (top 120° from up); never more inverted.
    expect((maxTilt * 180) / Math.PI).toBeLessThan(121);
  });
});
