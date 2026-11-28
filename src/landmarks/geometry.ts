/**
 * Geometry of the landmark viewer, independent of the DOM.
 *
 * Frames
 * - level-0 index (x, y, z): voxel index at full resolution, x the fastest array
 *   axis; integer values are voxel centres. Landmark positions are stored so.
 * - physical (x, y, z) um: level-0 index times the level-0 voxel size, in the
 *   array's own axes (no orientation applied). All planes live here.
 * - level-L index: continuous voxel index at pyramid level L, mapped as in
 *   `boxAround` (level sizes come from the shapes, which also covers pyramids
 *   that do not halve every axis).
 *
 * Every view is a square on a plane (centre, in-plane unit vectors u = screen
 * right and v = screen up, normal n), sampled from a block read at one level,
 * averaged over a slab along n.
 */
import { parse } from "../orientation";
import type { Box, ImageInfo, Voxels } from "../readers/types";
import { VIEW_AXES, type ViewName } from "../views";

export type V3 = [number, number, number];

export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: V3): V3 => scale(a, 1 / (norm(a) || 1));

/** Shape of a level as x, y, z. */
export const shapeXYZ = (info: ImageInfo, level: number): V3 => {
  const s = info.levels[level].shape;
  return [s[2], s[1], s[0]];
};

/** Level-0 voxel size in um, x, y, z. */
export const voxel0 = (info: ImageInfo): V3 => {
  const v = info.levels[0].voxelSize;
  return [v[2], v[1], v[0]];
};

/**
 * Downsampling factor of a level per axis (x, y, z): the integer nearest the
 * shape ratio. Pyramids halve with floor(n / 2) (Imaris) or scale by integer
 * factors (OME-Zarr), so a level-L voxel k covers level-0 voxels
 * [k f, (k + 1) f) exactly; the shape ratio itself drifts (6906 / 215 = 32.12).
 */
export function levelFactor(info: ImageInfo, level: number): V3 {
  const n0 = shapeXYZ(info, 0);
  const nl = shapeXYZ(info, level);
  return [0, 1, 2].map((a) => Math.max(1, Math.round(n0[a] / nl[a]))) as V3;
}

/** Voxel size of a level in um, x, y, z. */
export function levelVoxel(info: ImageInfo, level: number): V3 {
  const f = levelFactor(info, level);
  const v0 = voxel0(info);
  return [0, 1, 2].map((a) => v0[a] * f[a]) as V3;
}

export const l0ToPhys = (info: ImageInfo, p: V3): V3 => {
  const v = voxel0(info);
  return [p[0] * v[0], p[1] * v[1], p[2] * v[2]];
};

export const physToL0 = (info: ImageInfo, p: V3): V3 => {
  const v = voxel0(info);
  return [p[0] / v[0], p[1] / v[1], p[2] / v[2]];
};

/** Per-axis affine physical -> level index: idx = p * s + b (level-0 index i -> (i + 0.5) / f - 0.5). */
export function levelMap(info: ImageInfo, level: number): { s: V3; b: V3 } {
  const f = levelFactor(info, level);
  const v0 = voxel0(info);
  const s = [0, 1, 2].map((a) => 1 / (f[a] * v0[a])) as V3;
  const b = [0, 1, 2].map((a) => 0.5 / f[a] - 0.5) as V3;
  return { s, b };
}

export function physToLevel(info: ImageInfo, level: number, p: V3): V3 {
  const { s, b } = levelMap(info, level);
  return [p[0] * s[0] + b[0], p[1] * s[1] + b[1], p[2] * s[2] + b[2]];
}

export interface Plane {
  center: V3;
  u: V3;
  v: V3;
  n: V3;
}

/** What to draw: a square of `widthUm` on a plane, `px` pixels across, averaged over `slabUm`. */
export interface Sampling {
  plane: Plane;
  widthUm: number;
  px: number;
  slabUm: number;
}

/** A plane from a normal and a hint for screen-right; v = n x u keeps screen-up consistent. */
export function planeFrom(center: V3, n: V3, uHint: V3): Plane {
  const nn = normalize(n);
  const u = normalize(sub(uHint, scale(nn, dot(uHint, nn))));
  return { center, u, v: cross(nn, u), n: nn };
}

/** Physical direction of a RAS axis (0 = R, 1 = A, 2 = S) under an orientation string. */
export function rasAxis(orientation: string, k: number): V3 {
  const d = parse(orientation); // d[i] = RAS vector of image axis i (X, Y, Z)
  return [d[0][k], d[1][k], d[2][k]];
}

/** The standard anatomical view through `center` (neurological convention, as the QC views). */
export function orthoPlane(orientation: string, view: ViewName, center: V3): Plane {
  const [h, v, t] = VIEW_AXES[view];
  return { center, u: rasAxis(orientation, h), v: rasAxis(orientation, v), n: rasAxis(orientation, t) };
}

/** Physical position of a canvas pixel (pixel centres at +0.5). */
export function pixelToPhys(s: Sampling, col: number, row: number, depth = 0): V3 {
  const a = ((col + 0.5) / s.px - 0.5) * s.widthUm;
  const b = (0.5 - (row + 0.5) / s.px) * s.widthUm;
  const p = s.plane;
  return add(add(add(p.center, scale(p.u, a)), scale(p.v, b)), scale(p.n, depth));
}

