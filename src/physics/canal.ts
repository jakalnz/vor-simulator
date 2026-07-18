import { Vec3, v3, normalize } from './types';

export type CanalType = 'posterior' | 'horizontal' | 'anterior';
export type EarSide = 'left' | 'right';

/** Identifies one specific canal: which type, in which ear. */
export interface CanalId {
  canal: CanalType;
  side: EarSide;
}

export function mirrorAcrossSagittal(n: Vec3): Vec3 {
  return v3(n[0], -n[1], n[2]);
}

/**
 * Semicircular canal plane normals, expressed in HeadFrame (+X anterior, +Y left,
 * +Z superior). Posterior/horizontal are the LEFT ear's literature value, mirrored across
 * the sagittal plane (flip HeadFrame.Y) to get the right ear.
 *
 * Source: Wu et al., "Measurement of Human Semicircular Canal Spatial Attitude",
 * Front Neurol. 2021;12:741948 (doi:10.3389/fneur.2021.741948), in their explicitly
 * stated coordinate system (their X = positive left, Y = positive anterior, Z = positive
 * superior, reference plane parallel to Frankfort/Reid's plane), axis-mapped into
 * HeadFrame (HeadFrame.X = their Y, HeadFrame.Y = their X, HeadFrame.Z = their Z).
 *
 * Posterior: n_left_theirs = [0.660, 0.702, 0.266] -> n_left_head = [0.702, 0.660, 0.266].
 * Horizontal: n_left_theirs = [0.025, -0.279, 0.960] -> n_left_head = [-0.279, 0.025, 0.960].
 *
 * Anterior: no hand-derived literature normal (this canal wasn't modeled before). Sourced
 * instead directly from src/scene/earAnatomy.json's real IEMap-derived fitted normal
 * (scripts/build-ear-assets/build.mjs's fitPlaneNormal over the real duct centerline,
 * RIGHT ear, already in HeadFrame via that script's RAS->HeadFrame transform -- the same
 * transform independently validated to ~7.7-8.5 degrees of the literature posterior/
 * horizontal normals). Cross-checked here via RALP coplanarity: dot(this anterior-right
 * normal, LEFT_PLANE_NORMAL.posterior) ~= -0.959 (~16.6 degrees from perfectly
 * anti-parallel/coplanar) -- comparable order to the other cross-checks in this file,
 * giving confidence the direction is anatomically sound.
 */
const LEFT_PLANE_NORMAL: Record<'posterior' | 'horizontal', Vec3> = {
  posterior: normalize(v3(0.702, 0.66, 0.266)),
  horizontal: normalize(v3(-0.279, 0.025, 0.96)),
};

const ANTERIOR_PLANE_NORMAL_RIGHT: Vec3 = normalize(
  v3(-0.624988698529963, -0.780394857324509, -0.019313036304071583)
);

export const CANAL_PLANE_NORMAL: Record<CanalType, Record<EarSide, Vec3>> = {
  posterior: {
    left: LEFT_PLANE_NORMAL.posterior,
    right: mirrorAcrossSagittal(LEFT_PLANE_NORMAL.posterior),
  },
  horizontal: {
    left: LEFT_PLANE_NORMAL.horizontal,
    right: mirrorAcrossSagittal(LEFT_PLANE_NORMAL.horizontal),
  },
  anterior: {
    left: mirrorAcrossSagittal(ANTERIOR_PLANE_NORMAL_RIGHT),
    right: ANTERIOR_PLANE_NORMAL_RIGHT,
  },
};

/**
 * Ewald's second/third laws: for the VERTICAL canals (posterior, anterior), ampullofugal
 * endolymph flow is excitatory. For the HORIZONTAL canal, it's the opposite -- ampullopetal
 * flow is excitatory, ampullofugal is inhibitory. Applied in firingRate.ts, the one place
 * cupula deflection becomes a firing-rate change, rather than baked into the sign
 * convention below (which stays a uniform, purely geometric "ampullofugal is positive").
 */
export const AMPULLOFUGAL_IS_EXCITATORY: Record<CanalType, boolean> = {
  posterior: true,
  horizontal: false,
  anterior: true,
};

/**
 * Sign that converts dot(headAngularVelocityBody, CANAL_PLANE_NORMAL[canal][side]) into
 * an ampullofugal-positive endolymph flow rate: ampullofugalFlow = AMPULLOFUGAL_SIGN *
 * dot(omega, n). NOT guessable from n alone -- two anatomically mirrored ducts sharing
 * (nearly) the same plane can still curl with opposite handedness relative to their own
 * shared axis, so the same head rotation drives ampullopetal flow in one ear's duct and
 * ampullofugal in the other's. This is the physical basis of VOR's bilateral push-pull
 * (e.g. yawing right excites the right horizontal canal and inhibits the left).
 *
 * Derived, not guessed: for a duct point at the ampulla (s=0) with in-plane tangent e2
 * (pointing ampullofugally, i.e. away from the ampulla) and radial direction e1 (pointing
 * from the canal's own center to the ampulla), a rigid head rotation by omega gives the
 * duct wall a velocity omega x (R*e1) at that point; endolymph inertia lags behind, so the
 * RELATIVE (ampullofugal-positive) flow is the tangential component of -(omega x (R*e1)),
 * i.e. proportional to -dot(omega x e1, e2) = -dot(omega, e1 x e2) = dot(omega, n) *
 * (useE1CrossN ? +1 : -1), using e1 x e2 = -n when e2 = e1 x n, or = +n when e2 = n x e1.
 *
 * "useE1CrossN" per (canal, side) was verified two independent ways: (a) numerically
 * against the real duct centerline's own tangent direction at the ampulla (whichever
 * candidate -- e1 x n or n x e1 -- has positive dot with the real ampulla-outward
 * tangent), for posterior/horizontal cross-checked against clinical Dix-Hallpike/roll-test
 * sign conventions, and independently re-derived here for anterior the same numerical way
 * against src/scene/earAnatomy.json's real anterior centerline (dot ~= +0.849 for
 * e2 = n x e1, i.e. useE1CrossN=false for the right ear); (b) mirror symmetry: reflecting
 * the whole head (a proper physical symmetry) forces useE1CrossN to flip between left and
 * right for every canal type -- confirmed both posterior and horizontal already had
 * right=true/left=false, matching this general rule.
 *
 * The e1/e2 arc-basis machinery that produced these signs is intentionally not carried
 * into this head-velocity-driven VOR engine (it was debris-arc-position machinery this
 * app no longer needs at runtime), but the physically-derived signs it produced are real
 * geometric facts about the anatomy and are preserved here as plain constants.
 */
export const AMPULLOFUGAL_SIGN: Record<CanalType, Record<EarSide, 1 | -1>> = {
  posterior: { left: -1, right: 1 },
  horizontal: { left: -1, right: 1 },
  anterior: { left: 1, right: -1 },
};

export const ALL_CANAL_TYPES: readonly CanalType[] = ['horizontal', 'anterior', 'posterior'];
export const ALL_EAR_SIDES: readonly EarSide[] = ['left', 'right'];
