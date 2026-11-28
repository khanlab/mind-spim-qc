/**
 * Landmark placement page: opens a protocol (from spimquant-fiducials
 * make_protocol.py) and its image, and lets a rater place each landmark at full
 * resolution. Blocks of the image are read at the level the field of view needs
 * and resampled on the views' planes here.
 */
import { folderFromEntry, folderFromFileList, folderFromHandle, type Folder } from "../folders";
import { isValid } from "../orientation";
import type { Box, ImageInfo, Volume } from "../readers/types";
import { VIEWS, VIEW_LABELS, type ViewName } from "../views";
import type { FetchReply, Notice, Request, Source } from "../worker";
import {
  add, blurNaN, boxForBounds, boxVoxels, chooseBlock, samplingBounds, dot, l0ToPhys, levelVoxel, normalize, orthoPlane, physToL0, physToPixel,
  pixelToPhys, rasAxis, sampleInto, scale, sub, tiles, voxel0, windowOf,
  type Block, type Plane, type Roi, type Sampling, type V3,
} from "./geometry";
import { apply } from "../registration/affine";
import { idx0ToWorld, runAlignment, tplVecToPhys, type Alignment } from "./alignment";
import {
  derivativePrefix, emptyPlacement, fcsvText, instantiate, isDone, markupsJson, parseProtocol, sessionTsv, sidecar, storageKey, worldPoints,
  type Landmark, type Placement, type Protocol, type Session, type Status,
} from "./protocol";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const BLOCK_BUDGET = 64e6;
/** flat views read thicker, tilted boxes; allow more so they stay at full detail */
const OBLIQUE_BUDGET = 110e6;
/** starting field of view per group (um), before the rater changes it */
const DEFAULT_FOV: Record<string, number> = { point3d: 1600, barrel: 1200, hippo: 1200, border: 1600, probe: 1600 };

// ---- worker ---------------------------------------------------------------------

const worker = new Worker(new URL("../worker.ts", import.meta.url), { type: "module" });
let nextId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let folder: Folder | null = null;

worker.onmessage = async (e) => {
  const msg = e.data as Notice | { id: number; result?: any; error?: string };
  if ("type" in msg && msg.type === "progress") return;
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

type Body = Request extends infer R ? (R extends any ? Omit<R, "id"> : never) : never;
function call<T>(body: Body): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...body, id });
  });
}

// ---- state ----------------------------------------------------------------------

let proto: Protocol | null = null;
/** the template protocol as loaded, when the page places it by an alignment */
let templateProto: Protocol | null = null;
let alignment: Alignment | null = null;
const TEMPLATES: Record<string, { anat: string; mask: string }> = {
  ABAv3: {
    anat: new URL("templates/ABAv3/tpl-ABAv3_res-100um_anat.nii.gz", location.href).href,
    mask: new URL("templates/ABAv3/tpl-ABAv3_res-100um_desc-brain_mask.nii.gz", location.href).href,
  },
};
const alignKey = (tpl: string, image: string) => `align:${tpl}:${image}`;
let source: Source | null = null;
let sourceName = "";
let info: ImageInfo | null = null;
let session: Session | null = null;
let current = 0;
/** landmark indices shown in the list (group filter) */
let shown: number[] = [];

interface ViewState {
  cursor: V3; // physical um
  center: V3; // centre of the field, physical um
  fov: number;
  depth: number; // oblique: offset of the plane along the normal
  tiltU: number; // oblique: degrees, about the screen-vertical axis
  tiltV: number; // oblique: degrees, about the screen-horizontal axis
  activeClick: number;
}
let vs: ViewState | null = null;
let reading: Promise<void> | null = null;
let wantRead = false;
let lastSampling: Map<HTMLCanvasElement, Sampling> = new Map();
/** the unsmoothed samples last drawn on each canvas (for the layer-4 suggestion) */
let lastImage: Map<HTMLCanvasElement, Float32Array> = new Map();
let timerStart = 0;

const lm = () => proto!.landmarks[current];
const placement = (): Placement => {
  const id = lm().id;
  session!.placements[id] ??= emptyPlacement();
  return session!.placements[id];
};

function busy(message: string) {
  $("busy").hidden = false;
  $("busy-message").textContent = message;
}
const idle = () => ($("busy").hidden = true);
function status(text: string, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}

// ---- loading --------------------------------------------------------------------

async function setProtocolFile(f: File) {
  try {
    proto = parseProtocol(await f.text());
    $("protocol-name").textContent = `${f.name} – ${proto.landmarks.length} landmarks for ${proto.image.name}`;
    status("");
  } catch (e) {
    proto = null;
    $("protocol-name").textContent = "–";
    status(`Protocol: ${(e as Error).message}`, true);
  }
  updateStart();
}

function setImage(s: Source, name: string) {
  source = s;
  sourceName = name;
  $("image-name").textContent = name;
  updateStart();
}

function updateStart() {
  const ok = !!proto && !!source && $<HTMLInputElement>("rater").value.trim().length > 0;
  $<HTMLButtonElement>("start").disabled = !ok;
  if (proto && source && sourceName !== proto.image.name)
    status(`Note: the protocol was made for ${proto.image.name}, not ${sourceName}.`, true);
}

$("protocol-input").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void setProtocolFile(f);
});
$("file-input").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) setImage({ kind: "file", file: f }, f.name);
});
$("folder-button").addEventListener("click", async () => {
  const picker = (window as any).showDirectoryPicker;
  if (picker) {
    try {
      const h = await picker();
      folder = folderFromHandle(h);
      setImage({ kind: "folder", name: h.name }, h.name);
    } catch {
      /* cancelled */
    }
  } else $("folder-input").click();
});
$("folder-input").addEventListener("change", (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (!files?.length) return;
  folder = folderFromFileList(files);
  setImage({ kind: "folder", name: folder.name }, folder.name);
});
$("rater").addEventListener("input", updateStart);

