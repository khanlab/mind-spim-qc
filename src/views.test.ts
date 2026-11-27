import { describe, expect, it } from "vitest";
import { allOrientations, parse } from "./orientation";
import { readPlan, type ImageInfo, type Volume } from "./readers/types";
import { VIEWS, VIEW_AXES, arrayMips, viewPlane } from "./views";

// a small volume with distinct sizes along each axis and random values
const shape: [number, number, number] = [5, 7, 9];
const voxelSize: [number, number, number] = [3, 2, 1];
const data = new Uint16Array(shape[0] * shape[1] * shape[2]);
let seed = 1;
for (let i = 0; i < data.length; i++) data[i] = (seed = (seed * 16807) % 2147483647) % 1000;
const vol: Volume = { shape, voxelSize, data };
const mips = arrayMips(vol);

/** The value at RAS voxel coordinates, straight from the orientation's direction vectors. */
function atRas(orientation: string, ras: number[]): number {
  const dirs = parse(orientation); // RAS direction of image X, Y, Z
  const xyzSize = [shape[2], shape[1], shape[0]];
  const xyz = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const k = dirs[i].findIndex((c) => c !== 0);
    xyz[i] = dirs[i][k] > 0 ? ras[k] : xyzSize[i] - 1 - ras[k];
  }
  return data[(xyz[2] * shape[1] + xyz[1]) * shape[2] + xyz[0]];
}

function rasSize(orientation: string): number[] {
  const dirs = parse(orientation);
  const xyzSize = [shape[2], shape[1], shape[0]];
  const out = [0, 0, 0];
  dirs.forEach((d, i) => (out[d.findIndex((c) => c !== 0)] = xyzSize[i]));
  return out;
}

describe("views", () => {
  it("projections and slices match brute force in every orientation", () => {
    for (const o of allOrientations()) {
      const n = rasSize(o);
      for (const view of VIEWS) {
        const [h, v, t] = VIEW_AXES[view];
        const mip = viewPlane(vol, mips, o, view, "mip");
        const mid = viewPlane(vol, null, o, view, 0.5);
        const tMid = Math.round(0.5 * (n[t] - 1));
        expect([mip.width, mip.height]).toEqual([n[h], n[v]]);
        for (let row = 0; row < n[v]; row++)
          for (let col = 0; col < n[h]; col++) {
            const ras = [0, 0, 0];
            ras[h] = col;
            ras[v] = n[v] - 1 - row;
            let max = -Infinity;
            for (let i = 0; i < n[t]; i++) max = Math.max(max, atRas(o, Object.assign([...ras], { [t]: i })));
            expect(mip.values[row * n[h] + col]).toBe(max);
            expect(mid.values[row * n[h] + col]).toBe(atRas(o, Object.assign([...ras], { [t]: tMid })));
          }
      }
    }
  });

  it("plans near-isotropic reads within the budget", () => {
    // like the MIND OME-Zarr: z is never downsampled
    const info: ImageInfo = {
      format: "ome-zarr",
      name: "t",
      dtype: "uint16",
      channels: [{ name: "a" }],
      metadata: {},
      levels: [
        { shape: [100, 632, 384], voxelSize: [2.75, 26, 26] },
        { shape: [100, 316, 192], voxelSize: [2.75, 52, 52] },
      ],
    };
    // level 0 stepped by 9 in z is 12 x 632 x 384, over the budget
    const plan = readPlan(info, 1_000_000);
    expect(plan.level).toBe(1);
    expect(plan.step).toEqual([18, 1, 1]);
    expect(plan.shape).toEqual([6, 316, 192]);
    expect(plan.voxelSize).toEqual([49.5, 52, 52]);
  });
});
