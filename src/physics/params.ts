/**
 * VOR engine tuning constants. Unlike the BPPV-debris-paroxysm constants this file
 * previously held (tuned against a specific clinical timing picture), there is no
 * existing clinical dataset to anchor a head-velocity-driven VOR gain against directly --
 * these are reasonable starting values (see each constant's own derivation), expected to
 * need empirical tuning once the engine can be exercised in the browser (see
 * physics/vorEngine.ts's manual verification plan: moderate yaw should produce a
 * horizontal slow-phase velocity in the same ballpark as the head's own velocity, VOR
 * gain roughly 0.9-1.0).
 */

/**
 * Cupula relaxation time constant, seconds (the Steinhausen damped-torsion-pendulum
 * model's tau) -- this engine's single-pole cupula filter (dbeta/dt = flow - beta/tau)
 * uses ONE time constant for BOTH the eye's response ONSET and its decay, since it
 * collapses the canal's real two-pole mechanics (a very fast, imperceptible ~3-6ms pole
 * plus a slow ~4-20s adaptation pole) into a single pole.
 *
 * Originally set to 4.0s (matching this app's earlier BPPV debris model, and within the
 * literature's long-time-constant range) -- but for THIS engine, that same 4.0s also
 * governs the ONSET, meaning the eye only reaches a meaningful fraction of its response
 * roughly one tau (4 seconds) after a head movement starts. In reality the onset is
 * governed by the canal's fast pole (effectively instantaneous for a human-scale head
 * movement) -- a real VOR eye response tracks head velocity within tens of milliseconds,
 * not seconds. Reported (by a live user testing mouse-drag input) as the eye visibly
 * lagging behind the head rather than moving with it -- confirming the single-pole
 * onset-lag problem is not just theoretical.
 *
 * Lowered to 0.3s so the ONSET reads as near-immediate for interactive use, at the cost
 * of also shortening the DECAY (a real nystagmus's multi-second "build and fade" is
 * compressed into under a second here) -- an explicit tradeoff, not a free fix: this
 * single-pole model cannot have a fast onset and a slow decay simultaneously. Revisit
 * with a genuine two-pole cupula model if the compressed decay becomes its own complaint.
 * FIRING_GAIN_HZ_PER_RAD_S and GAIN_VOR_FIRING were rescaled together with this change to
 * preserve the same steady-state response magnitude (beta_ss = flow * tau shrinks
 * proportionally to tau, so the downstream gains were scaled up to compensate).
 */
export const TAU_CUPULA = 0.3;

/**
 * Neural firing baseline (Hz), the resting discharge rate of a vestibular afferent with
 * no head movement. Standard textbook figure (~90-100 spikes/sec).
 */
export const FIRING_BASELINE_HZ = 90;

/** Ceiling firing rate (Hz) -- afferents can increase discharge well above baseline but
 * not without bound in practice; a generous but finite ceiling, per claude.MD's spec. */
export const FIRING_CEILING_HZ = 400;

/**
 * Firing-rate gain, Hz per (rad/s) of canal-axis-projected head angular velocity. No
 * literature-anchored constant exists for this (it depends on cupula mechanics this app
 * doesn't model at that level of detail). Rescaled alongside TAU_CUPULA's 4.0s -> 0.3s
 * drop (see that constant's doc comment): steady-state firing delta is proportional to
 * gainHzPerRadS * tau, so shrinking tau ~13x means this had to grow by a similar factor
 * to keep a brisk head turn (~1.5 rad/s) producing a comparable, clearly-visible
 * excitation/inhibition swing (tens of Hz) without saturating the ceiling for ordinary
 * movements. Flagged for empirical tuning.
 */
export const FIRING_GAIN_HZ_PER_RAD_S = 150;

/**
 * Converts summed canal firing-rate delta (Hz, see physics/vorEngine.ts) into eye
 * angular velocity (rad/s). Rescaled alongside TAU_CUPULA/FIRING_GAIN_HZ_PER_RAD_S so
 * that a brisk yaw (~1.5 rad/s) still produces a horizontal slow-phase eye velocity
 * roughly matching the head's own velocity (target VOR gain ~0.9-1.0), now with the eye
 * reacting promptly instead of ramping up over seconds. Flagged for empirical tuning once
 * the engine can be exercised with a real gyroscope.
 */
export const GAIN_VOR_FIRING = 0.011;

/** Eye deviation (radians) beyond which a quick-phase (fast corrective saccade) fires. */
export const QUICK_PHASE_THRESHOLD = 0.35;

/** Amount (radians) the quick phase resets the eye back toward center. */
export const QUICK_PHASE_RESET_AMOUNT = 0.3;

/**
 * World-frame gravity direction (unit vector, HeadFrame axis convention: +X anterior, +Y
 * left, +Z superior), i.e. gravity points toward the world's -Z ("down") when the head is
 * upright/neutral (qHead = identity). Magnitude is irrelevant here -- only direction is
 * used (physics/canalith.ts projects it onto a canal tangent, then scales by
 * DEBRIS_MOBILITY_M_PER_S), so this is left as a unit vector rather than 9.81 m/s^2.
 */
export const G_WORLD = [0, 0, -1] as const;

/**
 * Canalithiasis (free-floating otoconia debris) idealized overdamped Stokes-drag arc
 * velocity, meters/sec, at full gravity alignment with the duct tangent (dot=1). No
 * inertia lag or latency gating in this minimal-slice model (see canalith.ts) -- an
 * empirical starting value chosen so debris traverses a typical few-millimeter duct
 * (sMax, see canalith.ts) in a few seconds of sustained tilt, legible for interactive
 * teaching use. Flagged for empirical tuning once exercised live.
 */
export const DEBRIS_MOBILITY_M_PER_S = 0.0025;

/**
 * Converts debris arc-velocity (m/s, see canalith.ts's dsdt) into a cupula flow
 * contribution in the same units/scale as the head-velocity-driven flow term
 * (AMPULLOFUGAL_SIGN * dot(headAngularVelocityBody, n), order rad/s) so both can be summed
 * before entering updateCupula. Chosen so a debris arc-velocity near
 * DEBRIS_MOBILITY_M_PER_S produces a flow magnitude comparable to a brisk head rotation's
 * (roughly 1-1.5 rad/s) -- an empirical starting value, not literature-derived (the old
 * app's analogous KAPPA_FLOW/CUPULA_GRAVITY_GAIN constants were tuned against a different,
 * now-removed linear beta->eye-angle mapping and don't carry over numerically). Flagged
 * for empirical tuning once exercised live.
 */
export const DEBRIS_FLOW_GAIN_PER_M_S = 600;
