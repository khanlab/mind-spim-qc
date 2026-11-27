import { describe, expect, it } from "vitest";
import { type Shape } from "./mask";
import { zAnisotropy } from "./spectral";

let seed = 11;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gn = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

/**
 * Isotropic objects (round blobs of sigma 2 um at random positions, many
 * overlapping) seen through a Gaussian PSF: each blob in the image is a Gaussian
 * whose sigma per axis is sqrt(object^2 + psf^2), evaluated exactly at voxel centres.
 */
function blobs(shape: Shape, vox: Shape, psf: Shape, count: number): Float32Array {
  const [nz, ny, nx] = shape;
  const img = new Float32Array(nz * ny * nx);
  const s = psf.map((p) => Math.sqrt(4 + p * p));
  const r = s.map((v, a) => Math.ceil((4 * v) / vox[a]));
  seed = 5;
  for (let b = 0; b < count; b++) {
    const c = shape.map((n) => rand() * n);
    const amp = 0.5 + rand();
    const z0 = Math.floor(c[0]), y0 = Math.floor(c[1]), x0 = Math.floor(c[2]);
    for (let z = Math.max(0, z0 - r[0]); z <= Math.min(nz - 1, z0 + r[0]); z++) {
      const ez = (((z - c[0]) * vox[0]) / s[0]) ** 2;
      for (let y = Math.max(0, y0 - r[1]); y <= Math.min(ny - 1, y0 + r[1]); y++) {
        const ey = (((y - c[1]) * vox[1]) / s[1]) ** 2;
        for (let x = Math.max(0, x0 - r[2]); x <= Math.min(nx - 1, x0 + r[2]); x++)
          img[(z * ny + y) * nx + x] += amp * Math.exp(-0.5 * (ez + ey + (((x - c[2]) * vox[2]) / s[2]) ** 2));
      }
    }
  }
  return img;
}

describe("z anisotropy from spectra", () => {
  const vox: Shape = [2.75, 1.6, 1.6];
  const shape: Shape = [64, 128, 128];

  for (const [psfZ, psfXY] of [
    [6, 1.2],
    [3, 1.2],
    [1.2, 1.2],
  ]) {
    it(`finds the extra z blur with sigma z ${psfZ} um, x-y ${psfXY} um`, () => {
      const img = blobs(shape, vox, [psfZ, psfXY, psfXY], 15000);
      const noisy = img.map((v) => 100 + 50 * v + 0.5 * gn());
      const r = zAnisotropy(noisy, shape, vox);
      const expected = 2.3548 * Math.sqrt(psfZ ** 2 - psfXY ** 2);
      expect(r.extraZFwhm).not.toBeNull();
      expect(Math.abs(r.extraZFwhm! - expected)).toBeLessThan(Math.max(1.5, 0.15 * expected));
    });
  }
});
