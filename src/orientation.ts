/**
 * Orientation strings, as used by SPIMquant (`OrientationStringXYZ`, `--orientation`)
 * and zarrnii (`xyz_orientation`): one letter per image axis X, Y, Z, giving the
 * anatomical direction in which that axis *increases*. X is the last (fastest)
 * array axis of the stored z,y,x data, in both Imaris and OME-Zarr.
 *
 * Example: "RAI" means X increases to the right, Y anteriorly, Z inferiorly.
 */

export type Letter = "R" | "L" | "A" | "P" | "S" | "I";
export type Vec3 = [number, number, number];
/** Directions in RAS space of the image axes X, Y, Z (the columns of the matrix). */
export type Directions = [Vec3, Vec3, Vec3];

const VECTORS: Record<Letter, Vec3> = {
  R: [1, 0, 0],
  L: [-1, 0, 0],
  A: [0, 1, 0],
  P: [0, -1, 0],
  S: [0, 0, 1],
  I: [0, 0, -1],
};

const LETTERS = Object.keys(VECTORS) as Letter[];

export function isValid(s: string): boolean {
  if (!/^[RLAPSI]{3}$/.test(s)) return false;
  const axes = new Set([...s].map((c) => VECTORS[c as Letter].findIndex((v) => v !== 0)));
  return axes.size === 3;
}

export function parse(s: string): Directions {
  const t = s.toUpperCase();
  if (!isValid(t)) throw new Error(`Not an orientation string: ${s}`);
  return [...t].map((c) => [...VECTORS[c as Letter]]) as Directions;
}

function letterOf(v: Vec3): Letter {
  const found = LETTERS.find((l) => VECTORS[l].every((x, i) => x === v[i]));
  if (!found) throw new Error(`Not an axis-aligned direction: ${v}`);
  return found;
}

export function format(d: Directions): string {
  return d.map(letterOf).join("");
}

function det3(d: Directions): number {
  const [a, b, c] = d; // columns
  return (
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    b[0] * (a[1] * c[2] - a[2] * c[1]) +
    c[0] * (a[1] * b[2] - a[2] * b[1])
  );
}

/**
 * +1 or -1: the handedness of the map from image axes to RAS. Rotations keep it;
 * a mirror flips it. A left-right mirrored brain still looks like a brain, so
 * handedness cannot be judged from the image: it comes from how the microscope
 * and stitching write the data (the preset).
 */
export function handedness(s: string): 1 | -1 {
  return det3(parse(s)) > 0 ? 1 : -1;
}

/** A rotation by quarter turns about an anatomical axis (right-hand rule). */
export type RotationAxis = "R" | "A" | "S";

function rotateVec(v: Vec3, axis: RotationAxis, quarterTurns: number): Vec3 {
  let [x, y, z] = v;
  const n = ((quarterTurns % 4) + 4) % 4;
  for (let i = 0; i < n; i++) {
    if (axis === "S") [x, y] = [-y, x]; // R -> A
    else if (axis === "R") [y, z] = [-z, y]; // A -> S
    else [z, x] = [-x, z]; // S -> R
  }
  return [x + 0, y + 0, z + 0]; // no -0
}

/**
 * The orientation after the displayed brain is rotated by quarter turns about an
 * anatomical axis. Keeps handedness.
 */
export function rotate(s: string, axis: RotationAxis, quarterTurns: number): string {
  return format(parse(s).map((v) => rotateVec(v, axis, quarterTurns)) as Directions);
}

/** The orientation with left and right swapped. Changes handedness. */
export function mirrorLR(s: string): string {
  return format(parse(s).map(([x, y, z]) => [-x + 0, y, z]) as Directions);
}

/** All 48 orientation strings. */
export function allOrientations(): string[] {
  const out: string[] = [];
  for (const a of LETTERS)
    for (const b of LETTERS)
      for (const c of LETTERS) if (isValid(a + b + c)) out.push(a + b + c);
  return out;
}

/** The 24 orientations of one handedness: the candidates for an automatic suggestion. */
export function orientationsWithHandedness(h: 1 | -1): string[] {
  return allOrientations().filter((s) => handedness(s) === h);
}

/** For each RAS axis (R, A, S): which image axis (0=X, 1=Y, 2=Z) runs along it, and whether reversed. */
export interface AxisMap {
  imageAxis: 0 | 1 | 2;
  flip: boolean;
}

export function rasAxisMap(s: string): [AxisMap, AxisMap, AxisMap] {
  const d = parse(s);
  return [0, 1, 2].map((k) => {
    const i = d.findIndex((v) => v[k] !== 0) as 0 | 1 | 2;
    return { imageAxis: i, flip: d[i][k] < 0 };
  }) as [AxisMap, AxisMap, AxisMap];
}

/** Default orientations of known acquisition setups (from the SPIMquant --orientation help). */
export interface Preset {
  id: string;
  label: string;
  orientation: string;
}

export const PRESETS: Preset[] = [
  { id: "imaris-stitched", label: "Blaze, stitched in Imaris", orientation: "RAI" },
  // a single Blaze tile converted with ImarisConvert keeps the Blaze row order
  // (checked on one dataset: Y runs posteriorly, as with SPIMprep)
  { id: "imaris-convert", label: "Blaze, converted with ImarisConvert", orientation: "RPI" },
  { id: "spimprep", label: "Blaze, stitched with SPIMprep", orientation: "RPI" },
  { id: "lifecanvas", label: "LifeCanvas", orientation: "RAS" },
];

/**
 * The presets to offer for an image, with the one to start from: the orientation
 * stored in the file if there is one, else a guess from what wrote the file.
 */
export function presetsFor(
  format: string,
  metadata: Record<string, string>,
  fileOrientation?: string,
): { presets: Preset[]; suggested: Preset } {
  if (fileOrientation) {
    const fromFile = { id: "file", label: "Stored in the file", orientation: fileOrientation };
    return { presets: [fromFile, ...PRESETS], suggested: fromFile };
  }
  const id =
    format === "imaris"
      ? /ImarisConvert/i.test(metadata.Creator ?? "")
        ? "imaris-convert"
        : "imaris-stitched"
      : "spimprep";
  return { presets: PRESETS, suggested: PRESETS.find((p) => p.id === id)! };
}