const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  for (const item of Array.from(e.dataTransfer?.items ?? [])) {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      folder = folderFromEntry(entry as FileSystemDirectoryEntry);
      setImage({ kind: "folder", name: entry.name }, entry.name);
      continue;
    }
    const f = item.getAsFile();
    if (!f) continue;
    if (f.name.toLowerCase().endsWith(".json")) await setProtocolFile(f);
    else setImage({ kind: "file", file: f }, f.name);
  }
});

$("start").addEventListener("click", start);

async function start() {
  if (!proto || !source) return;
  const rater = $<HTMLInputElement>("rater").value.trim();
  const ses = $<HTMLInputElement>("session").value.trim() || "1";
  busy(`Opening ${sourceName}…`);
  try {
    const r = await call<{ info: ImageInfo }>({ type: "open", source });
    info = r.info;
  } catch (e) {
    idle();
    status(`Cannot open the image: ${(e as Error).message}`, true);
    return;
  }
  idle();
  const warnings: string[] = [];
  if (proto.space === "template") {
    templateProto = proto;
    const channel = Number($<HTMLInputElement>("channel").value || 0);
    const orientation = ($<HTMLInputElement>("orientation").value.trim() || info.orientation || "").toUpperCase();
    if (!isValid(orientation)) {
      status("Enter the image orientation (e.g. RAI): the file does not store one. The QC page helps to find it.", true);
      return;
    }
    if (channel >= info.channels.length) {
      status(`Channel ${channel} does not exist: the image has ${info.channels.length}.`, true);
      return;
    }
    const tname = proto.template ?? "ABAv3";
    const urls = TEMPLATES[tname];
    if (!urls) {
      status(`No template ${tname} on this site.`, true);
      return;
    }
    const savedText = localStorage.getItem(alignKey(tname, sourceName));
    const savedAl = savedText ? (JSON.parse(savedText) as Alignment) : null;
    // a saved alignment brings its channel unless one was chosen
    const ch = savedAl?.channel !== undefined && !$<HTMLInputElement>("channel").value ? savedAl.channel : channel;
    $("drop").hidden = true;
    alignment = await runAlignment({
      info, channel: ch, imageName: sourceName, orientation, call,
      template: { name: tname, ...urls }, saved: savedAl && savedAl.orientation === orientation ? savedAl : null,
    });
    localStorage.setItem(alignKey(tname, sourceName), JSON.stringify(alignment));
    proto = placeTemplate(templateProto, alignment, alignment.channel ?? channel);
  }
  if (proto.image.channel >= info.channels.length) {
    status(`The protocol uses channel ${proto.image.channel}, the image has ${info.channels.length}.`, true);
    return;
  }
  const v0 = voxel0(info);
  const pv = proto.image.voxel_size0_um_xyz;
  if (pv && pv.some((v, i) => Math.abs(v - v0[i]) > 0.01 * v))
    warnings.push(`voxel size ${v0.map((v) => v.toFixed(3)).join("×")} µm differs from the protocol's ${pv.join("×")} µm`);
  if (!isValid(proto.image.orientation)) warnings.push(`orientation "${proto.image.orientation}" is not valid; views use RAS`);
  const key = storageKey(proto, rater, ses);
  const saved = localStorage.getItem(key);
  session = saved
    ? (JSON.parse(saved) as Session)
    : { protocol: proto.protocol, image: sourceName, rater, session: ses, started: new Date().toISOString(), placements: {} };
  if (alignment) session.alignment = alignment;
  $("drop").hidden = true;
  $("app").hidden = false;
  $("realign").hidden = !templateProto;
  $("file-name").textContent = sourceName;
  $("session-info").textContent =
    `Rater ${rater}, session ${ses}. Channel ${proto.image.channel}${proto.image.channel_name ? ` (${proto.image.channel_name})` : ""}, orientation ${proto.image.orientation}.` +
    (warnings.length ? ` Warning: ${warnings.join("; ")}.` : "") +
    (saved ? " Resumed from this browser." : "");
  const groups = [...new Set(proto.landmarks.map((l) => l.group))];
  $<HTMLSelectElement>("group-filter").replaceChildren(
    new Option("all landmarks", ""),
    ...groups.map((g) => new Option(`${g} (${proto!.landmarks.filter((l) => l.group === g).length})`, g)),
  );
  applyFilter();
  const firstTodo = proto.landmarks.findIndex((l) => !isDone(l, session!.placements[l.id]));
  openLandmark(firstTodo >= 0 ? firstTodo : 0);
  setInterval(tick, 1000);
}

function placeTemplate(tp: Protocol, al: Alignment, channel: number): Protocol {
  return instantiate(tp, (mm) => apply(al.tpl2idx0, mm), (v) => tplVecToPhys(al, v), {
    name: sourceName, orientation: al.orientation, channel,
    channel_name: info!.channels[channel]?.name, voxel_size0_um_xyz: voxel0(info!),
  });
}

$("realign").addEventListener("click", async () => {
  if (!templateProto || !alignment || !info) return;
  save();
  $("app").hidden = true;
  alignment = await runAlignment({
    info, channel: proto!.image.channel, imageName: sourceName, orientation: alignment.orientation, call,
    template: { name: alignment.template, ...TEMPLATES[alignment.template] }, saved: alignment,
  });
  localStorage.setItem(alignKey(alignment.template, sourceName), JSON.stringify(alignment));
  proto = placeTemplate(templateProto, alignment, alignment.channel ?? proto!.image.channel);
  session!.alignment = alignment;
  save();
  $("app").hidden = false;
  openLandmark(current);
});