/** Canvas pixel (fractional) and depth along n of a physical point. */
export function physToPixel(s: Sampling, q: V3): { col: number; row: number; depth: number } {
  const d = sub(q, s.plane.center);
  return {
    col: (dot(d, s.plane.u) / s.widthUm + 0.5) * s.px - 0.5,
    row: (0.5 - dot(d, s.plane.v) / s.widthUm) * s.px - 0.5,
    depth: dot(d, s.plane.n),
  };
}

/** Physical bounding box of a sampling (the square, thickened by the slab). */
export function samplingBounds(s: Sampling): { lo: V3; hi: V3 } {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  const h = s.widthUm / 2;
  for (const a of [-h, h])
    for (const b of [-h, h])
      for (const c of [-s.slabUm / 2, s.slabUm / 2]) {
        const q = add(add(add(s.plane.center, scale(s.plane.u, a)), scale(s.plane.v, b)), scale(s.plane.n, c));
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], q[k]);
          hi[k] = Math.max(hi[k], q[k]);
        }
      }
  return { lo, hi };
}

/** Box (z, y, x, at `level`) covering physical bounds plus a margin of voxels, inside the image. */
export function boxForBounds(info: ImageInfo, level: number, lo: V3, hi: V3, margin = 2): Box | null {
  const a = physToLevel(info, level, lo);
  const b = physToLevel(info, level, hi);
  const n = shapeXYZ(info, level);
  const start: V3 = [0, 0, 0];
  const stop: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    start[k] = Math.max(0, Math.floor(Math.min(a[k], b[k])) - margin);
    stop[k] = Math.min(n[k], Math.ceil(Math.max(a[k], b[k])) + 1 + margin);
    if (stop[k] <= start[k]) return null;
  }
  return { level, start: [start[2], start[1], start[0]], stop: [stop[2], stop[1], stop[0]] };
}

export const boxVoxels = (b: Box) => (b.stop[0] - b.start[0]) * (b.stop[1] - b.start[1]) * (b.stop[2] - b.start[2]);

/**
 * The level and box to read for some samplings: the coarsest level whose in-plane
 * voxel is still at most one display pixel (no point reading finer), then coarser
 * until the box fits the voxel budget.
 */
export function chooseBlock(info: ImageInfo, samplings: Sampling[], budget: number, minLevel = 0): Box | null {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const s of samplings) {
    const b = samplingBounds(s);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], b.lo[k]);
      hi[k] = Math.max(hi[k], b.hi[k]);
    }
  }
  const pxUm = Math.min(...samplings.map((s) => s.widthUm / s.px));
  let level = minLevel;
  for (let l = minLevel; l < info.levels.length; l++) {
    const v = levelVoxel(info, l);
    if (Math.min(v[0], v[1]) <= pxUm * 1.01) level = l;
  }
  for (let l = level; l < info.levels.length; l++) {
    const box = boxForBounds(info, l, lo, hi);
    if (box && boxVoxels(box) <= budget) return box;
  }
  return boxForBounds(info, info.levels.length - 1, lo, hi);
}

/** A block of voxels read at one level. */
export interface Block {
  box: Box;
  /** z, y, x as read */
  data: Voxels;
}

/** Pixel rectangle [col0, row0, col1, row1) of a view that a tile block was read for. */
export type Roi = [number, number, number, number];

/** A plane sampled from one block: see `sampleInto`. */
export function sampleBlock(info: ImageInfo, block: Block, s: Sampling): Float32Array {
  const out = new Float32Array(s.px * s.px).fill(NaN);
  sampleInto(info, block, s, out);
  return out;
}

/**
 * Samples a block on a plane into `out` (px x px): trilinear, averaged over the
 * slab (samples one level voxel apart). Writes only pixels still NaN in `out`
 * that the block covers, so tiles can be merged; `roi` limits the pixels visited.
 */
