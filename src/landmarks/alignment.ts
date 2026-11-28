/**
 * Aligning a template to the image, for template-space protocols: an automatic
 * affine (in the worker), then nudges by the rater (rotate 5 degrees, move,
 * scale), judged on three views with the template outline drawn over the
 * image. Only places the landmark views; accuracy of a few hundred um is fine.
 *
 * Subject world (mm, RAS) = R (i0 * v0): the orientation's axis directions R,
 * level-0 voxel index i0, level-0 voxel size v0; origin at voxel 0.
 */
import { app, anatomyChannel, emit, on, setStep } from "../app";
import { call } from "../client";
import { getRecord, updateRecord } from "../imagestore";
import { isValid } from "../orientation";
import type { Box, ImageInfo, Volume } from "../readers/types";
import { apply, applyVec, inv, mul, sample, type Grid, type M4, type RegResult } from "../registration/affine";
import { loadNifti } from "../registration/nifti";
import { VIEWS, VIEW_LABELS } from "../views";
import {
  boxVoxels, levelFactor, normalize, orthoPlane, pixelToPhys, rasAxis, sampleInto, shapeXYZ, sub, scale, dot, voxel0, windowOf,
  type Block, type Sampling, type V3,
} from "./geometry";

export { idx0ToWorld, tplVecToPhys, type Alignment } from "./frames";
import { idx0ToWorld, type Alignment } from "./frames";

