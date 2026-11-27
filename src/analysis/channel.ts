/**
 * Per-channel analysis of the overview, and where to look at full resolution.
 * Runs in the worker (or in Node).
 */
import {
  boxAround,
  boxCost,
  coarserPlan,
  overviewToLevel0,
  stepVolume,
  type Box,
  type ImageReader,
  type ReadPlan,
  type Volume,
} from "../readers/types";
import { edgeTouchFraction, erode, gaussian3d, tissueMask, type Shape } from "./mask";
import { axisProfiles, dtypeCeiling, intensityMetrics, saturatedFraction, sharpness, type AxisProfile, type IntensityMetrics } from "./metrics";

/** Voxels of the grid the mask and metrics are computed on. */
export const ANALYSIS_VOXELS = 4e6;

export interface ChannelMetrics {
  intensity: IntensityMetrics | null;
  /** along array z, y, x */
  profiles: AxisProfile[];
  tissueVolumeMm3: number;
  edgeFraction: number;
  /** voxel size of the grid the metrics were computed on (um), z, y, x */
  gridVoxelSize: Shape;
}

/** Kept by the worker for each channel. */
export interface ChannelAnalysis {
  plan: ReadPlan;
  volume: Volume;
  mask: Uint8Array;
  metrics: ChannelMetrics;
}

export function analyseChannel(overview: Volume, plan: ReadPlan): ChannelAnalysis {
  const { plan: grid, factor } = coarserPlan(plan, ANALYSIS_VOXELS);
  const volume = stepVolume(overview, factor);
  const mask = tissueMask(volume.data, volume.shape);
  let n = 0;
  for (const v of mask) n += v;
  const voxelMm3 = grid.voxelSize.reduce((a, b) => a * b, 1) / 1e9;
  return {
    plan: grid,
    volume,
    mask,
    metrics: {
      intensity: intensityMetrics(volume.data, mask),
      profiles: axisProfiles(volume.data, mask, volume.shape),
      tissueVolumeMm3: n * voxelMm3,
      edgeFraction: edgeTouchFraction(mask, volume.shape),
      gridVoxelSize: grid.voxelSize,
    },
  };
}

export interface Site {
  label: string;
  /** level-0 voxel, z, y, x */
  level0: Shape;
}

/**
 * The brightest and dimmest places in the tissue (smoothed, away from its
 * surface), kept apart from each other by a fifth of the tissue's extent.
 */
export function chooseSites(a: ChannelAnalysis, reader: ImageReader, nBright: number, nDim: number): Site[] {
  const { volume, mask, plan } = a;
  const shape = volume.shape;
  const [, ny, nx] = shape;
  const smooth = gaussian3d(volume.data, shape, 2);
  const inner = erode(mask, shape, 3);
  const idx: number[] = [];
  for (let i = 0; i < inner.length; i++) if (inner[i]) idx.push(i);
  if (!idx.length) return [];
  idx.sort((p, q) => smooth[q] - smooth[p]);
  const coord = (i: number): Shape => [Math.floor(i / (nx * ny)), Math.floor(i / nx) % ny, i % nx];
  // tissue extent, um
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const i of idx) coord(i).forEach((v, k) => ((lo[k] = Math.min(lo[k], v)), (hi[k] = Math.max(hi[k], v))));
  const extent = Math.max(...hi.map((h, k) => (h - lo[k]) * plan.voxelSize[k]));
  const apart = extent / 5;
  const pick = (order: number[], n: number, taken: Shape[]) => {
    const out: Shape[] = [];
    for (const i of order) {
      if (out.length >= n) break;
      const c = coord(i);
      const far = (o: Shape) => Math.hypot(...c.map((v, k) => (v - o[k]) * plan.voxelSize[k])) >= apart;
      if ([...taken, ...out].every(far)) out.push(c);
    }
    return out;
  };
  const bright = pick(idx, nBright, []);
  const dim = pick([...idx].reverse(), nDim, bright);
  return [
    ...bright.map((c, k) => ({ label: `Bright ${k + 1}`, level0: overviewToLevel0(reader.info, plan, c) })),
    ...dim.map((c, k) => ({ label: `Dim ${k + 1}`, level0: overviewToLevel0(reader.info, plan, c) })),
  ];
}

/** Bytes to decode for one zoom of one channel, at most. */
export const ZOOM_BYTES = 1.5e9;

export interface Zoom {
  box: Box;
  volume: Volume;
  /** saturated fraction of voxels, and sharpness of the middle x-y plane */
  saturated: number | null;
  sharpness: number | null;
}

/** Zoom box size at level 0: about 400 um across and 150 um deep. */
export function zoomSize(voxelSize: Shape): Shape {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  return [clamp(150 / voxelSize[0], 16, 64), clamp(400 / voxelSize[1], 128, 384), clamp(400 / voxelSize[2], 128, 384)];
}

/** The finest level whose zoom box can be read within the byte budget (chunks can be large). */
export function zoomBox(reader: ImageReader, level0: Shape): Box {
  const info = reader.info;
  const size = zoomSize(info.levels[0].voxelSize);
  for (let level = 0; level < info.levels.length; level++) {
    const box = boxAround(info, level, level0, size);
    if (boxCost(reader, box) <= ZOOM_BYTES || level === info.levels.length - 1) return box;
  }
  return boxAround(info, 0, level0, size);
}

export async function readZoom(reader: ImageReader, level0: Shape, channel: number): Promise<Zoom> {
  const box = zoomBox(reader, level0);
  const volume = await reader.readBox(box, channel);
  const [nz, ny, nx] = volume.shape;
  const mid = Math.floor(nz / 2) * ny * nx;
  const plane = Float32Array.from(volume.data.subarray(mid, mid + ny * nx));
  return {
    box,
    volume,
    saturated: saturatedFraction(volume.data, dtypeCeiling(reader.info.dtype)),
    sharpness: sharpness(plane, nx, ny),
  };
}
