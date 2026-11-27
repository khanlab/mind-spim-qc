/** A multi-resolution, multi-channel 3D image, whatever its file format. */

export interface LevelInfo {
  /** Size of the image (not of padded storage), in z, y, x order. */
  shape: [number, number, number];
  /** Voxel size in micrometres, in z, y, x order. */
  voxelSize: [number, number, number];
}

export interface ChannelInfo {
  name: string;
  /** Display colour as r, g, b in 0..1, if the file stores one. */
  color?: [number, number, number];
}

export interface ImageInfo {
  format: "imaris" | "ome-zarr";
  name: string;
  dtype: string;
  channels: ChannelInfo[];
  /** Level 0 is full resolution. */
  levels: LevelInfo[];
  /** Orientation string (X, Y, Z) stored in the file, if any. */
  orientation?: string;
  /** Other metadata worth showing (acquisition date, software, ...). */
  metadata: Record<string, string>;
}

export type Voxels = Uint8Array | Uint16Array | Float32Array;

export interface Volume {
  /** z, y, x */
  shape: [number, number, number];
  /** micrometres, z, y, x */
  voxelSize: [number, number, number];
  data: Voxels;
}

/** What to read for the overview: a level, and a step along each axis. */
export interface ReadPlan {
  level: number;
  /** z, y, x */
  step: [number, number, number];
  /** Shape after stepping, z, y, x */
  shape: [number, number, number];
  /** Voxel size after stepping (um), z, y, x */
  voxelSize: [number, number, number];
}

/** Largest number of voxels per channel to read for the overview. */
export const OVERVIEW_VOXEL_BUDGET = 32 * 1024 * 1024;

/**
 * The finest level that fits the voxel budget. Axes much finer than the coarsest
 * axis of a level are stepped through to near-isotropic voxels: some pyramids
 * never downsample z, and reading every plane would be most of the work.
 */
export function readPlan(info: ImageInfo, budget = OVERVIEW_VOXEL_BUDGET): ReadPlan {
  const plans = info.levels.map((l, level): ReadPlan => {
    const coarsest = Math.max(...l.voxelSize);
    const step = l.voxelSize.map((v) => Math.max(1, Math.floor(coarsest / v))) as [number, number, number];
    const shape = l.shape.map((n, i) => Math.ceil(n / step[i])) as [number, number, number];
    const voxelSize = l.voxelSize.map((v, i) => v * step[i]) as [number, number, number];
    return { level, step, shape, voxelSize };
  });
  const voxels = (p: ReadPlan) => p.shape[0] * p.shape[1] * p.shape[2];
  return plans.find((p) => voxels(p) <= budget) ?? plans.reduce((a, b) => (voxels(b) < voxels(a) ? b : a));
}

/** Reports progress as a fraction in 0..1. */
export type Progress = (fraction: number) => void;

/** A format reader, as used by the worker. */
export interface ImageReader {
  info: ImageInfo;
  read(plan: ReadPlan, channel: number, progress: Progress): Promise<Volume>;
}

/** Copies a typed array of any numeric type into one the views can use. */
export function asVoxels(data: ArrayLike<number> & { constructor: unknown }): Voxels {
  if (data instanceof Uint8Array || data instanceof Uint16Array || data instanceof Float32Array) return data;
  return Float32Array.from(data as ArrayLike<number>);
}
