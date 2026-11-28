/**
 * Affine registration of a template to a subject image, small enough to run in
 * a browser worker in seconds. Only meant to put landmark views near the right
 * place (100-200 um is plenty), so it favours robustness over accuracy.
 *
 * Both images are "grids": a 3D array (i fastest) and a voxel -> world (RAS mm)
 * matrix. For the subject the matrix comes from the orientation string and the
 * voxel size, origin at level-0 voxel 0, so the result converts exactly to
 * full-resolution voxel indices.
 *
 * The transform maps template world -> subject world:
 *   x_s = R(rot) Sh S (x_t - c_t) + c_t + t
 * with the template brain centroid c_t, log-scales S and shears Sh.
 *
 * Stages: (1) smoothed brain masks, sum of squared differences, 9 parameters
 * (contrast-free); (2, 3) mutual information of intensities, 12 parameters,
 * at about 200 and 100 um. Optimiser: pattern search with step halving.
 */

export type M4 = number[]; // row-major 4x4

export interface Grid {
  dims: [number, number, number];
  data: Float32Array;
  vox2world: M4;
}

export const mul = (a: M4, b: M4): M4 => {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[4 * r + c] += a[4 * r + k] * b[4 * k + c];
  return o;
};

export function inv(m: M4): M4 {
  // general 4x4 inverse (Gauss-Jordan)
  const a = m.slice();
  const b = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[4 * r + c]) > Math.abs(a[4 * p + c])) p = r;
    for (let k = 0; k < 4; k++) {
      [a[4 * c + k], a[4 * p + k]] = [a[4 * p + k], a[4 * c + k]];
      [b[4 * c + k], b[4 * p + k]] = [b[4 * p + k], b[4 * c + k]];
    }
    const d = a[4 * c + c];
    if (Math.abs(d) < 1e-12) throw new Error("singular matrix");
    for (let k = 0; k < 4; k++) {
      a[4 * c + k] /= d;
      b[4 * c + k] /= d;
    }
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[4 * r + c];
      for (let k = 0; k < 4; k++) {
        a[4 * r + k] -= f * a[4 * c + k];
        b[4 * r + k] -= f * b[4 * c + k];
      }
    }
  }
  return b;
}

export const apply = (m: M4, p: number[]): [number, number, number] => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

/** Linear part applied to a vector. */
export const applyVec = (m: M4, v: number[]): [number, number, number] => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
  m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
];

// ---- grids ---------------------------------------------------------------------

/** Trilinear sample at a continuous voxel index; NaN outside. */
export function sample(g: Grid, x: number, y: number, z: number): number {
  const [nx, ny, nz] = g.dims;
  if (x < 0 || y < 0 || z < 0 || x > nx - 1 || y > ny - 1 || z > nz - 1) return NaN;
  const xi = Math.min(Math.floor(x), nx - 2 < 0 ? 0 : nx - 2);
  const yi = Math.min(Math.floor(y), ny - 2 < 0 ? 0 : ny - 2);
  const zi = Math.min(Math.floor(z), nz - 2 < 0 ? 0 : nz - 2);
  const fx = nx > 1 ? x - xi : 0;
  const fy = ny > 1 ? y - yi : 0;
  const fz = nz > 1 ? z - zi : 0;
  const sx = nx > 1 ? 1 : 0;
  const sy = ny > 1 ? nx : 0;
  const sz = nz > 1 ? nx * ny : 0;
  const i = xi + nx * (yi + ny * zi);
  const d = g.data;
  const c00 = d[i] * (1 - fx) + d[i + sx] * fx;
  const c10 = d[i + sy] * (1 - fx) + d[i + sy + sx] * fx;
  const c01 = d[i + sz] * (1 - fx) + d[i + sz + sx] * fx;
  const c11 = d[i + sz + sy] * (1 - fx) + d[i + sz + sy + sx] * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}

