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
import type { ChannelInfo, ImageInfo, LevelInfo, Volume, Voxels } from "./types";

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

/** One channel of one level, cropped to the image (no chunk padding). */
export function readImsVolume(f: H5File, info: ImageInfo, level: number, channel: number): Volume {
  const { shape, voxelSize } = info.levels[level];
  const d = dataset(f, level, channel);
  const data = d.slice([
    [0, shape[0]],
    [0, shape[1]],
    [0, shape[2]],
  ]) as unknown as Voxels;
  return { shape, voxelSize, data };
}
