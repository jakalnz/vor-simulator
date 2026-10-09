import { Maneuver, Waypoint } from './types';
import { Quat, quatIdentity, quatFromAxisAngle, quatCompose, v3, DEG2RAD } from '../physics/types';
import { EarSide } from '../physics/canal';
import { turnSign, rollSign } from './signs';
import { sitUpFrom } from './poses';

/**
 * Semont maneuver for the posterior canal, parametrized by affected ear and whether the
 * full liberatory throw is included. Classic Semont starts seated with the head turned
 * 45° AWAY from the affected ear -- the OPPOSITE turn direction from Dix-Hallpike/Epley
 * (which turn toward the tested ear) -- then the patient is rapidly laid down onto the
 * affected side (diagnostic: observe nystagmus here). The liberatory version continues
 * with a rapid flip through sitting to lying on the opposite side, then a slow return to
 * sitting.
 *
 * The head-turn-relative-to-trunk is held fixed throughout (never re-turned mid-roll),
 * matching real Semont technique.
 */
function turnedAway45(side: EarSide): Quat {
  const opposite: EarSide = side === 'right' ? 'left' : 'right';
  return quatFromAxisAngle(v3(0, 0, 1), turnSign(opposite) * 45 * DEG2RAD);
}

/**
 * Rolls the body by phiDeg (about world X, same convention as bbqRoll.ts/rollTest.ts)
 * while preserving the 45°-away head turn. This base frame (turnedAway45) is still
 * SEATED at phi=0, not already lying down -- so phi=90 gives lying on `side` (the
 * diagnostic pose) and phi=-90 gives lying on the opposite side (the liberatory
 * endpoint), NOT phi=-180 (fully inverted), which is not what Semont does.
 */
function semontRollAtPhi(side: EarSide, phiDeg: number): Quat {
  const roll = quatFromAxisAngle(v3(1, 0, 0), rollSign(side) * phiDeg * DEG2RAD);
  return quatCompose(roll, turnedAway45(side));
}

/**
 * How far below horizontal the liberatory version lies the patient, in BOTH positions --
 * the "Sémont-plus" (SM+) modification. Obrist et al. 2016 (Front Neurol 7:150,
 * doi:10.3389/fneur.2016.00150) found in a physical canal model that the classic Semont,
 * lying only to horizontal, did not reposition the debris at all; extending the movements
 * 20° or more below horizontal did. This model reproduces that: with the second position
 * exactly 180° from the first, the debris' resting point in position 1 becomes the CREST
 * of the canal in position 2, and it rolls back to the ampulla (reported live as "falls
 * back after the second position").
 *
 * 30° rather than 20° (both within the paper's tested range): this model runs the debris
 * ~10x faster than real otoconia so its 30s holds can stand in for real minutes-long
 * ones, but the ~1s flip isn't compressed the same way -- so the debris slides back
 * further during the flip than it would in reality, and 20° falls just short here.
 */
const SEMONT_PLUS_BELOW_HORIZONTAL_DEG = 30;

export function buildSemont(side: EarSide, liberatory: boolean): Maneuver {
  const upright = quatIdentity();
  const turned = turnedAway45(side);
  const lieAngle = liberatory ? 90 + SEMONT_PLUS_BELOW_HORIZONTAL_DEG : 90;
  const lieOnAffectedSide = semontRollAtPhi(side, lieAngle);
  const lieOnOppositeSide = semontRollAtPhi(side, -lieAngle);
  const lieLabel = liberatory
    ? `Rapid lie onto ${side} side, head ${SEMONT_PLUS_BELOW_HORIZONTAL_DEG}° below horizontal`
    : `Rapid lie onto ${side} side`;

  const waypoints: Waypoint[] = [
    { t: 0, quat: upright, label: 'Seated upright' },
    { t: 1.5, quat: turned, label: `Head turned 45° away from ${side} ear` },
    // Fast transition (~1s): the flip's speed has no physics consequence in this model
    // (ManeuverPlayer only SLERPs by elapsed time), it's purely visual pacing.
    { t: 2.5, quat: lieOnAffectedSide, label: lieLabel },
    { t: 32.5, quat: lieOnAffectedSide, label: 'Hold (observe nystagmus)' },
  ];

  if (!liberatory) {
    waypoints.push(
      { t: 34, quat: turned, label: 'Sit back up' },
      { t: 35, quat: upright, label: 'Seated upright' }
    );
  } else {
    waypoints.push(
      // Unlabelled midpoint at sitting: the flip spans 2 x lieAngle (> 180° for Semont-
      // plus), and a slerp always takes the SHORTER way round -- without this it would
      // swing the patient through head-down instead of through sitting, as Semont is done.
      { t: 33, quat: turned },
      {
        t: 33.5,
        quat: lieOnOppositeSide,
        label: `Rapid flip through sitting to the opposite side, face down, ${SEMONT_PLUS_BELOW_HORIZONTAL_DEG}° below horizontal`,
      },
      { t: 63.5, quat: lieOnOppositeSide, label: 'Hold (observe nystagmus)' },
      // Sit up as one sideways arc, head still turned 45° (see poses.ts sitUpFrom) --
      // was a slerp back to `upright` that also unwound the turn mid sit-up.
      { t: 65, quat: sitUpFrom(lieOnOppositeSide), label: 'Slowly sit back up' }
    );
  }

  return { name: `${liberatory ? 'Semont-plus (liberatory)' : 'Semont (diagnostic)'} (${side})`, waypoints };
}

export const semontDiagnosticRight = buildSemont('right', false);
export const semontDiagnosticLeft = buildSemont('left', false);
export const semontLiberatoryRight = buildSemont('right', true);
export const semontLiberatoryLeft = buildSemont('left', true);
