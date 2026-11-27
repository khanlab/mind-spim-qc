// Open an OME-Zarr folder in Node with the app's reader, print info and read the overview.
import { FileSystemStore } from "@zarrita/storage";
import { OmeZarrReader } from "../src/readers/omezarr";
import { readPlan } from "../src/readers/types";
const path = process.argv[2];
const t0 = performance.now();
const r = await OmeZarrReader.open(new FileSystemStore(path) as any, path.split("/").pop()!);
console.log(JSON.stringify(r.info, null, 1).slice(0, 1500));
const plan = readPlan(r.info);
console.log("plan", plan, "open ms", (performance.now() - t0).toFixed(0));
const t1 = performance.now();
const v = await r.read(plan, 2, (f) => process.stdout.write(`${(f * 100).toFixed(0)}% `));
let mx = 0; for (const x of v.data) if (x > mx) mx = x;
console.log("\nread", v.data.length, "voxels in", (performance.now() - t1).toFixed(0), "ms, max", mx);
