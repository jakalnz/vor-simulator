import { Vec3, v3, dot, normalize, norm } from './types';
import { CanalType, EarSide, ALL_CANAL_TYPES, mirrorAcrossSagittal } from './canal';
import { DEBRIS_MOBILITY_M_PER_S, DEBRIS_FLOW_GAIN_PER_M_S } from './params';
import earAnatomyData from '../scene/earAnatomy.json';

interface EarAnatomyCanalGeometry {
  centerline: [number, number, number][];
}
const EAR_ANATOMY = earAnatomyData as unknown as { canals: Record<CanalType, EarAnatomyCanalGeometry> };

/**
 * Idealized free-floating-debris (canalithiasis) position along one canal's duct,
 * parametrized by arc length s: s=0 at the ampulla (JSON centerline's first point, per
 * earAnatomy.json's own build script ordering -- confirmed centerline[0] ==
 * ampullaAnchor), increasing toward the utricular end. This is the "minimal slice"
 * canalithiasis model per the BPPV plan -- no cupulolithiasis, no latency gating, no
 * inertia lag, no short-arm reentry; instantaneous overdamped Stokes-drag target velocity
 * only, matching the old app's `targetVelocity` term (canalith.ts, pre-VOR-conversion)
 * without its `LATENCY_SECONDS`/`CLOT_INERTIA_TAU` refinement stages.
 */
export interface CanalithState {
  /** Arc-length position, meters, clamped to [0, sMax(canal, side)]. */
  s: number;
}

export function initialCanalithState(): CanalithState {
  return { s: 0 };
}

interface DuctPolyline {
  /** Cumulative arc length at each centerline point, meters. */
  cumulative: number[];
  points: Vec3[];
  sMax: number;
}

const polylineCache = new Map<string, DuctPolyline>();

function mirrorPoint(p: [number, number, number]): Vec3 {
  return mirrorAcrossSagittal(v3(p[0], p[1], p[2]));
}

/** Points sampled per control-point segment when smoothing the sparse (5-point)
 * centerline (see buildPolyline's doc comment). */
const CATMULL_ROM_SAMPLES_PER_SEGMENT = 16;

function catmullRomPoint(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] =
      0.5 *
      (2 * p1[k] +
        (-p0[k] + p2[k]) * t +
        (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
        (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
  }
  return v3(out[0], out[1], out[2]);
}

/**
 * Smooths the sparse (5-point) raw centerline into a finer Catmull-Rom-interpolated
 * polyline before it's used for either physics (ductTangent's dot-with-gravity) or
 * rendering (ductPositionAtFraction). The raw JSON centerline has only 5 stations for the
 * whole duct -- piecewise-LINEAR interpolation between them cuts corners at the sharply
 * curved ampulla end, visibly placing the debris marker outside the actual (much smoother)
 * duct mesh surface there (reported live). Catmull-Rom passes exactly through every
 * control point while curving smoothly between them, matching how the old app's own
 * debris-position code already followed real anatomy curves (see canalith.ts research
 * notes, "curve-following" via Catmull-Rom). Endpoint tangents use a clamped/duplicated
 * boundary (P(-1)=P0, P(n)=P(n-1)), the standard approach when no natural continuation
 * point exists past either end.
 */
function smoothCenterline(points: Vec3[]): Vec3[] {
  if (points.length < 3) return points;
  const out: Vec3[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? points[i + 1];
    for (let s = 1; s <= CATMULL_ROM_SAMPLES_PER_SEGMENT; s++) {
      out.push(catmullRomPoint(p0, p1, p2, p3, s / CATMULL_ROM_SAMPLES_PER_SEGMENT));
    }
  }
  return out;
}

function buildPolyline(canal: CanalType, side: EarSide): DuctPolyline {
  // earAnatomy.json's centerline is RIGHT-ear raw data (see scene/canalScene.ts's own
  // doc comment: "IEMap dataset (right ear...)", and its labyrinthGroup.scale.y = -1
  // mirror applied only for the LEFT side) -- so 'right' must use the raw points
  // unmirrored, and 'left' is the mirrored one. An earlier version of this had the
  // ternary backwards (mirroring 'right' instead of 'left'), which silently flipped the
  // Y coordinate for the right ear and placed the debris marker at its mirror-image
  // position, well outside the actual duct -- confirmed live by comparing the debris
  // world position against the loaded duct mesh's own bounding box.
  const raw = EAR_ANATOMY.canals[canal].centerline;
  const controlPoints = raw.map((p) => (side === 'right' ? v3(p[0], p[1], p[2]) : mirrorPoint(p)));
  const points = smoothCenterline(controlPoints);
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    const segLen = norm(v3(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]));
    cumulative.push(cumulative[i - 1] + segLen);
  }
  return { cumulative, points, sMax: cumulative[cumulative.length - 1] };
}

