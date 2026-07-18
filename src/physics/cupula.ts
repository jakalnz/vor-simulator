/**
 * Cupula deflection update: driven by endolymph flow, relaxing back toward neutral with
 * time constant tau (the Steinhausen damped-torsion-pendulum model). Semi-implicit
 * (backward Euler on the decay term) so it stays stable for any dt:
 *   beta_new = (beta_old + flow * dt) / (1 + dt / tau)
 * tau is a parameter (not a hard-coded constant) so the same tested primitive can serve
 * different callers -- currently the head-velocity-driven VOR engine (see vorEngine.ts,
 * physics/params.ts's TAU_CUPULA), previously (and potentially again, for a future
 * debris-physics rebuild) driven by clot arc-velocity instead.
 */
export function updateCupula(beta: number, flow: number, dt: number, tau: number): number {
  const driven = beta + flow * dt;
  return driven / (1 + dt / tau);
}

/** Relaxation with no driving flow. */
export function relaxOnly(beta: number, dt: number, tau: number): number {
  return updateCupula(beta, 0, dt, tau);
}