/** Voxel size (mm) along each grid axis. */
export const voxelMm = (g: Grid): [number, number, number] =>
  [0, 1, 2].map((c) => Math.hypot(g.vox2world[c], g.vox2world[4 + c], g.vox2world[8 + c])) as [number, number, number];

/** Separable Gaussian blur (sigma in mm). */
export function blur(g: Grid, sigmaMm: number): Grid {
  const vs = voxelMm(g);
  let data = g.data.slice();
  const [nx, ny, nz] = g.dims;
  const strides = [1, nx, nx * ny];
  for (let ax = 0; ax < 3; ax++) {
    const s = sigmaMm / vs[ax];
    if (s < 0.3) continue;
    const r = Math.ceil(3 * s);
    const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * s * s)));
    const n = g.dims[ax];
    const st = strides[ax];
    const out = new Float32Array(data.length);
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const pos = [x, y, z][ax];
          const base = x + nx * (y + ny * z) - pos * st;
          let sum = 0;
          let w = 0;
          for (let j = -r; j <= r; j++) {
            const q = pos + j;
            if (q < 0 || q >= n) continue;
            sum += k[j + r] * data[base + q * st];
            w += k[j + r];
          }
          out[x + nx * (y + ny * z)] = sum / w;
        }
    data = out;
  }
  return { ...g, data };
}

/** Block-average downsampling by integer factors. */
export function downsample(g: Grid, f: [number, number, number]): Grid {
  const [nx, ny, nz] = g.dims;
  const dims = [Math.floor(nx / f[0]), Math.floor(ny / f[1]), Math.floor(nz / f[2])].map((v) => Math.max(1, v)) as [number, number, number];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++)
    for (let y = 0; y < dims[1]; y++)
      for (let x = 0; x < dims[0]; x++) {
        let s = 0;
        let c = 0;
        for (let k = 0; k < f[2]; k++)
          for (let j = 0; j < f[1]; j++)
            for (let i = 0; i < f[0]; i++) {
              const xx = x * f[0] + i;
              const yy = y * f[1] + j;
              const zz = z * f[2] + k;
              if (xx < nx && yy < ny && zz < nz) {
                s += g.data[xx + nx * (yy + ny * zz)];
                c++;
              }
            }
        data[x + dims[0] * (y + dims[1] * z)] = s / c;
      }
  // new voxel (i) centre = old voxels i f .. i f + f - 1 -> old index i f + (f - 1) / 2
  const sc = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let a = 0; a < 3; a++) {
    sc[5 * a] = f[a];
    sc[4 * a + 3] = (f[a] - 1) / 2;
  }
  return { dims, data, vox2world: mul(g.vox2world, sc) };
}

/** Downsample to about `mm` voxels. */
export function toResolution(g: Grid, mm: number): Grid {
  const vs = voxelMm(g);
  const f = vs.map((v) => Math.max(1, Math.round(mm / v))) as [number, number, number];
  return f.every((v) => v === 1) ? g : downsample(g, f);
}

/** Otsu threshold of the values above the lowest percent (background excluded from the histogram tail). */
export function otsu(data: Float32Array): number {
  const v = Array.from(data).filter(Number.isFinite).sort((a, b) => a - b);
  const lo = v[Math.floor(0.005 * (v.length - 1))];
  const hi = v[Math.floor(0.995 * (v.length - 1))];
  const nb = 128;
  const h = new Float64Array(nb);
  for (const x of v) h[Math.min(nb - 1, Math.max(0, Math.floor(((x - lo) / (hi - lo + 1e-9)) * nb)))]++;
  const tot = v.length;
  let sumAll = 0;
  for (let i = 0; i < nb; i++) sumAll += i * h[i];
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestT = 0;
  for (let i = 0; i < nb; i++) {
    wB += h[i];
    if (!wB) continue;
    const wF = tot - wB;
    if (!wF) break;
    sumB += i * h[i];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      bestT = i;
    }
  }
  return lo + ((bestT + 1) / nb) * (hi - lo);
}

