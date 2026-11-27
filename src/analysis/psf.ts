/**
 * Resolution (PSF) estimate from small bright objects in full-resolution blocks.
 *
 * In each block: local maxima of the lightly smoothed image that are among the
 * brightest voxels are taken as spots; along x, y and z through each spot, a
 * Gaussian is fitted to the background-subtracted profile (weighted log-parabola,
 * Caruana's method), giving a full width at half maximum per axis.
 *
 * Tissue has no point sources: a spot's width is that of the object blurred by
 * the PSF, so it is an upper bound of the PSF width. The narrowest spots come
 * closest, so the lower quartile is reported along with the median. What matters
 * most is comparing z with x-y, and scans of the same stain with each other: a
 * thicker light sheet or a misaligned detection objective widens z.
 *
 * Blocks are z, y, x, row-major.
 */
import { gaussian3d, type Shape } from "./mask";

export const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.log(2));

export interface Spot {
  /** voxel in the block, z, y, x */
  at: Shape;
  peak: number;
  /** FWHM along z, y, x in micrometres (null where the fit failed) */
  fwhm: [number | null, number | null, number | null];
}

export interface PsfOptions {
  /** Half-length of the profiles, voxels, z and x-y */
  radius: [number, number];
  /** Brightness percentile spots must reach (in the smoothed block) */
  percentile: number;
  maxSpots: number;
}

export const DEFAULT_PSF_OPTIONS: PsfOptions = { radius: [8, 8], percentile: 99.5, maxSpots: 300 };

/**
 * Profile half-lengths for a voxel size: 30 um along z and 15 um in x-y, so
 * FWHMs up to about a third of that can be measured (the profile must reach
 * background), within limits in voxels.
 */
export function psfOptionsFor(voxelSize: Shape): PsfOptions {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    ...DEFAULT_PSF_OPTIONS,
    radius: [clamp(Math.ceil(30 / voxelSize[0]), 5, 16), clamp(Math.ceil(15 / voxelSize[1]), 5, 12)],
  };
}

/**
 * Gaussian sigma (in samples) and centre offset of a peaked 1D profile, or null.
 * Uses points above a quarter of the peak, contiguous with the centre sample.
 */
export function fitGaussian1d(profile: ArrayLike<number>, center: number): { sigma: number; offset: number } | null {
  const n = profile.length;
  // background: the lower of the two ends (two samples each)
  const left = (profile[0] + profile[1]) / 2;
  const right = (profile[n - 1] + profile[n - 2]) / 2;
  const bg = Math.min(left, right);
  const peak = profile[center] - bg;
  if (!(peak > 0)) return null;
  let lo = center;
  let hi = center;
  while (lo > 0 && profile[lo - 1] - bg > 0.25 * peak) lo--;
  while (hi < n - 1 && profile[hi + 1] - bg > 0.25 * peak) hi++;
  // the profile must fall below a quarter of the peak on both sides within the window
  if (lo === 0 || hi === n - 1) return null;
  if (hi - lo < 2) {
    // too narrow for a fit over > 3 points: use the 3 central points
    lo = center - 1;
    hi = center + 1;
  }
  // weighted least squares of ln(y) = a + b x + c x^2, weights y^2
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = lo; i <= hi; i++) {
    const y = profile[i] - bg;
    if (y <= 0) continue;
    const x = i - center;
    const w = y * y;
    const ly = Math.log(y);
    s0 += w; s1 += w * x; s2 += w * x * x; s3 += w * x * x * x; s4 += w * x * x * x * x;
    t0 += w * ly; t1 += w * x * ly; t2 += w * x * x * ly;
  }
  // solve the 3x3 normal equations by Cramer's rule
  const det = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const A = [s0, s1, s2, s1, s2, s3, s2, s3, s4];
  const D = det(A);
  if (!D) return null;
  const b = det([s0, t0, s2, s1, t1, s3, s2, t2, s4]) / D;
  const c = det([s0, s1, t0, s1, s2, t1, s2, s3, t2]) / D;
  if (!(c < 0)) return null;
  const sigma = Math.sqrt(-1 / (2 * c));
  const offset = -b / (2 * c);
  if (!Number.isFinite(sigma) || Math.abs(offset) > 1.5) return null;
  return { sigma, offset };
}

