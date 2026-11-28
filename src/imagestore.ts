/**
 * What the pages learn about an image, kept in this browser so the next page or
 * session can start from it: the orientation confirmed on the QC page and
 * template alignments made on the landmark page. Keyed by file name, with the
 * full-resolution size to catch a different image under the same name.
 */
export interface ImageRecord {
  name: string;
  /** level-0 shape z, y, x */
  shape0?: [number, number, number];
  orientation?: string;
  orientationConfirmed?: boolean;
  orientationUpdated?: string;
  /** by template name */
  alignments?: Record<string, unknown>;
}

const key = (name: string) => `image:${name}`;

export function getRecord(name: string, shape0?: [number, number, number]): ImageRecord | null {
  const t = localStorage.getItem(key(name));
  if (!t) return null;
  const r = JSON.parse(t) as ImageRecord;
  if (shape0 && r.shape0 && r.shape0.some((v, i) => v !== shape0[i])) return null; // another image, same name
  return r;
}

export function updateRecord(name: string, patch: Partial<ImageRecord>): ImageRecord {
  const r: ImageRecord = { ...(getRecord(name) ?? { name }), ...patch, name };
  localStorage.setItem(key(name), JSON.stringify(r));
  return r;
}