/**
 * Binary mask (0/1). With a threshold: values above it. Without: tissue vs
 * background by Otsu on log intensity. Fluorescence is heavy-tailed (bright
 * nuclei, vessels), and Otsu on raw values splits those off instead of the
 * tissue from the dark background.
 */
export function maskOf(g: Grid, threshold?: number): Grid {
  const data = new Float32Array(g.data.length);
  if (threshold !== undefined) {
    for (let i = 0; i < data.length; i++) data[i] = g.data[i] > threshold ? 1 : 0;
    return { ...g, data };
  }
  let mn = Infinity;
  for (const v of g.data) if (v < mn) mn = v;
  const lg = g.data.map((v) => Math.log(1 + Math.max(0, v - mn)));
  const t = otsu(lg);
  for (let i = 0; i < data.length; i++) data[i] = lg[i] > t ? 1 : 0;
  return { ...g, data };
}

function moments(g: Grid): { c: [number, number, number]; sd: [number, number, number]; n: number } {
  const [nx, ny, nz] = g.dims;
  let n = 0;
  const s = [0, 0, 0];
  const s2 = [0, 0, 0];
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const w = g.data[x + nx * (y + ny * z)];
        if (w <= 0.5) continue;
        const p = apply(g.vox2world, [x, y, z]);
        n++;
        for (let a = 0; a < 3; a++) {
          s[a] += p[a];
          s2[a] += p[a] * p[a];
        }
      }
  const c = s.map((v) => v / n) as [number, number, number];
  const sd = s2.map((v, a) => Math.sqrt(Math.max(1e-9, v / n - c[a] ** 2))) as [number, number, number];
  return { c, sd, n };
}

/**
 * Crude bias correction: divide by the local mean inside the mask (sigma in mm),
 * 0 outside. Light-sheet images have strong large-scale intensity gradients
 * (SPIMquant applies N4 before registering for the same reason).
 */
export function flatten(g: Grid, mask: Grid, sigmaMm = 1.0): Grid {
  const m = mask.data;
  const num = blur({ ...g, data: g.data.map((v, i) => v * m[i]) }, sigmaMm).data;
  const den = blur({ ...g, data: Float32Array.from(m) }, sigmaMm).data;
  const data = new Float32Array(g.data.length);
  for (let i = 0; i < data.length; i++) data[i] = m[i] > 0.5 && num[i] > 0 ? g.data[i] / (num[i] / den[i]) : 0;
  return { ...g, data };
}

// ---- parameters ---------------------------------------------------------------------

/** [tx, ty, tz, rx, ry, rz (rad), lsx, lsy, lsz (log scale), shxy, shxz, shyz] */
export type Params = number[];

export function matrixOf(p: Params, center: number[]): M4 {
  const [tx, ty, tz, rx, ry, rz, lx, ly, lz, hxy, hxz, hyz] = p;
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  const m3 = (a: number[], b: number[]) => {
    const o = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[3 * r + c] += a[3 * r + k] * b[3 * k + c];
    return o;
  };
  const S = [Math.exp(lx), 0, 0, 0, Math.exp(ly), 0, 0, 0, Math.exp(lz)];
  const Sh = [1, hxy, hxz, 0, 1, hyz, 0, 0, 1];
  const L = m3(m3(m3(Rz, Ry), Rx), m3(Sh, S));
  const t = [0, 1, 2].map((r) => center[r] + [tx, ty, tz][r] - (L[3 * r] * center[0] + L[3 * r + 1] * center[1] + L[3 * r + 2] * center[2]));
  return [L[0], L[1], L[2], t[0], L[3], L[4], L[5], t[1], L[6], L[7], L[8], t[2], 0, 0, 0, 1];
}

// ---- metrics --------------------------------------------------------------------------

interface Samples {
  /** template world points (x, y, z interleaved) */
  pts: Float32Array;
  /** template values at the points */
  val: Float32Array;
}

