/**
 * Frames of a template alignment, without DOM or worker: the subject world
 * (RAS mm) = R (i0 * v0), with the orientation's axis directions R, level-0
 * voxel index i0 and level-0 voxel size v0; origin at voxel 0.
 */
import { isValid } from "../orientation";
import { applyVec, type M4 } from "../registration/affine";
import { normalize, rasAxis, type V3 } from "./geometry";

export interface Alignment {
  template: string;
  image: string;
  orientation: string;
  voxel0_um_xyz: V3;
  /** template world (mm) -> subject world (mm, see above), row-major 4x4 */
  tpl2world: M4;
  /** template world (mm) -> level-0 voxel index (x, y, z) */
  tpl2idx0: M4;
  /** image channel shown and aligned */
  channel?: number;
  method: string;
  nudges: string[];
  overlap?: number;
  created: string;
}

/** level-0 voxel index -> subject world (mm) */
export function idx0ToWorld(orientation: string, v0um: V3): M4 {
  const o = isValid(orientation) ? orientation : "RAS";
  // world_k = sum_a d_a[k] i0_a v0_a: column a is the RAS direction of image axis a
  const cols = [0, 1, 2].map((k) => rasAxis(o, k)); // cols[k][a] = d_a[k]
  const m = new Array(16).fill(0);
  for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) m[4 * k + a] = (cols[k][a] * v0um[a]) / 1000;
  m[15] = 1;
  return m;
}

/** A template-space direction as a unit vector in the image's physical frame (um axes). */
export function tplVecToPhys(al: Alignment, v: number[]): V3 {
  const w = applyVec(al.tpl2world, v); // world mm direction
  const o = isValid(al.orientation) ? al.orientation : "RAS";
  // physical = R^T world (R is a signed permutation)
  const p = [0, 1, 2].map((a) => [0, 1, 2].reduce((s, k) => s + rasAxis(o, k)[a] * w[k], 0)) as V3;
  return normalize(p);
}

