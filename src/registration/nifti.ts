/** Minimal NIfTI-1 reader (single volume, little-endian), enough for the template assets. */

export interface NiftiVolume {
  /** i, j, k sizes; data has i fastest */
  dims: [number, number, number];
  data: Float32Array;
  /** voxel (i, j, k) -> world (RAS mm), row-major 4x4 */
  affine: number[];
}

export async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buf;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

export function parseNifti(buf: ArrayBuffer): NiftiVolume {
  const dv = new DataView(buf);
  if (dv.getInt32(0, true) !== 348) throw new Error("Not a little-endian NIfTI-1 file");
  const dim = Array.from({ length: 8 }, (_, i) => dv.getInt16(40 + 2 * i, true));
  const dims: [number, number, number] = [dim[1], dim[2], Math.max(1, dim[3])];
  const datatype = dv.getInt16(70, true);
  const voxOffset = dv.getFloat32(108, true);
  const slope = dv.getFloat32(112, true) || 1;
  const inter = dv.getFloat32(116, true) || 0;
  const sform = dv.getInt16(254, true);
  if (sform <= 0) throw new Error("NIfTI without an sform");
  const row = (o: number) => [0, 1, 2, 3].map((i) => dv.getFloat32(o + 4 * i, true));
  const affine = [...row(280), ...row(296), ...row(312), 0, 0, 0, 1];
  const n = dims[0] * dims[1] * dims[2];
  const off = Math.round(voxOffset);
  const src =
    datatype === 2 ? new Uint8Array(buf, off, n)
    : datatype === 4 ? new Int16Array(buf.slice(off, off + 2 * n))
    : datatype === 512 ? new Uint16Array(buf.slice(off, off + 2 * n))
    : datatype === 16 ? new Float32Array(buf.slice(off, off + 4 * n))
    : null;
  if (!src) throw new Error(`NIfTI datatype ${datatype} not supported`);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = src[i] * slope + inter;
  return { dims, data, affine };
}

export async function loadNifti(url: string): Promise<NiftiVolume> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Cannot load ${url}: ${r.status}`);
  return parseNifti(await gunzip(await r.arrayBuffer()));
}
