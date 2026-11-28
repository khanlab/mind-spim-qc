import { handedness, isValid, mirrorLR, presetsFor, rotate, type Preset, type RotationAxis } from "./orientation";
import { level0ToOverview, overviewToLevel0, readPlan, type ImageInfo, type ReadPlan, type Volume } from "./readers/types";
import {
  VIEWS,
  VIEW_AXES,
  VIEW_LABELS,
  arrayToRas,
  brightestDepth,
  composite,
  mipAxis,
  rasGeometry,
  rasToArray,
  viewPlane,
  type Layer,
  type Mips,
  type ViewName,
} from "./views";
import type { ChannelMetrics, FetchReply, Notice, ReadResult, Request, Source } from "./worker";
import type { AppContext, Marker } from "./panels/context";
import { ZoomPanel } from "./panels/zooms";
import { PsfPanel, SIDE_COLORS } from "./panels/psf";
import { rasAxisMap } from "./orientation";
import { renderMetrics } from "./panels/metrics";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- busy popup ---------------------------------------------------------------

function busy(message: string, fraction?: number) {
  $("busy").hidden = false;
  $("busy-message").textContent = message;
  const bar = $<HTMLProgressElement>("busy-bar");
  if (fraction === undefined) bar.removeAttribute("value");
  else bar.value = fraction;
}
const idle = () => ($("busy").hidden = true);

// ---- folders: files read on request of the worker --------------------------------

/** A dropped or chosen folder: reads files by relative path. */
interface Folder {
  name: string;
  read(path: string): Promise<File | null>;
}

function folderFromEntry(dir: FileSystemDirectoryEntry): Folder {
  return {
    name: dir.name,
    read: (path) =>
      new Promise((resolve) =>
        dir.getFile(
          path,
          {},
          (entry) => (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
          () => resolve(null),
        ),
      ),
  };
}

function folderFromHandle(dir: FileSystemDirectoryHandle): Folder {
  return {
    name: dir.name,
    async read(path) {
      try {
        const parts = path.split("/");
        let d = dir;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
        return await (await d.getFileHandle(parts[parts.length - 1])).getFile();
      } catch {
        return null;
      }
    },
  };
}

/** From an <input webkitdirectory>, which lists every file up front. */
function folderFromFileList(files: FileList): Folder {
  const byPath = new Map<string, File>();
  let name = "";
  for (const f of Array.from(files)) {
    const [root, ...rest] = f.webkitRelativePath.split("/");
    name = root;
    byPath.set(rest.join("/"), f);
  }
  return { name, read: async (path) => byPath.get(path) ?? null };
}

let folder: Folder | null = null;

// ---- worker -------------------------------------------------------------------

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let nextId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; progress?: (f: number) => void }>();

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

type Body = Request extends infer R ? (R extends any ? Omit<R, "id"> : never) : never;
function call<T>(body: Body, progress?: (f: number) => void): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, progress });
    worker.postMessage({ ...body, id });
  });
}

// ---- state --------------------------------------------------------------------

interface ChannelState {
  metrics: ChannelMetrics;
  volume: Volume;
  mips: Mips;
  window: [number, number];
  mipWindows: [number, number][];
  color: [number, number, number];
  visible: boolean;
  stain: string;
}

const state = {
  name: "",
  size: null as number | null,
  info: null as ImageInfo | null,
  plan: null as ReadPlan | null,
  channels: [] as ChannelState[],
  presets: [] as Preset[],
  preset: null as Preset | null,
  orientation: "RAS",
  mode: "mip" as "mip" | "slice",
  position: { coronal: 0.5, sagittal: 0.5, axial: 0.5 } as Record<ViewName, number>,
};

const DEFAULT_COLORS: [number, number, number][] = [
  [1, 0, 1],
  [0, 1, 0],
  [0, 0.6, 1],
  [1, 1, 0],
];

/** The file's colour for a channel, unless it is white or already taken; else an unused default. */
function channelColor(
  fromFile: [number, number, number] | undefined,
  taken: [number, number, number][],
  c: number,
): [number, number, number] {
  const same = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 0.01);
  if (fromFile && !fromFile.every((x) => x > 0.99) && !taken.some((t) => same(t, fromFile))) return fromFile;
  return DEFAULT_COLORS.find((d) => !taken.some((t) => same(t, d))) ?? DEFAULT_COLORS[c % DEFAULT_COLORS.length];
}