function samplePoints(tpl: Grid, mask: Grid | null, n: number, seed = 1): Samples {
  const [nx, ny, nz] = tpl.dims;
  const idx: number[] = [];
  for (let i = 0; i < tpl.data.length; i++) if (!mask || mask.data[i] > 0.5) idx.push(i);
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const m = Math.min(n, idx.length);
  for (let i = 0; i < m; i++) {
    const j = i + Math.floor(rnd() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const pts = new Float32Array(3 * m);
  const val = new Float32Array(m);
  for (let k = 0; k < m; k++) {
    const i = idx[k];
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / (nx * ny));
    const w = apply(tpl.vox2world, [x, y, z]);
    pts.set(w, 3 * k);
    val[k] = tpl.data[i];
  }
  void nz;
  return { pts, val };
}

/**
 * Trimmed mean squared difference (outside the subject counts as 0): the worst
 * `trim` fraction of samples is ignored, so tissue one image has and the other
 * lacks (a longer medulla, a torn olfactory bulb) does not pull the fit.
 */
function ssd(sub: Grid, w2v: M4, T: M4, s: Samples, trim = 0): number {
  const M = mul(w2v, T);
  const n = s.val.length;
  const e = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const q = apply(M, [s.pts[3 * k], s.pts[3 * k + 1], s.pts[3 * k + 2]]);
    const v = sample(sub, q[0], q[1], q[2]);
    const d = (Number.isFinite(v) ? v : 0) - s.val[k];
    e[k] = d * d;
  }
  e.sort();
  const m = Math.max(1, Math.round(n * (1 - trim)));
  let t = 0;
  for (let k = 0; k < m; k++) t += e[k];
  return t / m;
}

/** Negative mutual information (nearest-bin joint histogram; outside the subject = lowest bin). */
function negMI(sub: Grid, w2v: M4, T: M4, s: Samples, subRange: [number, number], tplRange: [number, number], bins = 32): number {
  const M = mul(w2v, T);
  const h = new Float64Array(bins * bins);
  const n = s.val.length;
  const bs = (v: number, r: [number, number]) => Math.min(bins - 1, Math.max(0, Math.floor(((v - r[0]) / (r[1] - r[0])) * bins)));
  for (let k = 0; k < n; k++) {
    const q = apply(M, [s.pts[3 * k], s.pts[3 * k + 1], s.pts[3 * k + 2]]);
    const v = sample(sub, q[0], q[1], q[2]);
    h[bs(s.val[k], tplRange) * bins + bs(Number.isFinite(v) ? v : subRange[0], subRange)]++;
  }
  const pa = new Float64Array(bins);
  const pb = new Float64Array(bins);
  for (let i = 0; i < bins; i++) for (let j = 0; j < bins; j++) {
    pa[i] += h[i * bins + j];
    pb[j] += h[i * bins + j];
  }
  let mi = 0;
  for (let i = 0; i < bins; i++) for (let j = 0; j < bins; j++) {
    const p = h[i * bins + j];
    if (p > 0) mi += (p / n) * Math.log((p * n) / (pa[i] * pb[j]));
  }
  return -mi;
}

function range(data: Float32Array, lo = 0.5, hi = 99.5): [number, number] {
  const v = Array.from(data).filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number) => v[Math.floor((p / 100) * (v.length - 1))];
  const a = q(lo);
  const b = q(hi);
  return b > a ? [a, b] : [a, a + 1];
}

// ---- optimiser ------------------------------------------------------------------------

function patternSearch(f: (p: Params) => number, p0: Params, steps: number[], minSteps: number[], active: boolean[], maxEval = 4000): { p: Params; f: number; evals: number } {
  let p = p0.slice();
  let fp = f(p);
  let evals = 1;
  const st = steps.slice();
  while (evals < maxEval) {
    let improved = false;
    for (let i = 0; i < p.length; i++) {
      if (!active[i] || st[i] < minSteps[i]) continue;
      for (const dir of [1, -1]) {
        const q = p.slice();
        q[i] += dir * st[i];
        const fq = f(q);
        evals++;
        if (fq < fp) {
          p = q;
          fp = fq;
          improved = true;
          break;
        }
      }
    }
    if (!improved) {
      let any = false;
      for (let i = 0; i < st.length; i++) {
        if (!active[i]) continue;
        st[i] /= 2;
        if (st[i] >= minSteps[i]) any = true;
      }
      if (!any) break;
    }
  }
  return { p, f: fp, evals };
}

