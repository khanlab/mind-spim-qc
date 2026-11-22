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
  dtype: "uint8" | "uint16" | "float32";
  channels: ChannelInfo[];
  /** Level 0 is full resolution. */
  levels: LevelInfo[];
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

/** Largest number of voxels per channel to read for the overview. */
export const OVERVIEW_VOXEL_BUDGET = 32 * 1024 * 1024;

/** The finest level that fits the voxel budget (or the coarsest level). */
export function overviewLevel(info: ImageInfo, budget = OVERVIEW_VOXEL_BUDGET): number {
  const fits = info.levels.findIndex((l) => l.shape[0] * l.shape[1] * l.shape[2] <= budget);
  return fits === -1 ? info.levels.length - 1 : fits;
}