// ---- opening --------------------------------------------------------------------

const status = (msg: string, error = false) => {
  $("status").textContent = msg;
  $("status").classList.toggle("error", error);
};

async function open(source: Source, size: number | null) {
  const name = source.kind === "file" ? source.file.name : source.name;
  try {
    status("");
    busy(`Opening ${name}…`);
    const { info } = await call<{ info: ImageInfo }>({ type: "open", source });
    state.name = name;
    state.size = size;
    state.info = info;
    state.plan = readPlan(info);
    const { presets, suggested } = presetsFor(info.format, info.metadata, info.orientation);
    state.presets = presets;
    state.preset = suggested;
    state.orientation = suggested.orientation;
    state.channels = [];
    $<HTMLInputElement>("confirmed").checked = false;

    const n = info.channels.length;
    for (let c = 0; c < n; c++) {
      const label = `Reading ${info.channels[c].name} (channel ${c + 1} of ${n})`;
      busy(label, c / n);
      const r = await call<ReadResult>({ type: "read", plan: state.plan, channel: c }, (f) => busy(label, (c + f) / n));
      state.channels.push({
        metrics: r.metrics,
        volume: r.volume,
        mips: r.mips,
        window: r.window,
        mipWindows: r.mipWindows,
        color: channelColor(info.channels[c].color, state.channels.map((ch) => ch.color), c),
        visible: true,
        stain: /^Channel \d+$/.test(info.channels[c].name) ? "" : info.channels[c].name,
      });
    }
    $("drop").hidden = true;
    $("app").hidden = false;
    showInfo();
    showChannels();
    showOrientation();
    measureViews();
    render();
    startPanels();
  } catch (err) {
    status(String((err as Error).message ?? err), true);
  } finally {
    idle();
  }
}

