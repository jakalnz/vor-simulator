import { PerCanalSide } from '../physics/vorEngine';
import {
  COLOR_ACCENT_DARK,
  COLOR_ACCENT_LIGHT,
  OUTER_RING_SPAN_HZ,
  PAIR_AXES,
} from './canalHexPlot';

/** Bar fills its full half-width at this many Hz of pair difference, past which it just
 * clamps -- same span the hex plot's outer ring (and its resultant vectors) saturate at,
 * so "full bar" here means the same stimulus strength as "spoke reaches the outer ring"
 * there. */
const FULL_SCALE_HZ = OUTER_RING_SPAN_HZ;

/**
 * Three horizontal bar meters, one per anatomical canal pair (Horiz/LARP/RALP), each
 * showing the signed Hz difference between that pair's two canals -- the actual combined
 * push-pull signal reaching the brainstem (see PAIR_AXES in canalHexPlot.ts, the single
 * source of truth for which canals pair up). Drawn as a companion to the hex plot's own,
 * more subtle resultant-vector arrows: this panel makes the SAME numbers the primary
 * focus, at a glance, without having to read spoke lengths against each other. Also makes
 * Ewald's-law sensitivity-doubling legible: because one canal's excitation and its
 * partner's inhibition move in opposite Hz directions, the pair DIFFERENCE swings roughly
 * twice as far as either canal's own deviation from baseline alone.
 */
export class CanalDiffMeters {
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

    const isLight = document.documentElement.dataset.theme === 'light';
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = isLight ? '#f3f4f6' : '#12151a';
    ctx.fillRect(0, 0, width, height);

    const accentColor = isLight ? COLOR_ACCENT_LIGHT : COLOR_ACCENT_DARK;
    const gridColor = isLight ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.2)';
    const labelColor = isLight ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.75)';

    const rowCount = PAIR_AXES.length;
    const rowHeight = height / rowCount;
    const labelWidth = 52;
    const valueWidth = 56;
    const trackLeft = labelWidth;
    const trackRight = width - valueWidth;
    const trackWidth = Math.max(0, trackRight - trackLeft);
    const trackCenter = trackLeft + trackWidth / 2;
    const halfTrack = trackWidth / 2;
    const barThickness = Math.min(18, rowHeight * 0.4);

    ctx.font = '12px sans-serif';
    ctx.textBaseline = 'middle';

    PAIR_AXES.forEach((pair, i) => {
      const rowCy = rowHeight * i + rowHeight / 2;

      ctx.textAlign = 'left';
      ctx.fillStyle = labelColor;
      ctx.fillText(pair.label, 4, rowCy);

      // Center zero-line for this row's track.
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(trackLeft, rowCy);
      ctx.lineTo(trackRight, rowCy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(trackCenter, rowCy - rowHeight * 0.3);
      ctx.lineTo(trackCenter, rowCy + rowHeight * 0.3);
      ctx.stroke();

      if (!this.rates) return;

      const hzA = this.rates[pair.vertexA.canal][pair.vertexA.side];
      const hzB = this.rates[pair.vertexB.canal][pair.vertexB.side];
      // Sign convention matches canalHexPlot.ts's drawPairVector: positive means
      // vertexA's side is firing more (excited relative to its partner).
      const net = hzA - hzB;
      const t = Math.max(-1, Math.min(1, net / FULL_SCALE_HZ));
      const barLen = Math.abs(t) * halfTrack;

      ctx.fillStyle = accentColor;
      const barTop = rowCy - barThickness / 2;
      if (t >= 0) {
        ctx.fillRect(trackCenter, barTop, barLen, barThickness);
      } else {
        ctx.fillRect(trackCenter - barLen, barTop, barLen, barThickness);
      }

      ctx.textAlign = 'right';
      ctx.fillStyle = labelColor;
      const sign = net > 0 ? '+' : net < 0 ? '−' : '';
      ctx.fillText(`${sign}${Math.abs(net).toFixed(0)} Hz`, width - 4, rowCy);
    });
  }
}
