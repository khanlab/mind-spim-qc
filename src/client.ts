/**
 * The one worker of the page and the request helper every step uses: the image
 * is opened once and stays open across the steps.
 */
import type { Folder } from "./folders";
import type { FetchReply, Notice, Request } from "./worker";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let nextId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; progress?: (f: number) => void }>();
let folder: Folder | null = null;

/** The OME-Zarr folder whose files the worker asks for (null for single files). */
export function setFolder(f: Folder | null) {
  folder = f;
}

worker.onmessage = async (e) => {
  const msg = e.data as Notice | { id: number; result?: any; error?: string };
  if ("type" in msg && msg.type === "progress") return pending.get(msg.id)?.progress?.(msg.fraction);
  if ("type" in msg && msg.type === "fetch") {
    const file = folder ? await folder.read(msg.key) : null;
    const bytes = file ? await file.arrayBuffer() : null;
    const reply: FetchReply = { type: "fetched", fetchId: msg.fetchId, bytes };
    worker.postMessage(reply, bytes ? [bytes] : []);
    return;
  }
  const { id, result, error } = msg as { id: number; result?: any; error?: string };
  const p = pending.get(id);
  pending.delete(id);
  if (error) p?.reject(new Error(error));
  else p?.resolve(result);
};

export type Body = Request extends infer R ? (R extends any ? Omit<R, "id"> : never) : never;

export function call<T>(body: Body, progress?: (f: number) => void): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, progress });
    worker.postMessage({ ...body, id });
  });
}
