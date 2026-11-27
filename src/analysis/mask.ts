/**
 * Tissue mask of a downsampled volume, as in SPIMquant's QC (qcscan_lib.tissue_mask):
 * Otsu threshold of the smoothed log intensities, keeping the largest connected
 * component with its holes filled. Volumes are z, y, x, row-major.
 */

export type Shape = [number, number, number];

/** Separable Gaussian smoothing (in voxels), edges clamped. */
export function gaussian3d(data: ArrayLike<number>, shape: Shape, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += kernel[i + radius] = Math.exp((-i * i) / (2 * sigma * sigma));
  kernel.forEach((v, i) => (kernel[i] = v / sum));

  let src = Float32Array.from(data);
  let dst = new Float32Array(src.length);
  const [nz, ny, nx] = shape;
  const strides = [nx * ny, nx, 1];
  const line = new Float32Array(Math.max(nz, ny, nx));
  for (let axis = 0; axis < 3; axis++) {
    const n = shape[axis];
    const s = strides[axis];
    const others = [0, 1, 2].filter((a) => a !== axis);
    for (let a = 0; a < shape[others[0]]; a++)
      for (let b = 0; b < shape[others[1]]; b++) {
        const base = a * strides[others[0]] + b * strides[others[1]];
        for (let i = 0; i < n; i++) line[i] = src[base + i * s];
        for (let i = 0; i < n; i++) {
          let acc = 0;
          for (let k = -radius; k <= radius; k++) {
            const p = i + k < 0 ? 0 : i + k >= n ? n - 1 : i + k;
            acc += kernel[k + radius] * line[p];
          }
          dst[base + i * s] = acc;
        }
      }
    [src, dst] = [dst, src];
  }
  return src;
}

/** Otsu threshold of values, over a 256-bin histogram. */
export function otsu(values: ArrayLike<number>): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  if (!(hi > lo)) return lo;
  const bins = 256;
  const hist = new Float64Array(bins);
  const scale = (bins - 1) / (hi - lo);
  for (let i = 0; i < values.length; i++) hist[Math.round((values[i] - lo) * scale)]++;
  const total = values.length;
  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * hist[b];
  let w0 = 0;
  let sum0 = 0;
  let best = -1;
  let bestB = 0;
  for (let b = 0; b < bins - 1; b++) {
    w0 += hist[b];
    sum0 += b * hist[b];
    const w1 = total - w0;
    if (w0 === 0 || w1 === 0) continue;
    const m0 = sum0 / w0;
    const m1 = (sumAll - sum0) / w1;
    const between = w0 * w1 * (m0 - m1) ** 2;
    if (between > best) (best = between), (bestB = b);
  }
  return lo + (bestB + 0.5) / scale;
}

/** Labels connected components (6-connectivity) of `mask`; returns the largest as a new mask. */
export function largestComponent(mask: Uint8Array, shape: Shape): Uint8Array {
  const [nz, ny, nx] = shape;
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  let bestLabel = 0;
  let bestSize = 0;
  let label = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    label++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    while (head < tail) {
      const i = queue[head++];
      const x = i % nx;
      const y = Math.floor(i / nx) % ny;
      const z = Math.floor(i / (nx * ny));
      const visit = (j: number) => {
        if (mask[j] && !labels[j]) (labels[j] = label), (queue[tail++] = j);
      };
      if (x > 0) visit(i - 1);
      if (x < nx - 1) visit(i + 1);
      if (y > 0) visit(i - nx);
      if (y < ny - 1) visit(i + nx);
      if (z > 0) visit(i - nx * ny);
      if (z < nz - 1) visit(i + nx * ny);
    }
    if (tail > bestSize) (bestSize = tail), (bestLabel = label);
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = labels[i] === bestLabel && bestLabel > 0 ? 1 : 0;
  return out;
}

/** Fills holes: background not connected (6-connectivity) to the volume faces becomes foreground. */
export function fillHoles(mask: Uint8Array, shape: Shape): Uint8Array {
  const [nz, ny, nx] = shape;
  const outside = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let tail = 0;
  const seed = (i: number) => {
    if (!mask[i] && !outside[i]) (outside[i] = 1), (queue[tail++] = i);
  };
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        if (z === 0 || y === 0 || x === 0 || z === nz - 1 || y === ny - 1 || x === nx - 1) seed((z * ny + y) * nx + x);
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / (nx * ny));
    if (x > 0) seed(i - 1);
    if (x < nx - 1) seed(i + 1);
    if (y > 0) seed(i - nx);
    if (y < ny - 1) seed(i + nx);
    if (z > 0) seed(i - nx * ny);
    if (z < nz - 1) seed(i + nx * ny);
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

