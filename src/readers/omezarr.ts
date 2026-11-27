/**
 * OME-Zarr (NGFF 0.4 on Zarr v2, or 0.5 on Zarr v3), from any zarrita store:
 * a dropped folder, an .ozx zip, or (in Node) the file system.
 *
 * Orientation is read the way zarrnii does: `xyz_orientation` (X, Y, Z), or else
 * the legacy `orientation`, which is in Z, Y, X order and is reversed.
 */
import * as zarr from "zarrita";
import type { Readable } from "@zarrita/storage";
import { isValid } from "../orientation";
import {
  asVoxels,
  type Box,
  type ChannelInfo,
  type ImageInfo,
  type ImageReader,
  type LevelInfo,
  type Progress,
  type ReadPlan,
  type Volume,
  type Voxels,
} from "./types";

type Attrs = Record<string, any>;
type Arr = zarr.Array<zarr.DataType, Readable>;

const TO_UM: Record<string, number> = {
  nanometer: 1e-3,
  nm: 1e-3,
  micrometer: 1,
  micron: 1,
  um: 1,
  µm: 1,
  millimeter: 1e3,
  mm: 1e3,
  centimeter: 1e4,
  meter: 1e6,
};

function hexColor(hex: unknown): [number, number, number] | undefined {
  if (typeof hex !== "string" || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function fileOrientation(attrs: Attrs): string | undefined {
  const ome = attrs.ome ?? {};
  const xyz = attrs.xyz_orientation ?? ome.xyz_orientation;
  if (typeof xyz === "string" && isValid(xyz.toUpperCase())) return xyz.toUpperCase();
  const zyx = attrs.orientation ?? ome.orientation;
  if (typeof zyx === "string" && isValid(zyx.toUpperCase())) return [...zyx.toUpperCase()].reverse().join("");
  return undefined;
}

export class OmeZarrReader implements ImageReader {
  private constructor(
    public info: ImageInfo,
    private arrays: Arr[],
    /** Index of each of t, c, z, y, x in the array dimensions (-1 if absent). */
    private dims: Record<"t" | "c" | "z" | "y" | "x", number>,
  ) {}

  static async open(store: Readable, name: string): Promise<OmeZarrReader> {
    const root = zarr.root(store);
    const group = await zarr.open(root, { kind: "group" });
    const attrs = group.attrs as Attrs;
    const ms = (attrs.ome?.multiscales ?? attrs.multiscales)?.[0];
    if (!ms) throw new Error("Not an OME-Zarr image: no multiscales metadata");

    const axes: { name: string; unit?: string }[] = ms.axes.map((a: any) => (typeof a === "string" ? { name: a } : a));
    const names = axes.map((a) => a.name.toLowerCase());
    const dims = Object.fromEntries((["t", "c", "z", "y", "x"] as const).map((d) => [d, names.indexOf(d)])) as Record<
      "t" | "c" | "z" | "y" | "x",
      number
    >;
    if (dims.z < 0 || dims.y < 0 || dims.x < 0) throw new Error(`Need z, y and x axes, found ${names.join(", ")}`);
    const toUm = (i: number) => TO_UM[(axes[i].unit ?? "micrometer").toLowerCase()] ?? 1;

    const arrays: Arr[] = [];
    const levels: LevelInfo[] = [];
    for (const ds of ms.datasets) {
      const arr = await zarr.open(root.resolve(ds.path), { kind: "array" });
      arrays.push(arr);
      const scaleT = (ds.coordinateTransformations ?? []).find((t: any) => t.type === "scale");
      const scale: number[] = scaleT?.scale ?? names.map(() => 1);
      levels.push({
        shape: [arr.shape[dims.z], arr.shape[dims.y], arr.shape[dims.x]],
        voxelSize: [dims.z, dims.y, dims.x].map((i) => scale[i] * toUm(i)) as [number, number, number],
      });
    }

    const omero = attrs.omero ?? attrs.ome?.omero ?? ms.metadata?.omero;
    const nChannels = dims.c >= 0 ? arrays[0].shape[dims.c] : 1;
    const channels: ChannelInfo[] = Array.from({ length: nChannels }, (_, c) => {
      const ch = omero?.channels?.[c];
      return { name: ch?.label || `Channel ${c}`, color: hexColor(ch?.color) };
    });

    const metadata: Record<string, string> = {};
    if (ms.version ?? attrs.ome?.version) metadata.NGFF = String(ms.version ?? attrs.ome?.version);
    const info: ImageInfo = {
      format: "ome-zarr",
      name,
      dtype: arrays[0].dtype,
      channels,
      levels,
      orientation: fileOrientation(attrs),
      metadata,
    };
    return new OmeZarrReader(info, arrays, dims);
  }

  async read(plan: ReadPlan, channel: number, progress: Progress): Promise<Volume> {
    const arr = this.arrays[plan.level];
    const { dims } = this;
    const [nz] = this.info.levels[plan.level].shape;
    const [sz, sy, sx] = plan.step;
    const [oz, oy, ox] = plan.shape;
    const planeSize = oy * ox;
    // blocks of about 1/20 of the planes, a whole number of z steps
    const block = Math.max(sz, Math.ceil(Math.ceil(nz / 20) / sz) * sz);
    let out: Voxels | null = null;
    for (let z0 = 0; z0 < nz; z0 += block) {
      const z1 = Math.min(nz, z0 + block);
      const sel: (number | zarr.Slice | null)[] = arr.shape.map(() => null);
      if (dims.t >= 0) sel[dims.t] = 0;
      if (dims.c >= 0) sel[dims.c] = channel;
      sel[dims.z] = zarr.slice(z0, z1, sz);
      sel[dims.y] = zarr.slice(0, null, sy);
      sel[dims.x] = zarr.slice(0, null, sx);
      const part = await zarr.get(arr, sel);
      // remaining dims are z, y, x in array order; put them in z, y, x order
      const kept = [dims.z, dims.y, dims.x].sort((a, b) => a - b);
      const data = asVoxels(part.data as any);
      if (!out) out = new (data.constructor as new (n: number) => Voxels)(oz * oy * ox);
      const offset = (z0 / sz) * planeSize;
      if (kept[0] === dims.z && kept[1] === dims.y) out.set(data, offset);
      else {
        // general case: axes stored in another order
        const shp = part.shape;
        const strides = part.stride;
        const pz = shp[kept.indexOf(dims.z)];
        const iz = strides[kept.indexOf(dims.z)];
        const iy = strides[kept.indexOf(dims.y)];
        const ix = strides[kept.indexOf(dims.x)];
        for (let z = 0; z < pz; z++)
          for (let y = 0; y < oy; y++)
            for (let x = 0; x < ox; x++) out[offset + (z * oy + y) * ox + x] = data[z * iz + y * iy + x * ix];
      }
      progress(z1 / nz);
    }
    return { shape: plan.shape, voxelSize: plan.voxelSize, data: out! };
  }

  async readBox(box: Box, channel: number): Promise<Volume> {
    const arr = this.arrays[box.level];
    const { dims } = this;
    const sel: (number | zarr.Slice | null)[] = arr.shape.map(() => null);
    if (dims.t >= 0) sel[dims.t] = 0;
    if (dims.c >= 0) sel[dims.c] = channel;
    (["z", "y", "x"] as const).forEach((d, a) => (sel[dims[d]] = zarr.slice(box.start[a], box.stop[a])));
    const part = await zarr.get(arr, sel);
    const shape = box.stop.map((v, a) => v - box.start[a]) as [number, number, number];
    const kept = [dims.z, dims.y, dims.x].sort((a, b) => a - b);
    let data = asVoxels(part.data as any);
    if (!(kept[0] === dims.z && kept[1] === dims.y)) {
      const out = new (data.constructor as new (n: number) => Voxels)(data.length);
      const st = [dims.z, dims.y, dims.x].map((d) => part.stride[kept.indexOf(d)]);
      for (let z = 0, i = 0; z < shape[0]; z++)
        for (let y = 0; y < shape[1]; y++)
          for (let x = 0; x < shape[2]; x++, i++) out[i] = data[z * st[0] + y * st[1] + x * st[2]];
      data = out;
    }
    return { shape, voxelSize: this.info.levels[box.level].voxelSize, data };
  }

  chunks(level: number): [number, number, number] {
    const c = this.arrays[level].chunks;
    const { dims } = this;
    return [c[dims.z], c[dims.y], c[dims.x]];
  }

  close() {}
}
