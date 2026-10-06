import { edgeTable, triTable } from 'three/examples/jsm/objects/MarchingCubes.js';

/**
 * Offline mesh helpers for build.mjs: Taubin smoothing (removes the MRI-segmentation
 * lumpiness without shrinking the slender duct tubes the way plain Laplacian smoothing
 * would), and the "unified skin" -- one seamless surface over the whole membranous
 * labyrinth, made by voxelizing the union of every piece, blurring, and re-meshing with
 * marching cubes. Settings were chosen interactively in the Labyrinth Model Lab
 * playground (smooth 12 passes for the pieces, 10 for the skin/envelope housing).
 */

function adjacency(indices, vertexCount) {
  const sets = Array.from({ length: vertexCount }, () => new Set());
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    sets[a].add(b).add(c);
    sets[b].add(a).add(c);
    sets[c].add(a).add(b);
  }
  return sets.map((s) => [...s]);
}

/** Taubin lambda/mu smoothing -- each pass is a shrink step (lambda) followed by an
 * inflate step (mu), so the surface smooths without the net volume loss that would
 * thin the ~0.3mm ducts. Returns a new Float32Array; the input is left untouched. */
export function taubinSmooth(points, indices, passes, lambda = 0.5, mu = -0.53) {
  let a = Float32Array.from(points);
  if (!passes) return a;
  const n = a.length / 3;
  const adj = adjacency(indices, n);
  let b = new Float32Array(a.length);
  for (let p = 0; p < passes * 2; p++) {
    const f = p % 2 === 0 ? lambda : mu;
    for (let i = 0; i < n; i++) {
      const nb = adj[i];
      if (nb.length === 0) {
        b[3 * i] = a[3 * i];
        b[3 * i + 1] = a[3 * i + 1];
        b[3 * i + 2] = a[3 * i + 2];
        continue;
      }
      let x = 0, y = 0, z = 0;
      for (const v of nb) {
        x += a[3 * v];
        y += a[3 * v + 1];
        z += a[3 * v + 2];
      }
      const k = 1 / nb.length;
      for (let d = 0; d < 3; d++) {
        const avg = (d === 0 ? x : d === 1 ? y : z) * k;
        b[3 * i + d] = a[3 * i + d] + f * (avg - a[3 * i + d]);
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

/**
 * Unified skin over a set of CLOSED meshes (all IEMap pieces are closed surfaces):
 * x-ray parity fill of each mesh into a shared voxel grid (OR'd together = the union),
 * Gaussian blur (fuses the small seams between pieces -- e.g. the ~0.09mm utricle-saccule
 * gap -- and softens voxel stairs), then marching cubes at the 0.5 iso level.
 *
 * `voxel` and the returned points are in the SAME units as the input meshes.
 */
export function unifiedSkin(meshes, voxel, blurSigmaVoxels) {
  const H = voxel;
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const { points } of meshes)
    for (let i = 0; i < points.length; i += 3)
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], points[i + k]);
        mx[k] = Math.max(mx[k], points[i + k]);
      }
  for (let k = 0; k < 3; k++) {
    mn[k] -= 6 * H;
    mx[k] += 6 * H;
  }
  const [NX, NY, NZ] = mn.map((v, k) => Math.ceil((mx[k] - v) / H) + 1);
  const idx3 = (x, y, z) => x + NX * (y + NY * z);
  const occ = new Float32Array(NX * NY * NZ);

  for (const { points: p, indices: t } of meshes) {
    const cols = new Map();
    for (let f = 0; f < t.length; f += 3) {
      const [a, b, c] = [t[f] * 3, t[f + 1] * 3, t[f + 2] * 3];
      const ax = (p[a] - mn[0]) / H, ay = (p[a + 1] - mn[1]) / H, az = (p[a + 2] - mn[2]) / H;
      const bx = (p[b] - mn[0]) / H, by = (p[b + 1] - mn[1]) / H, bz = (p[b + 2] - mn[2]) / H;
      const cx = (p[c] - mn[0]) / H, cy = (p[c + 1] - mn[1]) / H, cz = (p[c + 2] - mn[2]) / H;
      const det = (by - ay) * (cz - az) - (cy - ay) * (bz - az);
      if (Math.abs(det) < 1e-12) continue;
      for (let y = Math.ceil(Math.min(ay, by, cy)); y <= Math.floor(Math.max(ay, by, cy)); y++)
        for (let z = Math.ceil(Math.min(az, bz, cz)); z <= Math.floor(Math.max(az, bz, cz)); z++) {
          // Tiny jitter keeps rays off exact edges/vertices, where parity would double-count.
          const py = y + 1e-4, pz = z + 2e-4;
          const u = ((py - ay) * (cz - az) - (cy - ay) * (pz - az)) / det;
          const v = ((by - ay) * (pz - az) - (py - ay) * (bz - az)) / det;
          if (u < 0 || v < 0 || u + v > 1) continue;
          const key = y * NZ + z;
          if (!cols.has(key)) cols.set(key, []);
          cols.get(key).push(ax + u * (bx - ax) + v * (cx - ax));
        }
    }
    for (const [key, xs] of cols) {
      xs.sort((m, n) => m - n);
      const y = Math.floor(key / NZ), z = key % NZ;
      for (let i = 0; i + 1 < xs.length; i += 2)
        for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) occ[idx3(x, y, z)] = 1;
    }
  }

  const field = gaussianBlur3d(occ, [NX, NY, NZ], blurSigmaVoxels);

  const verts = [];
  const tris = [];
  const edgeVert = new Map();
  const corner = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const vals = new Float32Array(8);
  const ev = new Int32Array(12);
  const ISO = 0.5;
  for (let z = 0; z < NZ - 1; z++)
    for (let y = 0; y < NY - 1; y++)
      for (let x = 0; x < NX - 1; x++) {
        let ci = 0;
        for (let c = 0; c < 8; c++) {
          vals[c] = field[idx3(x + corner[c][0], y + corner[c][1], z + corner[c][2])];
          if (vals[c] < ISO) ci |= 1 << c;
        }
        const em = edgeTable[ci];
        if (!em) continue;
        for (let e = 0; e < 12; e++) {
          if (!(em & (1 << e))) continue;
          const [c0, c1] = edges[e];
          const g0 = [x + corner[c0][0], y + corner[c0][1], z + corner[c0][2]];
          const g1 = [x + corner[c1][0], y + corner[c1][1], z + corner[c1][2]];
          const k0 = idx3(...g0), k1 = idx3(...g1);
          const d = Math.abs(k1 - k0);
          // Shared-edge key, so neighbouring cubes reuse the same vertex (a welded mesh).
          const key = Math.min(k0, k1) * 4 + (d === 1 ? 0 : d === NX ? 1 : 2);
          let vi = edgeVert.get(key);
          if (vi === undefined) {
            const t = (ISO - vals[c0]) / (vals[c1] - vals[c0]);
            vi = verts.length / 3;
            for (let k = 0; k < 3; k++) verts.push(mn[k] + (g0[k] + t * (g1[k] - g0[k])) * H);
            edgeVert.set(key, vi);
          }
          ev[e] = vi;
        }
        const o = ci << 4;
        for (let i = 0; triTable[o + i] !== -1; i += 3)
          tris.push(ev[triTable[o + i]], ev[triTable[o + i + 2]], ev[triTable[o + i + 1]]);
      }
  return { points: Float32Array.from(verts), indices: Uint32Array.from(tris) };
}

