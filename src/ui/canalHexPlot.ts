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

// Same excitation/inhibition palette as canalScene.ts's 3D ear model (COLOR_REST/
// COLOR_EXCITED/COLOR_INHIBITED there) -- deliberately NOT a left/right color split (an
// earlier version used red=left/green=right), since which side a spoke belongs to is
// already unambiguous from its label/position, while excitation state is the thing a
// student actually needs a color cue for, and having the SAME two views encode the same
// state in the same colors (rather than one red/green-by-side, the other red/blue-by-
// state) was confusing across the two canal-panel views.
const REST_RGB: [number, number, number] = [154, 163, 171]; // 0x9aa3ab
const EXCITED_RGB: [number, number, number] = [224, 27, 36]; // 0xe01b24
const INHIBITED_RGB: [number, number, number] = [26, 95, 180]; // 0x1a5fb4

function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

/**
 * Colors a single canal's spoke by how far its firing rate has moved from baseline --
 * grey at rest, lerping to red as it excites, to blue as it's inhibited, saturating at
 * OUTER_RING_SPAN_HZ (same scale the outer reference ring itself is drawn at, so a spoke
 * reaching full color exactly coincides with it reaching the outer ring visually).
 */
function colorForHz(hz: number): string {
  const t = Math.max(-1, Math.min(1, (hz - FIRING_BASELINE_HZ) / OUTER_RING_SPAN_HZ));
  return t >= 0 ? lerpRgb(REST_RGB, EXCITED_RGB, t) : lerpRgb(REST_RGB, INHIBITED_RGB, -t);
}

/**
 * App's own --accent (see styles.css), hardcoded here since canvas 2D drawing can't read
 * CSS custom properties directly (same reasoning as this file's isLight-branched grid/
 * label colors above). Used for the resultant paired-difference vectors below -- a
 * deliberately distinct color from the red/grey/blue excite/inhibit spokes, since these
 * vectors represent a different kind of quantity (a COMBINED signal, not one canal's own
 * activity).
 */
const COLOR_ACCENT_DARK = '#d9a441';
const COLOR_ACCENT_LIGHT = '#b8791f';

interface PairAxis {
  label: string;
  vertexA: HexVertex;
  vertexB: HexVertex;
}

/**
 * The three anatomically real push-pull canal pairs, each one a straight line through the
 * hexagon's center: horizontal L/R are coplanar with each other, LARP is left-anterior
 * paired with right-posterior, RALP is right-anterior paired with left-posterior (see
 * physics/canal.test.ts's coplanarity assertions -- this is not a visualization
 * convenience, it's the real anatomical pairing this app's VOR engine already sums over).
 * Built from VERTICES' own indices (each pair is exactly 180 degrees apart in that array)
 * rather than a second hand-written angle table, so this can never drift out of sync with
 * the spoke layout above.
 */
const PAIR_AXES: PairAxis[] = [
  { label: 'Horiz', vertexA: VERTICES[0], vertexB: VERTICES[3] }, // LL / RL
  { label: 'LARP', vertexA: VERTICES[1], vertexB: VERTICES[4] }, // LA / RP
  { label: 'RALP', vertexA: VERTICES[2], vertexB: VERTICES[5] }, // RA / LP
];

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

      /**
       * Draws one paired-canal RESULTANT vector: an arrow from the plot's center along a
       * pair's own axis, pointing toward whichever of its two canals currently fires
       * MORE (the side "winning" the push-pull comparison), with length proportional to
       * the Hz DIFFERENCE between them -- the actual combined signal reaching the
       * brainstem, not either canal's own activity alone (see PAIR_AXES' doc comment).
       * Drawn UNDER the per-canal spokes below (called first), so the individual spokes
       * -- what a student reads first -- stay visually primary; this is a secondary,
       * distinctly-colored layer explaining how those spokes combine.
       */
      const drawPairVector = (angleDeg: number, radius: number, color: string, label: string): void => {
        if (radius < 2) return; // nothing meaningful to draw at (near-)zero difference
        const [x, y] = pointFor(angleDeg, radius);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.stroke();

        // Small triangular arrowhead at the tip, oriented along the vector's own
        // direction -- matches pointFor's own (x: +cos, y: -sin) convention.
        const rad = (angleDeg * Math.PI) / 180;
        const headLength = 9;
        const headWidth = 7;
        const dirX = Math.cos(rad);
        const dirY = -Math.sin(rad);
        const perpX = -dirY;
        const perpY = dirX;
        const baseX = x - dirX * headLength;
        const baseY = y - dirY * headLength;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(baseX + perpX * (headWidth / 2), baseY + perpY * (headWidth / 2));
        ctx.lineTo(baseX - perpX * (headWidth / 2), baseY - perpY * (headWidth / 2));
        ctx.closePath();
        ctx.fill();

        const [lx, ly] = pointFor(angleDeg, radius + 12);
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, lx, ly);
      };

      const accentColor = isLight ? COLOR_ACCENT_LIGHT : COLOR_ACCENT_DARK;
      for (const pair of PAIR_AXES) {
        const hzA = this.rates[pair.vertexA.canal][pair.vertexA.side];
        const hzB = this.rates[pair.vertexB.canal][pair.vertexB.side];
        const net = hzA - hzB;
        const angle = net >= 0 ? pair.vertexA.angleDeg : pair.vertexB.angleDeg;
        const radius = Math.max(0, Math.min(maxDrawRadius, Math.abs(net) * pxPerHz));
        drawPairVector(angle, radius, accentColor, pair.label);
      }

      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      for (const v of VERTICES) {
        const hz = this.rates[v.canal][v.side];
        const radius = Math.max(0, Math.min(maxDrawRadius, hz * pxPerHz));
        const [x, y] = pointFor(v.angleDeg, radius);
        ctx.strokeStyle = colorForHz(hz);
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