// ---- persistence ------------------------------------------------------------------

function save() {
  if (!proto || !session) return;
  localStorage.setItem(storageKey(proto, session.rater, session.session), JSON.stringify(session));
  renderList();
}

function tick() {
  if (!session || document.visibilityState !== "visible" || !timerStart) return;
  const p = placement();
  p.seconds += 1;
  if (p.seconds % 10 === 0) save();
}

function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const prefix = () => derivativePrefix(sourceName, session!.rater, session!.session);
const orientationNow = () => (isValid(proto!.image.orientation) ? proto!.image.orientation : "RAS");
$("export-tsv").addEventListener("click", () => {
  if (!proto || !session || !info) return;
  download(`${prefix()}_landmarks.tsv`, sessionTsv(proto, session, voxel0(info)), "text/tab-separated-values");
  setTimeout(() => download(`${prefix()}_landmarks.json`, sidecar(proto!, session!, voxel0(info!), orientationNow()), "application/json"), 300);
});
$("export-slicer").addEventListener("click", () => {
  if (!proto || !session || !info) return;
  const M = idx0ToWorld(orientationNow(), voxel0(info));
  const pts = worldPoints(proto, session, (p0) => apply(M, p0));
  download(`${prefix()}_landmarks.fcsv`, fcsvText(pts), "text/plain");
  setTimeout(() => download(`${prefix()}_landmarks.mrk.json`, markupsJson(pts), "application/json"), 300);
});
$("export-json").addEventListener("click", () => {
  if (!proto || !session || !info) return;
  const out = { ...session, protocol_image: proto.image, voxel_size0_um_xyz: voxel0(info), saved: new Date().toISOString() };
  download(`${prefix()}_session.json`, JSON.stringify(out, null, 1), "application/json");
});
$("import-json").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f || !session) return;
  const s = JSON.parse(await f.text()) as Session;
  if (!s.placements) return;
  if (!confirm(`Replace the placements of this session with the ${Object.keys(s.placements).length} in ${f.name}?`)) return;
  session.placements = s.placements;
  save();
  openLandmark(current);
});

// ---- list ---------------------------------------------------------------------------

const MARK: Record<Status, string> = { todo: "·", placed: "✓", absent: "∅", damaged: "!", skipped: "–" };

function applyFilter() {
  const g = $<HTMLSelectElement>("group-filter").value;
  shown = proto!.landmarks.map((_, i) => i).filter((i) => !g || proto!.landmarks[i].group === g);
  renderList();
}
$("group-filter").addEventListener("change", () => {
  applyFilter();
  if (shown.length && !shown.includes(current)) openLandmark(shown[0]);
});

function renderList() {
  if (!proto || !session) return;
  const ol = $("list");
  ol.replaceChildren(
    ...shown.map((i) => {
      const l = proto!.landmarks[i];
      const p = session!.placements[l.id];
      const st: Status = p?.status ?? "todo";
      const partial = st === "placed" && !isDone(l, p);
      const li = document.createElement("li");
      li.className = `${st}${i === current ? " current" : ""}`;
      li.innerHTML = `<span class="mark">${partial ? "◐" : MARK[st]}</span><span><span class="gid">${l.id}</span> ${l.name}</span>`;
      li.addEventListener("click", () => openLandmark(i));
      return li;
    }),
  );
  ol.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  const done = proto.landmarks.filter((l) => isDone(l, session!.placements[l.id])).length;
  $("progress").textContent = `${done} of ${proto.landmarks.length} done`;
}

// ---- landmark ------------------------------------------------------------------------

function openLandmark(i: number) {
  if (!proto || !info) return;
  if (session && timerStart) save();
  current = i;
  timerStart = Date.now();
  const l = lm();
  const p = placement();
  const start = l0ToPhys(info, l.position0);
  const last = p.clicks.find((c) => c.position0)?.position0;
  const cursor = last ? l0ToPhys(info, last) : start;
  const def = l.view;
  const fov = p.fov_um ?? DEFAULT_FOV[l.group] ?? (l.view.kind === "ortho" ? 1600 : 1200);
  vs = {
    cursor,
    center: def.kind === "plane" ? start : cursor,
    fov,
    depth: p.depth_um ?? def.depth_um ?? 0,
    tiltU: p.tilt_deg?.[0] ?? 0,
    tiltV: p.tilt_deg?.[1] ?? 0,
    activeClick: Math.max(0, l.clicks.findIndex((c) => !p.clicks.some((k) => k.label === c))),
  };
  if (def.kind === "plane") vs.cursor = projectOnPlane(cursor, start, def.normal!);
  $("lm-title").textContent = `${l.id} · ${l.name}`;
  $("lm-group").textContent = l.group;
  $("lm-def").textContent = l.definition;
  const img = $<HTMLImageElement>("lm-ref");
  $("lm-ref-fig").hidden = !l.reference_png;
  if (l.reference_png) img.src = l.reference_png;
  $<HTMLSelectElement>("fov").value = String(fov);
  $<HTMLInputElement>("slab").value = String(def.slab_um ?? (def.kind === "ortho" ? 0 : 8));
  $<HTMLInputElement>("smooth").value = String(def.smooth_um ?? 0);
  const depth = $<HTMLInputElement>("depth");
  $("depth-label").hidden = def.kind === "ortho";
  $("depth-name").textContent = def.kind === "plane" ? "Plane offset" : "Depth";
  $("tilt-label").hidden = def.kind !== "oblique";
  $<HTMLInputElement>("tilt-u").value = String(vs.tiltU);
  $<HTMLInputElement>("tilt-v").value = String(vs.tiltV);
  $("tilt-value").textContent = `${vs.tiltU}°, ${vs.tiltV}°`;
  $("depth-value").textContent = `${vs.depth} µm`;
  if (def.kind !== "ortho") {
    const [a, b] = def.depth_range_um ?? (def.kind === "plane" ? [-400, 400] : [-300, 300]);
    depth.min = String(a);
    depth.max = String(b);
    depth.value = String(vs.depth);
  }
  $<HTMLTextAreaElement>("lm-note").value = p.note;
  buildViews();
  renderClicks();
  renderList();
  tilesRead = [];
  void refresh();
}

