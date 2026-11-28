import { describe, expect, it } from "vitest";
import type { ImageInfo } from "../readers/types";
import {
  blurNaN, boxForBounds, chooseBlock, dot, l0ToPhys, levelVoxel, orthoPlane, physToL0, physToLevel, physToPixel,
  pixelToPhys, planeFrom, sampleBlock, windowOf, type Block, type Sampling, type V3,
} from "./geometry";

// like the 4x test file: x, y voxels 1.625 um, z 2.75 um; levels halve every axis
const info: ImageInfo = {
  format: "imaris",
  name: "t.ims",
  dtype: "uint16",
  channels: [{ name: "c" }],
  metadata: {},
  levels: [0, 1, 2, 3].map((l) => ({
    shape: [Math.ceil(64 / 2 ** l), Math.ceil(96 / 2 ** l), Math.ceil(128 / 2 ** l)] as [number, number, number],
    voxelSize: [2.75 * 2 ** l, 1.625 * 2 ** l, 1.625 * 2 ** l] as [number, number, number],
  })),
};

describe("frames", () => {
  it("level 0 index <-> physical round trip", () => {
    const p: V3 = [10.5, 20, 3.25];
    expect(physToL0(info, l0ToPhys(info, p))).toEqual(p);
    expect(l0ToPhys(info, [2, 0, 1])).toEqual([3.25, 0, 2.75]);
  });
  it("level index follows voxel centres", () => {
    // level-0 voxels 0 and 1 make level-1 voxel 0; its centre is at level-0 index 0.5
    const p = l0ToPhys(info, [0.5, 0.5, 0.5]);
    const i1 = physToLevel(info, 1, p);
    i1.forEach((v) => expect(v).toBeCloseTo(0, 9));
    expect(levelVoxel(info, 2)).toEqual([6.5, 6.5, 11]);
  });
});

describe("planes", () => {
  it("ortho views follow the orientation string", () => {
    // RAI: X -> R, Y -> A, Z -> I
    const cor = orthoPlane("RAI", "coronal", [0, 0, 0]);
    expect(cor.u).toEqual([1, 0, 0]); // screen right = R = +X
    expect(cor.v).toEqual([0, 0, -1]); // screen up = S = -Z
    const sag = orthoPlane("RAI", "sagittal", [0, 0, 0]);
    expect(sag.u).toEqual([0, 1, 0]); // right = A = +Y
    const ax = orthoPlane("LPS", "axial", [0, 0, 0]);
    expect(ax.u).toEqual([-1, 0, 0]); // right = R = -X under LPS
    expect(ax.v).toEqual([0, -1, 0]); // up = A = -Y
  });
  it("pixel <-> physical round trip on an oblique plane", () => {
    const plane = planeFrom([100, 50, 40], [1, 1, 0.3], [0, 0, 1]);
    expect(dot(plane.u, plane.n)).toBeCloseTo(0, 12);
    const s: Sampling = { plane, widthUm: 400, px: 200, slabUm: 0 };
    const q = pixelToPhys(s, 37, 121, 12);
    const b = physToPixel(s, q);
    expect(b.col).toBeCloseTo(37, 9);
    expect(b.row).toBeCloseTo(121, 9);
    expect(b.depth).toBeCloseTo(12, 9);
    // screen up is +v
    const top = pixelToPhys(s, 100, 0);
    expect(dot(top, plane.v) - dot(plane.center, plane.v)).toBeGreaterThan(0);
  });
});

describe("blocks", () => {
  it("box stays inside the image and covers the bounds", () => {
    const b = boxForBounds(info, 1, [-50, 10, 10], [80, 60, 60])!;
    expect(b.start[2]).toBe(0);
    const s = info.levels[1].shape;
    b.stop.forEach((v, a) => expect(v).toBeLessThanOrEqual(s[a]));
  });
  it("chooses the coarsest level the display needs, then fits the budget", () => {
    const plane = orthoPlane("RAS", "axial", l0ToPhys(info, [64, 48, 32]));
    const fine: Sampling = { plane, widthUm: 50, px: 100, slabUm: 0 }; // 0.5 um/px -> level 0
    expect(chooseBlock(info, [fine], 1e9)!.level).toBe(0);
    const coarse: Sampling = { plane, widthUm: 200, px: 30, slabUm: 0 }; // 6.7 um/px -> level 2
    expect(chooseBlock(info, [coarse], 1e9)!.level).toBe(2);
    expect(chooseBlock(info, [fine], 10)!.level).toBeGreaterThan(0);
  });
  it("samples the voxel that holds a point (values encode coordinates)", () => {
    // value of voxel (x, y, z) at level 0 = x + 128 y + 16384 z : linear, so
    // trilinear sampling returns the continuous level-0 index exactly
    const [nz, ny, nx] = info.levels[0].shape;
    const data = new Float32Array(nz * ny * nx);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) data[(z * ny + y) * nx + x] = x + 128 * y + 16384 * z;
    const block: Block = { box: { level: 0, start: [0, 0, 0], stop: [nz, ny, nx] }, data };
    const plane = planeFrom(l0ToPhys(info, [60.3, 40.7, 30.2]), [0.2, 1, 0.5], [1, 0, 0]);
    const s: Sampling = { plane, widthUm: 30, px: 7, slabUm: 0 };
    const img = sampleBlock(info, block, s);
    for (const [col, row] of [[0, 0], [3, 3], [6, 2]]) {
      const q = physToL0(info, pixelToPhys(s, col, row));
      expect(img[row * 7 + col]).toBeCloseTo(q[0] + 128 * q[1] + 16384 * q[2], 1);
    }
    // a slab averages symmetric samples: same value on a linear field
    const slab = sampleBlock(info, block, { ...s, slabUm: 10 });
    expect(slab[3 * 7 + 3]).toBeCloseTo(img[3 * 7 + 3], 0);
  });
  it("is NaN outside the block", () => {
    const block: Block = { box: { level: 0, start: [0, 0, 0], stop: [2, 2, 2] }, data: new Uint16Array(8).fill(7) };
    const s: Sampling = { plane: orthoPlane("RAS", "axial", [1, 1, 1]), widthUm: 40, px: 5, slabUm: 0 };
    const img = sampleBlock(info, block, s);
    expect(Number.isNaN(img[0])).toBe(true);
  });
});

describe("display", () => {
  it("blur ignores NaN and keeps constants", () => {
    const img = new Float32Array(25).fill(3);
    img[0] = NaN;
    const b = blurNaN(img, 5, 5, 1.2);
    expect(Number.isNaN(b[0])).toBe(true);
    expect(b[12]).toBeCloseTo(3, 6);
  });
  it("window from finite values", () => {
    expect(windowOf(new Float32Array([NaN, 0, 1, 2, 3, 4]), 0, 100)).toEqual([0, 4]);
  });
});
