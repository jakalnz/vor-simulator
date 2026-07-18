import { describe, it, expect } from 'vitest';
import { firingRate, FiringRateParams } from './firingRate';

const PARAMS: FiringRateParams = { baselineHz: 90, ceilingHz: 400, gainHzPerRadS: 20 };

describe('firingRate', () => {
  it('returns baseline at zero cupula deflection', () => {
    expect(firingRate(0, 'horizontal', PARAMS)).toBeCloseTo(90);
    expect(firingRate(0, 'posterior', PARAMS)).toBeCloseTo(90);
    expect(firingRate(0, 'anterior', PARAMS)).toBeCloseTo(90);
  });

  it('floors at 0Hz for a large inhibitory deflection', () => {
    expect(firingRate(-1000, 'posterior', PARAMS)).toBe(0);
  });

  it('ceilings at ceilingHz for a large excitatory deflection', () => {
    expect(firingRate(1000, 'posterior', PARAMS)).toBe(400);
  });

  it('applies opposite polarity for horizontal vs vertical canals (Ewald)', () => {
    // Ampullofugal-positive deflection is EXCITATORY for posterior/anterior, INHIBITORY for horizontal.
    expect(firingRate(1, 'posterior', PARAMS)).toBeGreaterThan(90);
    expect(firingRate(1, 'anterior', PARAMS)).toBeGreaterThan(90);
    expect(firingRate(1, 'horizontal', PARAMS)).toBeLessThan(90);
  });

  it("Ewald's second law: a large inhibitory drive is bounded by the 0Hz floor, an equal-magnitude excitatory drive is not", () => {
    const excited = firingRate(10, 'posterior', PARAMS) - 90;
    const inhibited = 90 - firingRate(-10, 'posterior', PARAMS);
    expect(inhibited).toBeLessThan(excited);
  });
});
