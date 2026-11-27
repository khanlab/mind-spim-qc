/**
 * Full-resolution zooms: the brightest and dimmest places in the tissue, and any
 * place clicked on the views. Each shows the imaging plane (x-y) and a cut
 * through depth (x-z), as projections or slices, for one channel at a time, with
 * a black and white level shared by all zooms of the channel.
 */
import type { Zoom } from "../worker";
import { autoWindow } from "../views";
import { drawGrey, el, fmt, scaleBar, type AppContext, type Marker } from "./context";

interface Site {
  label: string;
  level0: [number, number, number];
  zooms: Map<number, Zoom | "loading" | Error>;
  /** slice position through z, 0..1 */
  z: number;
  card: HTMLElement;
}

const INSET_PX = 300;

export class ZoomPanel {
  private sites: Site[] = [];
  private channel = 0;
  private mode: "mip" | "slice" = "mip";
  private windows = new Map<number, [number, number]>();
  private clicked = 0;

  constructor(private ctx: AppContext, private root: HTMLElement) {
    root.replaceChildren();
    const channelSel = el("select");
    ctx.info.channels.forEach((_, c) => channelSel.append(el("option", { value: String(c), textContent: ctx.channelNames()[c] })));
    channelSel.onchange = () => {
      this.channel = Number(channelSel.value);
      this.loadAll();
      this.syncSliders();
      this.renderAll();
    };
    const mode = (value: "mip" | "slice", text: string) => {
      const r = el("input", { type: "radio", name: "zoom-mode", value, checked: value === "mip" });
      r.onchange = () => ((this.mode = value), this.renderAll());
      return el("label", {}, r, ` ${text}`);
    };
    this.black = el("input", { type: "range", min: "0", max: "1", step: "1" });
    this.white = el("input", { type: "range", min: "0", max: "1", step: "1" });
    const onLevel = () => {
      let lo = Number(this.black.value);
      let hi = Number(this.white.value);
      if (hi <= lo) hi = lo + 1;
      this.windows.set(this.channel, [lo, hi]);
      this.renderAll();
    };
    this.black.oninput = this.white.oninput = onLevel;
    const auto = el("button", { className: "secondary", textContent: "Auto" });
    auto.onclick = () => (this.windows.delete(this.channel), this.syncSliders(), this.renderAll());
    this.status = el("span", { className: "hint" });
    root.append(
      el(
        "div",
        { className: "zoom-controls" },
        el("label", {}, "Channel ", channelSel),
        mode("mip", "Projection"),
        mode("slice", "Slices"),
        el("label", {}, "Black ", this.black),
        el("label", {}, "White ", this.white),
        auto,
        this.status,
      ),
      (this.grid = el("div", { className: "zooms" })),
    );
  }

  private black: HTMLInputElement;
  private white: HTMLInputElement;
  private status: HTMLElement;
  private grid: HTMLElement;

  markers(): Marker[] {
    return this.sites.map((s, i) => ({ level0: s.level0, label: String(i + 1), kind: "zoom" as const }));
  }

  setChannel(c: number) {
    this.channel = c;
    (this.root.querySelector("select") as HTMLSelectElement).value = String(c);
  }

  async suggest() {
    const sites = await this.ctx.call<{ label: string; level0: [number, number, number] }[]>({
      type: "sites",
      channel: this.channel,
      bright: 2,
      dim: 2,
    });
    for (const s of sites) this.add(s.label, s.level0);
  }

  addClicked(level0: [number, number, number]) {
    this.add(`Clicked ${++this.clicked}`, level0);
  }

  private add(label: string, level0: [number, number, number]) {
    const card = el("div", { className: "zoom" });
    const site: Site = { label, level0, zooms: new Map(), z: 0.5, card };
    this.sites.push(site);
    this.grid.append(card);
    this.ctx.redrawViews();
    this.load(site);
    this.render(site);
  }

  private remove(site: Site) {
    this.sites = this.sites.filter((s) => s !== site);
    site.card.remove();
    this.sites.forEach((s) => this.render(s));
    this.ctx.redrawViews();
  }

  private loadAll() {
    for (const s of this.sites) this.load(s);
  }

  private async load(site: Site) {
    const c = this.channel;
    if (site.zooms.has(c)) return;
    site.zooms.set(c, "loading");
    this.updateStatus();
    try {
      const z = await this.ctx.call<Zoom>({ type: "zoom", level0: site.level0, channel: c });
      site.zooms.set(c, z);
    } catch (e) {
      site.zooms.set(c, e as Error);
    }
    this.updateStatus();
    if (c === this.channel) {
      this.syncSliders();
      this.renderAll();
    }
  }

  private updateStatus() {
    const n = this.sites.filter((s) => s.zooms.get(this.channel) === "loading").length;
    this.status.textContent = n ? `Reading ${n} zoom${n > 1 ? "s" : ""} at full resolution…` : "Click a view above to add a zoom there.";
  }

  private loaded(): Zoom[] {
    return this.sites.map((s) => s.zooms.get(this.channel)).filter((z): z is Zoom => !!z && typeof z === "object" && "volume" in z);
  }

