import { Maneuver } from './types';
import { Quat, quatIdentity, quatFromAxisAngle, quatCompose, v3, DEG2RAD } from '../physics/types';
import { EarSide } from '../physics/canal';
import { turnSign, rollSign } from './signs';

/**
 * Zuma (Zuma e Maia) maneuver for apogeotropic horizontal-canal cupulolithiasis, from
 * Zuma e Maia, "New Treatment Strategy for Apogeotropic HC-BPPV" (PMC5134676):
 *   I.   Lie down on the affected side.
 *   II.  Head rotated 90° toward the ceiling -- a neck yaw with the body still side-lying.
 *   III. Body moves to dorsal decubitus (supine), head turned 90° toward the unaffected side.
 *   IV.  Head tilted slightly forward (encourages debris toward the utricle).
 *   V.   Slow return to sitting.
 *
 * Real clinical hold duration is 3 minutes per step; compressed to ~20-30s here to match
 * this app's existing pacing convention (Dix-Hallpike/Epley/BBQ-roll similarly compress
 * real durations for teaching pace, not clinical accuracy).
 */
function supineNeutral(): Quat {
  return quatFromAxisAngle(v3(0, 1, 0), -90 * DEG2RAD);
}

function zumaPose(side: EarSide, rollPhiDeg: number, yawDeg: number): Quat {
  const roll = quatFromAxisAngle(v3(1, 0, 0), rollSign(side) * rollPhiDeg * DEG2RAD);
  const yaw = quatFromAxisAngle(v3(0, 0, 1), yawDeg * DEG2RAD);
  return quatCompose(roll, quatCompose(supineNeutral(), yaw));
}

export function buildZuma(side: EarSide): Maneuver {
  const opposite: EarSide = side === 'right' ? 'left' : 'right';
  const upright = quatIdentity();

  const lieOnAffectedSide = zumaPose(side, 90, 0);
  const headTowardCeiling = zumaPose(side, 90, turnSign(opposite) * 90);
  const supineHeadTurnedAway = zumaPose(side, 0, turnSign(opposite) * 90);
  const headTiltedForward = quatCompose(quatFromAxisAngle(v3(0, 1, 0), 20 * DEG2RAD), supineHeadTurnedAway);

  return {
    name: `Zuma (${side})`,
    waypoints: [
      { t: 0, quat: upright, label: 'Seated upright' },
      { t: 0.8, quat: lieOnAffectedSide, label: `Lie down on ${side} (affected) side` },
      { t: 20.8, quat: lieOnAffectedSide, label: 'Hold' },
      { t: 21.6, quat: headTowardCeiling, label: 'Head rotated 90° toward the ceiling' },
      { t: 41.6, quat: headTowardCeiling, label: 'Hold' },
      { t: 42.4, quat: supineHeadTurnedAway, label: `Supine, head turned 90° toward ${opposite} (unaffected) side` },
      { t: 62.4, quat: supineHeadTurnedAway, label: 'Hold' },
      { t: 64.4, quat: headTiltedForward, label: 'Head tilted slightly forward' },
      { t: 67.4, quat: upright, label: 'Slowly return to sitting' },
    ],
  };
}

export const zumaRight = buildZuma('right');
export const zumaLeft = buildZuma('left');
