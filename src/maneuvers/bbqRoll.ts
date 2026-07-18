import { Maneuver } from './types';
import { quatIdentity, quatFromAxisAngle, quatCompose, v3, DEG2RAD, Quat } from '../physics/types';
import { EarSide } from '../physics/canal';
import { rollSign } from './signs';

/**
 * BBQ roll (Lempert maneuver), the repositioning maneuver for horizontal canalithiasis,
 * parametrized by which ear is affected. A continuous ~270 degree body roll, starting
 * from the affected-ear-down provoking position and rolling AWAY from that ear through
 * supine, the opposite ear down, and finally prone, before sitting up.
 *
 * Uses the same world-X roll axis as rollTest.ts, parametrized by a single
 * continuously-changing angle phiDeg relative to supine-neutral: phiDeg=+90 is affected
 * ear down, decreasing through 0 (supine) to -90 reaches the opposite ear down, and
 * -180 reaches prone.
 */
function supineNeutral(): Quat {
  return quatFromAxisAngle(v3(0, 1, 0), -90 * DEG2RAD);
}

function rollAtAngle(side: EarSide, phiDeg: number): Quat {
  const roll = quatFromAxisAngle(v3(1, 0, 0), rollSign(side) * phiDeg * DEG2RAD);
  return quatCompose(roll, supineNeutral());
}

export function buildBbqRoll(side: EarSide): Maneuver {
  const upright = quatIdentity();
  const affectedEarDown = rollAtAngle(side, 90);
  const neutral = rollAtAngle(side, 0);
  const oppositeEarDown = rollAtAngle(side, -90);
  const prone = rollAtAngle(side, -180);

  return {
    name: `BBQ roll (${side})`,
    waypoints: [
      { t: 0, quat: upright, label: 'Seated upright' },
      { t: 2, quat: affectedEarDown, label: `Reclined to supine, ${side} ear down` },
      { t: 32, quat: affectedEarDown, label: 'Hold' },
      { t: 35, quat: neutral, label: 'Rolled to supine, head neutral' },
      { t: 65, quat: neutral, label: 'Hold' },
      { t: 68, quat: oppositeEarDown, label: 'Rolled further, opposite ear down' },
      { t: 98, quat: oppositeEarDown, label: 'Hold' },
      { t: 101, quat: prone, label: 'Rolled further, face down' },
      { t: 131, quat: prone, label: 'Hold' },
      { t: 134, quat: upright, label: 'Sit up' },
    ],
  };
}

export const bbqRollRight = buildBbqRoll('right');
export const bbqRollLeft = buildBbqRoll('left');
