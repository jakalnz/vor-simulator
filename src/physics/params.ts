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
 * model's tau). Literature reports anywhere from ~4-20s depending on canal/source; this
 * app's own BPPV debris model was already tuned and tested at 4.0s (as opposed to
 * claude.MD's illustrative ~6s) -- kept here rather than silently switched, since 4.0s is
 * already a real, defensible literature value and there's no strong reason yet to prefer
 * 6s specifically. Revisit during empirical tuning if the resulting nystagmus decay reads
 * as too fast/slow.
 */
export const TAU_CUPULA = 4.0;

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
 * doesn't model at that level of detail) -- picked so a brisk head turn (~1.5 rad/s,
 * ~86 deg/s) drives a canal's steady-state firing rate up by roughly 100+ Hz (comfortably
 * within [0, FIRING_CEILING_HZ] without saturating for ordinary head movements, but large
 * enough to read as a clear excitation/inhibition signal). Flagged for empirical tuning.
 */
export const FIRING_GAIN_HZ_PER_RAD_S = 20;

/**
 * Converts summed canal firing-rate delta (Hz, see physics/vorEngine.ts) into eye
 * angular velocity (rad/s). Picked jointly with FIRING_GAIN_HZ_PER_RAD_S and TAU_CUPULA
 * so that a brisk yaw (~1.5 rad/s) produces a horizontal slow-phase eye velocity roughly
 * matching the head's own velocity (target VOR gain ~0.9-1.0) -- see the worked estimate
 * in this constant's commit/derivation notes. Flagged for empirical tuning once the
 * engine can be exercised in a real browser with a real gyroscope.
 */
export const GAIN_VOR_FIRING = 0.006;

/** Eye deviation (radians) beyond which a quick-phase (fast corrective saccade) fires. */
export const QUICK_PHASE_THRESHOLD = 0.35;

/** Amount (radians) the quick phase resets the eye back toward center. */
export const QUICK_PHASE_RESET_AMOUNT = 0.3;
