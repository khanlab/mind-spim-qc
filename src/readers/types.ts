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

/** A box of voxels at some level: start inclusive, stop exclusive, z, y, x. */
export interface Box {
  level: number;
  start: [number, number, number];
  stop: [number, number, number];
}

/** A format reader, as used by the worker. */
export interface ImageReader {
  info: ImageInfo;
  read(plan: ReadPlan, channel: number, progress: Progress): Promise<Volume>;
  /** One channel of a box, at full detail. */
  readBox(box: Box, channel: number): Promise<Volume>;
  /** Chunk shape of a level, z, y, x. */
  chunks(level: number): [number, number, number];
}

/** Bytes of chunks to decode to read a box of one channel. */
export function boxCost(reader: ImageReader, box: Box, bytesPerVoxel = 2): number {
  const c = reader.chunks(box.level);
  let n = bytesPerVoxel;
  for (let a = 0; a < 3; a++) {
    const first = Math.floor(box.start[a] / c[a]);
    const last = Math.floor((box.stop[a] - 1) / c[a]);
    n *= (last - first + 1) * c[a];
  }
  return n;
}

/** Level-0 voxel of the centre of an overview voxel. */
export function overviewToLevel0(info: ImageInfo, plan: ReadPlan, at: [number, number, number]): [number, number, number] {
  const lv = info.levels[plan.level].shape;
  const l0 = info.levels[0].shape;
  return at.map((i, a) => {
    const atLevel = i * plan.step[a] + (plan.step[a] - 1) / 2;
    return Math.min(l0[a] - 1, Math.max(0, Math.round(((atLevel + 0.5) * l0[a]) / lv[a] - 0.5)));
  }) as [number, number, number];
}

/** A box of `size` voxels at `level` centred on a level-0 voxel, inside the image. */
export function boxAround(info: ImageInfo, level: number, center0: [number, number, number], size: [number, number, number]): Box {
  const l0 = info.levels[0].shape;
  const lv = info.levels[level].shape;
  const start = [0, 0, 0] as [number, number, number];
  const stop = [0, 0, 0] as [number, number, number];
  for (let a = 0; a < 3; a++) {
    const c = Math.round(((center0[a] + 0.5) * lv[a]) / l0[a] - 0.5);
    const n = Math.min(size[a], lv[a]);
    start[a] = Math.min(lv[a] - n, Math.max(0, c - Math.floor(n / 2)));
    stop[a] = start[a] + n;
  }
  return { level, start, stop };
}

/** Copies a typed array of any numeric type into one the views can use. */
export function asVoxels(data: ArrayLike<number> & { constructor: unknown }): Voxels {
  if (data instanceof Uint8Array || data instanceof Uint16Array || data instanceof Float32Array) return data;
  return Float32Array.from(data as ArrayLike<number>);
}

/** A coarser plan from a plan, by stepping further, to at most `budget` voxels: for analyses that need less detail. */
export function coarserPlan(plan: ReadPlan, budget: number): { plan: ReadPlan; factor: number } {
  const n = plan.shape[0] * plan.shape[1] * plan.shape[2];
  const factor = Math.max(1, Math.ceil(Math.cbrt(n / budget)));
  return {
    factor,
    plan: {
      level: plan.level,
      step: plan.step.map((s) => s * factor) as [number, number, number],
      shape: plan.shape.map((v) => Math.ceil(v / factor)) as [number, number, number],
      voxelSize: plan.voxelSize.map((v) => v * factor) as [number, number, number],
    },
  };
}

/** Every `factor`-th voxel of a volume along each axis (shape as from coarserPlan). */
export function stepVolume(vol: Volume, factor: number): Volume {
  if (factor === 1) return vol;
  const [nz, ny, nx] = vol.shape;
  const shape = vol.shape.map((v) => Math.ceil(v / factor)) as [number, number, number];
  const data = new (vol.data.constructor as new (n: number) => Voxels)(shape[0] * shape[1] * shape[2]);
  let i = 0;
  for (let z = 0; z < nz; z += factor)
    for (let y = 0; y < ny; y += factor) for (let x = 0; x < nx; x += factor) data[i++] = vol.data[(z * ny + y) * nx + x];
  return { shape, voxelSize: vol.voxelSize.map((v) => v * factor) as [number, number, number], data };
}

/** Overview voxel (fractional) of a level-0 voxel: the inverse of overviewToLevel0. */
export function level0ToOverview(info: ImageInfo, plan: ReadPlan, l0: [number, number, number]): [number, number, number] {
  const lv = info.levels[plan.level].shape;
  const n0 = info.levels[0].shape;
  return l0.map((i, a) => (((i + 0.5) * lv[a]) / n0[a] - 0.5 - (plan.step[a] - 1) / 2) / plan.step[a]) as [number, number, number];
}
