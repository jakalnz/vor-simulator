import { CanalType, EarSide, ALL_CANAL_TYPES, ALL_EAR_SIDES } from './canal';

/** Per-canal-per-ear function scale: 0 = absent (complete loss), 1 = normal. */
export type CanalFunction = Record<CanalType, Record<EarSide, number>>;

export function normalCanalFunction(): CanalFunction {
  const fn = {} as CanalFunction;
  for (const canal of ALL_CANAL_TYPES) {
    fn[canal] = { left: 1, right: 1 } as Record<EarSide, number>;
  }
  return fn;
}

export function withCanalFunction(fn: CanalFunction, canal: CanalType, side: EarSide, scale: number): CanalFunction {
  return { ...fn, [canal]: { ...fn[canal], [side]: scale } };
}

/**
 * Scales a canal's ENTIRE firing rate (not just its delta from baseline) by
 * functionScale -- functionScale=0 means this canal is permanently silent (0Hz, whether
 * the head is moving or not), functionScale=1 is normal.
 *
 * This is deliberately NOT "baseline + (fired - baseline) * functionScale" (an earlier
 * version of this function did that, scaling only the RESPONSE-TO-ROTATION while leaving
 * resting output pinned at the normal baseline regardless of functionScale) -- that
 * models a pure gain deficit (can't respond to movement, but still tonically active at
 * rest), not a destructive lesion. A real acutely destroyed/silenced labyrinth doesn't
 * fire at all, even with the head stationary, which is exactly what makes ACUTE
 * UNCOMPENSATED unilateral vestibular loss clinically distinctive: with both labyrinths
 * normally firing ~equally at rest (so their difference, and hence eye position, sits at
 * zero), a canal permanently silenced to 0Hz creates a large, PERMANENT resting
 * imbalance the brainstem misreads as continuous rotation -- producing spontaneous
 * nystagmus even in a perfectly still patient, the hallmark sign this scaling is meant to
 * reproduce. Scaling the whole firing rate (not just its delta) is what makes that
 * resting imbalance appear at all; scaling only the delta cannot represent it, since
 * delta = 0 at rest regardless of functionScale.
 *
 * Deliberately a simple linear scalar per (canal, side), not an exhaustive pathology
 * taxonomy -- the shape is generic enough to extend later (partial hypofunction, gain
 * asymmetry) without redesign.
 */
export function scaleFiring(firedHz: number, functionScale: number): number {
  return firedHz * functionScale;
}

export function allCanalSides(): [CanalType, EarSide][] {
  const out: [CanalType, EarSide][] = [];
  for (const canal of ALL_CANAL_TYPES) {
    for (const side of ALL_EAR_SIDES) out.push([canal, side]);
  }
  return out;
}
