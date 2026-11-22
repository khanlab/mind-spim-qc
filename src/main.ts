import {
  PRESETS,
  handedness,
  isValid,
  mirrorLR,
  rotate,
  suggestPreset,
  type Preset,
  type RotationAxis,
} from "./orientation";
import { overviewLevel, type ImageInfo, type Volume } from "./readers/types";
import { VIEW_LABELS, autoWindow, composite, viewPlane, type Layer, type ViewName } from "./views";
import type { Request } from "./worker";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- worker ---------------------------------------------------------------

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let nextId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
worker.onmessage = (e) => {
  const { id, result, error } = e.data;
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

// ---- state ----------------------------------------------------------------

interface ChannelState {
  volume: Volume;
  window: [number, number];
  color: [number, number, number];
  visible: boolean;
  stain: string;
}

const state = {
  file: null as File | null,
  info: null as ImageInfo | null,
  level: 0,
  channels: [] as ChannelState[],
  preset: PRESETS[0] as Preset,
  orientation: PRESETS[0].orientation,
  mode: "mip" as "mip" | "slice",
  position: { coronal: 0.5, sagittal: 0.5, axial: 0.5 } as Record<ViewName, number>,
};

const DEFAULT_COLORS: [number, number, number][] = [
  [1, 0, 1],
  [0, 1, 0],
  [0, 0.6, 1],
  [1, 1, 0],
];

// ---- opening a file -------------------------------------------------------

const status = (msg: string, error = false) => {
  $("status").textContent = msg;
  $("status").classList.toggle("error", error);
};

async function open(file: File) {
  try {
    status(`Opening ${file.name}…`);
    const { info } = await call<{ info: ImageInfo }>({ type: "open", file });
    state.file = file;
    state.info = info;
    state.level = overviewLevel(info);
    state.preset = suggestPreset(info.format, info.metadata);
    state.orientation = state.preset.orientation;
    state.channels = [];
    showInfo();
    $("drop").hidden = true;
    $("app").hidden = false;

    const t0 = performance.now();
    for (let c = 0; c < info.channels.length; c++) {
      $("read-status").textContent = `Reading channel ${c + 1} of ${info.channels.length}…`;
      const { volume } = await call<{ volume: Volume }>({ type: "read", level: state.level, channel: c });
      state.channels.push({
        volume,
        window: autoWindow(volume.data),
        color: DEFAULT_COLORS[c % DEFAULT_COLORS.length],
        visible: true,
        stain: "",
      });
    }
    $("read-status").textContent = `Read in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    showChannels();
    showOrientation();
    render();
  } catch (err) {
    status(String((err as Error).message ?? err), true);
    $("drop").hidden = false;
    $("app").hidden = true;
  }
}

function showInfo() {
  const info = state.info!;
  const l0 = info.levels[0];
  const lv = info.levels[state.level];
  const fmt = (v: number[]) => v.map((x) => (x < 10 ? x.toFixed(2) : x.toFixed(0))).join(" × ");
  const rows: [string, string][] = [
    ["Written by", info.metadata.Creator ?? "?"],
    ["Recorded", info.metadata.RecordingDate ?? "?"],
    ["Size (x × y × z)", fmt([...l0.shape].reverse())],
    ["Voxel (µm)", fmt([...l0.voxelSize].reverse())],
    ["File size", `${(state.file!.size / 1e9).toFixed(1)} GB`],
    ["Shown at", `level ${state.level}, ${fmt([...lv.voxelSize].reverse())} µm`],
  ];
  $("file-name").textContent = info.name;
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
    name.placeholder = `${state.info!.channels[c].name}: stain?`;
    name.oninput = () => (ch.stain = name.value.trim());
    row.append(vis, sw, name);
    box.append(row);
  });
}

// ---- orientation ----------------------------------------------------------

function showOrientation() {
  const sel = $<HTMLSelectElement>("preset");
  sel.replaceChildren(
    ...PRESETS.map((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${p.label} (${p.orientation})${p.id === state.preset.id ? " – suggested" : ""}`;
      o.selected = p.id === state.preset.id;
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
  const mirrored = handedness(state.orientation) !== handedness(state.preset.orientation);
  warn.hidden = !mirrored;
  warn.textContent = mirrored
    ? `Mirrored compared with "${state.preset.label}". A mirrored brain looks normal, so only keep this if you know this acquisition is mirrored.`
    : "";
}

$<HTMLSelectElement>("preset").onchange = (e) => {
  state.preset = PRESETS.find((p) => p.id === (e.target as HTMLSelectElement).value)!;
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

// ---- views ----------------------------------------------------------------

document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => {
  r.onchange = () => ((state.mode = r.value as "mip" | "slice"), render());
});

const VIEW_BOX = 420; // px, longest side of a view

function render() {
  const visible = state.channels.filter((c) => c.visible);
  const box = $("views");
  box.replaceChildren();
  if (!visible.length) return;
  for (const view of ["coronal", "sagittal", "axial"] as ViewName[]) {
    const pos = state.mode === "mip" ? "mip" : state.position[view];
    const layers: Layer[] = visible.map((c) => {
      const plane = viewPlane(c.volume, state.orientation, view, pos);
      // a projection is brighter than any slice, so window it on itself
      return { plane, window: pos === "mip" ? autoWindow(plane.values) : c.window, color: c.color };
    });
    const { plane } = layers[0];
    const off = new OffscreenCanvas(plane.width, plane.height);
    off.getContext("2d")!.putImageData(new ImageData(composite(layers) as any, plane.width, plane.height), 0, 0);
    const physW = plane.width * plane.pixelSize[0];
    const physH = plane.height * plane.pixelSize[1];
    const scale = VIEW_BOX / Math.max(physW, physH);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(physW * scale);
    canvas.height = Math.round(physH * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

    const [left, right, top, bottom] = VIEW_LABELS[view];
    const el = document.createElement("div");
    el.className = "view";
    const cell = (text: string, style = "") => {
      const s = document.createElement("span");
      s.textContent = text;
      if (style) s.setAttribute("style", style);
      return s;
    };
    el.append(
      cell(""), cell(top), cell(""),
      cell(left), canvas, cell(right),
      cell(""), cell(bottom), cell(""),
    );
    const title = cell(view);
    title.className = "title";
    el.append(title);
    if (state.mode === "slice") {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "1";
      slider.step = "0.005";
      slider.value = String(state.position[view]);
      slider.oninput = () => ((state.position[view] = Number(slider.value)), render());
      el.append(slider);
    }
    box.append(el);
  }
}

// ---- export ---------------------------------------------------------------

$("export").onclick = () => {
  const info = state.info!;
  const l0 = info.levels[0];
  const rating = document.querySelector<HTMLInputElement>('input[name="rating"]:checked')?.value ?? null;
  const out = {
    file: { name: state.file!.name, size: state.file!.size, lastModified: new Date(state.file!.lastModified).toISOString() },
    // BIDS microscopy sidecar fields, as SPIMpack and SPIMquant read them
    OrientationStringXYZ: state.orientation,
    PixelSize: [...l0.voxelSize].reverse().map((v) => Number((v / 1000).toPrecision(6))),
    PixelSizeUnits: "mm",
    SampleStaining: state.channels.map((c, i) => c.stain || info.channels[i].name),
    orientation: {
      confirmed: $<HTMLInputElement>("confirmed").checked,
      preset: state.preset.id,
      mirroredFromPreset: handedness(state.orientation) !== handedness(state.preset.orientation),
    },
    qc: { rating, note: $<HTMLTextAreaElement>("note").value },
    metadata: info.metadata,
    savedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = state.file!.name.replace(/\.ims$/i, "") + "_qc.json";
  a.click();
  URL.revokeObjectURL(a.href);
};

$("close").onclick = () => location.reload();

// ---- drag and drop --------------------------------------------------------

const drop = $("drop");
drop.ondragover = (e) => (e.preventDefault(), drop.classList.add("over"));
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const file = e.dataTransfer?.files[0];
  if (file) open(file);
};
$<HTMLInputElement>("file-input").onchange = (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) open(file);
};