function showInfo() {
  const info = state.info!;
  const plan = state.plan!;
  const l0 = info.levels[0];
  const fmt = (v: number[]) => v.map((x) => (x < 10 ? x.toFixed(2) : x.toFixed(0))).join(" × ");
  const rows: [string, string][] = [
    ["Format", info.format === "imaris" ? "Imaris" : `OME-Zarr ${info.metadata.NGFF ?? ""}`],
    ...(info.metadata.Creator ? [["Written by", info.metadata.Creator] as [string, string]] : []),
    ...(info.metadata.RecordingDate ? [["Recorded", info.metadata.RecordingDate] as [string, string]] : []),
    ["Size (x × y × z)", fmt([...l0.shape].reverse())],
    ["Voxel (µm)", fmt([...l0.voxelSize].reverse())],
    ...(state.size ? [["File size", `${(state.size / 1e9).toFixed(1)} GB`] as [string, string]] : []),
    ["Shown at", `level ${plan.level}, ${fmt([...plan.voxelSize].reverse())} µm`],
  ];
  $("file-name").textContent = state.name;
  $("file-info").replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

function showChannels() {
  const box = $("channels");
  box.replaceChildren();
  state.channels.forEach((ch, c) => {
    const row = document.createElement("div");
    row.className = "channel";
    const vis = document.createElement("input");
    vis.type = "checkbox";
    vis.checked = ch.visible;
    vis.title = "Show";
    vis.onchange = () => ((ch.visible = vis.checked), render());
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = `rgb(${ch.color.map((x) => x * 255).join(",")})`;
    const name = document.createElement("input");
    name.type = "text";
    name.value = ch.stain;
    name.placeholder = `Channel ${c}: stain?`;
    name.oninput = () => (ch.stain = name.value.trim());
    row.append(vis, sw, name);
    box.append(row);
  });
}

// ---- orientation ------------------------------------------------------------------

function showOrientation() {
  const sel = $<HTMLSelectElement>("preset");
  sel.replaceChildren(
    ...state.presets.map((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${p.label} (${p.orientation})${p.id === state.preset!.id ? " – suggested" : ""}`;
      o.selected = p.id === state.preset!.id;
      return o;
    }),
  );
  updateOrientation();
}

function setOrientation(s: string) {
  state.orientation = s;
  $<HTMLInputElement>("confirmed").checked = false;
  updateOrientation();
  render();
}

function updateOrientation() {
  const input = $<HTMLInputElement>("orientation");
  if (document.activeElement !== input) input.value = state.orientation;
  input.classList.remove("invalid");
  const warn = $("handedness");
  const mirrored = handedness(state.orientation) !== handedness(state.preset!.orientation);
  warn.hidden = !mirrored;
  warn.textContent = mirrored
    ? `Mirrored compared with "${state.preset!.label}". A mirrored brain looks normal, so only keep this if you know this acquisition is mirrored.`
    : "";
}

$<HTMLSelectElement>("preset").onchange = (e) => {
  state.preset = state.presets.find((p) => p.id === (e.target as HTMLSelectElement).value)!;
  setOrientation(state.preset.orientation);
};

$<HTMLInputElement>("orientation").oninput = (e) => {
  const input = e.target as HTMLInputElement;
  const s = input.value.toUpperCase();
  if (isValid(s)) setOrientation(s);
  else input.classList.add("invalid");
};

document.querySelectorAll<HTMLButtonElement>("[data-rot]").forEach((b) => {
  const [axis, turns] = b.dataset.rot!.split(",");
  b.title = `Turn the brain 90° about the ${axis === "R" ? "left–right" : axis === "A" ? "anterior–posterior" : "superior–inferior"} axis`;
  b.onclick = () => setOrientation(rotate(state.orientation, axis as RotationAxis, Number(turns)));
});

$("mirror").onclick = () => {
  if (
    confirm(
      "Left and right cannot be told apart in the image: a mirrored brain still looks like a brain. " +
        "Mirror only if you know this acquisition writes mirrored images. Mirror?",
    )
  )
    setOrientation(mirrorLR(state.orientation));
};

// ---- views ----------------------------------------------------------------------
//
// Three fixed square boxes with the anatomical labels fixed around them, all at
// one physical scale that fits the volume in any orientation: changing the
// orientation turns the brain inside the boxes and moves nothing else.

document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => {
  r.onchange = () => ((state.mode = r.value as "mip" | "slice"), render());
});

const viewEls = new Map<ViewName, { canvas: HTMLCanvasElement; slider: HTMLInputElement }>();
/** Where each view's plane is drawn: offset (px), px per plane pixel, and the plane size. */
const drawn = new Map<ViewName, { ox: number; oy: number; sx: number; sy: number; width: number; height: number }>();

function buildViews() {
  const box = $("views");
  box.replaceChildren();
  for (const view of VIEWS) {
    const [left, right, top, bottom] = VIEW_LABELS[view];
    const el = document.createElement("div");
    el.className = "view";
    const cell = (text: string, cls = "") => {
      const s = document.createElement("span");
      s.textContent = text;
      if (cls) s.className = cls;
      return s;
    };
    const canvas = document.createElement("canvas");
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.005";
    slider.value = String(state.position[view]);
    slider.oninput = () => ((state.position[view] = Number(slider.value)), render());
    el.append(cell(""), cell(top), cell(""), cell(left), canvas, cell(right), cell(""), cell(bottom), cell(""));
    el.append(cell(view, "title"), slider);
    box.append(el);
    canvas.onclick = (e) => onViewClick(view, e);
    canvas.title = "Click to add a full-resolution zoom here";
    viewEls.set(view, { canvas, slider });
  }
}
buildViews();

/** Box size in px: measured when an image is shown and when the window is resized, never on a redraw. */
let boxPx = 400;
function measureViews() {
  const width = $("views").clientWidth;
  boxPx = Math.max(200, Math.min(480, Math.floor((width - 3 * 40) / 3)));
}

function render() {
  if (!state.channels.length) return;
  const vol = state.channels[0].volume;
  const extent = Math.max(...vol.shape.map((n, i) => n * vol.voxelSize[i]));
  const scale = boxPx / extent; // px per um, the same for every view and orientation
  const visible = state.channels.filter((c) => c.visible);

  for (const view of VIEWS) {
    const { canvas, slider } = viewEls.get(view)!;
    slider.style.visibility = state.mode === "slice" ? "visible" : "hidden";
    canvas.width = canvas.height = boxPx;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, boxPx, boxPx);
    if (!visible.length) continue;
    const pos = state.mode === "mip" ? "mip" : state.position[view];
    const layers: Layer[] = visible.map((c) => ({
      plane: viewPlane(c.volume, c.mips, state.orientation, view, pos),
      window: pos === "mip" ? c.mipWindows[mipAxis(state.orientation, view)] : c.window,
      color: c.color,
    }));
    const { plane } = layers[0];
    const off = new OffscreenCanvas(plane.width, plane.height);
    off.getContext("2d")!.putImageData(new ImageData(composite(layers), plane.width, plane.height), 0, 0);
    const w = plane.width * plane.pixelSize[0] * scale;
    const h = plane.height * plane.pixelSize[1] * scale;
    ctx.imageSmoothingEnabled = true;
    const ox = (boxPx - w) / 2;
    const oy = (boxPx - h) / 2;
    ctx.drawImage(off, ox, oy, w, h);
    const t = { ox, oy, sx: w / plane.width, sy: h / plane.height, width: plane.width, height: plane.height };
    drawn.set(view, t);
    drawMarkers(ctx, view, t);
  }
}

function drawMarkers(ctx: CanvasRenderingContext2D, view: ViewName, t: { ox: number; oy: number; sx: number; sy: number; width: number; height: number }) {
  const vol = state.channels[0].volume;
  const [h, v] = VIEW_AXES[view];
  // where the two light-sheet sides meet, if that axis lies in this view
  const split = psfPanel?.splitLine();
  if (split) {
    const at: [number, number, number] = [0, 0, 0];
    at[split.axis] = split.level0;
    const ov = level0ToOverview(state.info!, state.plan!, at)[split.axis];
    const imageAxis = 2 - split.axis; // array axis 2 (x) is image axis 0
    const map = rasAxisMap(state.orientation);
    const k = map.findIndex((m) => m.imageAxis === imageAxis);
    const n = vol.shape[split.axis];
    const ras = map[k].flip ? n - 1 - ov : ov;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "rgba(255,255,255,.7)";
    ctx.beginPath();
    if (k === h) {
      const x = t.ox + (ras + 0.5) * t.sx;
      ctx.moveTo(x, t.oy);
      ctx.lineTo(x, t.oy + t.height * t.sy);
    } else if (k === v) {
      const y = t.oy + (t.height - 1 - ras + 0.5) * t.sy;
      ctx.moveTo(t.ox, y);
      ctx.lineTo(t.ox + t.width * t.sx, y);
    }
    ctx.stroke();
    ctx.restore();
  }
  ctx.font = "600 11px system-ui";
  ctx.lineWidth = 1.5;
  for (const m of markers()) {
    const ov = level0ToOverview(state.info!, state.plan!, m.level0);
    const ras = arrayToRas(state.orientation, vol.shape, ov);
    const x = t.ox + (ras[h] + 0.5) * t.sx;
    const y = t.oy + (t.height - 1 - ras[v] + 0.5) * t.sy;
    ctx.strokeStyle = ctx.fillStyle = m.kind === "zoom" ? "#ffd60a" : m.side ? SIDE_COLORS[m.side] : "#ff6b9d";
    ctx.beginPath();
    if (m.kind === "zoom") ctx.arc(x, y, 6, 0, 2 * Math.PI);
    else ctx.rect(x - 5, y - 5, 10, 10);
    ctx.stroke();
    ctx.fillText(m.label, x + 8, y - 6);
  }
}

/** A click on a view adds a zoom there: at the slice shown, or the brightest voxel along the projection. */
function onViewClick(view: ViewName, e: MouseEvent) {
  const t = drawn.get(view);
  if (!t || !zoomPanel) return;
  const canvas = viewEls.get(view)!.canvas;
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) * canvas.width) / rect.width;
  const py = ((e.clientY - rect.top) * canvas.height) / rect.height;
  const col = Math.floor((px - t.ox) / t.sx);
  const row = Math.floor((py - t.oy) / t.sy);
  if (col < 0 || row < 0 || col >= t.width || row >= t.height) return;
  const vis = state.channels.find((c) => c.visible) ?? state.channels[0];
  const vol = vis.volume;
  const { size } = rasGeometry(vol.shape, vol.voxelSize, state.orientation);
  const [h, v, th] = VIEW_AXES[view];
  const ras = [0, 0, 0];
  ras[h] = col;
  ras[v] = t.height - 1 - row;
  ras[th] =
    state.mode === "mip"
      ? brightestDepth(vol, state.orientation, view, col, row)
      : Math.round(state.position[view] * (size[th] - 1));
  zoomPanel.addClicked(overviewToLevel0(state.info!, state.plan!, rasToArray(state.orientation, vol.shape, ras)));
}
window.addEventListener("resize", () => (measureViews(), render()));

// ---- panels below the views -------------------------------------------------------

let zoomPanel: ZoomPanel | null = null;
let psfPanel: PsfPanel | null = null;
let correlations: (number | null)[][] | null = null;

function channelNames() {
  return state.channels.map((c, i) => c.stain || state.info!.channels[i].name);
}

function startPanels() {
  const ctx: AppContext = {
    call: (body, progress) => call(body, progress),
    info: state.info!,
    plan: state.plan!,
    channelNames,
    redrawViews: () => render(),
  };
  zoomPanel = new ZoomPanel(ctx, $("zoom-panel"));
  zoomPanel.suggest();
  psfPanel = new PsfPanel(ctx, $("psf-panel"));
  correlations = null;
  showMetrics();
  call<(number | null)[][]>({ type: "correlations" }).then((m) => ((correlations = m), showMetrics()));
}

function showMetrics() {
  renderMetrics(
    $("metrics-panel"),
    channelNames(),
    state.channels.map((c) => c.metrics),
    correlations,
  );
}

function markers(): Marker[] {
  return [...(zoomPanel?.markers() ?? []), ...(psfPanel?.markers() ?? [])];
}

// ---- export -----------------------------------------------------------------------

$("export").onclick = () => {
  const info = state.info!;
  const l0 = info.levels[0];
  const rating = document.querySelector<HTMLInputElement>('input[name="rating"]:checked')?.value ?? null;
  const out = {
    image: { name: state.name, format: info.format, size: state.size },
    // BIDS microscopy sidecar fields, as SPIMpack and SPIMquant read them
    OrientationStringXYZ: state.orientation,
    PixelSize: [...l0.voxelSize].reverse().map((v) => Number((v / 1000).toPrecision(6))),
    PixelSizeUnits: "mm",
    SampleStaining: state.channels.map((c, i) => c.stain || info.channels[i].name),
    orientation: {
      confirmed: $<HTMLInputElement>("confirmed").checked,
      preset: state.preset!.id,
      storedInFile: info.orientation ?? null,
      mirroredFromPreset: handedness(state.orientation) !== handedness(state.preset!.orientation),
    },
    qc: { rating, note: $<HTMLTextAreaElement>("note").value },
    metrics: Object.fromEntries(state.channels.map((c, i) => [channelNames()[i], c.metrics])),
    zooms: zoomPanel?.summary() ?? [],
    resolution: psfPanel?.summary() ?? null,
    metadata: info.metadata,
    savedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = state.name.replace(/(\.ome)?\.(ims|ozx|zarr|zip)$/i, "") + "_qc.json";
  a.click();
  URL.revokeObjectURL(a.href);
};

$("close").onclick = () => {
  $("app").hidden = true;
  $("drop").hidden = false;
};

// ---- choosing and dropping ------------------------------------------------------------

function openFile(file: File) {
  folder = null;
  open({ kind: "file", file }, file.size);
}

function openFolder(f: Folder) {
  folder = f;
  open({ kind: "folder", name: f.name }, null);
}

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  $("drop").classList.add("over");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) $("drop").classList.remove("over");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  $("drop").classList.remove("over");
  const item = e.dataTransfer?.items[0];
  const entry = item?.webkitGetAsEntry?.();
  if (entry?.isDirectory) openFolder(folderFromEntry(entry as FileSystemDirectoryEntry));
  else {
    const file = e.dataTransfer?.files[0];
    if (file) openFile(file);
  }
});

$<HTMLInputElement>("file-input").onchange = (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) openFile(file);
};

$("folder-button").onclick = async () => {
  const picker = (window as any).showDirectoryPicker as (() => Promise<FileSystemDirectoryHandle>) | undefined;
  if (!picker) return $("folder-input").click();
  try {
    openFolder(folderFromHandle(await picker()));
  } catch {
    /* cancelled */
  }
};
$<HTMLInputElement>("folder-input").onchange = (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (files?.length) openFolder(folderFromFileList(files));
};
