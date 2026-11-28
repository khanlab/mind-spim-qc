/**
 * Resolution on each side of the tissue's midline along x (or y), with the app's code.
 *   npx tsx scripts/sides-probe.ts <image> [channel] [points per side] [x|y]
 */
import h5wasm from "h5wasm/node";
import { FileSystemStore } from "@zarrita/storage";
import { ImsReader } from "../src/readers/ims";
import { OmeZarrReader } from "../src/readers/omezarr";
import { readPlan, type ImageReader } from "../src/readers/types";
import { analyseChannel } from "../src/analysis/channel";
import { measureSides } from "../src/analysis/run";

const [path, ch, nArg, axisArg] = process.argv.slice(2);
let reader: ImageReader;
if (path.endsWith(".ims")) {
  await h5wasm.ready;
  reader = new ImsReader(new h5wasm.File(path, "r"), path);
} else reader = await OmeZarrReader.open(new FileSystemStore(path) as any, path);
const plan = readPlan(reader.info);
const c = Number(ch ?? reader.info.channels.length - 1);
const a = analyseChannel(await reader.read(plan, c, () => {}), plan);
const axis = axisArg === "y" ? 1 : 2;
const r = await measureSides(reader, a.plan, a.mask, axis, Number(nArg ?? 6), c);
const f = (v: number | null | undefined) => (v == null ? "  -  " : v.toFixed(1).padStart(5));
console.log(`split at ${axisArg ?? "x"} = ${r.splitLevel0} (level-0 voxels)`);
for (const [name, s] of [["low ", r.low], ["high", r.high]] as const) {
  console.log(`${name}: spots z ${f(s.z.median)} xy ${f(s.xy.median)} (n ${s.z.n}); extra z spectral ${f(s.extraZFwhm)}; per point extra z: ${s.points.map((p) => f(p.spectral.extraZFwhm)).join(" ")}; z medians: ${s.points.map((p) => f(p.z.median)).join(" ")}`);
}