/** In-plane axes and normal of the landmark's plane, with the rater's tilt (oblique views). */
function axes(): { u: V3; v: V3; n: V3 } {
  const def = lm().view;
  let { u, v, normal: n } = def as Required<typeof def>;
  if (def.kind === "oblique" && vs && (vs.tiltU || vs.tiltV)) {
    const tu = Math.tan((vs.tiltU * Math.PI) / 180);
    const tv = Math.tan((vs.tiltV * Math.PI) / 180);
    n = normalize(add(add(n, scale(u, tu)), scale(v, tv)));
    u = normalize(sub(u, scale(n, dot(u, n))));
    v = normalize(sub(sub(v, scale(n, dot(v, n))), scale(u, dot(v, u))));
  }
  return { u, v, n };
}

function projectOnPlane(q: V3, c: V3, n: V3): V3 {
  const nn = normalize(n);
  return sub(q, scale(nn, dot(sub(q, c), nn)));
}

function renderClicks() {
  const l = lm();
  const p = placement();
  const box = $("lm-clicks");
  const parts: (HTMLElement | string)[] = [];
  if (l.clicks.length > 1) parts.push("Clicks:");
  l.clicks.forEach((label, k) => {
    const made = p.clicks.find((c) => c.label === label);
    const b = document.createElement("button");
    b.textContent = `${k + 1}. ${label}${made ? (made.position0 ? " ✓" : " absent") : ""}`;
    b.className = `${k === vs!.activeClick ? "active " : ""}${made ? (made.position0 ? "done" : "none") : "secondary"}`;
    b.addEventListener("click", () => {
      vs!.activeClick = k;
      if (made?.position0) vs!.cursor = l0ToPhys(info!, made.position0);
      renderClicks();
      draw();
    });
    if (l.clicks.length > 1) parts.push(b);
  });
  if (l.clicks.includes("L4") && ["pia", "WM"].every((c) => p.clicks.some((k) => k.label === c && k.position0))) {
    const sug = document.createElement("button");
    sug.className = "secondary";
    sug.id = "suggest-l4";
    sug.textContent = "Suggest L4";
    sug.title = "Move the cursor to the peak of nuclear density between the pia and white-matter clicks; place it with Space if it is right";
    sug.addEventListener("click", suggestL4);
    parts.push(sug);
  }
  if (l.clicks.length > 1) {
    const none = document.createElement("button");
    none.className = "secondary";
    none.textContent = `${l.clicks[vs!.activeClick]} absent here`;
    none.addEventListener("click", () => setClick(null));
    parts.push(none);
  }
  const st = p.status === "placed" && !isDone(l, p) ? "in progress" : p.status;
  $("lm-state").textContent = `${st}${p.seconds ? ` · ${p.seconds} s` : ""}`;
  box.replaceChildren(...parts);
}

/**
 * Layer 4 is the densest band of nuclei in granular cortex: the peak of the
 * smoothed intensity profile between the pia and white-matter clicks, averaged
 * over a 40 um wide strip, searched between 20 % and 65 % of the depth.
 */
function suggestL4() {
  const p = placement();
  const pia = p.clicks.find((c) => c.label === "pia")?.position0;
  const wm = p.clicks.find((c) => c.label === "WM")?.position0;
  const v = views[0];
  const s = lastSampling.get(v.canvas);
  const img = lastImage.get(v.canvas);
  if (!pia || !wm || !s || !img) return;
  const a = physToPixel(s, l0ToPhys(info!, pia));
  const b = physToPixel(s, l0ToPhys(info!, wm));
  const len = Math.hypot(b.col - a.col, b.row - a.row);
  const umPerPx = s.widthUm / s.px;
  const n = Math.max(10, Math.round(len));
  const half = Math.max(1, Math.round(20 / umPerPx));
  const dx = (b.col - a.col) / len;
  const dy = (b.row - a.row) / len;
  const prof = new Float32Array(n + 1).fill(NaN);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let sum = 0;
    let cnt = 0;
    for (let k = -half; k <= half; k++) {
      const c = Math.round(a.col + t * (b.col - a.col) - k * dy);
      const r = Math.round(a.row + t * (b.row - a.row) + k * dx);
      if (c < 0 || r < 0 || c >= s.px || r >= s.px) continue;
      const val = img[r * s.px + c];
      if (Number.isFinite(val)) {
        sum += val;
        cnt++;
      }
    }
    if (cnt) prof[i] = sum / cnt;
  }
  const sm = blurNaN(prof, n + 1, 1, Math.max(1, 15 / umPerPx / (len / n)));
  let best = -1;
  for (let i = Math.round(0.2 * n); i <= Math.round(0.65 * n); i++) if (Number.isFinite(sm[i]) && (best < 0 || sm[i] > sm[best])) best = i;
  const i0 = Math.round(0.2 * n);
  const i1 = Math.round(0.65 * n);
  // a real band rises above both ends of the search window (5 % of the range)
  const lo = Math.min(sm[i0], sm[i1]);
  const range = Math.max(...Array.from(sm).filter(Number.isFinite)) - Math.min(...Array.from(sm).filter(Number.isFinite));
  if (best < 0 || best === i0 || best === i1 || sm[best] - Math.max(sm[i0], sm[i1]) < 0.05 * range || !(sm[best] > lo)) {
    $("lm-status").textContent = "No clear layer 4 peak between the pia and white matter (agranular cortex?): place it by eye, or mark it absent.";
    return;
  }
  const t = best / n;
  vs!.cursor = pixelToPhys(s, a.col + t * (b.col - a.col), a.row + t * (b.row - a.row));
  $("lm-status").textContent = `Suggested layer 4 at ${(100 * t).toFixed(0)} % of the depth (pia 0 %, white matter 100 %). Check it, then place with Space.`;
  draw();
}

