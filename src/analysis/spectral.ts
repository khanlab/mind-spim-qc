/**
 * Blur along z compared with x-y, from the power spectra of a full-resolution block.
 *
 * If the structure of the tissue is statistically isotropic (nuclei, vessels and
 * fibres in all directions), its 1D power spectra along z and along x-y are the
 * same function of physical frequency k; the measured spectra differ only by the
 * blur. With Gaussian PSFs of standard deviations sz and sxy:
 *
 *   ln(Sz(k) / Sxy(k)) = c - (2 pi k)^2 (sz^2 - sxy^2)
 *
 * where S is the power above the noise floor. A line fitted against k^2 over the
 * frequencies where both spectra are well above noise gives the extra blur in z,
 * reported as the FWHM of the Gaussian that, convolved with the x-y blur, gives
 * the z blur: 2.355 sqrt(sz^2 - sxy^2). It does not depend on the size of the
 * objects, but it is biased where the tissue is anisotropic (e.g. layers).
 *
 * Camera noise is white in 3D, so its floor (per sample) is the same along every
 * axis; it is measured at the highest x-y frequencies, which are better sampled
 * than z and mostly noise.
 */
import type { Shape } from "./mask";

const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.log(2));

/** In-place radix-2 FFT of (re, im), length a power of 2. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/**
 * Mean power spectrum of windowed lines of length `len` along an axis of a
 * block (z, y, x), normalized so white noise of variance v gives v at every
 * frequency. Returns powers at frequencies k = i / (len * spacing), i = 0..len/2.
 */
export function axisSpectrum(block: ArrayLike<number>, shape: Shape, axis: number, len: number, maxLines = 4000): Float64Array {
  const [nz, ny, nx] = shape;
  const strides = [nx * ny, nx, 1];
  const n = shape[axis];
  const win = Float64Array.from({ length: len }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / len));
  const wss = win.reduce((a, b) => a + b * b, 0);
  const power = new Float64Array(len / 2 + 1);
  const re = new Float64Array(len);
  const im = new Float64Array(len);
  // line starts: every voxel of the other two axes, and non-overlapping segments along the axis
  const others = [0, 1, 2].filter((a) => a !== axis);
  const starts: number[] = [];
  for (let a = 0; a < shape[others[0]]; a++)
    for (let b = 0; b < shape[others[1]]; b++)
      for (let s = 0; s + len <= n; s += len) starts.push(a * strides[others[0]] + b * strides[others[1]] + s * strides[axis]);
  const step = Math.max(1, Math.floor(starts.length / maxLines));
  let lines = 0;
  for (let k = 0; k < starts.length; k += step) {
    let mean = 0;
    for (let i = 0; i < len; i++) mean += block[starts[k] + i * strides[axis]];
    mean /= len;
    for (let i = 0; i < len; i++) {
      re[i] = (block[starts[k] + i * strides[axis]] - mean) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let i = 0; i <= len / 2; i++) power[i] += (re[i] * re[i] + im[i] * im[i]) / wss;
    lines++;
  }
  void nz;
  if (lines) for (let i = 0; i < power.length; i++) power[i] /= lines;
  return power;
}

export interface Anisotropy {
  /** FWHM (um) of the extra blur along z beyond x-y; negative if x-y is blurrier */
  extraZFwhm: number | null;
  /** sz^2 - sxy^2 (um^2) */
  dSigma2: number | null;
  /** frequencies used, cycles/um, and how many */
  kRange: [number, number] | null;
  points: number;
  /** spectra for plotting: k (cycles/um), signal power above noise along z and x-y */
  k: number[];
  z: number[];
  xy: number[];
  noise: number;
}

const pow2 = (v: number) => 2 ** Math.round(Math.log2(v));

export function zAnisotropy(block: ArrayLike<number>, shape: Shape, voxelSize: Shape, snrMin = 4): Anisotropy {
  const [vz, vy, vx] = voxelSize;
  const vxy = (vy + vx) / 2;
  // lines of about the same physical length along every axis
  const lenZ = Math.min(pow2(shape[0]) > shape[0] ? pow2(shape[0]) / 2 : pow2(shape[0]), 64);
  const lenXY = Math.min(Math.max(8, pow2((lenZ * vz) / vxy)), pow2(Math.min(shape[1], shape[2])) > Math.min(shape[1], shape[2]) ? pow2(Math.min(shape[1], shape[2])) / 2 : pow2(Math.min(shape[1], shape[2])));
  const pz = axisSpectrum(block, shape, 0, lenZ);
  const py = axisSpectrum(block, shape, 1, lenXY);
  const px = axisSpectrum(block, shape, 2, lenXY);
  const pxy = py.map((v, i) => (v + px[i]) / 2);
  // noise floor: the top fifth of x-y frequencies
  const top = pxy.slice(Math.floor(0.8 * pxy.length));
  const noise = top.reduce((a, b) => a + b, 0) / top.length;
  const kz = (i: number) => i / (lenZ * vz);
  const kxy = (i: number) => i / (lenXY * vxy);
  // x-y signal at z frequencies, by linear interpolation of log power
  const sxyAt = (k: number) => {
    const f = k * lenXY * vxy;
    const i = Math.floor(f);
    if (i + 1 >= pxy.length) return NaN;
    const a = Math.max(pxy[i] - noise, 1e-30);
    const b = Math.max(pxy[i + 1] - noise, 1e-30);
    return Math.exp(Math.log(a) + (f - i) * (Math.log(b) - Math.log(a)));
  };
  const xs: number[] = [];
  const ys: number[] = [];
  const ks: number[] = [];
  const zs: number[] = [];
  const xys: number[] = [];
  for (let i = 1; i < pz.length; i++) {
    const k = kz(i);
    const sz = pz[i] - noise;
    const sxy = sxyAt(k);
    ks.push(k);
    zs.push(sz);
    xys.push(sxy);
    // skip the lowest frequencies (window leakage, mean) and anything near noise
    if (i < 2 || !(sz > snrMin * noise) || !(sxy > snrMin * noise)) continue;
    xs.push((2 * Math.PI * k) ** 2);
    ys.push(Math.log(sz / sxy));
  }
  void kxy;
  const base = { k: ks, z: zs, xy: xys, noise };
  if (xs.length < 3) return { extraZFwhm: null, dSigma2: null, kRange: null, points: xs.length, ...base };
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxx = 0;
  let sxy2 = 0;
  xs.forEach((x, i) => ((sxx += (x - mx) ** 2), (sxy2 += (x - mx) * (ys[i] - my))));
  const dSigma2 = -sxy2 / sxx;
  const extraZFwhm = Math.sign(dSigma2) * FWHM_PER_SIGMA * Math.sqrt(Math.abs(dSigma2));
  const kUsed = xs.map((x) => Math.sqrt(x) / (2 * Math.PI));
  return { extraZFwhm, dSigma2, kRange: [Math.min(...kUsed), Math.max(...kUsed)], points: xs.length, ...base };
}
