/**
 * Offline mesh helper for build.mjs: Taubin smoothing, which removes the MRI-segmentation
 * lumpiness without shrinking the slender duct tubes the way plain Laplacian smoothing
 * would. Pass counts are set in build.mjs (chosen in the Labyrinth Model Lab playground).
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