function setClick(pos0: V3 | null) {
  const l = lm();
  const p = placement();
  const label = l.clicks[vs!.activeClick];
  p.clicks = p.clicks.filter((c) => c.label !== label);
  p.clicks.push({ label, position0: pos0 });
  p.clicks.sort((a, b) => l.clicks.indexOf(a.label) - l.clicks.indexOf(b.label));
  p.status = "placed";
  p.updated = new Date().toISOString();
  p.fov_um = vs!.fov;
  if (l.view.kind !== "ortho") p.depth_um = vs!.depth;
  if (l.view.kind === "oblique") {
    p.tilt_deg = [vs!.tiltU, vs!.tiltV];
  }
  const next = l.clicks.findIndex((c) => !p.clicks.some((k) => k.label === c));
  if (next >= 0) vs!.activeClick = next;
  save();
  renderClicks();
  draw();
}

function flag(status: Status) {
  const p = placement();
  p.status = status;
  if (status !== "placed") p.clicks = [];
  p.updated = new Date().toISOString();
  save();
  renderClicks();
  draw();
}

$("place").addEventListener("click", () => setClick(physToL0(info!, vs!.cursor).map((v) => Math.round(v * 100) / 100) as V3));
$("absent").addEventListener("click", () => flag("absent"));
$("damaged").addEventListener("click", () => flag("damaged"));
$("skip").addEventListener("click", () => flag("skipped"));
$("clear").addEventListener("click", () => {
  const p = placement();
  p.clicks = [];
  p.status = "todo";
  vs!.activeClick = 0;
  save();
  renderClicks();
  draw();
});
$("lm-note").addEventListener("input", () => {
  placement().note = $<HTMLTextAreaElement>("lm-note").value;
  save();
});
const step = (d: number) => {
  const k = shown.indexOf(current);
  const j = shown[Math.min(shown.length - 1, Math.max(0, (k < 0 ? 0 : k) + d))];
  if (j !== undefined && j !== current) openLandmark(j);
};
$("next").addEventListener("click", () => step(1));
$("prev").addEventListener("click", () => step(-1));
$("recenter").addEventListener("click", recenter);
function recenter() {
  if (!vs) return;
  vs.center = vs.cursor;
  void refresh();
}

for (const id of ["slab", "smooth", "contrast"]) $(id).addEventListener("input", () => void refresh());
$("fov").addEventListener("change", () => {
  vs!.fov = Number($<HTMLSelectElement>("fov").value);
  void refresh();
});
for (const id of ["tilt-u", "tilt-v"])
  $(id).addEventListener("input", () => {
    vs!.tiltU = Number($<HTMLInputElement>("tilt-u").value);
    vs!.tiltV = Number($<HTMLInputElement>("tilt-v").value);
    $("tilt-value").textContent = `${vs!.tiltU}°, ${vs!.tiltV}°`;
    void refresh();
  });
$("depth").addEventListener("input", () => {
  vs!.depth = Number($<HTMLInputElement>("depth").value);
  const def = lm().view;
  if (def.kind === "plane") vs!.cursor = projectOnPlane(vs!.cursor, add(l0ToPhys(info!, lm().position0), scale(def.normal!, vs!.depth)), def.normal!);
  $("depth-value").textContent = `${vs!.depth} µm`;
  void refresh();
});
$("show-init").addEventListener("change", () => draw());

