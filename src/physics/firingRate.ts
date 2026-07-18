import { AMPULLOFUGAL_IS_EXCITATORY, CanalType } from './canal';

export interface FiringRateParams {
  baselineHz: number;
  ceilingHz: number;
  gainHzPerRadS: number;
}

/**
 * Converts cupula deflection (ampullofugal-positive, see canal.ts's AMPULLOFUGAL_SIGN)
 * into an afferent nerve firing rate, applying Ewald's law polarity (AMPULLOFUGAL_IS_
 * EXCITATORY) and clamping to [0, ceilingHz].
 *
 * This floor/ceiling clamp is the SOLE source of Ewald's SECOND law asymmetry in this
 * engine (an excitatory stimulus can drive firing arbitrarily far above baseline, up to
 * the ceiling; an inhibitory stimulus of equal magnitude can only pull it down to zero,
 * i.e. by at most baselineHz) -- do not additionally apply a separate inhibitory-gain
 * fraction on top of this, that would double-count the same physiology.
 */
export function firingRate(cupulaDeflection: number, canal: CanalType, params: FiringRateParams): number {
  const polarity = AMPULLOFUGAL_IS_EXCITATORY[canal] ? 1 : -1;
  const drive = polarity * cupulaDeflection;
  const raw = params.baselineHz + params.gainHzPerRadS * drive;
  return Math.max(0, Math.min(params.ceilingHz, raw));
}
