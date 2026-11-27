/**
 * Anatomical views of a volume under a given orientation string, independent of
 * the DOM so they can be rendered in Node too.
 *
 * Views are drawn in neurological convention (the subject's left on the left of
 * the screen in coronal and axial views; anterior to the right in sagittal):
 *   coronal  - fixed A: horizontal L -> R, vertical I -> S (S at top)
 *   sagittal - fixed R: horizontal P -> A, vertical I -> S (S at top)
 *   axial    - fixed S: horizontal L -> R, vertical P -> A (A at top)
 *
 * Projections are computed once along each array axis (`arrayMips`); the
 * projection of any view in any orientation is one of them, flipped or
 * transposed, so changing the orientation needs no pass over the volume.
 */
import { rasAxisMap } from "./orientation";
import type { Volume } from "./readers/types";

export type ViewName = "coronal" | "sagittal" | "axial";
export const VIEWS: ViewName[] = ["coronal", "sagittal", "axial"];

/** RAS axes (0=R, 1=A, 2=S) of each view: [horizontal, vertical, through]. */
export const VIEW_AXES: Record<ViewName, [number, number, number]> = {
  coronal: [0, 2, 1],
  sagittal: [1, 2, 0],
  axial: [0, 1, 2],
};

/** Labels at the [left, right, top, bottom] edges of each view. */
export const VIEW_LABELS: Record<ViewName, [string, string, string, string]> = {
  coronal: ["L", "R", "S", "I"],
  sagittal: ["P", "A", "S", "I"],
  axial: ["L", "R", "A", "P"],
};

/**
 * Maximum intensity projections along the array axes z, y, x: 2D images of
 * (y, x), (z, x) and (z, y), row-major.
 */
export type Mips = [Float32Array, Float32Array, Float32Array];

export function arrayMips(vol: Volume): Mips {
  const [nz, ny, nx] = vol.shape;
  const d = vol.data;
  const mz = new Float32Array(ny * nx).fill(-Infinity);
  const my = new Float32Array(nz * nx).fill(-Infinity);
  const mx = new Float32Array(nz * ny).fill(-Infinity);
  let i = 0;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++) {
      let rowMax = -Infinity;
      const yz = y * nx;
      const zx = z * nx;
      for (let x = 0; x < nx; x++, i++) {
        const v = d[i];
        if (v > mz[yz + x]) mz[yz + x] = v;
        if (v > my[zx + x]) my[zx + x] = v;
        if (v > rowMax) rowMax = v;
      }
      mx[z * ny + y] = rowMax;
    }
  return [mz, my, mx];
}

/** Strides of image axes X, Y, Z in the volume and in each projection (0 = projected away). */
function strides(shape: [number, number, number], source: "volume" | 0 | 1 | 2): [number, number, number] {
  const [, ny, nx] = shape;
  if (source === "volume") return [1, nx, nx * ny];
  if (source === 0) return [1, nx, 0]; // along z: (y, x)
  if (source === 1) return [1, 0, nx]; // along y: (z, x)
  return [0, 1, ny]; // along x: (z, y)
}

/** Size of the volume along R, A, S (voxels) and voxel size along R, A, S (um). */
export function rasGeometry(shape: [number, number, number], voxelSize: [number, number, number], orientation: string) {
  const map = rasAxisMap(orientation);
  // image axis i (0=X, 1=Y, 2=Z) is array axis 2-i of the z,y,x data
  const size = map.map((m) => shape[2 - m.imageAxis]) as [number, number, number];
  const spacing = map.map((m) => voxelSize[2 - m.imageAxis]) as [number, number, number];
  return { map, size, spacing };
}

export interface Plane {
  width: number;
  height: number;
  /** Row-major, row 0 at the top. */
  values: Float32Array;
  /** Physical size of a pixel, horizontal and vertical (um). */
  pixelSize: [number, number];
}

/** Which projection a view uses under an orientation: the array axis projected along. */
export function mipAxis(orientation: string, view: ViewName): 0 | 1 | 2 {
  const t = VIEW_AXES[view][2];
  return (2 - rasAxisMap(orientation)[t].imageAxis) as 0 | 1 | 2;
}

/**
 * A slice (at `position`, 0..1 along the through axis) or the maximum intensity
 * projection (position = "mip") of a volume in an anatomical view.
 */
