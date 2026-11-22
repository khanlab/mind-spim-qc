/// <reference lib="webworker" />
/**
 * Reads image files off the main thread. Local files are mounted with WORKERFS,
 * so HDF5 reads only the chunks it needs (a 300 GB file opens in milliseconds).
 */
import h5wasm from "h5wasm";
import type { File as H5File } from "h5wasm";
import { readImsInfo, readImsVolume } from "./readers/ims";
import type { ImageInfo } from "./readers/types";

export type Request =
  | { id: number; type: "open"; file: File }
  | { id: number; type: "read"; level: number; channel: number };

let h5file: H5File | null = null;
let info: ImageInfo | null = null;
let mountCount = 0;

async function handle(req: Request) {
  const { FS } = await h5wasm.ready;
  if (req.type === "open") {
    h5file?.close();
    const dir = `/work${mountCount++}`;
    FS.mkdir(dir);
    FS.mount((FS as any).filesystems.WORKERFS, { files: [req.file] }, dir);
    if (!req.file.name.toLowerCase().endsWith(".ims")) throw new Error("Only Imaris (.ims) files are supported so far");
    h5file = new h5wasm.File(`${dir}/${req.file.name}`, "r");
    info = readImsInfo(h5file, req.file.name);
    return { info };
  }
  if (!h5file || !info) throw new Error("No file open");
  const t0 = performance.now();
  const vol = readImsVolume(h5file, info, req.level, req.channel);
  return { volume: vol, ms: performance.now() - t0 };
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const req = e.data;
  try {
    const result = await handle(req);
    const transfer = "volume" in result && result.volume ? [result.volume.data.buffer as ArrayBuffer] : [];
    self.postMessage({ id: req.id, result }, { transfer });
  } catch (err) {
    self.postMessage({ id: req.id, error: String((err as Error)?.message ?? err) });
  }
};
