/**
 * Overview metrics and PSF estimate of an image in Node, with the app's code.
 *   npx tsx scripts/psf-probe.ts <image.ims|folder.ome.zarr> [points=6] [channels=all]
 */
import h5wasm from "h5wasm/node";
import { FileSystemStore } from "@zarrita/storage";
import { ImsReader } from "../src/readers/ims";
import { OmeZarrReader } from "../src/readers/omezarr";
import { coarserPlan, readPlan, stepVolume, type ImageReader } from "../src/readers/types";
import { edgeTouchFraction, tissueMask } from "../src/analysis/mask";
import { axisProfiles, intensityMetrics } from "../src/analysis/metrics";
import { measurePsf, psfCost, psfPoints } from "../src/analysis/run";

const [path, nArg, chArg] = process.argv.slice(2);
let reader: ImageReader;
if (path.endsWith(".ims")) {
  await h5wasm.ready;
  reader = new ImsReader(new h5wasm.File(path, "r"), path);
} else reader = await OmeZarrReader.open(new FileSystemStore(path) as any, path);
const info = reader.info;
const plan = readPlan(info);
const channels = chArg ? chArg.split(",").map(Number) : info.channels.map((_, i) => i);
const f = (v: number | null | undefined, d = 1) => (v == null ? "-" : v.toFixed(d));
console.log(`voxel (z,y,x) ${info.levels[0].voxelSize.map((v) => v.toFixed(2))} um; overview level ${plan.level} step ${plan.step}`);
for (const c of channels) {
  let t = performance.now();
  const overview = await reader.read(plan, c, () => {});
  const tr = performance.now() - t;
  const { plan: aplan, factor } = coarserPlan(plan, 4e6);
  const vol = stepVolume(overview, factor);
  const mask = tissueMask(vol.data, vol.shape);
  const m = intensityMetrics(vol.data, mask)!;
  const prof = axisProfiles(vol.data, mask, vol.shape);
  const vox = aplan.voxelSize.reduce((a, b) => a * b, 1) / 1e9;
  const nMask = mask.reduce((a, b) => a + b, 0);
  console.log(`\n## ${info.channels[c].name}: read ${tr.toFixed(0)} ms, metrics ${(performance.now() - t - tr).toFixed(0)} ms`);
  console.log(`  SNR ${f(m.snr)}  tissue/bg ${f(m.tissueToBackground, 2)}  range ${f(m.signalRange, 2)}  CV z,y,x ${prof.map((p) => f(p.cv, 3))}  volume ${f(nMask * vox, 0)} mm3  edge ${f(edgeTouchFraction(mask, vol.shape), 3)}`);
  const points = psfPoints(mask, aplan, Number(nArg ?? 6));
  console.log(`  PSF: ${points.length} points, ${(psfCost(reader, aplan, points) / 1e9).toFixed(2)} GB to decode`);
  t = performance.now();
  const r = await measurePsf(reader, aplan, points, c);
  console.log(`  PSF in ${((performance.now() - t) / 1000).toFixed(1)} s: FWHM z q25/median ${f(r.z.q25)}/${f(r.z.median)} um (n ${r.z.n}), xy ${f(r.xy.q25)}/${f(r.xy.median)} um (n ${r.xy.n}), avg spot n ${r.average.n}; spectral extra z blur ${f(r.extraZFwhm)} um`);
  for (const p of r.points) console.log(`    at ${p.level0}: spots ${p.spots}  z ${f(p.z.q25)}/${f(p.z.median)}  xy ${f(p.xy.q25)}/${f(p.xy.median)}  sat ${f((p.saturated ?? 0) * 100, 3)}%  spectral extra z ${f(p.spectral.extraZFwhm)} um (${p.spectral.points} freqs ${p.spectral.kRange?.map((k) => k.toFixed(3)).join("-") ?? ""} cyc/um)`);
}
