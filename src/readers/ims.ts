/**
 * Imaris (.ims) files: HDF5, with a resolution pyramid at
 * DataSet/ResolutionLevel N/TimePoint T/Channel C/Data (z, y, x).
 *
 * Stored datasets are padded to whole chunks; the image size of each level is in
 * the ImageSizeX/Y/Z attributes of its Channel group, and the physical extent in
 * DataSetInfo/Image ExtMin0..2 / ExtMax0..2 (X, Y, Z). Imaris stores attribute
 * strings as arrays of single characters.
 *
 * Works on an h5wasm File in Node or in a browser worker.
 */
import type { File as H5File, Group, Dataset } from "h5wasm";
import type { Box, ChannelInfo, ImageInfo, ImageReader, LevelInfo, Progress, ReadPlan, Volume, Voxels } from "./types";

function attrString(g: Group | Dataset, key: string): string | undefined {
  const a = g.attrs[key];
  if (!a) return undefined;
  const v = a.value as unknown;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<unknown>).join("");
  return String(v);
}

function attrNumber(g: Group | Dataset, key: string): number {
  const s = attrString(g, key);
  const n = s === undefined ? NaN : Number(s);
  if (!Number.isFinite(n)) throw new Error(`Imaris attribute ${key} is missing or not a number`);
  return n;
}

function group(f: H5File, path: string): Group {
  const g = f.get(path);
  if (!g || !("keys" in g) || "shape" in g) throw new Error(`Not an Imaris file: no group ${path}`);
  return g as Group;
}

function dataset(f: H5File, level: number, channel: number, timepoint = 0): Dataset {
  const path = `DataSet/ResolutionLevel ${level}/TimePoint ${timepoint}/Channel ${channel}/Data`;
  const d = f.get(path);
  if (!d || !("shape" in d)) throw new Error(`Missing dataset ${path}`);
  return d as Dataset;
}

const DTYPES: Record<string, ImageInfo["dtype"]> = {
  "<B": "uint8",
  "|B": "uint8",
  "<H": "uint16",
  "<f": "float32",
};

export function readImsInfo(f: H5File, name: string): ImageInfo {
  const image = group(f, "DataSetInfo/Image");
  const unit = attrString(image, "Unit") ?? "um";
  const toUm = unit === "nm" ? 1e-3 : unit === "mm" ? 1e3 : 1;
  // physical extent of the image, X, Y, Z
  const extent = [0, 1, 2].map(
    (i) => (attrNumber(image, `ExtMax${i}`) - attrNumber(image, `ExtMin${i}`)) * toUm,
  );

  const nLevels = group(f, "DataSet").keys().length;
  const levels: LevelInfo[] = [];
  for (let l = 0; l < nLevels; l++) {
    const ch = group(f, `DataSet/ResolutionLevel ${l}/TimePoint 0/Channel 0`);
    const xyz = ["X", "Y", "Z"].map((a) => attrNumber(ch, `ImageSize${a}`));
    levels.push({
      shape: [xyz[2], xyz[1], xyz[0]],
      voxelSize: [extent[2] / xyz[2], extent[1] / xyz[1], extent[0] / xyz[0]],
    });
  }

  const nChannels = group(f, "DataSet/ResolutionLevel 0/TimePoint 0").keys().length;
  const channels: ChannelInfo[] = [];
  for (let c = 0; c < nChannels; c++) {
    const g = f.get(`DataSetInfo/Channel ${c}`) as Group | null;
    let chName = g ? attrString(g, "Name") : undefined;
    if (!chName || chName === "(name not specified)") chName = `Channel ${c}`;
    const color = g ? attrString(g, "Color")?.trim().split(/\s+/).map(Number) : undefined;
    channels.push({
      name: chName,
      color: color?.length === 3 && color.every(Number.isFinite) ? (color as [number, number, number]) : undefined,
    });
  }

  const dtype = DTYPES[dataset(f, 0, 0).dtype as string];
  if (!dtype) throw new Error(`Unsupported data type ${dataset(f, 0, 0).dtype}`);

  const metadata: Record<string, string> = {};
  for (const k of ["Name", "RecordingDate", "OriginalFormatFileIOVersion", "Unit"]) {
    const v = attrString(image, k);
    if (v) metadata[k] = v;
  }
  const dsInfo = f.get("DataSetInfo/ImarisDataSet") as Group | null;
  const creator = dsInfo ? attrString(dsInfo, "Creator") : undefined;
  if (creator) metadata.Creator = creator;
  return { format: "imaris", name, dtype, channels, levels, metadata };
}

/** Reads one channel of a level in slabs along z, with progress, stepping as planned. */
export function readImsVolume(f: H5File, info: ImageInfo, plan: ReadPlan, channel: number, progress: Progress = () => {}): Volume {
  const [nz, ny, nx] = info.levels[plan.level].shape;
  const [sz, sy, sx] = plan.step;
  const [oz, oy, ox] = plan.shape;
  const d = dataset(f, plan.level, channel);
  // slabs of about 1/20 of the image, a whole number of z steps
  const slab = Math.max(sz, Math.ceil(Math.ceil(nz / 20) / sz) * sz);
  let out: Voxels | null = null;
  for (let z0 = 0; z0 < nz; z0 += slab) {
    const z1 = Math.min(nz, z0 + slab);
    const part = d.slice([[z0, z1], [0, ny], [0, nx]]) as unknown as Voxels;
    if (!out) out = new (part.constructor as new (n: number) => Voxels)(oz * oy * ox);
    for (let z = z0; z < z1; z += sz) {
      const zi = z / sz;
      for (let y = 0, yi = 0; y < ny; y += sy, yi++) {
        const src = ((z - z0) * ny + y) * nx;
        const dst = (zi * oy + yi) * ox;
        if (sx === 1) out.set(part.subarray(src, src + nx), dst);
        else for (let x = 0, xi = 0; x < nx; x += sx, xi++) out[dst + xi] = part[src + x];
      }
    }
    progress(z1 / nz);
  }
  return { shape: plan.shape, voxelSize: plan.voxelSize, data: out! };
}

export class ImsReader implements ImageReader {
  info: ImageInfo;
  constructor(private file: H5File, name: string) {
    this.info = readImsInfo(file, name);
  }
  async read(plan: ReadPlan, channel: number, progress: Progress) {
    return readImsVolume(this.file, this.info, plan, channel, progress);
  }
  async readBox(box: Box, channel: number): Promise<Volume> {
    const d = dataset(this.file, box.level, channel);
    const data = d.slice([0, 1, 2].map((a) => [box.start[a], box.stop[a]])) as unknown as Voxels;
    const shape = box.stop.map((v, a) => v - box.start[a]) as [number, number, number];
    return { shape, voxelSize: this.info.levels[box.level].voxelSize, data };
  }
  chunks(level: number): [number, number, number] {
    const c = (dataset(this.file, level, 0).metadata as { chunks?: number[] | null }).chunks;
    return (c?.length === 3 ? c : [32, 128, 128]) as [number, number, number];
  }
  close() {
    this.file.close();
  }
}
