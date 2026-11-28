/**
 * Analyses that read full-resolution data: used by the worker, and by scripts in Node.
 */
import { boxAround, boxCost, overviewToLevel0, type Box, type ImageReader, type ReadPlan } from "../readers/types";
import { spreadCenters, type Shape } from "./mask";
import { dtypeCeiling, saturatedFraction } from "./metrics";
import { averageSpot, measureSpots, psfOptionsFor, summarizeSpots, type FwhmSummary, type Spot } from "./psf";
import { zAnisotropy, type Anisotropy } from "./spectral";

export interface PsfPoint {
  /** overview voxel and level-0 voxel of the block centre, z, y, x */
  overview: Shape;
  level0: Shape;
  box: Box;
  spots: number;
  z: FwhmSummary;
  xy: FwhmSummary;
  saturated: number | null;
  /** extra z blur from the spectra of the block */
  spectral: Anisotropy;
}

export interface PsfResult {
  channel: number;
  voxelSize: Shape;
  points: PsfPoint[];
  z: FwhmSummary;
  xy: FwhmSummary;
  /** average spot, z, y, x, peak 1 */
  average: { data: Float32Array; shape: Shape; n: number };
  /** profile half-lengths, voxels, z and x-y */
  radius: [number, number];
  /** median over points of the extra z blur (FWHM, um) from the spectra */
  extraZFwhm: number | null;
}

/**
 * Size of the blocks read for the PSF, voxels z, y, x: room for spot profiles
 * around a usable core, and at least 64 planes for the z spectrum.
 */
export function psfBlockSize(voxelSize: Shape): Shape {
  const [rz, rxy] = psfOptionsFor(voxelSize).radius;
  return [Math.max(64, 2 * rz + 24), 2 * rxy + 128, 2 * rxy + 128];
}

/** Where the PSF is measured: points spread through the tissue mask of the overview. */
export function psfPoints(mask: Uint8Array, plan: ReadPlan, n: number): Shape[] {
  return spreadCenters(mask, plan.shape, n, plan.voxelSize);
}

export function psfCost(reader: ImageReader, plan: ReadPlan, points: Shape[]): number {
  const info = reader.info;
  const size = psfBlockSize(info.levels[0].voxelSize);
  return points.reduce((sum, p) => sum + boxCost(reader, boxAround(info, 0, overviewToLevel0(info, plan, p), size)), 0);
}

export async function measurePsf(
  reader: ImageReader,
  plan: ReadPlan,
  points: Shape[],
  channel: number,
  progress: (fraction: number) => void = () => {},
  cancelled: () => boolean = () => false,
): Promise<PsfResult> {
  const info = reader.info;
  const voxelSize = info.levels[0].voxelSize;
  const opts = psfOptionsFor(voxelSize);
  const size = psfBlockSize(voxelSize);
  const ceiling = dtypeCeiling(info.dtype);
  const out: PsfPoint[] = [];
  const all: Spot[] = [];
  const avgSum = { data: null as Float32Array | null, shape: [0, 0, 0] as Shape, n: 0 };
  for (let k = 0; k < points.length; k++) {
    if (cancelled()) break;
    const level0 = overviewToLevel0(info, plan, points[k]);
    const box = boxAround(info, 0, level0, size);
    const vol = await reader.readBox(box, channel);
    const block = Float32Array.from(vol.data);
    const spots = measureSpots(block, vol.shape, voxelSize, ceiling, opts);
    const s = summarizeSpots(spots);
    const avg = averageSpot(block, vol.shape, spots, opts);
    if (avg.n) {
      avgSum.data ??= new Float32Array(avg.data.length);
      avg.data.forEach((v, i) => (avgSum.data![i] += v * avg.n));
      avgSum.shape = avg.shape;
      avgSum.n += avg.n;
    }
    all.push(...spots);
    const spectral = zAnisotropy(block, vol.shape, voxelSize);
    out.push({ overview: points[k], level0, box, spots: spots.length, ...s, saturated: saturatedFraction(vol.data, ceiling), spectral });
    progress((k + 1) / points.length);
  }
  const pooled = summarizeSpots(all);
  const average = {
    data: avgSum.data ? avgSum.data.map((v) => v / avgSum.n) : new Float32Array(0),
    shape: avgSum.shape,
    n: avgSum.n,
  };
  const extra = out.map((p) => p.spectral.extraZFwhm).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const extraZFwhm = extra.length ? extra[Math.floor((extra.length - 1) / 2)] : null;
  return { channel, voxelSize, points: out, ...pooled, average, radius: opts.radius, extraZFwhm };
}

/**
 * The two sides of a mask along an array axis: the halves meet at the median
 * tissue position, and each side keeps only the band between 10% and 40% (or
 * 60% and 90%) of the tissue along the axis, away from the midline where the two
 * light sheets meet and from the far edges.
 */
export function splitMask(
  mask: Uint8Array,
  shape: Shape,
  axis: 0 | 1 | 2,
  bands: [[number, number], [number, number]] = [
    [0.1, 0.4],
    [0.6, 0.9],
  ],
): { low: Uint8Array; high: Uint8Array; split: number } {
  const [, ny, nx] = shape;
  const posOf = (i: number) => (axis === 2 ? i % nx : axis === 1 ? Math.floor(i / nx) % ny : Math.floor(i / (nx * ny)));
  const counts = new Float64Array(shape[axis]);
  let total = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) counts[posOf(i)]++, total++;
  // position below which a fraction of the tissue lies
  const cum = new Float64Array(shape[axis]);
  let acc = 0;
  counts.forEach((c, k) => (cum[k] = (acc += c) / Math.max(1, total)));
  const at = (f: number) => {
    let k = 0;
    while (k < cum.length - 1 && cum[k] <= f) k++;
    return k;
  };
  const split = at(0.5);
  const [lo, hi] = bands.map(([a, b]) => [at(a), at(b)]);
  const low = new Uint8Array(mask.length);
  const high = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const pos = posOf(i);
    if (pos >= lo[0] && pos < Math.min(lo[1], split)) low[i] = 1;
    else if (pos >= Math.max(hi[0], split) && pos < hi[1]) high[i] = 1;
  }
  return { low, high, split };
}

export interface SidesResult {
  /** array axis the sheets travel along (2 = x, 1 = y) */
  axis: 1 | 2;
  /** where the halves meet, in level-0 voxels along the axis */
  splitLevel0: number;
  low: PsfResult;
  high: PsfResult;
}

/** Points on each side of the tissue's midline along an axis. */
export function sidePoints(mask: Uint8Array, plan: ReadPlan, axis: 1 | 2, n: number) {
  const { low, high, split } = splitMask(mask, plan.shape, axis);
  return { low: psfPoints(low, plan, n), high: psfPoints(high, plan, n), split };
}

export async function measureSides(
  reader: ImageReader,
  plan: ReadPlan,
  mask: Uint8Array,
  axis: 1 | 2,
  n: number,
  channel: number,
  progress: (fraction: number) => void = () => {},
  cancelled: () => boolean = () => false,
): Promise<SidesResult> {
  const pts = sidePoints(mask, plan, axis, n);
  const low = await measurePsf(reader, plan, pts.low, channel, (f) => progress(f / 2), cancelled);
  const high = await measurePsf(reader, plan, pts.high, channel, (f) => progress(0.5 + f / 2), cancelled);
  const at: Shape = [0, 0, 0];
  at[axis] = pts.split;
  return { axis, splitLevel0: overviewToLevel0(reader.info, plan, at)[axis], low, high };
}
