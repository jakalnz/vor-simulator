import { Maneuver } from './types';
import { Quat, quatSlerp } from '../physics/types';

/** Movements starting closer together than this are merged into one chapter -- see
 * ManeuverPlayer.chapters. Also keeps the scrub-bar stage markers from overlapping. */
const MIN_CHAPTER_GAP_S = 3;

/** Plays a Maneuver's waypoints back over time, slerping between bracketing quaternions. */
export class ManeuverPlayer {
  private elapsed = 0;
  private playing = false;

  constructor(private maneuver: Maneuver) {}

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  reset(): void {
    this.elapsed = 0;
  }

  scrubTo(t: number): void {
    this.elapsed = Math.max(0, Math.min(t, this.duration));
  }

  tick(dt: number): void {
    if (!this.playing) return;
    this.elapsed = Math.min(this.elapsed + dt, this.duration);
    if (this.elapsed >= this.duration) this.playing = false;
  }

  setManeuver(m: Maneuver): void {
    this.maneuver = m;
    this.elapsed = 0;
    this.playing = false;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get elapsedSeconds(): number {
    return this.elapsed;
  }

  get duration(): number {
    return this.maneuver.waypoints[this.maneuver.waypoints.length - 1].t;
  }

  get name(): string {
    return this.maneuver.name;
  }

  /**
   * A waypoint's label describes the SEGMENT that ends at it (the movement or hold
   * leading up to that pose -- e.g. Dix-Hallpike's "Hold (observe nystagmus)" sits on
   * the waypoint at the END of the 30s hold). So the current label is the next labelled
   * waypoint's, not the last-passed one's: the earlier last-passed version ran one stage
   * behind (showing "Hold" while the patient was actually sitting up). Before playback
   * starts, the first waypoint's label describes the starting pose.
   */
  get currentLabel(): string {
    const wps = this.maneuver.waypoints;
    if (this.elapsed <= wps[0].t) return wps[0].label ?? '';
    for (const wp of wps) {
      if (wp.t > this.elapsed && wp.label) return wp.label;
    }
    return wps[wps.length - 1].label ?? '';
  }

  /**
   * Stage start times for chapter navigation: one per labelled movement, starting where
   * that movement begins (the previous labelled waypoint's time). "Hold" segments aren't
   * chapters of their own -- they're folded into the movement before them, so each
   * chapter shows one repositioning followed by its hold. Movements that follow each
   * other within MIN_CHAPTER_GAP_S are one stage (e.g. the 45° head turn and the recline
   * that together make the Dix-Hallpike position), labelled "first → second".
   */
  get chapters(): { t: number; label: string }[] {
    const wps = this.maneuver.waypoints;
    const chapters: { t: number; label: string }[] = [];
    let segmentStart = wps[0].t;
    for (let i = 1; i < wps.length; i++) {
      const label = wps[i].label;
      if (!label) continue;
      if (!/^hold\b/i.test(label)) {
        const previous = chapters[chapters.length - 1];
        if (previous && segmentStart - previous.t < MIN_CHAPTER_GAP_S) previous.label += ` → ${label}`;
        else chapters.push({ t: segmentStart, label });
      }
      segmentStart = wps[i].t;
    }
    return chapters;
  }

  isFinished(): boolean {
    return this.elapsed >= this.duration;
  }

  currentOrientation(): Quat {
    const wps = this.maneuver.waypoints;
    if (this.elapsed <= wps[0].t) return wps[0].quat;
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i];
      const b = wps[i + 1];
      if (this.elapsed >= a.t && this.elapsed <= b.t) {
        const span = b.t - a.t;
        const t = span <= 0 ? 1 : (this.elapsed - a.t) / span;
        return quatSlerp(a.quat, b.quat, t);
      }
    }
    return wps[wps.length - 1].quat;
  }
}