document.addEventListener("keydown", (e) => {
  if (!vs || $("app").hidden) return;
  const t = e.target as HTMLElement;
  if (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox" && (t as HTMLInputElement).type !== "range")) return;
  const k = e.key.toLowerCase();
  if (k === " " || k === "enter") $("place").click();
  else if (k === "a") $("absent").click();
  else if (k === "d") $("damaged").click();
  else if (k === "c") recenter();
  else if (k === "n") step(1);
  else if (k === "p") step(-1);
  else if (k === "+" || k === "=" || k === "-") {
    const sel = $<HTMLSelectElement>("fov");
    sel.selectedIndex = Math.min(sel.options.length - 1, Math.max(0, sel.selectedIndex + (k === "-" ? 1 : -1)));
    sel.dispatchEvent(new Event("change"));
  } else return;
  e.preventDefault();
});

// ---- views ----------------------------------------------------------------------------

interface ViewSpec {
  name: string;
  canvas: HTMLCanvasElement;
  px: number;
  /** plane of this view for the current state */
  plane(): Plane;
  /** cross-section of an oblique view: clicking sets the depth */
  isSection?: boolean;
}
let views: ViewSpec[] = [];

function letterOf(w: V3): string {
  const o = proto!.image.orientation;
  const ok = isValid(o);
  let best = 0;
  let k = 0;
  for (let a = 0; a < 3; a++) {
    const d = ok ? dot(w, rasAxis(o, a)) : w[a];
    if (Math.abs(d) > Math.abs(best)) {
      best = d;
      k = a;
    }
  }
  return ["LR", "PA", "IS"][k][best > 0 ? 1 : 0];
}

function viewElement(title: string, px: number): { root: HTMLElement; canvas: HTMLCanvasElement; edges: HTMLElement[] } {
  const root = document.createElement("div");
  root.className = "lm-view";
  const t = document.createElement("span");
  t.className = "title";
  t.textContent = title;
  const top = document.createElement("span");
  const left = document.createElement("span");
  const right = document.createElement("span");
  const bottom = document.createElement("span");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  canvas.style.width = canvas.style.height = `${px}px`;
  root.append(t, document.createElement("span"), top, document.createElement("span"), left, canvas, right, document.createElement("span"), bottom);
  return { root, canvas, edges: [left, right, top, bottom] };
}

function buildViews() {
  const l = lm();
  const def = l.view;
  const host = $("lm-views");
  host.replaceChildren();
  views = [];
  const o = isValid(proto!.image.orientation) ? proto!.image.orientation : "RAS";
  const big = Math.max(380, Math.min(720, Math.floor((window.innerWidth - 420) * 0.62)));
  const add = (spec: ViewSpec, edges: HTMLElement[], el: HTMLElement) => {
    host.append(el);
    views.push(spec);
    const p = spec.plane();
    const [le, ri, to, bo] = edges;
    if (spec.name in VIEW_LABELS) [le.textContent, ri.textContent, to.textContent, bo.textContent] = VIEW_LABELS[spec.name as ViewName];
    else {
      le.textContent = letterOf(scale(p.u, -1));
      ri.textContent = letterOf(p.u);
      to.textContent = spec.isSection ? "n" : letterOf(p.v);
      bo.textContent = spec.isSection ? "" : letterOf(scale(p.v, -1));
    }
    hookCanvas(spec);
  };
  if (def.kind === "ortho") {
    const px = Math.max(300, Math.min(460, Math.floor((window.innerWidth - 420) / 3) - 50));
    for (const name of VIEWS) {
      const e = viewElement(name, px);
      add({ name, canvas: e.canvas, px, plane: () => {
        const pl = orthoPlane(o, name, vs!.center);
        // through the cursor, centred on the field centre
        return { ...pl, center: add3(vs!.center, scale(pl.n, dot(sub(vs!.cursor, vs!.center), pl.n))) };
      } }, e.edges, e.root);
    }
  } else {
    const title = def.kind === "oblique" ? "flat view (depth slider moves it along the normal)" : "locked plane";
    const e = viewElement(title, big);
    add({ name: "main", canvas: e.canvas, px: big, plane: () => {
      const { u, v, n } = axes();
      const c = add3(projectOnPlane(vs!.center, l0ToPhys(info!, l.position0), n), scale(n, vs!.depth));
      return { center: c, u, v, n };
    } }, e.edges, e.root);
    if (def.kind === "oblique") {
      const sp = Math.round(big * 0.5);
      const s = viewElement("cross-section (click to set depth)", sp);
      add({ name: "section", canvas: s.canvas, px: sp, isSection: true, plane: () => {
        const { u, v, n } = axes();
        const c = projectOnPlane(vs!.center, l0ToPhys(info!, l.position0), n);
        return { center: c, u, v: n, n: scale(v, -1) };
      } }, s.edges, s.root);
    }
  }
}
const add3 = add;

function hookCanvas(spec: ViewSpec) {
  const c = spec.canvas;
  const at = (e: MouseEvent) => {
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) * spec.px) / r.width - 0.5, ((e.clientY - r.top) * spec.px) / r.height - 0.5] as const;
  };
  c.addEventListener("click", (e) => {
    const s = lastSampling.get(c);
    if (!s || !vs) return;
    const [col, row] = at(e);
    const q = pixelToPhys(s, col, row);
    if (spec.isSection) {
      const def = lm().view;
      const { n } = axes();
      const c0 = projectOnPlane(vs.center, l0ToPhys(info!, lm().position0), n);
      const d = dot(sub(q, c0), n);
      const [a, b] = def.depth_range_um ?? [-300, 300];
      vs.depth = Math.round(Math.min(b, Math.max(a, d)));
      $<HTMLInputElement>("depth").value = String(vs.depth);
      $("depth-value").textContent = `${vs.depth} µm`;
      void refresh();
      return;
    }
    vs.cursor = q;
    draw();
  });
  c.addEventListener("dblclick", (e) => {
    const s = lastSampling.get(c);
    if (!s || !vs || spec.isSection) return;
    const [col, row] = at(e);
    vs.cursor = pixelToPhys(s, col, row);
    recenter();
  });
  c.addEventListener("wheel", (e) => {
    if (!vs || !info) return;
    const def = lm().view;
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    const fast = e.shiftKey ? 5 : 1;
    if (def.kind === "oblique") {
      const d = Number($<HTMLInputElement>("depth").value) + dir * 4 * fast;
      const [a, b] = def.depth_range_um ?? [-300, 300];
      vs.depth = Math.min(b, Math.max(a, d));
      $<HTMLInputElement>("depth").value = String(vs.depth);
      $("depth-value").textContent = `${vs.depth} µm`;
      void refresh();
      return;
    }
    if (def.kind === "plane") return; // locked
    const pl = spec.plane();
    const lv = levelVoxel(info, levelOf());
    const stepUm = Math.abs(pl.n[0]) * lv[0] + Math.abs(pl.n[1]) * lv[1] + Math.abs(pl.n[2]) * lv[2];
    vs.cursor = add(vs.cursor, scale(pl.n, dir * stepUm * fast));
    void refresh();
  }, { passive: false });
}

