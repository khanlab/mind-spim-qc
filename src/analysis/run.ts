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
