// Runs the in-browser affine registration in Node on a dumped subject volume and
// compares it, at template points, with an affine fitted to SPIMquant's warp.
//   npx tsx scripts/reg-probe.ts /local/scratch/tmp/regval/AS40F2
import { readFileSync } from "node:fs";
import { apply, inv, mul, registerAffine, type Grid, type M4 } from "../src/registration/affine";
import { gunzip, parseNifti } from "../src/registration/nifti";
import { rasAxis } from "../src/landmarks/geometry";

const base = process.argv[2];
const meta = JSON.parse(readFileSync(base + ".json", "utf8"));
const raw = readFileSync(base + ".raw");
const data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const [nx, ny, nz] = meta.dims;
const f = 2 ** meta.level;
const v0: number[] = meta.v0_mm;
// subject world = R (i0 * v0), i0 = f j + (f - 1) / 2  (R from the orientation string)
const R = [0, 1, 2].map((k) => rasAxis(meta.orientation, k)); // R[k] = physical dir of RAS axis k
// world_k = sum_a R[k][a] * i0_a * v0_a
const idx0ToWorld: M4 = [
  R[0][0] * v0[0], R[0][1] * v0[1], R[0][2] * v0[2], 0,
  R[1][0] * v0[0], R[1][1] * v0[1], R[1][2] * v0[2], 0,
  R[2][0] * v0[0], R[2][1] * v0[1], R[2][2] * v0[2], 0,
  0, 0, 0, 1,
];
const levelToIdx0: M4 = [f, 0, 0, (f - 1) / 2, 0, f, 0, (f - 1) / 2, 0, 0, f, (f - 1) / 2, 0, 0, 0, 1];
const sub: Grid = { dims: [nx, ny, nz], data, vox2world: mul(idx0ToWorld, levelToIdx0) };

const load = async (p: string) => {
  const b = readFileSync(p);
  const nii = parseNifti(await gunzip(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
  return { dims: nii.dims, data: nii.data, vox2world: nii.affine } as Grid;
};
const tpl = await load("public/templates/ABAv3/tpl-ABAv3_res-100um_anat.nii.gz");
const tplMask = await load("public/templates/ABAv3/tpl-ABAv3_res-100um_desc-brain_mask.nii.gz");

const res = registerAffine(tpl, tplMask, sub, { log: (m) => console.log("  " + m) });
const ours = mul(inv(idx0ToWorld), res.T); // template mm -> level-0 index
const truth: M4 = meta.truth_tpl2idx0;
const errs = (meta.points as number[][]).map((p) => {
  const a = apply(ours, p);
  const b = apply(truth, p);
  return Math.hypot(...[0, 1, 2].map((k) => (a[k] - b[k]) * v0[k] * 1000));
});
errs.sort((a, b) => a - b);
const q = (x: number) => errs[Math.floor(x * (errs.length - 1))];
console.log(`${base}: vs affine fit of SPIMquant warp (itself ${meta.affine_fit_residual_um.toFixed(0)} um from the warp): ` +
  `median ${q(0.5).toFixed(0)} um, 90% ${q(0.9).toFixed(0)} um, max ${q(1).toFixed(0)} um over ${errs.length} points; overlap ${(100 * res.overlap).toFixed(0)} %`);

// diagnostics: how well does the TRUTH overlap, by the same measure?
import { maskOf, toResolution, blur, sample as samp, stageCosts } from "../src/registration/affine";
const sub200 = blur(toResolution(sub, 0.2), 0.2);
const sm = maskOf(sub200);
const frac = sm.data.reduce((a, b) => a + b, 0) / sm.data.length;
const tm = toResolution(tplMask, 0.2);
const overlapOf = (T: M4) => {
  const M = mul(inv(sm.vox2world), T);
  let n = 0, inside = 0;
  for (let z = 0; z < tm.dims[2]; z++) for (let y = 0; y < tm.dims[1]; y++) for (let x = 0; x < tm.dims[0]; x++) {
    if (tm.data[x + tm.dims[0] * (y + tm.dims[1] * z)] < 0.5) continue;
    n++;
    const q = apply(M, apply(tm.vox2world, [x, y, z]));
    if (samp(sm, q[0], q[1], q[2]) > 0.5) inside++;
  }
  return inside / n;
};
console.log(`subject mask fraction ${(100 * frac).toFixed(0)} %; overlap truth ${(100 * overlapOf(mul(idx0ToWorld, truth))).toFixed(0)} %, ours ${(100 * overlapOf(res.T)).toFixed(0)} %`);
const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(4)}`).join(", ");
console.log("costs truth:", fmt(stageCosts(tpl, tplMask, sub, mul(idx0ToWorld, truth))));
console.log("costs ours: ", fmt(stageCosts(tpl, tplMask, sub, res.T)));
{
  const d = (meta.points as number[][]).map((p) => { const a = apply(ours, p); const b = apply(truth, p); return [0, 1, 2].map((k) => (a[k] - b[k]) * v0[k] * 1000); });
  const mean = [0, 1, 2].map((k) => d.reduce((s, x) => s + x[k], 0) / d.length);
  const sd = [0, 1, 2].map((k) => Math.sqrt(d.reduce((s, x) => s + (x[k] - mean[k]) ** 2, 0) / d.length));
  console.log(`signed difference ours - truth (array x, y, z um): mean ${mean.map((v) => v.toFixed(0)).join(", ")}; sd ${sd.map((v) => v.toFixed(0)).join(", ")}`);
}
import { writeFileSync } from "node:fs";
writeFileSync(base + "_ours.json", JSON.stringify({ tpl2idx0: ours }));
