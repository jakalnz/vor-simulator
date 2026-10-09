import { Quat, quatFromAxisAngle, quatCompose, rotateVec, cross, norm, scale, dot, v3 } from '../physics/types';

/**
 * The seated pose reached by sitting up from lying pose `q` as a single arc: the
 * smallest rotation about a HORIZONTAL axis that brings the top of the head vertical (the
 * axis is top x up, which is always horizontal). Since the nose is perpendicular to the
 * top of the head, it ends level too. Nothing else rotates, so a head turn held while
 * lying is still held when seated.
 *
 * Several maneuvers used to end by slerping straight back to the neutral seated start
 * pose instead, which also unwound the head turn or roll mid sit-up: a sideways swing of
 * the nose (reported live on Epley) and a spurious yaw stimulus to the horizontal canals.
 * Epley itself uses its own nose-based variant -- see epley.ts noseToHorizontal.
 */
export function sitUpFrom(q: Quat): Quat {
  const up = v3(0, 0, 1);
  const top = rotateVec(q, up);
  const axis = cross(top, up);
  const axisLength = norm(axis);
  if (axisLength < 1e-9) return q; // already upright (top exactly up)
  const angle = Math.atan2(axisLength, dot(top, up));
  return quatCompose(quatFromAxisAngle(scale(axis, 1 / axisLength), angle), q);
}