export interface AlignContext {
  info: ImageInfo;
  channel: number;
  imageName: string;
  orientation: string;
  template: { name: string; anat: string; mask: string };
  call<T>(body: any): Promise<T>;
  saved?: Alignment | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const PX = 340;

/** Builds the alignment step for an image; `done` is called on every accept. */
export function runAlignment(ctx: AlignContext, done: (a: Alignment) => void): Promise<void> {
  return start(ctx, done);
}

async function start(ctx: AlignContext, done: (a: Alignment) => void) {
  const { info } = ctx;
  const status = (t: string) => ($("align-status").textContent = t);
  status("Reading an overview of the image and loading the template…");
  const v0 = voxel0(info);
  const o = isValid(ctx.orientation) ? ctx.orientation : "RAS";
  const toWorld = idx0ToWorld(o, v0);
  const Rm = [0, 1, 2].map((k) => rasAxis(o, k)); // Rm[k][a]: world_k from physical axis a

  // overview: the whole image at the finest level within 12 M voxels
  let level = info.levels.length - 1;
  for (let l = 0; l < info.levels.length; l++) {
    const n = shapeXYZ(info, l);
    if (n[0] * n[1] * n[2] <= 12e6) {
      level = l;
      break;
    }
  }
  const n = shapeXYZ(info, level);
  const box: Box = { level, start: [0, 0, 0], stop: [n[2], n[1], n[0]] };
  let channel = ctx.channel;
  const [vol, tAnat, tMask] = await Promise.all([
    ctx.call<Volume>({ type: "box", box, channel }),
    loadNifti(ctx.template.anat),
    loadNifti(ctx.template.mask),
  ]);
  let block: Block = { box, data: vol.data };
  const f = levelFactor(info, level);
  const levelToIdx0: M4 = [f[0], 0, 0, (f[0] - 1) / 2, 0, f[1], 0, (f[1] - 1) / 2, 0, 0, f[2], (f[2] - 1) / 2, 0, 0, 0, 1];
  let grid: Grid = { dims: n, data: Float32Array.from(vol.data), vox2world: mul(toWorld, levelToIdx0) };
  const sel = $<HTMLSelectElement>("align-channel");
  sel.replaceChildren(...info.channels.map((c, i) => new Option(`${i}${c.name && !/not specified/i.test(c.name) ? ` (${c.name})` : ""}`, String(i))));
  sel.value = String(channel);
  sel.onchange = async () => {
    channel = Number(sel.value);
    status(`Reading channel ${channel}…`);
    const v = await ctx.call<Volume>({ type: "box", box, channel });
    block = { box, data: v.data };
    grid = { ...grid, data: Float32Array.from(v.data) };
    subWindow = null;
    await runAuto();
  };
  const tpl: Grid = { dims: tAnat.dims, data: tAnat.data, vox2world: tAnat.affine };
  const tplMask: Grid = { dims: tMask.dims, data: tMask.data, vox2world: tMask.affine };
  const tplW2V = inv(tpl.vox2world);
  // template brain centre (world), for turning and scaling about it
  let cs = [0, 0, 0];
  let cn = 0;
  for (let k = 0; k < tMask.data.length; k++) {
    if (tMask.data[k] < 0.5) continue;
    const x = k % tMask.dims[0];
    const y = Math.floor(k / tMask.dims[0]) % tMask.dims[1];
    const z = Math.floor(k / (tMask.dims[0] * tMask.dims[1]));
    const w = apply(tMask.affine, [x, y, z]);
    cs = cs.map((v, i) => v + w[i]);
    cn++;
  }
  const tplCentre = cs.map((v) => v / cn);

  let T: M4 = ctx.saved?.tpl2world ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  let method = ctx.saved ? "loaded" : "auto";
  let nudges: string[] = ctx.saved?.nudges.slice() ?? [];
  let overlap: number | undefined = ctx.saved?.overlap;

  // views: whole brain, through a cursor (starts at the image centre)
  const ext = n.map((v, a) => v * f[a] * v0[a]) as V3; // um
  let cursor: V3 = ext.map((e) => e / 2) as V3;
  const fov = Math.max(...ext) * 1.02;
  const views = $("align-views");
  views.replaceChildren();
  const canvases = VIEWS.map((name) => {
    const wrap = document.createElement("div");
    wrap.className = "lm-view";
    const [le, ri, to, bo] = VIEW_LABELS[name];
    const t = document.createElement("span");
    t.className = "title";
    t.textContent = name;
    const c = document.createElement("canvas");
    c.width = c.height = PX;
    c.style.width = c.style.height = `${PX}px`;
    const span = (s: string) => Object.assign(document.createElement("span"), { textContent: s });
    wrap.append(t, span(""), span(to), span(""), span(le), c, span(ri), span(""), span(bo));
    views.append(wrap);
    return { name, c };
  });
  const samplingOf = (name: (typeof VIEWS)[number]): Sampling => {
    const pl = orthoPlane(o, name, ext.map((e) => e / 2) as V3);
    return { plane: { ...pl, center: add3(pl.center, scale(pl.n, dot(sub(cursor, pl.center), pl.n))) }, widthUm: fov, px: PX, slabUm: 0 };
  };
  let subWindow: [number, number] | null = null;
  const draw = () => {
    const toTpl = mul(tplW2V, inv(T));
    for (const { name, c } of canvases) {
      const s = samplingOf(name);
      const img = new Float32Array(PX * PX).fill(NaN);
      sampleInto(info, block, s, img);
      subWindow ??= windowOf(img, 1, 99.5);
      const [lo, hi] = subWindow;
      // template on the same pixels
      const tv = new Float32Array(PX * PX).fill(NaN);
      const tm = new Float32Array(PX * PX);
      for (let r = 0; r < PX; r++)
        for (let q = 0; q < PX; q++) {
          const p = pixelToPhys(s, q, r);
          const w: V3 = [
            (Rm[0][0] * p[0] + Rm[0][1] * p[1] + Rm[0][2] * p[2]) / 1000,
            (Rm[1][0] * p[0] + Rm[1][1] * p[1] + Rm[1][2] * p[2]) / 1000,
            (Rm[2][0] * p[0] + Rm[2][1] * p[1] + Rm[2][2] * p[2]) / 1000,
          ];
          const iv = apply(toTpl, w);
          tv[r * PX + q] = sample(tpl, iv[0], iv[1], iv[2]);
          tm[r * PX + q] = sample(tplMask, iv[0], iv[1], iv[2]) || 0;
        }
      // edges of the template intensity, inside its brain
      const edge = new Float32Array(PX * PX);
      let emax = 0;
      for (let r = 1; r < PX - 1; r++)
        for (let q = 1; q < PX - 1; q++) {
          const i = r * PX + q;
          const gx = tv[i + 1] - tv[i - 1];
          const gy = tv[i + PX] - tv[i - PX];
          const e = Number.isFinite(gx) && Number.isFinite(gy) && tm[i] > 0.5 ? Math.hypot(gx, gy) : 0;
          edge[i] = e;
          if (e > emax) emax = e;
        }
      const rgba = new Uint8ClampedArray(PX * PX * 4);
      const k = 255 / (hi - lo);
      for (let i = 0; i < PX * PX; i++) {
        const g = Number.isFinite(img[i]) ? Math.min(255, Math.max(0, (img[i] - lo) * k)) : 0;
        let rr = g, gg = g, bb = g;
        const boundary = i % PX > 0 && i > PX && ((tm[i] > 0.5) !== (tm[i - 1] > 0.5) || (tm[i] > 0.5) !== (tm[i - PX] > 0.5));
        if (boundary) [rr, gg, bb] = [255, 220, 0];
        else if (edge[i] > 0.35 * emax) [rr, gg, bb] = [255, 60, 220];
        rgba[4 * i] = rr;
        rgba[4 * i + 1] = gg;
        rgba[4 * i + 2] = bb;
        rgba[4 * i + 3] = 255;
      }
      c.getContext("2d")!.putImageData(new ImageData(rgba, PX, PX), 0, 0);
    }
    $("align-info").textContent =
      `${method}${nudges.length ? ` + ${nudges.length} nudge${nudges.length > 1 ? "s" : ""}` : ""}` +
      (overlap !== undefined ? ` · template brain inside image brain: ${(100 * overlap).toFixed(0)} % (automatic)` : "");
  };
  for (const { name, c } of canvases)
    c.onclick = (e) => {
      const r = c.getBoundingClientRect();
      cursor = pixelToPhys(samplingOf(name), ((e.clientX - r.left) * PX) / r.width - 0.5, ((e.clientY - r.top) * PX) / r.height - 0.5);
      draw();
    };

  // ---- nudges: in subject world (RAS), about where the template centre lands
  const centre = () => apply(T, tplCentre);
  const about = (Mc: number[][]) => {
    const c = centre();
    const m: M4 = [Mc[0][0], Mc[0][1], Mc[0][2], 0, Mc[1][0], Mc[1][1], Mc[1][2], 0, Mc[2][0], Mc[2][1], Mc[2][2], 0, 0, 0, 0, 1];
    for (let r = 0; r < 3; r++) m[4 * r + 3] = c[r] - (m[4 * r] * c[0] + m[4 * r + 1] * c[1] + m[4 * r + 2] * c[2]);
    return m;
  };
  const rot = (axis: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const [i, j] = [[1, 2], [2, 0], [0, 1]][axis];
    R[i][i] = c; R[i][j] = -s; R[j][i] = s; R[j][j] = c;
    return about(R);
  };
  const nudge = (m: M4, label: string) => {
    T = mul(m, T);
    nudges.push(label);
    draw();
  };
  const ctl = $("align-controls");
  ctl.replaceChildren();
  const row = (label: string, buttons: [string, (e?: MouseEvent) => void, string?][]) => {
    const d = document.createElement("div");
    d.className = "align-row";
    d.append(Object.assign(document.createElement("span"), { textContent: label }));
    for (const [t, fn, title] of buttons) {
      const b = document.createElement("button");
      b.className = "secondary";
      b.textContent = t;
      if (title) b.title = title;
      b.onclick = (e) => fn(e);
      d.append(b);
    }
    ctl.append(d);
  };
  const AX = ["L–R", "A–P", "S–I"];
  for (let k = 0; k < 3; k++)
    row(`Turn about ${AX[k]}`, [
      ["↺ 5°", () => nudge(rot(k, 5), `rotate ${AX[k]} +5`)],
      ["↻ 5°", () => nudge(rot(k, -5), `rotate ${AX[k]} -5`)],
    ]);
  const step = (e?: MouseEvent) => ((e as MouseEvent | undefined)?.shiftKey ? 0.5 : 0.1);
  const move = (k: number, sign: number) => (e?: MouseEvent) => {
    const d = [0, 0, 0];
    d[k] = sign * step(e);
    nudge([1, 0, 0, d[0], 0, 1, 0, d[1], 0, 0, 1, d[2], 0, 0, 0, 1], `move ${"RAS"[k]} ${(sign * step(e) * 1000).toFixed(0)} um`);
  };
  row("Move (shift: 0.5 mm)", [
    ["L", move(0, -1)], ["R", move(0, 1)], ["P", move(1, -1)], ["A", move(1, 1)], ["I", move(2, -1)], ["S", move(2, 1)],
  ]);
  row("Size", [
    ["−2 %", () => nudge(about([[0.98, 0, 0], [0, 0.98, 0], [0, 0, 0.98]]), "scale 0.98")],
    ["+2 %", () => nudge(about([[1.02, 0, 0], [0, 1.02, 0], [0, 0, 1.02]]), "scale 1.02")],
  ]);

  const runAuto = async (init?: M4) => {
    status(init ? "Refining from the current alignment…" : "Aligning the template automatically…");
    const t0 = performance.now();
    try {
      const r = await ctx.call<RegResult & { log: string[] }>({ type: "register", grid, template: { anat: ctx.template.anat, mask: ctx.template.mask }, init });
      T = r.T;
      overlap = r.overlap;
      method = init ? `${method} + refined` : "auto";
      if (!init) nudges = [];
      status(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s. Check the outline (magenta: template edges, yellow: template brain) and nudge if needed, then accept.`);
    } catch (e) {
      status(`Automatic alignment failed: ${(e as Error).message}. Nudge the template into place by hand.`);
    }
    draw();
  };
  $("align-auto").onclick = () => void runAuto();
  $("align-refine").onclick = () => void runAuto(T);
  $("align-accept").onclick = () => {
    done({
      template: ctx.template.name, image: ctx.imageName, orientation: o, voxel0_um_xyz: v0,
      tpl2world: T, tpl2idx0: mul(inv(toWorld), T), channel, method, nudges, overlap, created: new Date().toISOString(),
    });
  };
  $("align-save").onclick = () => {
    const al: Alignment = { template: ctx.template.name, image: ctx.imageName, orientation: o, voxel0_um_xyz: v0,
      tpl2world: T, tpl2idx0: mul(inv(toWorld), T), channel, method, nudges, overlap, created: new Date().toISOString() };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(al, null, 1)], { type: "application/json" }));
    a.download = `${ctx.imageName.replace(/\.(ims|ozx|zip|ome\.zarr|zarr)$/i, "").replace(/_[A-Za-z0-9]+$/, "")}_from-${ctx.template.name}_to-image_desc-affine_xfm.json`;
    a.click();
  };
  status(`Overview: level ${level}, ${(boxVoxels(box) / 1e6).toFixed(1)} M voxels.`);
  if (ctx.saved) {
    status("Using the saved alignment for this image. Nudge, refine, or accept.");
    draw();
  } else await runAuto();
}

const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// ---- the step -------------------------------------------------------------------------


export const TEMPLATES: Record<string, { anat: string; mask: string }> = {
  ABAv3: {
    anat: new URL("templates/ABAv3/tpl-ABAv3_res-100um_anat.nii.gz", location.href).href,
    mask: new URL("templates/ABAv3/tpl-ABAv3_res-100um_desc-brain_mask.nii.gz", location.href).href,
  },
};
export const DEFAULT_TEMPLATE = "ABAv3";

/** what the step was built for: image and orientation */
let builtFor = "";

/** Alignments saved for this image in earlier sessions (same orientation only). */
export function restoreAlignments() {
  app.alignments = {};
  if (!app.info) return;
  const rec = getRecord(app.name, app.info.levels[0].shape);
  for (const [t, a] of Object.entries(rec?.alignments ?? {})) {
    const al = a as Alignment;
    if (al.orientation === app.orientation) app.alignments[t] = al;
  }
}

on("image", () => {
  builtFor = "";
  restoreAlignments();
});
on("orientation", () => {
  // the subject world frame changes with the orientation: a new start
  if (builtFor && !builtFor.endsWith(`:${app.orientation}`)) builtFor = "";
  restoreAlignments();
});
on("step", () => {
  if (app.step !== "align" || !app.info) return;
  const want = `${app.name}:${app.orientation}`;
  $("align-warning").textContent = app.orientationConfirmed ? "" :
    "The orientation is not confirmed yet (step 1). A mirrored orientation aligns almost as well, so confirm it first.";
  if (builtFor === want) return;
  builtFor = want;
  const t = DEFAULT_TEMPLATE;
  const saved = app.alignments[t] ?? null;
  void runAlignment({
    info: app.info, channel: saved?.channel ?? anatomyChannel(), imageName: app.name, orientation: app.orientation,
    template: { name: t, ...TEMPLATES[t] }, call: call as AlignContext["call"], saved,
  }, (al) => {
    app.alignments[al.template] = al;
    const rec = getRecord(app.name, app.info!.levels[0].shape);
    updateRecord(app.name, { shape0: app.info!.levels[0].shape, alignments: { ...(rec?.alignments ?? {}), [al.template]: al } });
    emit("alignment");
    const annotate = document.querySelector('#stepbar [data-step="annotate"]') as HTMLElement;
    setStep(annotate.hidden ? "check" : "annotate");
  });
});
