/// <reference lib="webworker" />
/**
 * Reads image files off the main thread, and computes the projections, so the
 * page stays responsive. Sends progress while reading.
 *
 * Sources:
 * - an Imaris .ims File, mounted with WORKERFS so HDF5 reads only the chunks it needs
 * - an .ozx (zipped OME-Zarr) File, read with byte ranges
 * - an OME-Zarr folder, whose files the main thread reads on request (folder
 *   handles from drag and drop cannot be passed to a worker in every browser)
 */
import h5wasm from "h5wasm";
import ZipFileStore from "@zarrita/storage/zip";
import type { AsyncReadable } from "@zarrita/storage";
import { ImsReader } from "./readers/ims";
import { OmeZarrReader } from "./readers/omezarr";
import type { ImageReader, ReadPlan, Volume } from "./readers/types";
import { arrayMips, autoWindow, type Mips } from "./views";

export type Source = { kind: "file"; file: File } | { kind: "folder"; name: string };

export type Request =
  | { id: number; type: "open"; source: Source }
  | { id: number; type: "read"; plan: ReadPlan; channel: number };

/** Messages from the worker, besides replies to requests. */
export type Notice =
  | { type: "progress"; id: number; fraction: number }
  | { type: "fetch"; key: string; fetchId: number };

/** Reply of the main thread to a fetch notice. */
export type FetchReply = { type: "fetched"; fetchId: number; bytes: ArrayBuffer | null };

export interface ReadResult {
  volume: Volume;
  mips: Mips;
  window: [number, number];
  mipWindows: [[number, number], [number, number], [number, number]];
  ms: number;
}

let reader: (ImageReader & { close(): void }) | null = null;
let mountCount = 0;

// ---- folder store: files read by the main thread ----------------------------

let nextFetch = 0;
const fetches = new Map<number, (bytes: ArrayBuffer | null) => void>();

const folderStore: AsyncReadable = {
  async get(key: string): Promise<Uint8Array | undefined> {
    const fetchId = nextFetch++;
    const bytes = await new Promise<ArrayBuffer | null>((resolve) => {
      fetches.set(fetchId, resolve);
      self.postMessage({ type: "fetch", key: key.replace(/^\/+/, ""), fetchId } satisfies Notice);
    });
    return bytes ? new Uint8Array(bytes) : undefined;
  },
};

// ---- zip ---------------------------------------------------------------------

/** Paths relative to the image root, also when the zip holds a folder named after the image. */
function rootEntries<T>(entries: Record<string, T>): Record<string, T> {
  const markers = ["zarr.json", ".zattrs", ".zgroup"];
  if (markers.some((m) => m in entries)) return entries;
  const root = Object.keys(entries)
    .filter((k) => markers.some((m) => k.endsWith("/" + m)))
    .sort((a, b) => a.length - b.length)[0];
  if (!root) return entries;
  const prefix = root.slice(0, root.lastIndexOf("/") + 1);
  return Object.fromEntries(
    Object.entries(entries)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => [k.slice(prefix.length), v]),
  );
}

// ---- requests ----------------------------------------------------------------

async function open(source: Source) {
  reader?.close();
  reader = null;
  if (source.kind === "folder") {
    reader = await OmeZarrReader.open(folderStore, source.name);
    return reader.info;
  }
  const { file } = source;
  const name = file.name.toLowerCase();
  if (name.endsWith(".ims")) {
    const { FS } = await h5wasm.ready;
    const dir = `/work${mountCount++}`;
    FS!.mkdir(dir);
    FS!.mount((FS as any).filesystems.WORKERFS, { files: [file] }, dir);
    reader = new ImsReader(new h5wasm.File(`${dir}/${file.name}`, "r"), file.name);
  } else if (name.endsWith(".ozx") || name.endsWith(".zip")) {
    reader = await OmeZarrReader.open(ZipFileStore.fromBlob(file, { transformEntries: rootEntries }), file.name);
  } else {
    throw new Error(`Cannot read ${file.name}: drop an Imaris .ims file, an OME-Zarr folder or an .ozx file`);
  }
  return reader.info;
}

async function read(id: number, plan: ReadPlan, channel: number): Promise<ReadResult> {
  if (!reader) throw new Error("No image open");
  const t0 = performance.now();
  const volume = await reader.read(plan, channel, (fraction) =>
    self.postMessage({ type: "progress", id, fraction } satisfies Notice),
  );
  const mips = arrayMips(volume);
  return {
    volume,
    mips,
    window: autoWindow(volume.data),
    mipWindows: mips.map((m) => autoWindow(m)) as ReadResult["mipWindows"],
    ms: performance.now() - t0,
  };
}

self.onmessage = async (e: MessageEvent<Request | FetchReply>) => {
  const msg = e.data;
  if (msg.type === "fetched") {
    fetches.get(msg.fetchId)?.(msg.bytes);
    fetches.delete(msg.fetchId);
    return;
  }
  try {
    if (msg.type === "open") {
      self.postMessage({ id: msg.id, result: { info: await open(msg.source) } });
    } else {
      const result = await read(msg.id, msg.plan, msg.channel);
      const transfer = [result.volume.data.buffer, ...result.mips.map((m) => m.buffer)] as ArrayBuffer[];
      self.postMessage({ id: msg.id, result }, { transfer });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: String((err as Error)?.message ?? err) });
  }
};
