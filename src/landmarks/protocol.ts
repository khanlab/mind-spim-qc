/**
 * Landmark protocols (written by spimquant-fiducials make_protocol.py) and the
 * placements a rater makes. Independent of the DOM.
 */
import type { V3 } from "./geometry";

export interface ViewDef {
  /** ortho: the three anatomical views, free 3D; oblique: flat view with a depth
   * slider; plane: one locked plane */
  kind: "ortho" | "oblique" | "plane";
  /** unit vectors in the array's physical frame (x, y, z) */
  normal?: V3;
  u?: V3;
  v?: V3;
  locked?: boolean;
  slab_um?: number;
  smooth_um?: number;
  depth_range_um?: [number, number];
  depth_um?: number;
}

export interface Landmark {
  id: string;
  name: string;
  group: string;
  definition: string;
  /** level-0 voxel index x, y, z (initial position; not shown as a marker) */
  position0: V3;
  template_mm?: V3;
  view: ViewDef;
  /** labels of the clicks to make, in order (["point"], or ["pia", "L4", "WM"]) */
  clicks: string[];
  reference_png?: string;
  hemi?: string;
}

export interface Protocol {
  protocol: string;
  version: number;
  image: {
    name: string;
    orientation: string;
    channel: number;
    channel_name?: string;
    voxel_size0_um_xyz?: V3;
  };
  init?: Record<string, unknown>;
  landmarks: Landmark[];
}

export function parseProtocol(text: string): Protocol {
  const p = JSON.parse(text) as Protocol;
  if (!p || !Array.isArray(p.landmarks) || !p.image) throw new Error("Not a landmark protocol (no image or landmarks)");
  for (const l of p.landmarks) {
    if (!l.id || !Array.isArray(l.position0) || l.position0.length !== 3) throw new Error(`Landmark without id or position: ${JSON.stringify(l).slice(0, 80)}`);
    if (!l.clicks?.length) l.clicks = ["point"];
    if (!l.view) l.view = { kind: "ortho" };
  }
  return p;
}

export type Status = "todo" | "placed" | "absent" | "damaged" | "skipped";

export interface Click {
  label: string;
  /** level-0 voxel index, or null when marked absent (e.g. no layer 4) */
  position0: V3 | null;
}

export interface Placement {
  status: Status;
  clicks: Click[];
  note: string;
  /** seconds spent on this landmark (summed over visits) */
  seconds: number;
  /** ISO time of the last change */
  updated: string;
  /** view state at the last click, for the record */
  fov_um?: number;
  depth_um?: number;
  /** oblique views: tilt of the plane about the screen axes, degrees */
  tilt_deg?: [number, number];
}

export interface Session {
  protocol: string;
  image: string;
  rater: string;
  session: string;
  started: string;
  placements: Record<string, Placement>;
}

export const emptyPlacement = (): Placement => ({ status: "todo", clicks: [], note: "", seconds: 0, updated: "" });

export function storageKey(p: Protocol, rater: string, session: string) {
  return `landmarks:${p.protocol}:${p.image.name}:${rater}:${session}`;
}

/** A placement is complete when every click is made (or marked absent), or it is flagged. */
export function isDone(l: Landmark, p: Placement | undefined): boolean {
  if (!p) return false;
  if (p.status === "absent" || p.status === "damaged" || p.status === "skipped") return true;
  return p.status === "placed" && l.clicks.every((c) => p.clicks.some((k) => k.label === c));
}

const TSV_COLUMNS = [
  "rater", "session", "image", "landmark", "group", "name", "click", "status",
  "x0", "y0", "z0", "x_um", "y_um", "z_um", "seconds", "fov_um", "depth_um", "tilt_deg", "updated", "note",
] as const;

/** One row per click (or one row for a flagged landmark), positions as level-0 index and um. */
export function sessionTsv(proto: Protocol, s: Session, voxel0: V3): string {
  const rows: string[][] = [TSV_COLUMNS.slice()];
  const clean = (v: unknown) => String(v ?? "").replace(/[\t\n\r]+/g, " ");
  for (const l of proto.landmarks) {
    const p = s.placements[l.id];
    if (!p || p.status === "todo") continue;
    const base = (click: string, pos: V3 | null) => [
      s.rater, s.session, s.image, l.id, l.group, l.name, click, p.status,
      ...(pos ? pos.map((v) => v.toFixed(2)) : ["", "", ""]),
      ...(pos ? pos.map((v, i) => (v * voxel0[i]).toFixed(2)) : ["", "", ""]),
      p.seconds.toFixed(0), p.fov_um ?? "", p.depth_um ?? "", p.tilt_deg?.join(",") ?? "", p.updated, p.note,
    ];
    if (p.status !== "placed" || !p.clicks.length) rows.push(base("", null).map(clean));
    else for (const c of p.clicks) rows.push(base(c.label, c.position0).map(clean));
  }
  return rows.map((r) => r.join("\t")).join("\n") + "\n";
}
