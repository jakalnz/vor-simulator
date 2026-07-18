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
 * Scales a canal's contribution to the firing-rate DELTA (fired - baseline) by
 * functionScale -- functionScale=0 means this canal contributes nothing beyond its own
 * baseline (simulating complete unilateral loss), functionScale=1 is normal. Deliberately
 * a simple linear scalar per (canal, side), not an exhaustive pathology taxonomy -- the
 * shape is generic enough to extend later (partial hypofunction, gain asymmetry) without
 * redesign.
 */
export function scaleFiringDelta(baselineHz: number, firedHz: number, functionScale: number): number {
  return baselineHz + (firedHz - baselineHz) * functionScale;
}

export function allCanalSides(): [CanalType, EarSide][] {
  const out: [CanalType, EarSide][] = [];
  for (const canal of ALL_CANAL_TYPES) {
    for (const side of ALL_EAR_SIDES) out.push([canal, side]);
  }
  return out;
}