// ---- reading and drawing -----------------------------------------------------------------

function samplings(): Sampling[] {
  const slab = Math.max(0, Number($<HTMLInputElement>("slab").value) || 0);
  return views.map((v) => ({ plane: v.plane(), widthUm: vs!.fov, px: v.px, slabUm: v.isSection ? 0 : slab }));
}

function covers(b: Block | null, want: Box): boolean {
  if (!b || b.box.level !== want.level) return false;
  for (let a = 0; a < 3; a++) if (want.start[a] < b.box.start[a] || want.stop[a] > b.box.stop[a]) return false;
  return true;
}

/** A block read for part of a view (tiles of a flat or locked plane), or for all views (ortho). */
interface Tile {
  block: Block;
  view: number | null;
  roi?: Roi;
}
let tilesRead: Tile[] = [];

/** What to read: boxes with a margin (so small moves need no new read), and the tight boxes the views need now. */
interface PlanItem {
  read: Box;
  tight: Box;
  view: number | null;
  roi?: Roi;
}

const levelOf = () => tilesRead[0]?.block.box.level ?? 0;

function planRead(): PlanItem[] | null {
  const def = lm().view;
  const ss = samplings();
  const o = isValid(proto!.image.orientation) ? proto!.image.orientation : "RAS";
  const z0 = levelVoxel(info!, 0)[2];
  if (def.kind === "ortho") {
    // the whole field cube around the centre, so moving the cursor needs no read
    const cube = (f: number) => VIEWS.map((n) => ({ plane: orthoPlane(o, n, vs!.center), widthUm: vs!.fov * f, px: ss[0].px, slabUm: vs!.fov * f }));
    const read = chooseBlock(info!, cube(1.1), BLOCK_BUDGET);
    if (!read) return null;
    const b = samplingsBounds(cube(1.0));
    const tight = boxForBounds(info!, read.level, b.lo, b.hi, 0);
    return tight ? [{ read, tight, view: null }] : null;
  }
  // flat and locked planes: tiles, each a small box around its part of the plane
  // flat views: a thick margin so depth steps rarely need a new read (chunks are
  // decoded whole anyway); fewer, larger tiles keep the number of reads down
  const extra = def.kind === "oblique" ? 160 : 4 * z0;
  const n = Math.max(1, Math.ceil(vs!.fov / (def.kind === "oblique" ? 600 : 400)));
  const parts = ss.flatMap((s, view) => tiles(s, n).map((t) => ({ ...t, view })));
  const pxUm = vs!.fov / ss[0].px;
  let need = 0;
  for (let l = 0; l < info!.levels.length; l++) if (Math.min(...levelVoxel(info!, l).slice(0, 2)) <= pxUm * 1.01) need = l;
  const budget = def.kind === "oblique" ? OBLIQUE_BUDGET : BLOCK_BUDGET;
  for (let l = need; l < info!.levels.length; l++) {
    const items: PlanItem[] = [];
    let total = 0;
    for (const t of parts) {
      const g = samplingBounds({ ...t.sub, widthUm: t.sub.widthUm * 1.05, slabUm: t.sub.slabUm + extra });
      const r = boxForBounds(info!, l, g.lo, g.hi);
      const k = samplingBounds({ ...t.sub, slabUm: t.sub.slabUm + 2 * z0 });
      const tight = boxForBounds(info!, l, k.lo, k.hi, 0);
      if (!r || !tight) continue;
      total += boxVoxels(r);
      items.push({ read: r, tight, view: t.view, roi: t.roi });
    }
    if (total <= budget || l === info!.levels.length - 1) return items;
  }
  return null;
}

function samplingsBounds(ss: Sampling[]) {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const s of ss) {
    const b = samplingBounds(s);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], b.lo[k]);
      hi[k] = Math.max(hi[k], b.hi[k]);
    }
  }
  return { lo, hi };
}

const covered = (it: PlanItem) => tilesRead.some((t) => covers(t.block, it.tight));

/** Reads new blocks when the views leave the current ones, then draws. */
async function refresh() {
  if (!vs || !info || !proto) return;
  const plan = planRead();
  if (!plan) return;
  if (!plan.every(covered)) {
    wantRead = true;
    if (!reading) reading = readLoop();
    await reading;
  }
  draw();
}

