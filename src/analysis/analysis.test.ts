import { describe, expect, it } from "vitest";
import { edgeTouchFraction, otsu, spreadCenters, tissueMask, type Shape } from "./mask";
import { axisProfiles, intensityMetrics } from "./metrics";
import { FWHM_PER_SIGMA, averageSpot, fitGaussian1d, measureSpots, summarizeSpots } from "./psf";

let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gaussNoise = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

describe("mask", () => {
  it("finds a bright ball in noise, with holes filled", () => {
    const shape: Shape = [30, 40, 50];
    const data = new Float32Array(30 * 40 * 50);
    let inBall = 0;
    for (let z = 0; z < 30; z++)
      for (let y = 0; y < 40; y++)
        for (let x = 0; x < 50; x++) {
          const r = Math.hypot(z - 15, y - 20, x - 25);
          const ball = r < 10;
          const hole = r < 3; // dark inside, but enclosed
          inBall += ball ? 1 : 0;
          data[(z * 40 + y) * 50 + x] = (ball && !hole ? 1000 : 100) + 10 * gaussNoise();
        }
    const mask = tissueMask(data, shape);
    const n = mask.reduce((a, b) => a + b, 0);
    expect(Math.abs(n - inBall) / inBall).toBeLessThan(0.1);
    expect(mask[(15 * 40 + 20) * 50 + 25]).toBe(1); // the hole is filled
    expect(edgeTouchFraction(mask, shape)).toBe(0);
    const m = intensityMetrics(data, mask)!;
    expect(m.tissueToBackground!).toBeGreaterThan(8);
    expect(m.snr!).toBeGreaterThan(50);
    const centers = spreadCenters(mask, shape, 4);
    expect(centers).toHaveLength(4);
    for (const c of centers) expect(mask[(c[0] * 40 + c[1]) * 50 + c[2]]).toBe(1);
  });

  it("measures attenuation along z", () => {
    const shape: Shape = [20, 10, 10];
    const data = new Float32Array(2000);
    const mask = new Uint8Array(2000).fill(1);
    for (let z = 0; z < 20; z++) for (let i = 0; i < 100; i++) data[z * 100 + i] = 1000 * (1 - z / 40);
    const [pz, py, px] = axisProfiles(data, mask, shape);
    expect(pz.cv!).toBeGreaterThan(0.1);
    expect(py.cv!).toBeLessThan(1e-6);
    expect(px.cv!).toBeLessThan(1e-6);
  });

  it("thresholds two classes between them", () => {
    const v = [...Array(500).fill(10), ...Array(500).fill(90)];
    const t = otsu(v);
    expect(t).toBeGreaterThan(10);
    expect(t).toBeLessThan(90);
  });
});

describe("psf", () => {
  it("fits the sigma of a sampled Gaussian", () => {
    for (const sigma of [0.8, 1.5, 3]) {
      // the window must reach background: +-4 sigma
      const r = Math.ceil(4 * sigma);
      const p = Array.from({ length: 2 * r + 1 }, (_, i) => 50 + 1000 * Math.exp(-((i - r - 0.3) ** 2) / (2 * sigma * sigma)));
      const fit = fitGaussian1d(p, r)!;
      expect(fit.sigma).toBeCloseTo(sigma, 1);
      expect(fit.offset).toBeCloseTo(0.3, 1);
    }
  });

  it("recovers anisotropic blur of point sources in noise", () => {
    // spots blurred with sigma 1.0 voxel in x-y and 2.0 in z; voxels 1.6 um x-y, 2.75 um z
    const shape: Shape = [48, 96, 96];
    const [nz, ny, nx] = shape;
    const vox: Shape = [2.75, 1.6, 1.6];
    const sz = 2.0;
    const sxy = 1.0;
    const block = new Float32Array(nz * ny * nx);
    for (let i = 0; i < block.length; i++) block[i] = 200 + 5 * gaussNoise();
    const centers: Shape[] = [];
    for (let z = 12; z < nz - 12; z += 12)
      for (let y = 14; y < ny - 14; y += 17)
        for (let x = 14; x < nx - 14; x += 17) centers.push([z + rand(), y + rand(), x + rand()]);
    for (const [cz, cy, cx] of centers)
      for (let z = Math.floor(cz) - 8; z <= cz + 8; z++)
        for (let y = Math.floor(cy) - 6; y <= cy + 6; y++)
          for (let x = Math.floor(cx) - 6; x <= cx + 6; x++)
            block[(z * ny + y) * nx + x] +=
              3000 * Math.exp(-((z - cz) ** 2) / (2 * sz * sz) - ((y - cy) ** 2 + (x - cx) ** 2) / (2 * sxy * sxy));

    const spots = measureSpots(block, shape, vox, 65535);
    expect(spots.length).toBeGreaterThanOrEqual(centers.length * 0.9);
    const s = summarizeSpots(spots);
    expect(s.z.median!).toBeCloseTo(sz * FWHM_PER_SIGMA * vox[0], 0);
    expect(s.xy.median!).toBeGreaterThan(0.9 * sxy * FWHM_PER_SIGMA * vox[1]);
    expect(s.xy.median!).toBeLessThan(1.25 * sxy * FWHM_PER_SIGMA * vox[1]);
    const avg = averageSpot(block, shape, spots);
    expect(avg.n).toBeGreaterThan(10);
  });
});
