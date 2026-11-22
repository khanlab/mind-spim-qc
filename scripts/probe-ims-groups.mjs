import h5wasm from "h5wasm/node";
await h5wasm.ready;
const f = new h5wasm.File(process.argv[2], "r");
const s = (g, k) => { const v = g.attrs[k]?.value; return Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v).join("") : String(v); };
for (const p of ["/", "DataSetInfo/Imaris", "DataSetInfo/ImarisDataSet", "DataSetInfo/Log", "DataSetInfo/Pixels"]) {
  const g = f.get(p); if (!g) continue;
  const a = Object.fromEntries(Object.keys(g.attrs).map(k => [k, s(g, k).slice(0, 160)]));
  console.log(p, JSON.stringify(a));
}
