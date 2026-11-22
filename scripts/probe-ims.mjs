// Probe an Imaris file with h5wasm in Node: metadata + timing of a low-res read.
import h5wasm from "h5wasm/node";
await h5wasm.ready;
const path = process.argv[2];
const t0 = performance.now();
const f = new h5wasm.File(path, "r");
const attr = (g, k) => { const v = g.attrs[k]?.value; return Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v).join("") : String(v); };
const img = f.get("DataSetInfo/Image");
const meta = Object.fromEntries(Object.keys(img.attrs).map(k => [k, attr(img, k)]));
console.log("attrs:", JSON.stringify(meta));
const ds = f.get("DataSet");
for (const lvl of ds.keys()) {
  const d = f.get(`DataSet/${lvl}/TimePoint 0/Channel 0/Data`);
  console.log(lvl, d.shape, d.dtype, "chunks", d.chunks, "filters", JSON.stringify(d.filters));
}
console.log("open+meta ms", (performance.now() - t0).toFixed(0));
const level = process.argv[3] ?? "ResolutionLevel 3";
const d = f.get(`DataSet/${level}/TimePoint 0/Channel 0/Data`);
const t1 = performance.now();
const arr = d.value;
let mx = 0; for (const v of arr) if (v > mx) mx = v;
console.log(level, "read", arr.length, "voxels in", (performance.now() - t1).toFixed(0), "ms; max", mx);
f.close();