export function viewPlane(
  vol: Volume,
  mips: Mips | null,
  orientation: string,
  view: ViewName,
  position: number | "mip",
): Plane {
  const { map, size, spacing } = rasGeometry(vol.shape, vol.voxelSize, orientation);
  const [h, v, t] = VIEW_AXES[view];
  const width = size[h];
  const height = size[v];

  let data: ArrayLike<number>;
  let stride: [number, number, number];
  let tIndex = 0;
  if (position === "mip") {
    const axis = mipAxis(orientation, view);
    if (!mips) throw new Error("Projections not computed");
    data = mips[axis];
    stride = strides(vol.shape, axis);
  } else {
    data = vol.data;
    stride = strides(vol.shape, "volume");
    tIndex = Math.min(size[t] - 1, Math.max(0, Math.round(position * (size[t] - 1))));
  }
  // offset of voxel i along RAS axis k
  const off = (k: number, i: number) => (map[k].flip ? size[k] - 1 - i : i) * stride[map[k].imageAxis];

  const values = new Float32Array(width * height);
  const base = off(t, tIndex);
  const hStep = (map[h].flip ? -1 : 1) * stride[map[h].imageAxis];
  for (let row = 0; row < height; row++) {
    // top row is the high end of the vertical axis (S or A)
    let o = base + off(v, height - 1 - row) + off(h, 0);
    for (let col = 0; col < width; col++, o += hStep) values[row * width + col] = data[o];
  }
  return { width, height, values, pixelSize: [spacing[h], spacing[v]] };
}

/** Display window from percentiles of a (sub-sampled) image, ignoring zeros (padding, outside the sample). */
export function autoWindow(data: ArrayLike<number>, lo = 0.5, hi = 99.8): [number, number] {
  const step = Math.max(1, Math.floor(data.length / 1_000_000));
  const sample: number[] = [];
  for (let i = 0; i < data.length; i += step) if (data[i] > 0) sample.push(data[i]);
  if (!sample.length) return [0, 1];
  sample.sort((a, b) => a - b);
  const q = (p: number) => sample[Math.min(sample.length - 1, Math.floor((p / 100) * sample.length))];
  const w: [number, number] = [q(lo), q(hi)];
  if (w[1] <= w[0]) w[1] = w[0] + 1;
  return w;
}

export interface Layer {
  plane: Plane;
  window: [number, number];
  color: [number, number, number];
}

/** Additive composite of channels into RGBA bytes. */
export function composite(layers: Layer[]): Uint8ClampedArray<ArrayBuffer> {
  const { width, height } = layers[0].plane;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const acc = new Float32Array(width * height * 3);
  for (const { plane, window, color } of layers) {
    const [lo, hi] = window;
    const scale = 1 / (hi - lo);
    for (let i = 0; i < plane.values.length; i++) {
      const g = Math.min(1, Math.max(0, (plane.values[i] - lo) * scale));
      acc[3 * i] += g * color[0];
      acc[3 * i + 1] += g * color[1];
      acc[3 * i + 2] += g * color[2];
    }
  }
  for (let i = 0; i < width * height; i++) {
    rgba[4 * i] = acc[3 * i] * 255;
    rgba[4 * i + 1] = acc[3 * i + 1] * 255;
    rgba[4 * i + 2] = acc[3 * i + 2] * 255;
    rgba[4 * i + 3] = 255;
  }
  return rgba;
}

/** Array voxel (z, y, x) of a RAS voxel coordinate under an orientation. */
export function rasToArray(orientation: string, shape: [number, number, number], ras: number[]): [number, number, number] {
  const map = rasAxisMap(orientation);
  const size = map.map((m) => shape[2 - m.imageAxis]);
  const xyz = [0, 0, 0];
  map.forEach((m, k) => (xyz[m.imageAxis] = m.flip ? size[k] - 1 - ras[k] : ras[k]));
  return [xyz[2], xyz[1], xyz[0]];
}

/** RAS voxel coordinate of an array voxel (z, y, x) under an orientation. */
export function arrayToRas(orientation: string, shape: [number, number, number], zyx: number[]): [number, number, number] {
  const map = rasAxisMap(orientation);
  const size = map.map((m) => shape[2 - m.imageAxis]);
  const xyz = [zyx[2], zyx[1], zyx[0]];
  return map.map((m, k) => (m.flip ? size[k] - 1 - xyz[m.imageAxis] : xyz[m.imageAxis])) as [number, number, number];
}

/** Along the through axis of a view at (col, row): the depth of the brightest voxel. */
export function brightestDepth(vol: Volume, orientation: string, view: ViewName, col: number, row: number): number {
  const { size } = rasGeometry(vol.shape, vol.voxelSize, orientation);
  const [h, v, t] = VIEW_AXES[view];
  const ras = [0, 0, 0];
  ras[h] = col;
  ras[v] = size[v] - 1 - row;
  const [, ny, nx] = vol.shape;
  let best = 0;
  let bestV = -Infinity;
  for (let i = 0; i < size[t]; i++) {
    ras[t] = i;
    const [z, y, x] = rasToArray(orientation, vol.shape, ras);
    const val = vol.data[(z * ny + y) * nx + x];
    if (val > bestV) (bestV = val), (best = i);
  }
  return best;
}