async function readLoop() {
  while (wantRead) {
    wantRead = false;
    const plan = planRead();
    if (!plan) break;
    const missing = plan.filter((it) => !covered(it));
    if (!missing.length) break;
    // keep the blocks still needed; read the rest, drawing as tiles arrive
    tilesRead = tilesRead.filter((t) => plan.some((it) => covers(t.block, it.tight)));
    const level = missing[0].read.level;
    const lv = levelVoxel(info!, level);
    const voxels = missing.reduce((n, it) => n + boxVoxels(it.read), 0);
    const what = `level ${level} (${lv.map((v) => v.toFixed(2)).join(" × ")} µm voxels), ${(voxels / 1e6).toFixed(1)} M voxels in ${missing.length} block${missing.length > 1 ? "s" : ""}`;
    const t0 = performance.now();
    try {
      for (const [i, it] of missing.entries()) {
        if (wantRead) break; // the view moved on: plan again
        $("lm-status").textContent = `reading ${what} (${i + 1}/${missing.length})…`;
        const vol = await call<Volume>({ type: "box", box: it.read, channel: proto!.image.channel });
        tilesRead.push({ block: { box: it.read, data: vol.data }, view: it.view, roi: it.roi });
        draw();
      }
      $("lm-status").textContent = `${what}, read in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    } catch (e) {
      $("lm-status").textContent = `Read failed: ${(e as Error).message}`;
    }
    draw();
  }
  reading = null;
}

function draw() {
  if (!vs || !info || !tilesRead.length) return;
  const smoothUm = Math.max(0, Number($<HTMLInputElement>("smooth").value) || 0);
  const hiPct = Number($<HTMLInputElement>("contrast").value);
  const ss = samplings();
  lastSampling = new Map();
  views.forEach((v, i) => {
    const s = ss[i];
    lastSampling.set(v.canvas, s);
    let img: Float32Array = new Float32Array(s.px * s.px).fill(NaN);
    for (const t of tilesRead) if (t.view === i && t.roi) sampleInto(info!, t.block, s, img, t.roi);
    for (const t of tilesRead) sampleInto(info!, t.block, s, img);
    lastImage.set(v.canvas, img);
    if (smoothUm > 0) img = blurNaN(img, s.px, s.px, smoothUm / (s.widthUm / s.px));
    const [lo, hi] = windowOf(img, 0.5, hiPct);
    const ctx = v.canvas.getContext("2d")!;
    const rgba = new Uint8ClampedArray(s.px * s.px * 4);
    const k = 255 / (hi - lo);
    for (let j = 0; j < img.length; j++) {
      const g = Number.isFinite(img[j]) ? Math.min(255, Math.max(0, (img[j] - lo) * k)) : 0;
      rgba[4 * j] = rgba[4 * j + 1] = rgba[4 * j + 2] = g;
      rgba[4 * j + 3] = 255;
    }
    ctx.putImageData(new ImageData(rgba, s.px, s.px), 0, 0);
    overlay(ctx, v, s);
  });
}

function overlay(ctx: CanvasRenderingContext2D, v: ViewSpec, s: Sampling) {
  const l = lm();
  const p = placement();
  const tol = Math.max(s.slabUm / 2, 1.5 * Math.max(...levelVoxel(info!, levelOf())));
  const mark = (q: V3, color: string, label: string, r = 6) => {
    const { col, row, depth } = physToPixel(s, q);
    if (v.isSection) {
      // show every mark on the section at its in-plane position
    } else if (Math.abs(depth) > tol * 6) return;
    const near = v.isSection || Math.abs(depth) <= tol;
    ctx.globalAlpha = near ? 1 : 0.45;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(col + 0.5, row + 0.5, r, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = "12px system-ui";
    ctx.fillText(label, col + r + 3, row - r);
    ctx.globalAlpha = 1;
  };
  // placed clicks
  for (const c of p.clicks) if (c.position0) mark(l0ToPhys(info!, c.position0), "#ff5050", c.label === "point" ? "" : c.label);
  if ($<HTMLInputElement>("show-init").checked) mark(l0ToPhys(info!, l.position0), "#5aa0ff", "start", 9);
  // cursor
  const cur = physToPixel(s, vs!.cursor);
  ctx.strokeStyle = "#4cd964";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const g = 10;
  ctx.moveTo(cur.col + 0.5 - 2 * g, cur.row + 0.5);
  ctx.lineTo(cur.col + 0.5 - g / 2, cur.row + 0.5);
  ctx.moveTo(cur.col + 0.5 + g / 2, cur.row + 0.5);
  ctx.lineTo(cur.col + 0.5 + 2 * g, cur.row + 0.5);
  ctx.moveTo(cur.col + 0.5, cur.row + 0.5 - 2 * g);
  ctx.lineTo(cur.col + 0.5, cur.row + 0.5 - g / 2);
  ctx.moveTo(cur.col + 0.5, cur.row + 0.5 + g / 2);
  ctx.lineTo(cur.col + 0.5, cur.row + 0.5 + 2 * g);
  ctx.stroke();
  if (v.isSection) {
    // current depth and slab of the flat view
    const def = l.view;
    const { n } = axes();
    const c0 = projectOnPlane(vs!.center, l0ToPhys(info!, l.position0), n);
    const y = physToPixel(s, add(c0, scale(n, vs!.depth))).row + 0.5;
    const slabPx = (Number($<HTMLInputElement>("slab").value) || 0) * (s.px / s.widthUm);
    ctx.fillStyle = "rgba(90,160,255,0.18)";
    ctx.fillRect(0, y - slabPx / 2, s.px, slabPx);
    ctx.strokeStyle = "#5aa0ff";
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(s.px, y);
    ctx.stroke();
  }
  if (l.group === "probe" && !v.isSection) {
    // vertical guide through the probe centre
    const c = physToPixel(s, vs!.center);
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath();
    ctx.moveTo(c.col + 0.5, 0);
    ctx.lineTo(c.col + 0.5, s.px);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // scale bar
  const bar = s.widthUm > 2500 ? 500 : s.widthUm > 1000 ? 200 : 100;
  const w = (bar * s.px) / s.widthUm;
  ctx.fillStyle = "#fff";
  ctx.fillRect(10, s.px - 14, w, 3);
  ctx.font = "11px system-ui";
  ctx.fillText(`${bar} µm`, 10, s.px - 18);
}

window.addEventListener("beforeunload", () => save());