export function sampleInto(info: ImageInfo, block: Block, s: Sampling, out: Float32Array, roi?: Roi) {
  const { box, data } = block;
  const [z0, y0, x0] = box.start;
  const nz = box.stop[0] - z0;
  const ny = box.stop[1] - y0;
  const nx = box.stop[2] - x0;
  const { s: sc, b: bc } = levelMap(info, box.level);
  const vox = levelVoxel(info, box.level);
  const step = Math.min(...vox);
  const ns = Math.max(1, Math.round(s.slabUm / step));
  const depths = Array.from({ length: ns }, (_, i) => (ns === 1 ? 0 : -s.slabUm / 2 + (i * s.slabUm) / (ns - 1)));
  const [c0, r0, c1, r1] = roi ?? [0, 0, s.px, s.px];
  const w = c1 - c0;
  const p = s.plane;
  const du = scale(p.u, s.widthUm / s.px);
  const dv = scale(p.v, -s.widthUm / s.px);
  const origin = pixelToPhys(s, 0, 0);
  const toIdx = (q: V3): V3 => [q[0] * sc[0] + bc[0] - x0, q[1] * sc[1] + bc[1] - y0, q[2] * sc[2] + bc[2] - z0];
  const dui: V3 = [du[0] * sc[0], du[1] * sc[1], du[2] * sc[2]];
  const dvi: V3 = [dv[0] * sc[0], dv[1] * sc[1], dv[2] * sc[2]];
  const nyx = ny * nx;
  const sum = new Float32Array(w * (r1 - r0));
  const cnt = new Uint16Array(w * (r1 - r0));
  const gx = nx > 1 ? 1 : 0;
  const gy = ny > 1 ? nx : 0;
  const gz = nz > 1 ? nyx : 0;
  const mx = Math.max(0, nx - 2);
  const my = Math.max(0, ny - 2);
  const mz = Math.max(0, nz - 2);
  for (const d of depths) {
    const q0 = toIdx(add(origin, scale(p.n, d)));
    for (let row = r0; row < r1; row++) {
      const rx = q0[0] + row * dvi[0];
      const ry = q0[1] + row * dvi[1];
      const rz = q0[2] + row * dvi[2];
      for (let col = c0; col < c1; col++) {
        if (!Number.isNaN(out[row * s.px + col])) continue;
        const x = rx + col * dui[0];
        const y = ry + col * dui[1];
        const z = rz + col * dui[2];
        if (x < 0 || y < 0 || z < 0 || x > nx - 1 || y > ny - 1 || z > nz - 1) continue;
        const xi = Math.min(Math.floor(x), mx);
        const yi = Math.min(Math.floor(y), my);
        const zi = Math.min(Math.floor(z), mz);
        const fx = gx ? x - xi : 0;
        const fy = gy ? y - yi : 0;
        const fz = gz ? z - zi : 0;
        const i000 = zi * nyx + yi * nx + xi;
        const c00 = data[i000] * (1 - fx) + data[i000 + gx] * fx;
        const c10 = data[i000 + gy] * (1 - fx) + data[i000 + gy + gx] * fx;
        const c01 = data[i000 + gz] * (1 - fx) + data[i000 + gz + gx] * fx;
        const c11 = data[i000 + gz + gy] * (1 - fx) + data[i000 + gz + gy + gx] * fx;
        const k = (row - r0) * w + (col - c0);
        sum[k] += (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
        cnt[k]++;
      }
    }
  }
  // a pixel is taken from this block only when every slab sample fell inside it
  for (let row = r0; row < r1; row++)
    for (let col = c0; col < c1; col++) {
      const k = (row - r0) * w + (col - c0);
      if (cnt[k] === ns) out[row * s.px + col] = sum[k] / ns;
    }
}

/** Tiles of a sampling: n x n sub-squares, as samplings of their own and the pixels they cover. */
export function tiles(s: Sampling, n: number): { sub: Sampling; roi: Roi }[] {
  const out: { sub: Sampling; roi: Roi }[] = [];
  const edges = Array.from({ length: n + 1 }, (_, i) => Math.round((i * s.px) / n));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const roi: Roi = [edges[j], edges[i], edges[j + 1], edges[i + 1]];
      const cc = (roi[0] + roi[2]) / 2 - 0.5;
      const rr = (roi[1] + roi[3]) / 2 - 0.5;
      const w = ((roi[2] - roi[0]) * s.widthUm) / s.px;
      out.push({ sub: { ...s, plane: { ...s.plane, center: pixelToPhys(s, cc, rr) }, widthUm: w, px: roi[2] - roi[0] }, roi });
    }
  return out;
}

/** Gaussian blur of a w x h image that ignores NaN (normalised convolution). */
export function blurNaN(img: Float32Array, w: number, h: number, sigmaPx: number): Float32Array {
  if (sigmaPx <= 0.3) return img;
  const r = Math.ceil(3 * sigmaPx);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigmaPx * sigmaPx)));
  const pass = (src: Float32Array, wt: Float32Array, horiz: boolean) => {
    const o = new Float32Array(w * h);
    const ow = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        let sw = 0;
        for (let j = -r; j <= r; j++) {
          const xx = horiz ? x + j : x;
          const yy = horiz ? y : y + j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const i = yy * w + xx;
          s += k[j + r] * src[i];
          sw += k[j + r] * wt[i];
        }
        o[y * w + x] = s;
        ow[y * w + x] = sw;
      }
    return [o, ow] as const;
  };
  const v0 = new Float32Array(w * h);
  const w0 = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const ok = Number.isFinite(img[i]);
    v0[i] = ok ? img[i] : 0;
    w0[i] = ok ? 1 : 0;
  }
  const [a, aw] = pass(v0, w0, true);
  const [b, bw] = pass(a, aw, false);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = w0[i] && bw[i] > 1e-6 ? b[i] / bw[i] : NaN;
  return out;
}

/** Display window from percentiles of the finite values. */
export function windowOf(img: Float32Array, lo = 0.5, hi = 99.7): [number, number] {
  const v = Array.from(img).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [0, 1];
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round((p / 100) * (v.length - 1))))];
  const a = q(lo);
  const b = q(hi);
  return b > a ? [a, b] : [a, a + 1];
}
