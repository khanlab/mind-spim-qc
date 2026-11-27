// Read a zoom at the middle of an image and print its level and cost, with the app's code.
//   npx tsx scripts/zoom-probe.ts <image> [channel]
import h5wasm from "h5wasm/node";
import { FileSystemStore } from "@zarrita/storage";
import { ImsReader } from "../src/readers/ims";
import { OmeZarrReader } from "../src/readers/omezarr";
import { boxCost, type ImageReader } from "../src/readers/types";
import { readZoom, zoomBox } from "../src/analysis/channel";
const [path, ch] = process.argv.slice(2);
let reader: ImageReader;
if (path.endsWith(".ims")) {
  await h5wasm.ready;
  reader = new ImsReader(new h5wasm.File(path, "r"), path);
} else reader = await OmeZarrReader.open(new FileSystemStore(path) as any, path);
const l0 = reader.info.levels[0].shape.map((n) => Math.floor(n / 2)) as [number, number, number];
for (let l = 0; l < reader.info.levels.length; l++) console.log(`level ${l} chunks ${reader.chunks(l)}`);
const box = zoomBox(reader, l0);
console.log("zoom box", box, `${(boxCost(reader, box) / 1e9).toFixed(2)} GB`);
const t = performance.now();
const z = await readZoom(reader, l0, Number(ch ?? 2));
let mx = 0; for (const v of z.volume.data) if (v > mx) mx = v;
console.log(`read ${z.volume.shape} in ${((performance.now() - t) / 1000).toFixed(1)} s; max ${mx}; sharpness ${z.sharpness?.toFixed(2)}; saturated ${z.saturated}`);