export function tissueMask(data: ArrayLike<number>, shape: Shape): Uint8Array {
  const logs = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) logs[i] = Math.log1p(Math.max(0, data[i]));
  const smoothed = gaussian3d(logs, shape, 1);
  const t = otsu(smoothed);
  const mask = new Uint8Array(data.length);
  let any = false;
  for (let i = 0; i < data.length; i++) if (smoothed[i] > t) (mask[i] = 1), (any = true);
  if (!any) return mask;
  return fillHoles(largestComponent(mask, shape), shape);
}

/** Voxels of the mask with all 6 neighbours inside it, `iterations` times. */
export function erode(mask: Uint8Array, shape: Shape, iterations = 1): Uint8Array {
  const [nz, ny, nx] = shape;
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const out = new Uint8Array(cur.length);
    for (let z = 1; z < nz - 1; z++)
      for (let y = 1; y < ny - 1; y++)
        for (let x = 1; x < nx - 1; x++) {
          const i = (z * ny + y) * nx + x;
          out[i] =
            cur[i] & cur[i - 1] & cur[i + 1] & cur[i - nx] & cur[i + nx] & cur[i - nx * ny] & cur[i + nx * ny];
        }
    cur = out;
  }
  return cur;
}

/**
 * Fraction of the tissue's surface voxels on the faces of the volume: high when
 * the sample is cut off by the field of view.
 */
export function edgeTouchFraction(mask: Uint8Array, shape: Shape): number {
  const [nz, ny, nx] = shape;
  const inner = erode(mask, shape, 1);
  let surface = 0;
  let onFace = 0;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = (z * ny + y) * nx + x;
        const face = z === 0 || y === 0 || x === 0 || z === nz - 1 || y === ny - 1 || x === nx - 1;
        // on a face, erode() leaves 0: a tissue voxel there is surface
        if (mask[i] && !inner[i]) {
          surface++;
          if (face) onFace++;
        }
      }
  return surface ? onFace / surface : 0;
}

/**
 * n voxels spread through a mask, away from its surface and each other (as
 * SPIMquant's spread_centers): the deepest voxel first, then each next the
 * candidate furthest from those chosen, among voxels at least half as deep as
 * the deepest. Depth is a city-block distance to the background.
 */
export function spreadCenters(mask: Uint8Array, shape: Shape, n: number, spacing: Shape = [1, 1, 1]): Shape[] {
  const depth = cityBlockDepth(mask, shape);
  let maxDepth = 0;
  let deepest = -1;
  for (let i = 0; i < depth.length; i++) if (depth[i] > maxDepth) (maxDepth = depth[i]), (deepest = i);
  if (deepest < 0) return [];
  const [, ny, nx] = shape;
  const coord = (i: number): Shape => [Math.floor(i / (nx * ny)), Math.floor(i / nx) % ny, i % nx];
  // candidates, sub-sampled to keep this fast
  const all: number[] = [];
  for (let i = 0; i < depth.length; i++) if (depth[i] >= 0.5 * maxDepth) all.push(i);
  const step = Math.max(1, Math.floor(all.length / 20000));
  const cands = all.filter((_, k) => k % step === 0).map(coord);
  const dist = (a: Shape, b: Shape) => Math.hypot(...a.map((v, k) => (v - b[k]) * spacing[k]));
  const chosen: Shape[] = [coord(deepest)];
  const nearest = cands.map((c) => dist(c, chosen[0]));
  while (chosen.length < n) {
    let best = -1;
    let bestD = 0;
    nearest.forEach((d, k) => d > bestD && ((bestD = d), (best = k)));
    if (best < 0) break;
    chosen.push(cands[best]);
    cands.forEach((c, k) => (nearest[k] = Math.min(nearest[k], dist(c, cands[best]))));
  }
  return chosen;
}

function cityBlockDepth(mask: Uint8Array, shape: Shape): Float32Array {
  const [nz, ny, nx] = shape;
  const d = new Float32Array(mask.length);
  const big = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? big : 0;
  const idx = (z: number, y: number, x: number) => (z * ny + y) * nx + x;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = idx(z, y, x);
        if (!d[i]) continue;
        let m = d[i];
        m = Math.min(m, x > 0 ? d[i - 1] + 1 : 1, y > 0 ? d[i - nx] + 1 : 1, z > 0 ? d[i - nx * ny] + 1 : 1);
        d[i] = m;
      }
  for (let z = nz - 1; z >= 0; z--)
    for (let y = ny - 1; y >= 0; y--)
      for (let x = nx - 1; x >= 0; x--) {
        const i = idx(z, y, x);
        if (!d[i]) continue;
        d[i] = Math.min(
          d[i],
          x < nx - 1 ? d[i + 1] + 1 : 1,
          y < ny - 1 ? d[i + nx] + 1 : 1,
          z < nz - 1 ? d[i + nx * ny] + 1 : 1,
        );
      }
  return d;
}
