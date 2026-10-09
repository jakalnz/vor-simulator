import { Maneuver } from './types';
import { quatIdentity, quatFromAxisAngle, quatCompose, v3, DEG2RAD, rotateVec, cross, normalize, Quat } from '../physics/types';
import { EarSide } from '../physics/canal';
import { turnSign, rollSign } from './signs';

/**
 * Epley (canalith repositioning) maneuver, parametrized by which ear is affected.
 * Continues from the Dix-Hallpike end pose for that side, then walks the canalith
 * around the duct back toward the utricle: turn the head to the opposite side while
 * still supine and extended, roll the body onto the opposite shoulder with the face
 * angled toward the floor, then sit up.
 *
 * As with dixHallpike.ts, exact angles are common teaching approximations -- this is a
 * visualization aid, not a clinically validated device.
 */
export function buildEpley(side: EarSide): Maneuver {
  const opposite: EarSide = side === 'right' ? 'left' : 'right';
  const upright = quatIdentity();
  const turned45 = quatFromAxisAngle(v3(0, 0, 1), turnSign(side) * 45 * DEG2RAD);
  const turned45Opposite = quatFromAxisAngle(v3(0, 0, 1), turnSign(opposite) * 45 * DEG2RAD);
  const pitchBack110 = quatFromAxisAngle(v3(0, 1, 0), -110 * DEG2RAD);

  const supineHeadHanging = quatCompose(pitchBack110, turned45);
  const supineHeadHangingOpposite = quatCompose(pitchBack110, turned45Opposite);

  // Roll the body onto the shoulder opposite the affected ear (approximated as a roll
  // about the world X axis) while keeping the head turned, ending face-down-ish toward the floor.
  const rollOntoShoulder = quatFromAxisAngle(v3(1, 0, 0), rollSign(opposite) * 135 * DEG2RAD);
  const sideLyingFaceDown = quatCompose(rollOntoShoulder, supineHeadHangingOpposite);
  const satUp = noseToHorizontal(sideLyingFaceDown);

  return {
    name: `Epley (${side})`,
    waypoints: [
      { t: 0, quat: upright, label: 'Seated upright' },
      { t: 2, quat: turned45, label: `Head turned 45° ${side}` },
      { t: 4, quat: supineHeadHanging, label: 'Reclined to supine, head hanging (Dix-Hallpike)' },
      { t: 34, quat: supineHeadHanging, label: 'Hold' },
      { t: 37, quat: supineHeadHangingOpposite, label: 'Head turned 45° to the other side, still supine' },
      { t: 67, quat: supineHeadHangingOpposite, label: 'Hold' },
      { t: 70, quat: sideLyingFaceDown, label: 'Roll onto shoulder, face down' },
      { t: 100, quat: sideLyingFaceDown, label: 'Hold' },
      { t: 103, quat: satUp, label: 'Sit up' },
    ],
  };
}

/**
 * The sit-up at the end of Epley: the head arcs from nose-down to nose-horizontal and
 * nothing else -- one rotation about the horizontal axis perpendicular to the nose's own
 * vertical plane, so the nose's compass heading and the head's turn are kept. This used
 * to slerp straight back to `upright` (the seated start pose), which also had to undo
 * the head turn and the roll: the nose swept ~110° sideways while rising (reported live
 * as wrong), and that spurious yaw also drove the horizontal canals. The patient ends
 * seated with the head still turned toward the unaffected side, as in the clinical
 * maneuver -- in this model's world frame that leaves the face pointing away from where
 * the seated start pose faced.
 */
function noseToHorizontal(q: Quat): Quat {
  const up = v3(0, 0, 1);
  const nose = rotateVec(q, v3(1, 0, 0));
  const axis = normalize(cross(nose, up));
  const elevationRad = Math.asin(Math.max(-1, Math.min(1, nose[2])));
  // Rotating by +angle about (nose x up) turns the nose toward up -- by exactly its
  // depression below horizontal.
  return quatCompose(quatFromAxisAngle(axis, -elevationRad), q);
}

export const epleyRight = buildEpley('right');
export const epleyLeft = buildEpley('left');