  /** Slider range from the loaded zooms; the window from them unless set by hand. */
  private syncSliders() {
    const zooms = this.loaded();
    if (!zooms.length) return;
    let max = 0;
    for (const z of zooms) for (const v of z.volume.data) if (v > max) max = v;
    this.black.max = this.white.max = String(Math.max(1, max));
    if (!this.windows.has(this.channel)) {
      // auto: percentiles of the projections, pooled
      const pooled: number[] = [];
      for (const z of zooms) {
        const p = projectXY(z);
        for (let i = 0; i < p.values.length; i += 7) pooled.push(p.values[i]);
      }
      this.auto = autoWindow(pooled);
    }
    const w = this.windows.get(this.channel) ?? this.auto;
    this.black.value = String(w[0]);
    this.white.value = String(w[1]);
  }
  private auto: [number, number] = [0, 1];

  private renderAll() {
    for (const s of this.sites) this.render(s);
    this.updateStatus();
  }

  private render(site: Site) {
    const i = this.sites.indexOf(site) + 1;
    const close = el("button", { className: "close", textContent: "×", title: "Remove" });
    close.onclick = () => this.remove(site);
    const head = el("div", { className: "zoom-head" }, el("b", {}, `${i}. ${site.label}`), close);
    const z = site.zooms.get(this.channel);
    if (!z || z === "loading") {
      site.card.replaceChildren(head, el("div", { className: "zoom-loading" }, el("div", { className: "spinner" })));
      return;
    }
    if (z instanceof Error) {
      site.card.replaceChildren(head, el("p", { className: "status error" }, z.message));
      return;
    }
    const window = this.windows.get(this.channel) ?? this.auto;
    const [nz, ny, nx] = z.volume.shape;
    const [vz, vy, vx] = z.volume.voxelSize;
    const scale = INSET_PX / (nx * vx); // px per um
    const zi = Math.min(nz - 1, Math.round(site.z * (nz - 1)));
    const xy = this.mode === "mip" ? projectXY(z) : sliceXY(z, zi);
    const xz = this.mode === "mip" ? projectXZ(z) : sliceXZ(z, Math.floor(ny / 2));
    const cXY = el("canvas");
    const ctxXY = drawGrey(cXY, xy.values, nx, ny, window, nx * vx * scale, ny * vy * scale);
    scaleBar(ctxXY, 1 / scale);
    const cXZ = el("canvas");
    const ctxXZ = drawGrey(cXZ, xz.values, nx, nz, window, nx * vx * scale, nz * vz * scale);
    if (this.mode === "slice") {
      // where the x-y slice is
      ctxXZ.strokeStyle = "rgba(90,160,255,.8)";
      const y = (zi + 0.5) * vz * scale;
      ctxXZ.beginPath();
      ctxXZ.moveTo(0, y);
      ctxXZ.lineTo(cXZ.width, y);
      ctxXZ.stroke();
    }
    const children: (Node | string)[] = [head, el("div", { className: "plane-label" }, this.mode === "mip" ? "x-y, projection through z" : `x-y, slice ${zi + 1} of ${nz}`), cXY];
    if (this.mode === "slice") {
      const slider = el("input", { type: "range", min: "0", max: "1", step: String(1 / Math.max(1, nz - 1)), value: String(site.z) });
      slider.oninput = () => ((site.z = Number(slider.value)), this.render(site));
      children.push(slider);
    }
    const levelText = z.box.level === 0 ? "full resolution" : `level ${z.box.level} (chunks too large for full resolution)`;
    children.push(
      el("div", { className: "plane-label" }, this.mode === "mip" ? "x-z, projection through y" : "x-z, middle slice"),
      cXZ,
      el(
        "div",
        { className: "zoom-meta" },
        `${levelText}, ${fmt(vx, 2)} × ${fmt(vy, 2)} × ${fmt(vz, 2)} µm · sharpness ${fmt(z.sharpness, 2)} · saturated ${fmt((z.saturated ?? 0) * 100, 3)}%`,
      ),
    );
    site.card.replaceChildren(...children);
  }

  /** For the QC file and the metrics table. */
  summary() {
    return this.sites.map((s) => ({
      label: s.label,
      level0: s.level0,
      channels: [...s.zooms.entries()]
        .filter((e): e is [number, Zoom] => typeof e[1] === "object" && "volume" in e[1])
        .map(([c, z]) => ({ channel: c, level: z.box.level, sharpness: z.sharpness, saturated: z.saturated })),
    }));
  }
}

// ---- planes of a zoom (z, y, x) ------------------------------------------------

function projectXY(z: Zoom) {
  const [nz, ny, nx] = z.volume.shape;
  const values = new Float32Array(ny * nx).fill(-Infinity);
  const d = z.volume.data;
  for (let k = 0; k < nz; k++) for (let i = 0; i < ny * nx; i++) if (d[k * ny * nx + i] > values[i]) values[i] = d[k * ny * nx + i];
  return { values };
}

function projectXZ(z: Zoom) {
  const [nz, ny, nx] = z.volume.shape;
  const values = new Float32Array(nz * nx).fill(-Infinity);
  const d = z.volume.data;
  for (let k = 0; k < nz; k++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const v = d[(k * ny + y) * nx + x];
        if (v > values[k * nx + x]) values[k * nx + x] = v;
      }
  return { values };
}

function sliceXY(z: Zoom, k: number) {
  const [, ny, nx] = z.volume.shape;
  return { values: z.volume.data.subarray(k * ny * nx, (k + 1) * ny * nx) };
}

function sliceXZ(z: Zoom, y: number) {
  const [nz, ny, nx] = z.volume.shape;
  const values = new Float32Array(nz * nx);
  for (let k = 0; k < nz; k++) for (let x = 0; x < nx; x++) values[k * nx + x] = z.volume.data[(k * ny + y) * nx + x];
  return { values };
}