function polylineFor(canal: CanalType, side: EarSide): DuctPolyline {
  const key = `${canal}:${side}`;
  let pl = polylineCache.get(key);
  if (!pl) {
    pl = buildPolyline(canal, side);
    polylineCache.set(key, pl);
  }
  return pl;
}

/** Maximum arc-length position (utricular end of the modeled centerline), meters. */
export function sMax(canal: CanalType, side: EarSide): number {
  return polylineFor(canal, side).sMax;
}

/** Unit tangent at arc-length s, pointing in the direction of increasing s (ampullofugal). */
export function ductTangent(canal: CanalType, side: EarSide, s: number): Vec3 {
  const { cumulative, points } = polylineFor(canal, side);
  const clamped = Math.max(0, Math.min(cumulative[cumulative.length - 1], s));
  let i = 1;
  while (i < cumulative.length - 1 && cumulative[i] < clamped) i++;
  const a = points[i - 1];
  const b = points[i];
  return normalize(v3(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
}

/**
 * Debris marker position at arc-length FRACTION (0=ampulla, 1=utricular end), in the raw
 * RIGHT-ear mesh coordinates the loaded OBJ geometry itself uses (see
 * scene/canalScene.ts) -- deliberately not mirrored per side, since CanalScene already
 * applies the left-ear mirror to its whole labyrinth group, and mirroring position here
 * too would double-mirror it. Physics (stepCanalith/ductTangent) uses the per-side
 * mirrored variant instead, since that one needs to dot against a true per-side gHead.
 */
export function ductPositionAtFraction(canal: CanalType, fraction: number): Vec3 {
  const { cumulative, points, sMax: max } = polylineFor(canal, 'right');
  const s = Math.max(0, Math.min(max, fraction * max));
  let i = 1;
  while (i < cumulative.length - 1 && cumulative[i] < s) i++;
  const segStart = cumulative[i - 1];
  const segEnd = cumulative[i];
  const t = segEnd > segStart ? (s - segStart) / (segEnd - segStart) : 0;
  const a = points[i - 1];
  const b = points[i];
  return v3(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

/**
 * Advances one canal's canalithiasis debris state by one physics tick.
 *
 * gHead is the current gravity direction expressed in HeadFrame (see params.ts's
 * G_WORLD and main.ts's per-frame rotation of it by the inverse head orientation). The
 * debris' arc-velocity target is proportional to gravity's component along the duct's own
 * tangent at its current position -- an idealized overdamped (inertia-free) Stokes-drag
 * model, matching the old app's instantaneous `targetVelocity` term.
 *
 * Returns the updated state and a flow value in the SAME ampullofugal-positive convention
 * `vorEngine.ts` already uses for head-velocity-driven flow (AMPULLOFUGAL_SIGN * omegaProj)
 * -- since s is itself defined ampulla(0)->utricle(increasing) = ampullofugal, no extra
 * sign correction is needed; dsdt > 0 (debris moving toward the utricle) is directly
 * ampullofugal-positive flow.
 */
export function stepCanalith(
  state: CanalithState,
  canal: CanalType,
  side: EarSide,
  gHead: Vec3,
  dt: number
): { state: CanalithState; flow: number } {
  const tangent = ductTangent(canal, side, state.s);
  const dsdt = DEBRIS_MOBILITY_M_PER_S * dot(gHead, tangent);
  const max = sMax(canal, side);
  const s = Math.max(0, Math.min(max, state.s + dsdt * dt));
  // Debris that has fully cleared into the utricle (s === max) is no longer part of the
  // canal duct and stops driving the cupula, regardless of gravity direction -- otherwise
  // this idealized model would keep "pushing on the wall" forever with no way to
  // represent successful clearance. Debris pinned at the ampulla end (s === 0) is left
  // driving the cupula continuously, since physically it's pressed up against it.
  const clearedIntoUtricle = s >= max;
  const flow = clearedIntoUtricle ? 0 : DEBRIS_FLOW_GAIN_PER_M_S * dsdt;
  return { state: { s }, flow };
}

export type BppvSelection = { canal: CanalType; side: EarSide } | null;

export function allCanalTypes(): readonly CanalType[] {
  return ALL_CANAL_TYPES;
}