function gaussianBlur3d(src, dims, sigma) {
  const r = Math.ceil(sigma * 2.5);
  const w = [];
  let s = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    w.push(v);
    s += v;
  }
  for (let i = 0; i < w.length; i++) w[i] /= s;
  const [NX, NY, NZ] = dims;
  const strides = [1, NX, NX * NY];
  let a = src;
  let b = new Float32Array(src.length);
  for (let axis = 0; axis < 3; axis++) {
    const st = strides[axis], L = dims[axis];
    for (let i = 0; i < a.length; i++) {
      const coord = Math.floor(i / st) % L;
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const c = coord + k;
        if (c >= 0 && c < L) acc += a[i + k * st] * w[k + r];
      }
      b[i] = acc;
    }
    [a, b] = [b, a];
  }
  return a;
}

/**
 * Per-vertex colour for the skin: each skin vertex takes the colour of the nearest
 * vertex among the source pieces (looked up through a spatial hash), then colours are
 * averaged over mesh neighbours a few times so boundaries between structures fade
 * rather than stepping. `sources` is [{ points, color: [r,g,b] 0..1 sRGB }].
 */
export function colorByNearestSource(skin, sources, cellSize, blendPasses = 4) {
  const hash = new Map();
  const cellKey = (x, y, z) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
  sources.forEach(({ points }, si) => {
    for (let i = 0; i < points.length; i += 6) {
      const key = cellKey(points[i], points[i + 1], points[i + 2]);
      if (!hash.has(key)) hash.set(key, []);
      hash.get(key).push(points[i], points[i + 1], points[i + 2], si);
    }
  });
  const sp = skin.points;
  const n = sp.length / 3;
  let col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [sp[3 * i], sp[3 * i + 1], sp[3 * i + 2]];
    const [cx, cy, cz] = [Math.floor(x / cellSize), Math.floor(y / cellSize), Math.floor(z / cellSize)];
    let best = Infinity, bestSource = 0;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const arr = hash.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!arr) continue;
          for (let j = 0; j < arr.length; j += 4) {
            const d = (arr[j] - x) ** 2 + (arr[j + 1] - y) ** 2 + (arr[j + 2] - z) ** 2;
            if (d < best) {
              best = d;
              bestSource = arr[j + 3];
            }
          }
        }
    col.set(sources[bestSource].color, 3 * i);
  }
  const adj = adjacency(skin.indices, n);
  for (let pass = 0; pass < blendPasses; pass++) {
    const out = new Float32Array(col.length);
    for (let i = 0; i < n; i++) {
      let r = col[3 * i], g = col[3 * i + 1], b = col[3 * i + 2];
      for (const v of adj[i]) {
        r += col[3 * v];
        g += col[3 * v + 1];
        b += col[3 * v + 2];
      }
      const k = 1 / (adj[i].length + 1);
      out[3 * i] = r * k;
      out[3 * i + 1] = g * k;
      out[3 * i + 2] = b * k;
    }
    col = out;
  }
  return col;
}
