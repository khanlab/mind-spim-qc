/**
 * Render the coronal, sagittal and axial MIPs of an image (Imaris file or
 * OME-Zarr folder) under an orientation string to a PNG, with the same code as
 * the web app, to check orientations without a browser. Orientation "file" uses
 * the one stored in the image.
 *
 *   npx tsx scripts/render-views.ts image RAI out.png [channel]
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import h5wasm from "h5wasm/node";
import { FileSystemStore } from "@zarrita/storage";
import { ImsReader } from "../src/readers/ims";
import { OmeZarrReader } from "../src/readers/omezarr";
import { readPlan, type ImageReader } from "../src/readers/types";
import { arrayMips, autoWindow, composite, viewPlane, type ViewName } from "../src/views";

const [path, orientationArg, out, channelArg] = process.argv.slice(2);
let reader: ImageReader;
if (path.endsWith(".ims")) {
  await h5wasm.ready;
  reader = new ImsReader(new h5wasm.File(path, "r"), path);
} else reader = await OmeZarrReader.open(new FileSystemStore(path), path);
const info = reader.info;
const orientation = orientationArg === "file" ? info.orientation! : orientationArg;
const plan = readPlan(info, Number(process.env.BUDGET ?? 8 * 1024 * 1024));
const channel = Number(channelArg ?? info.channels.length - 1);
const t0 = performance.now();
const vol = await reader.read(plan, channel, () => {});
const mips = arrayMips(vol);
console.log(`${orientation}: level ${plan.level} step ${plan.step} ${vol.shape} voxel ${vol.voxelSize.map((v) => v.toFixed(1))} um, read ${(performance.now() - t0).toFixed(0)} ms`);

// each view resampled to square pixels of `px` um (nearest neighbour), side by side
const views: ViewName[] = ["coronal", "sagittal", "axial"];
const planes = views.map((v) => viewPlane(vol, mips, orientation, v, "mip"));
const px = Math.min(...planes.flatMap((p) => p.pixelSize));
const imgs = planes.map((p) => {
  const w = Math.round((p.width * p.pixelSize[0]) / px);
  const h = Math.round((p.height * p.pixelSize[1]) / px);
  const rgba = composite([{ plane: p, window: autoWindow(p.values), color: [1, 1, 1] }]);
  return { w, h, at: (x: number, y: number) => 4 * (Math.floor((y * p.height) / h) * p.width + Math.floor((x * p.width) / w)), rgba };
});
const gap = 8;
const W = imgs.reduce((s, i) => s + i.w + gap, gap);
const H = Math.max(...imgs.map((i) => i.h)) + 2 * gap;
const raw = Buffer.alloc((W * 3 + 1) * H, 40);
for (let y = 0; y < H; y++) raw[y * (W * 3 + 1)] = 0;
let x0 = gap;
for (const im of imgs) {
  for (let y = 0; y < im.h; y++)
    for (let x = 0; x < im.w; x++) {
      const s = im.at(x, y);
      const d = (y + gap) * (W * 3 + 1) + 1 + (x0 + x) * 3;
      raw[d] = im.rgba[s]; raw[d + 1] = im.rgba[s + 1]; raw[d + 2] = im.rgba[s + 2];
    }
  x0 += im.w + gap;
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => { const t = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(t)); return Buffer.concat([len, t, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
console.log("wrote", out, W, "x", H, "views: coronal (L|R, S top) | sagittal (P|A, S top) | axial (L|R, A top)");