// ---- registration -----------------------------------------------------------------------

export interface RegResult {
  /** template world (mm) -> subject world (mm) */
  T: M4;
  params: Params;
  center: number[];
  stages: { name: string; cost: number; evals: number; ms: number }[];
  /** fraction of template brain samples that fall inside the subject brain mask */
  overlap: number;
}

export interface RegOptions {
  log?: (msg: string) => void;
  /** refine from this transform (template -> subject world): skips the start and the mask stage */
  init?: M4;
}

/**
 * @param tpl template intensity grid, @param tplMask its brain mask, @param sub subject grid
 * (any resolution; downsampled here).
 */
export function registerAffine(tpl: Grid, tplMask: Grid, sub: Grid, opt: RegOptions = {}): RegResult {
  const log = opt.log ?? (() => {});
  const stages: RegResult["stages"] = [];
  const t0 = performance.now();
  // subject pyramid
  const sub400 = blur(toResolution(sub, 0.2), 0.2);
  const subMask = maskOf(sub400);
  const subMaskSm = blur(subMask, 0.3);
  const tpl200 = toResolution(tpl, 0.2);
  const tplMask200 = toResolution(tplMask, 0.2);
  const tplMaskSm = blur(maskOf(tplMask200, 0.5), 0.3);
  const mt = moments(maskOf(tplMask200, 0.5));
  const ms = moments(subMask);
  // The search is over D(p), composed with a fixed T0: T = D(p) T0. Without an
  // initial transform, T0 = identity and p starts from the moments; with one,
  // p starts at 0 and D turns about where T0 puts the template centre.
  const T0: M4 = opt.init ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const center = opt.init ? apply(T0, mt.c) : mt.c;
  const full = (q: Params) => mul(matrixOf(q, center), T0);
  let p: Params = opt.init ? new Array(12).fill(0) : [ms.c[0] - mt.c[0], ms.c[1] - mt.c[1], ms.c[2] - mt.c[2], 0, 0, 0,
    Math.log(ms.sd[0] / mt.sd[0]), Math.log(ms.sd[1] / mt.sd[1]), Math.log(ms.sd[2] / mt.sd[2]), 0, 0, 0];
  const steps = [0.4, 0.4, 0.4, 0.06, 0.06, 0.06, 0.05, 0.05, 0.05, 0.03, 0.03, 0.03];
  const minS = [0.01, 0.01, 0.01, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002];
  let ta = performance.now();
  let r: { p: Params; f: number; evals: number };
  if (!opt.init) {
    log(`init: translation ${p.slice(0, 3).map((v) => v.toFixed(2)).join(", ")} mm, scale ${p.slice(6, 9).map((v) => Math.exp(v).toFixed(2)).join(", ")}`);
    // stage 1: masks
    const w2v400 = inv(subMaskSm.vox2world);
    const sMask = samplePoints(tplMaskSm, null, 12000, 7);
    r = patternSearch((q) => ssd(subMaskSm, w2v400, full(q), sMask), p, steps, minS,
      [true, true, true, true, true, true, true, true, true, false, false, false]);
    p = r.p;
    stages.push({ name: "masks", cost: r.f, evals: r.evals, ms: performance.now() - ta });
    log(`masks: cost ${r.f.toFixed(4)} after ${r.evals} evaluations`);
  }

  // stages 2-3: mutual information
  for (const [name, res, n, scaleSteps] of [["MI 200 um", 0.2, 15000, 0.5], ["MI 100 um", 0.1, 25000, 0.25]] as const) {
    ta = performance.now();
    const raw = blur(toResolution(sub, res), res);
    const s = flatten(raw, maskOf(raw));
    const tg = res >= 0.2 ? blur(tpl200, 0.1) : tpl;
    const tm = res >= 0.2 ? tplMask200 : tplMask;
    // samples: inside the template brain only (the background boundary is the masks' job)
    const smp = samplePoints(tg, maskOf(tm, 0.5), n, 11);
    const sr = range(s.data);
    const tr = range(smp.val);
    const w2v = inv(s.vox2world);
    r = patternSearch((q) => negMI(s, w2v, full(q), smp, sr, tr), p,
      steps.map((v) => v * scaleSteps * (opt.init ? 0.5 : 1)), minS, new Array(12).fill(true));
    p = r.p;
    stages.push({ name, cost: r.f, evals: r.evals, ms: performance.now() - ta });
    log(`${name}: MI ${(-r.f).toFixed(4)} after ${r.evals} evaluations`);
  }
  const T = full(p);
  // overlap of the template brain with the subject mask
  const sm2 = samplePoints(tplMask200, tplMask200, 5000, 3);
  const M = mul(inv(subMask.vox2world), T);
  let inside = 0;
  for (let k = 0; k < sm2.val.length; k++) {
    const q = apply(M, [sm2.pts[3 * k], sm2.pts[3 * k + 1], sm2.pts[3 * k + 2]]);
    const v = sample(subMask, q[0], q[1], q[2]);
    if (v > 0.5) inside++;
  }
  const overlap = inside / sm2.val.length;
  log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s; template brain inside subject brain: ${(100 * overlap).toFixed(0)} %`);
  return { T, params: p, center, stages, overlap };
}

/** The stage costs of a given transform (for diagnostics). */
export function stageCosts(tpl: Grid, tplMask: Grid, sub: Grid, T: M4): Record<string, number> {
  const sub400 = blur(toResolution(sub, 0.2), 0.2);
  const subMaskSm = blur(maskOf(sub400), 0.3);
  const tpl200 = toResolution(tpl, 0.2);
  const tplMask200 = toResolution(tplMask, 0.2);
  const tplMaskSm = blur(maskOf(tplMask200, 0.5), 0.3);
  const out: Record<string, number> = {};
  out.masks = ssd(subMaskSm, inv(subMaskSm.vox2world), T, samplePoints(tplMaskSm, null, 12000, 7));
  for (const [name, res, n] of [["MI 200 um", 0.2, 15000], ["MI 100 um", 0.1, 25000]] as const) {
    const raw = blur(toResolution(sub, res), res);
    const s = flatten(raw, maskOf(raw));
    const tg = res >= 0.2 ? blur(tpl200, 0.1) : tpl;
    const tm = res >= 0.2 ? tplMask200 : tplMask;
    const smp = samplePoints(tg, maskOf(tm, 0.5), n, 11);
    out[name] = negMI(s, inv(s.vox2world), T, smp, range(s.data), range(smp.val));
  }
  return out;
}

/** Least-squares affine from >= 4 point pairs (template world -> subject world). */
export function affineFromPairs(tplPts: number[][], subPts: number[][]): M4 {
  const n = tplPts.length;
  if (n < 4) throw new Error("need at least 4 point pairs");
  // solve [x y z 1] A = [x' y' z'] by normal equations
  const AtA = new Array(16).fill(0);
  const AtB = new Array(12).fill(0);
  for (let k = 0; k < n; k++) {
    const a = [...tplPts[k], 1];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) AtA[4 * i + j] += a[i] * a[j];
      for (let c = 0; c < 3; c++) AtB[3 * i + c] += a[i] * subPts[k][c];
    }
  }
  const Ai = inv(AtA);
  const X = new Array(12).fill(0);
  for (let i = 0; i < 4; i++) for (let c = 0; c < 3; c++) for (let k = 0; k < 4; k++) X[3 * i + c] += Ai[4 * i + k] * AtB[3 * k + c];
  return [X[0], X[3], X[6], X[9], X[1], X[4], X[7], X[10], X[2], X[5], X[8], X[11], 0, 0, 0, 1];
}
