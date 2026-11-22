/**
 * Anatomical views of a volume under a given orientation string, independent of
 * the DOM so they can be rendered in Node too.
 *
 * Views are drawn in neurological convention (the subject's left on the left of
 * the screen in coronal and axial views; anterior to the right in sagittal):
 *   coronal  - fixed A: horizontal L -> R, vertical I -> S (S at top)
 *   sagittal - fixed R: horizontal P -> A, vertical I -> S (S at top)
 *   axial    - fixed S: horizontal L -> R, vertical P -> A (A at top)
 */
import { rasAxisMap } from "./orientation";
import type { Volume } from "./readers/types";

export type ViewName = "coronal" | "sagittal" | "axial";

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

/** Size of the volume along R, A, S (voxels) and voxel size along R, A, S (um). */
export function rasGeometry(vol: Volume, orientation: string) {
  const map = rasAxisMap(orientation);
  // image axis i (0=X, 1=Y, 2=Z) is array axis 2-i of the z,y,x data
  const size = map.map((m) => vol.shape[2 - m.imageAxis]) as [number, number, number];
  const spacing = map.map((m) => vol.voxelSize[2 - m.imageAxis]) as [number, number, number];
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

/**
 * A slice (at `position`, 0..1 along the through axis) or a maximum intensity
 * projection (position = "mip") of the volume in an anatomical view.
 */
export function viewPlane(vol: Volume, orientation: string, view: ViewName, position: number | "mip"): Plane {
  const { map, size, spacing } = rasGeometry(vol, orientation);
  const [h, v, t] = VIEW_AXES[view];
  const width = size[h];
  const height = size[v];
  const [nz, ny, nx] = vol.shape;
  // strides of image axes X, Y, Z in the flat z,y,x array
  const stride = [1, nx, nx * ny];

  // index into the data from a RAS voxel coordinate along axis k
  const axisOffset = (k: number, i: number) => {
    const m = map[k];
    return (m.flip ? size[k] - 1 - i : i) * stride[m.imageAxis];
  };

  const values = new Float32Array(width * height);
  const data = vol.data;
  const tRange =
    position === "mip"
      ? [0, size[t]]
      : (() => {
          const i = Math.min(size[t] - 1, Math.max(0, Math.round(position * (size[t] - 1))));
          return [i, i + 1];
        })();
  void nz;

  for (let row = 0; row < height; row++) {
    // top row is the high end of the vertical axis (S or A)
    const vOff = axisOffset(v, height - 1 - row);
    for (let col = 0; col < width; col++) {
      const base = vOff + axisOffset(h, col);
      let best = -Infinity;
      for (let i = tRange[0]; i < tRange[1]; i++) {
        const x = data[base + axisOffset(t, i)];
        if (x > best) best = x;
      }
      values[row * width + col] = best;
    }
  }
  return { width, height, values, pixelSize: [spacing[h], spacing[v]] };
}

/** Display window from percentiles of a (sub-sampled) volume, ignoring zeros (padding, outside the sample). */
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
export function composite(layers: Layer[]): Uint8ClampedArray {
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
