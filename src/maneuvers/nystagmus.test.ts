import { describe, it, expect } from 'vitest';
import { ManeuverPlayer } from './playback';
import { buildDixHallpike } from './dixHallpike';
import { initialCanalithState, stepCanalith } from '../physics/canalith';
import { initialVorEngineState, stepVorEngine } from '../physics/vorEngine';
import { G_WORLD } from '../physics/params';
import { EarSide } from '../physics/canal';
import { rotateVec, quatInvert, v3, angularVelocityBody } from '../physics/types';

/**
 * Net slow-phase eye drift (degrees) during the head-hanging hold of a Dix-Hallpike on
 * `side`, with canalithiasis in that side's posterior canal -- run through the same
 * canalith + VOR engine chain main.ts uses. Quick-phase resets (jumps) are excluded.
 */
function dixHallpikeSlowPhase(side: EarSide): { torsionalDeg: number; verticalDeg: number } {
  const dt = 1 / 120;
  const player = new ManeuverPlayer(buildDixHallpike(side));
  player.play();
  let canalith = initialCanalithState();
  let vor = initialVorEngineState();
  let prevQ = player.currentOrientation();
  let prev = { t: 0, v: 0 };
  let torsionalDeg = 0;
  let verticalDeg = 0;
  while (player.elapsedSeconds < 20) {
    const q = player.currentOrientation();
    const omega = angularVelocityBody(prevQ, q, dt);
    prevQ = q;
    player.tick(dt);
    const gHead = rotateVec(quatInvert(q), v3(...G_WORLD));
    const step = stepCanalith(canalith, 'posterior', side, gHead, dt);
    canalith = step.state;
    const debrisFlow = { posterior: { [side]: step.flow } } as Parameters<typeof stepVorEngine>[5];
    const result = stepVorEngine(vor, omega, dt, undefined, undefined, debrisFlow);
    vor = result.state;
    const dT = result.eye.torsionalDeg - prev.t;
    const dV = result.eye.verticalDeg - prev.v;
    // After the head reaches the hanging position (t = 4s); skip quick-phase jumps.
    if (player.elapsedSeconds > 4.2 && Math.abs(dT) < 1 && Math.abs(dV) < 1) {
      torsionalDeg += dT;
      verticalDeg += dV;
    }
    prev = { t: result.eye.torsionalDeg, v: result.eye.verticalDeg };
  }
  return { torsionalDeg, verticalDeg };
}

describe('posterior canal BPPV nystagmus in Dix-Hallpike', () => {
  // Classic finding: upbeating, torsional nystagmus whose fast phase beats the top of the
  // eye toward the dependent (affected) ear. Slow phases are the opposite: downward, and
  // torsionally away from the affected ear. In eyeScene.ts's convention (positive
  // torsion = counterclockwise as an examiner facing the patient sees it), the patient's
  // right ear is on the examiner's left -- so right-side slow phases are clockwise
  // (negative), left-side counterclockwise (positive).
  it('right: slow phases down and clockwise (fast phases up, toward the right ear)', () => {
    const slow = dixHallpikeSlowPhase('right');
    expect(slow.verticalDeg).toBeLessThan(-5);
    expect(slow.torsionalDeg).toBeLessThan(-5);
  });

  it('left: slow phases down and counterclockwise (fast phases up, toward the left ear)', () => {
    const slow = dixHallpikeSlowPhase('left');
    expect(slow.verticalDeg).toBeLessThan(-5);
    expect(slow.torsionalDeg).toBeGreaterThan(5);
  });
});
