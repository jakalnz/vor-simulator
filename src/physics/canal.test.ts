import { describe, it, expect } from 'vitest';
import { CANAL_PLANE_NORMAL, AMPULLOFUGAL_SIGN, ALL_CANAL_TYPES, ALL_EAR_SIDES } from './canal';
import { dot, norm } from './types';

describe('CANAL_PLANE_NORMAL', () => {
  it('is a unit vector for every canal/side', () => {
    for (const canal of ALL_CANAL_TYPES) {
      for (const side of ALL_EAR_SIDES) {
        expect(norm(CANAL_PLANE_NORMAL[canal][side])).toBeCloseTo(1, 5);
      }
    }
  });

  it('left and right horizontal canals are approximately coplanar with each other', () => {
    const cosAngle = Math.abs(dot(CANAL_PLANE_NORMAL.horizontal.left, CANAL_PLANE_NORMAL.horizontal.right));
    expect(cosAngle).toBeGreaterThan(0.99); // within a few degrees of coplanar
  });

  it('RALP pairing: right anterior is approximately coplanar with left posterior', () => {
    const cosAngle = Math.abs(dot(CANAL_PLANE_NORMAL.anterior.right, CANAL_PLANE_NORMAL.posterior.left));
    expect(cosAngle).toBeGreaterThan(0.9); // ~16.6 degrees off perfectly coplanar, see canal.ts's doc comment
  });

  it('LARP pairing: left anterior is approximately coplanar with right posterior', () => {
    const cosAngle = Math.abs(dot(CANAL_PLANE_NORMAL.anterior.left, CANAL_PLANE_NORMAL.posterior.right));
    expect(cosAngle).toBeGreaterThan(0.9);
  });
});

describe('AMPULLOFUGAL_SIGN', () => {
  it('flips sign between left and right ears for every canal type (mirror symmetry)', () => {
    for (const canal of ALL_CANAL_TYPES) {
      expect(AMPULLOFUGAL_SIGN[canal].left).toBe(-AMPULLOFUGAL_SIGN[canal].right);
    }
  });
});
