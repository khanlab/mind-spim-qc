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
  /** "template": positions and view vectors in template space (RAS mm); the page
   * aligns the template to the image first. "subject" (default): voxel positions. */
  space?: "subject" | "template";
  template?: string;
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
  if (!p || !Array.isArray(p.landmarks)) throw new Error("Not a landmark protocol (no landmarks)");
  const tpl = p.space === "template";
  if (tpl) {
    p.template ??= "ABAv3";
    p.image ??= { name: "", orientation: "", channel: 0 };
  } else if (!p.image) throw new Error("Not a landmark protocol (no image)");
  for (const l of p.landmarks) {
    const pos = tpl ? l.template_mm : l.position0;
    if (!l.id || !Array.isArray(pos) || pos.length !== 3) throw new Error(`Landmark without id or position: ${JSON.stringify(l).slice(0, 80)}`);
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
  /** template alignment used to place a template protocol (see alignment.ts) */
  alignment?: unknown;
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

/**
 * A template protocol placed in an image by an alignment: positions become
 * level-0 voxel indices, view vectors unit vectors of the image's physical frame
 * (each vector mapped separately and orthonormalised by Gram-Schmidt, never by
 * cross products, which would flip in left-handed image frames).
 */
export function instantiate(
  p: Protocol,
  toIdx0: (mm: number[]) => V3,
  vecToPhys: (v: number[]) => V3,
  image: Protocol["image"],
): Protocol {
  const dotp = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a: V3): V3 => {
    const n = Math.hypot(...a) || 1;
    return [a[0] / n, a[1] / n, a[2] / n];
  };
  const minus = (a: V3, b: V3, k: number): V3 => [a[0] - k * b[0], a[1] - k * b[1], a[2] - k * b[2]];
  return {
    ...p,
    space: "subject",
    image,
    landmarks: p.landmarks.map((l) => {
      const view = { ...l.view };
      if (view.kind !== "ortho" && view.u && view.v && view.normal) {
        const u = unit(vecToPhys(view.u));
        let v = vecToPhys(view.v);
        v = unit(minus(v, u, dotp(v, u)));
        let n = vecToPhys(view.normal);
        n = unit(minus(minus(n, u, dotp(n, u)), v, dotp(n, v)));
        Object.assign(view, { u, v, normal: n });
      }
      return { ...l, view, position0: toIdx0(l.template_mm!) };
    }),
  };
}

// ---- derivatives export -------------------------------------------------------------

/** BIDS-style stem of an image name: extension and final suffix dropped (sub-1_..._SPIM.ims -> sub-1_...). */
export function imageStem(name: string): string {
  const base = name.replace(/\.(ims|ozx|zip|ome\.zarr|zarr|nii\.gz|nii)$/i, "");
  return /_[A-Za-z0-9]+$/.test(base) && base.includes("-") ? base.replace(/_[A-Za-z0-9]+$/, "") : base;
}

/** File prefix for a rater's session: <stem>_desc-<rater>[ses<n>] (desc is alphanumeric). */
export function derivativePrefix(imageName: string, rater: string, session: string): string {
  const r = rater.replace(/[^A-Za-z0-9]/g, "");
  const ses = session && session !== "1" ? `ses${session.replace(/[^A-Za-z0-9]/g, "")}` : "";
  return `${imageStem(imageName)}_desc-${r}${ses}`;
}

interface WorldPoint {
  label: string;
  ras: [number, number, number];
}

/** Placed clicks in subject world (RAS mm), labelled <landmark> or <landmark>_<click>. */
export function worldPoints(proto: Protocol, s: Session, toWorld: (p0: V3) => [number, number, number]): WorldPoint[] {
  const out: WorldPoint[] = [];
  for (const l of proto.landmarks) {
    const p = s.placements[l.id];
    if (!p || p.status !== "placed") continue;
    for (const c of p.clicks)
      if (c.position0) out.push({ label: l.clicks.length > 1 ? `${l.id}_${c.label}` : l.id, ras: toWorld(c.position0) });
  }
  return out;
}

export function fcsvText(pts: WorldPoint[]): string {
  let t = "# Markups fiducial file version = 4.10\n# CoordinateSystem = 0\n" +
    "# columns = id,x,y,z,ow,ox,oy,oz,vis,sel,lock,label,desc,associatedNodeID\n";
  pts.forEach((p, i) => {
    t += `vtkMRMLMarkupsFiducialNode_${i + 1},${p.ras.map((v) => v.toFixed(5)).join(",")},0,0,0,1,1,1,1,${p.label.replace(/,/g, ";")},,\n`;
  });
  return t;
}

export function markupsJson(pts: WorldPoint[]): string {
  return JSON.stringify({
    "@schema": "https://raw.githubusercontent.com/slicer/slicer/master/Modules/Loadable/Markups/Resources/Schema/markups-schema-v1.0.3.json#",
    markups: [{
      type: "Fiducial", coordinateSystem: "RAS", coordinateUnits: "mm",
      controlPoints: pts.map((p, i) => ({ id: String(i + 1), label: p.label, position: p.ras, positionStatus: "defined" })),
    }],
  }, null, 1);
}

/** JSON sidecar of the landmarks TSV. */
export function sidecar(proto: Protocol, s: Session, voxel0: V3, orientation: string): string {
  return JSON.stringify({
    Description: "Manual anatomical landmarks placed with the mind-spim-qc landmark page.",
    Sources: [s.image],
    Protocol: proto.protocol,
    ProtocolVersion: proto.version,
    Template: proto.template,
    Rater: s.rater,
    Session: s.session,
    Started: s.started,
    CoordinateSpace: "level-0 voxel index (x0, y0, z0) of the image; x is the fastest array axis; integers are voxel centres. " +
      "x_um, y_um, z_um are the index times the voxel size (array axes, no orientation).",
    VoxelSize0_um_xyz: voxel0,
    OrientationStringXYZ: orientation,
    SlicerFiles: "The .fcsv and .mrk.json files hold the same points in RAS mm: world = orientation-signed index times voxel size, " +
      "origin at level-0 voxel (0, 0, 0).",
    Alignment: s.alignment ?? null,
  }, null, 1);
}
