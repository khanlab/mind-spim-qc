/**
 * Image quality metrics, with the definitions of SPIMquant's QC (qcscan_lib.py)
 * so the numbers can be compared with its reports.
 */
import type { Shape } from "./mask";

function quantiles(values: Float64Array | number[], ps: number[]): number[] {
  const sorted = Float64Array.from(values).sort();
  return ps.map((p) => {
    if (!sorted.length) return NaN;
    const pos = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(sorted.length - 1, lo + 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  });
}

function median(values: number[] | Float64Array): number {
  return quantiles(values, [50])[0];
}

/** Values in and out of the mask, sub-sampled to at most ~2M each. */
function split(data: ArrayLike<number>, mask: Uint8Array) {
  let nIn = 0;
  for (let i = 0; i < mask.length; i++) nIn += mask[i];
  const nOut = mask.length - nIn;
  const stepIn = Math.max(1, Math.floor(nIn / 2e6));
  const stepOut = Math.max(1, Math.floor(nOut / 2e6));
  const tissue: number[] = [];
  const background: number[] = [];
  let ci = 0;
  let co = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) ci++ % stepIn === 0 && tissue.push(data[i]);
    else co++ % stepOut === 0 && background.push(data[i]);
  }
  return { tissue, background };
}

export interface IntensityMetrics {
  p1: number;
  p50: number;
  p99: number;
  p99_9: number;
  /** p99.9 / p50: high for sparse bright labelling, near 1 for flat signal */
  signalRange: number | null;
  background: number | null;
  backgroundNoise: number | null;
  tissueToBackground: number | null;
  /** (tissue median - background median) / background noise (MAD) */
  snr: number | null;
}

export function intensityMetrics(data: ArrayLike<number>, mask: Uint8Array): IntensityMetrics | null {
  const { tissue, background } = split(data, mask);
  if (!tissue.length) return null;
  const [p1, p50, p99, p999] = quantiles(tissue, [1, 50, 99, 99.9]);
  const out: IntensityMetrics = {
    p1,
    p50,
    p99,
    p99_9: p999,
    signalRange: p50 > 0 ? p999 / p50 : null,
    background: null,
    backgroundNoise: null,
    tissueToBackground: null,
    snr: null,
  };
  if (background.length) {
    const bg = median(background);
    const noise = 1.4826 * median(background.map((v) => Math.abs(v - bg)));
    out.background = bg;
    out.backgroundNoise = noise;
    out.tissueToBackground = bg > 0 ? p50 / bg : null;
    out.snr = noise > 0 ? (p50 - bg) / noise : null;
  }
  return out;
}

export interface AxisProfile {
  /** Median tissue intensity of each slice over the tissue median; null for slices with little tissue */
  profile: (number | null)[];
  /** Coefficient of variation of the profile */
  cv: number | null;
}

/**
 * Median tissue intensity along each array axis (z, y, x), relative to the
 * tissue median. Slices with under `minFraction` of the fullest slice's tissue
 * are skipped. A high coefficient of variation means intensity falls off
 * through the sample (attenuation, uneven clearing or illumination).
 */
export function axisProfiles(data: ArrayLike<number>, mask: Uint8Array, shape: Shape, minFraction = 0.2): AxisProfile[] {
  const [nz, ny, nx] = shape;
  const tissueMedian = median(split(data, mask).tissue);
  return [0, 1, 2].map((axis) => {
    const n = shape[axis];
    const slices: number[][] = Array.from({ length: n }, () => []);
    const counts = new Int32Array(n);
    // sub-sample within slices so each holds at most ~50k values
    const per = (nz * ny * nx) / n;
    const step = Math.max(1, Math.floor(per / 50000));
    let k = 0;
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++, k++) {
          if (!mask[k]) continue;
          const s = axis === 0 ? z : axis === 1 ? y : x;
          if (counts[s]++ % step === 0) slices[s].push(data[k]);
        }
    const most = Math.max(...counts);
    const profile = slices.map((v, s) =>
      most && counts[s] >= Math.max(1, minFraction * most) && tissueMedian > 0 ? median(v) / tissueMedian : null,
    );
    const valid = profile.filter((v): v is number => v !== null);
    const mean = valid.reduce((a, b) => a + b, 0) / (valid.length || 1);
    const sd = Math.sqrt(valid.reduce((a, b) => a + (b - mean) ** 2, 0) / (valid.length || 1));
    return { profile, cv: valid.length > 2 && mean > 0 ? sd / mean : null };
  });
}

/** Pearson correlation of log intensities in tissue between channels: near 1 suggests bleed-through. */
export function logCorrelation(a: ArrayLike<number>, b: ArrayLike<number>, mask: Uint8Array): number | null {
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  const step = Math.max(1, Math.floor(mask.length / 4e6));
  for (let i = 0; i < mask.length; i += step) {
    if (!mask[i]) continue;
    const x = Math.log1p(Math.max(0, a[i]));
    const y = Math.log1p(Math.max(0, b[i]));
    n++;
    sa += x;
    sb += y;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
  }
  if (n < 3) return null;
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2;
  const vb = sbb / n - (sb / n) ** 2;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
}

/** 2D Gaussian blur (separable, clamped edges). */
function blur2d(img: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const ks = k.reduce((a, b) => a + b, 0);
  const tmp = new Float32Array(img.length);
  const out = new Float32Array(img.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += k[i + r] * img[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = a / ks;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = a / ks;
    }
  return out;
}

function std(a: Float32Array): number {
  let s = 0;
  let ss = 0;
  for (const v of a) (s += v), (ss += v * v);
  const m = s / a.length;
  return Math.sqrt(Math.max(0, ss / a.length - m * m));
}

/**
 * Fine detail relative to coarse structure in a 2D image, without units (as
 * SPIMquant's sharpness): the spread of the 1-2 px band over that of the 2-8 px
 * band. Lower when out of focus; compare between scans of the same stain.
 */
export function sharpness(img: Float32Array, w: number, h: number): number | null {
  const g1 = blur2d(img, w, h, 1);
  const g2 = blur2d(img, w, h, 2);
  const g8 = blur2d(img, w, h, 8);
  const fine = g1.map((v, i) => v - g2[i]);
  const coarse = g2.map((v, i) => v - g8[i]);
  const c = std(coarse);
  return c > 0 ? std(fine) / c : null;
}

/** Fraction of voxels at or above the top of the data type. */
export function saturatedFraction(data: ArrayLike<number>, ceiling: number | null): number | null {
  if (ceiling === null || !data.length) return null;
  let n = 0;
  for (let i = 0; i < data.length; i++) if (data[i] >= ceiling) n++;
  return n / data.length;
}

export function dtypeCeiling(dtype: string): number | null {
  return dtype === "uint8" ? 255 : dtype === "uint16" ? 65535 : null;
}
