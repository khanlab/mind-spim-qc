import h5wasm from "h5wasm/node";
await h5wasm.ready;
const f = new h5wasm.File(process.argv[2], "r");
const s = (g, k) => { const v = g.attrs[k]?.value; return Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v).join("") : String(v); };
for (const lvl of f.get("DataSet").keys()) {
  const g = f.get(`DataSet/${lvl}/TimePoint 0/Channel 0`);
  console.log(lvl, Object.fromEntries(Object.keys(g.attrs).map(k => [k, s(g, k)])));
}
for (const c of [0,1,2]) { const g = f.get(`DataSetInfo/Channel ${c}`); console.log("ch", c, Object.keys(g.attrs).join(",")); }
