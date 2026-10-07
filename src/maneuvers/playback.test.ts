import { describe, it, expect } from 'vitest';
import { ManeuverPlayer } from './playback';
import { buildEpley } from './epley';
import { buildDixHallpike, dixHallpikeRight } from './dixHallpike';
import { buildBbqRoll } from './bbqRoll';
import { buildRollTest } from './rollTest';
import { buildSemont } from './semont';
import { buildZuma } from './zuma';

const ALL_MANEUVERS = (['left', 'right'] as const).flatMap((side) => [
  buildDixHallpike(side),
  buildEpley(side),
  buildBbqRoll(side),
  buildRollTest(side),
  buildSemont(side, false),
  buildSemont(side, true),
  buildZuma(side),
]);

describe('ManeuverPlayer chapters', () => {
  it('gives one chapter per movement, starting where that movement begins, with holds folded in', () => {
    const player = new ManeuverPlayer(buildEpley('right'));
    expect(player.chapters).toEqual([
      // The 2s head turn and the recline that follows are one stage (merged, < 3s apart).
      { t: 0, label: 'Head turned 45° right → Reclined to supine, head hanging (Dix-Hallpike)' },
      { t: 34, label: 'Head turned 45° to the other side, still supine' },
      { t: 67, label: 'Roll onto shoulder, face down' },
      { t: 100, label: 'Sit up' },
    ]);
  });

  it('chapters are at least 3s apart and within the maneuver, for every maneuver', () => {
    for (const maneuver of ALL_MANEUVERS) {
      const player = new ManeuverPlayer(maneuver);
      const ts = player.chapters.map((c) => c.t);
      expect(ts.length, maneuver.name).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(3);
      expect(Math.max(...ts)).toBeLessThan(player.duration);
    }
  });
});

describe('ManeuverPlayer currentLabel', () => {
  it('names the segment in progress, not the last waypoint passed', () => {
    const player = new ManeuverPlayer(dixHallpikeRight);
    player.scrubTo(0);
    expect(player.currentLabel).toBe('Seated upright');
    player.scrubTo(3); // reclining (t 2 -> 4)
    expect(player.currentLabel).toBe('Reclined to supine, head hanging');
    player.scrubTo(20); // in the 30s hold (t 4 -> 34)
    expect(player.currentLabel).toBe('Hold (observe nystagmus)');
    player.scrubTo(35); // sitting back up (t 34 -> 36)
    expect(player.currentLabel).toBe('Sit back up');
    player.scrubTo(player.duration);
    expect(player.currentLabel).toBe('Seated upright');
  });
});