/** Local maxima (26-neighbourhood) of the smoothed block above a percentile, brightest first, kept apart. */
export function findSpots(block: Float32Array, shape: Shape, opts: PsfOptions = DEFAULT_PSF_OPTIONS): { at: Shape; value: number }[] {
  const [nz, ny, nx] = shape;
  const [rz, rxy] = opts.radius;
  const smooth = gaussian3d(block, shape, 0.7);
  // threshold from a sample of the smoothed values
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(smooth.length / 200000));
  for (let i = 0; i < smooth.length; i += step) sample.push(smooth[i]);
  sample.sort((a, b) => a - b);
  const threshold = sample[Math.floor((opts.percentile / 100) * (sample.length - 1))];
  const med = sample[Math.floor(sample.length / 2)];

  const found: { at: Shape; value: number }[] = [];
  for (let z = rz; z < nz - rz; z++)
    for (let y = rxy; y < ny - rxy; y++)
      for (let x = rxy; x < nx - rxy; x++) {
        const i = (z * ny + y) * nx + x;
        const v = smooth[i];
        if (v < threshold || v <= med * 1.5) continue;
        let isMax = true;
        for (let dz = -1; dz <= 1 && isMax; dz++)
          for (let dy = -1; dy <= 1 && isMax; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dz && !dy && !dx) continue;
              if (smooth[i + (dz * ny + dy) * nx + dx] > v) {
                isMax = false;
                break;
              }
            }
        if (isMax) found.push({ at: [z, y, x], value: v });
      }
  found.sort((a, b) => b.value - a.value);
  // keep spots apart by the profile half-length, so a profile crosses one object
  const kept: { at: Shape; value: number }[] = [];
  for (const s of found) {
    if (kept.length >= opts.maxSpots) break;
    if (kept.every((k) => Math.abs(k.at[0] - s.at[0]) > rz || Math.abs(k.at[1] - s.at[1]) > rxy || Math.abs(k.at[2] - s.at[2]) > rxy))
      kept.push(s);
  }
  return kept;
}

/** Spots of a block with their FWHM along z, y, x (um). Spots at the ceiling (saturated) are skipped. */
export function measureSpots(
  block: Float32Array,
  shape: Shape,
  voxelSize: Shape,
  ceiling: number | null,
  opts: PsfOptions = DEFAULT_PSF_OPTIONS,
): Spot[] {
  const [, ny, nx] = shape;
  const [rz, rxy] = opts.radius;
  const strides = [nx * ny, nx, 1];
  const spots: Spot[] = [];
  for (const { at } of findSpots(block, shape, opts)) {
    const i0 = (at[0] * ny + at[1]) * nx + at[2];
    // the brightest raw voxel next to the smoothed maximum
    const peak = block[i0];
    if (ceiling !== null && peak >= ceiling) continue;
    const fwhm = [0, 1, 2].map((axis) => {
      const r = axis === 0 ? rz : rxy;
      const profile = new Float32Array(2 * r + 1);
      for (let k = -r; k <= r; k++) profile[k + r] = block[i0 + k * strides[axis]];
      const fit = fitGaussian1d(profile, r);
      return fit ? fit.sigma * FWHM_PER_SIGMA * voxelSize[axis] : null;
    }) as Spot["fwhm"];
    spots.push({ at, peak, fwhm });
  }
  return spots;
}

/**
 * The average of spots that fitted on all axes, each background-subtracted and
 * scaled to a peak of 1, centred on its maximum: a picture of the blur.
 * Returns a (2rz+1, 2rxy+1, 2rxy+1) block.
 */
export function averageSpot(block: Float32Array, shape: Shape, spots: Spot[], opts: PsfOptions = DEFAULT_PSF_OPTIONS) {
  const [, ny, nx] = shape;
  const [rz, rxy] = opts.radius;
  const size: Shape = [2 * rz + 1, 2 * rxy + 1, 2 * rxy + 1];
  const sum = new Float32Array(size[0] * size[1] * size[2]);
  let n = 0;
  for (const s of spots) {
    if (s.fwhm.some((f) => f === null)) continue;
    const [z0, y0, x0] = s.at;
    // background: the minimum over the patch
    let bg = Infinity;
    for (let dz = -rz; dz <= rz; dz++)
      for (let dy = -rxy; dy <= rxy; dy++)
        for (let dx = -rxy; dx <= rxy; dx++) bg = Math.min(bg, block[((z0 + dz) * ny + y0 + dy) * nx + x0 + dx]);
    const scale = s.peak - bg;
    if (!(scale > 0)) continue;
    let k = 0;
    for (let dz = -rz; dz <= rz; dz++)
      for (let dy = -rxy; dy <= rxy; dy++)
        for (let dx = -rxy; dx <= rxy; dx++, k++) sum[k] += (block[((z0 + dz) * ny + y0 + dy) * nx + x0 + dx] - bg) / scale;
    n++;
  }
  if (n) for (let k = 0; k < sum.length; k++) sum[k] /= n;
  return { data: sum, shape: size, n };
}

export interface FwhmSummary {
  n: number;
  /** lower quartile and median FWHM, um */
  q25: number | null;
  median: number | null;
}

export function summarize(values: (number | null)[]): FwhmSummary {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))] : null);
  return { n: v.length, q25: q(0.25), median: q(0.5) };
}

/** FWHM summaries along z and in x-y (x and y pooled). */
export function summarizeSpots(spots: Spot[]): { z: FwhmSummary; xy: FwhmSummary } {
  return {
    z: summarize(spots.map((s) => s.fwhm[0])),
    xy: summarize(spots.flatMap((s) => [s.fwhm[1], s.fwhm[2]])),
  };
}
