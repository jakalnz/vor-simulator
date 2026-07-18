import { CanalType, EarSide } from '../physics/canal';
import { PerCanalSide } from '../physics/vorEngine';
import { FIRING_BASELINE_HZ } from '../physics/params';

/**
 * Outer gridline ring sits this many Hz above baseline -- matches canalScene.ts's
 * COLOR_SATURATION_HZ so both firing-rate visualizations in this app treat the same
 * delta-from-baseline as "clearly excited/inhibited," even though this plot's data
 * spokes are allowed to extend well past that ring for a stronger stimulus (see
 * MAX_RADIUS_SCALE), unlike a hard-clamped gauge.
 */
const OUTER_RING_SPAN_HZ = 60;
/** Cap on how far a data spoke can be drawn, as a multiple of the outer ring's own
 * radius -- keeps an extreme excitation (approaching FIRING_CEILING_HZ) on-canvas. */
const MAX_RADIUS_SCALE = 1.6;

interface HexVertex {
  canal: CanalType;
  side: EarSide;
  label: string;
  /** Degrees, 0 = screen-right, increasing counterclockwise (standard math convention). */
  angleDeg: number;
}

/**
 * Standard vestibular "mean gains" hexagon layout (LA/RA/RL/RP/LP/LL around the ring),
 * MIRRORED left<->right from the conventional clinical chart to match this app's
 * examiner-view convention already used for the ear/eye panels (index.html): the
 * subject's LEFT renders on the viewer's RIGHT. So LL (left lateral/horizontal) sits on
 * the right side of this plot, RL on the left, etc. -- a consistent mirror across the
 * whole app, not a one-off choice for this plot.
 */
const VERTICES: HexVertex[] = [
  { canal: 'horizontal', side: 'left', label: 'LL', angleDeg: 0 },
  { canal: 'anterior', side: 'left', label: 'LA', angleDeg: 60 },
  { canal: 'anterior', side: 'right', label: 'RA', angleDeg: 120 },
  { canal: 'horizontal', side: 'right', label: 'RL', angleDeg: 180 },
  { canal: 'posterior', side: 'right', label: 'RP', angleDeg: 240 },
  { canal: 'posterior', side: 'left', label: 'LP', angleDeg: 300 },
];

// Reuses the VNG trace's horizontal(red)/vertical(green) palette so a left/right split
// here doesn't introduce a third unrelated color convention into the app.
const COLOR_LEFT = '#e2534a';
const COLOR_RIGHT = '#4caf6b';

/**
 * Hexagonal "mean gains"-style plot of the 6 canals' current firing rates -- an
 * alternative to the 3D ear model view, showing all 6 canals' excitation/inhibition at a
 * glance rather than split across two ear panels. The inner hexagon is the resting
 * baseline (FIRING_BASELINE_HZ); a spoke shrinks toward the center as a canal is
 * inhibited (down to 0Hz at the very center) and extends outward, past the outer
 * reference hexagon, as it's excited.
 */
export class CanalHexPlot {
  private readonly ctx: CanvasRenderingContext2D;
  private rates: PerCanalSide<number> | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  setFiringRates(rates: PerCanalSide<number>): void {
    this.rates = rates;
  }

  render(): void {
    const canvas = this.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (width === 0 || height === 0) return;
    const ctx = this.ctx;

    // Reads the current theme fresh every frame (same pattern as vngTrace.ts) so a
    // mid-session theme toggle is reflected immediately -- these colors are drawn
    // directly onto the canvas, not CSS, so they don't otherwise pick up the toggle.
    const isLight = document.documentElement.dataset.theme === 'light';
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = isLight ? '#f3f4f6' : '#12151a';
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const outerRadius = Math.min(width, height) * 0.38;
    // Calibrated off the INNER ring (baseline, an exact known value) rather than the
    // outer ring, so the resting state always draws exactly on the inner hexagon
    // regardless of OUTER_RING_SPAN_HZ's own value.
    const innerRadius = outerRadius * (FIRING_BASELINE_HZ / (FIRING_BASELINE_HZ + OUTER_RING_SPAN_HZ));
    const pxPerHz = innerRadius / FIRING_BASELINE_HZ;

    const gridStrong = isLight ? 'rgba(0,0,0,0.32)' : 'rgba(255,255,255,0.35)';
    const gridWeak = isLight ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.16)';
    const labelColor = isLight ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.6)';

    const pointFor = (angleDeg: number, radius: number): [number, number] => {
      const rad = (angleDeg * Math.PI) / 180;
      // Canvas y grows downward, so subtract the sin term to keep "up" on screen matching
      // positive angles going counterclockwise in the usual math sense.
      return [cx + radius * Math.cos(rad), cy - radius * Math.sin(rad)];
    };

    const drawHexRing = (radius: number, color: string): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      VERTICES.forEach((v, i) => {
        const [x, y] = pointFor(v.angleDeg, radius);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    };

    drawHexRing(innerRadius, gridStrong);
    drawHexRing(outerRadius, gridWeak);

    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const v of VERTICES) {
      const [ox, oy] = pointFor(v.angleDeg, outerRadius);
      ctx.strokeStyle = gridWeak;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ox, oy);
      ctx.stroke();
      const [lx, ly] = pointFor(v.angleDeg, outerRadius + 16);
      ctx.fillStyle = labelColor;
      ctx.fillText(v.label, lx, ly);
    }

    if (this.rates) {
      const maxDrawRadius = outerRadius * MAX_RADIUS_SCALE;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      for (const v of VERTICES) {
        const hz = this.rates[v.canal][v.side];
        const radius = Math.max(0, Math.min(maxDrawRadius, hz * pxPerHz));
        const [x, y] = pointFor(v.angleDeg, radius);
        ctx.strokeStyle = v.side === 'left' ? COLOR_LEFT : COLOR_RIGHT;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }

    ctx.fillStyle = labelColor;
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
