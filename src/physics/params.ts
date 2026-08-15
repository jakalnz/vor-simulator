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

/**
 * Cupulolithiasis (otoconia debris adherent directly to the cupula) cupula-flow gain,
 * applied to dot(gHead, ductTangent(canal, side, 0)) -- i.e. gravity's component along the
 * ampullofugal tangent AT the cupula (see cupulolith.ts). Unlike canalithiasis this flow
 * never zeroes out on its own (there's no arc position to clear), so a sustained tilt
 * produces a sustained (non-fatiguing) cupula deflection via updateCupula's normal
 * steady-state (beta_ss = flow * tau) -- the clinically-correct persistent-positional-
 * nystagmus behavior falls out of the existing Steinhausen filter with no extra decay
 * logic. Chosen so full gravity alignment (dot=1) produces a deflection comparable in
 * magnitude to canalithiasis's DEBRIS_FLOW_GAIN_PER_M_S * DEBRIS_MOBILITY_M_PER_S at its
 * own full-alignment dsdt, so the two pathologies read as comparably "visible" in the
 * firing-rate/eye-movement display. Flagged for empirical tuning once exercised live.
 */
export const CUPULOLITH_FLOW_GAIN = 1.5;

/**
 * Angular speed (rad/s) |omegaBody| must sustain, cumulatively for JOLT_SUSTAIN_SECONDS
 * (see that constant's own doc comment), to register as a genuine detachment-triggering
 * "jolt" during a
 * liberatory maneuver (Semont liberatory / Zuma) -- see cupulolith.ts's doc comment for
 * why a raw frame-to-frame acceleration spike can't be used (ManeuverPlayer's linear
 * slerp between waypoints makes velocity piecewise-constant, so acceleration spikes at
 * every waypoint boundary regardless of how brisk that segment actually is). A brisk
 * clinical head/body swing is on the order of several rad/s; this threshold is set well
 * below that so a genuine liberatory swing clears it comfortably while an ordinary slow
 * repositioning move (or a "Hold" step) does not. Flagged for empirical tuning once
 * exercised live against maneuvers/semont.ts and maneuvers/zuma.ts.
 */
export const JOLT_SPEED_THRESHOLD_RAD_S = 1.2;

/**
 * Accumulated real seconds (NOT physics ticks) that |omegaBody| must have stayed above
 * JOLT_SPEED_THRESHOLD_RAD_S -- via cupulolith.ts's leaky-bucket jitterSeconds
 * accumulator -- before a cupulolithiasis lesion detaches. Deliberately NOT a consecutive-
 * tick count: real device `deviceorientation` events arrive well below the 120Hz physics
 * tick rate (see main.ts's stepPhysicsOnce), so between samples the orientation (and
 * hence omegaBody) is momentarily flat/zero even during a genuinely fast, sustained real
 * swing -- a consecutive-tick counter resets to 0 on every one of those in-between ticks
 * and can then NEVER reach a multi-tick streak, confirmed empirically (a full 180deg/s,
 * 1-second swing sampled at a realistic ~20Hz gyro rate produced a maximum consecutive
 * streak of exactly 1 tick, regardless of how long the swing was sustained -- this was
 * the reported live bug: cupulolithiasis wouldn't detach in gyro mode, or even reliably
 * in scripted maneuver mode). The leaky-bucket accumulator instead ADDS each sample's own
 * real-time span (velocityDt, capped per-sample by JOLT_MAX_SAMPLE_CONTRIBUTION_S -- see
 * its own doc comment for why an UNcapped span reintroduces essentially the same bug from
 * the other direction, a single anomalously long sample satisfying the whole requirement
 * on its own) while above threshold, and DECAYS (rather than hard-resets) otherwise, so
 * several genuine high-speed samples spread across sparse polling still sum to a real
 * sustained duration. 0.15s is comfortably inside a single brisk maneuver swing
 * (~1s) or handshake gesture, while being long enough that isolated single-sample spikes
 * (even after JOLT_MIN_VELOCITY_DT_S's floor and JOLT_MAX_SAMPLE_CONTRIBUTION_S's ceiling)
 * can't trigger it alone.
 */
export const JOLT_SUSTAIN_SECONDS = 0.15;

/** Exponential decay time constant (seconds) for cupulolith.ts's jitterSeconds
 * leaky-bucket accumulator during ticks where |omegaBody| is below
 * JOLT_SPEED_THRESHOLD_RAD_S -- long enough that the gaps between real gyro samples
 * (tens of ms, see JOLT_SUSTAIN_SECONDS's doc comment) don't erase progress from a
 * genuinely sustained swing, short enough that idly holding the head still for longer
 * than that eventually lets any transient spike decay away rather than accumulating
 * indefinitely. */
export const JOLT_LEAK_TAU_S = 0.4;

/**
 * Ceiling (seconds) on how much a SINGLE tick can add to cupulolith.ts's jitterSeconds
 * leaky-bucket accumulator, regardless of that tick's own velocityDt. Without this, one
 * anomalously large velocityDt sample -- e.g. a real clock gap after the gyro was
 * paused/backgrounded and then resumed, or the tab regaining focus, both of which report
 * a large genuine elapsed time between orientation samples -- could single-handedly
 * satisfy the entire JOLT_SUSTAIN_SECONDS requirement in one tick, detaching the lesion
 * instantly with no actual sustained fast motion (confirmed live: cupulolithiasis
 * detached immediately, before the clot marker had moved at all). Capped at roughly the
 * per-sample span implied by JOLT_SUSTAIN_SECONDS's own realistic ~20Hz polling
 * assumption, so genuine detachment still requires several separate above-threshold
 * samples, never just one unusually long one.
 */
export const JOLT_MAX_SAMPLE_CONTRIBUTION_S = 0.05;

/**
 * Floor (seconds) on a physics tick's velocityDt (see main.ts's stepPhysicsOnce) below
 * which that tick's |omegaBody| is treated as an unreliable sample and excluded from the
 * JOLT_SUSTAIN_TICKS count, rather than as genuine fast motion. Real device
 * `deviceorientation` events can arrive with noisy/quantized inter-sample timestamps;
 * dividing a small orientation delta by an underestimated elapsed time can otherwise
 * produce a spuriously huge instantaneous angular speed from ordinary sensor jitter while
 * the head is nearly still. Set below the fixed 1/120s physics tick (so it never rejects
 * ticks driven by mouse-drag or scripted maneuver playback, both of which reuse dt itself
 * as velocityDt -- see stepPhysicsOnce) but above the kind of sub-millisecond timestamp
 * quantization glitches observed on real phone gyros.
 */
export const JOLT_MIN_VELOCITY_DT_S = 0.002;
