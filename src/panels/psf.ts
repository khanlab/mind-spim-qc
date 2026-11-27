/**
 * Resolution estimate (experimental): full-resolution blocks at points spread
 * through the tissue; widths of small bright spots along x, y and z, the extra
 * blur along z from the spectra, and the average spot.
 */
import { fitGaussian1d, FWHM_PER_SIGMA } from "../analysis/psf";
import type { PsfPlan, PsfResult } from "../worker";
import { drawGrey, el, fmt, scaleBar, type AppContext, type Marker } from "./context";

const NUCLEAR = /yo-?pro|to-?pro|dapi|hoechst|syto|nuc|draq|propidium|\bpi\b/i;

export class PsfPanel {
  private channel: number;
  private points = 6;
  private plan: PsfPlan | null = null;
  private result: PsfResult | null = null;
  private running = false;

  constructor(private ctx: AppContext, private root: HTMLElement) {
    const names = ctx.channelNames();
    const nuclear = names.findIndex((n) => NUCLEAR.test(n));
    this.channel = nuclear >= 0 ? nuclear : names.length - 1;
    this.build();
    this.updatePlan();
  }

  markers(): Marker[] {
    const at = this.result?.points.map((p) => p.level0) ?? this.plan?.level0 ?? [];
    return at.map((l0, i) => ({ level0: l0, label: `P${i + 1}`, kind: "psf" as const }));
  }

  private controls!: HTMLElement;
  private out!: HTMLElement;
  private button!: HTMLButtonElement;
  private progress!: HTMLProgressElement;

  private build() {
    const sel = el("select");
    this.ctx.channelNames().forEach((n, c) => sel.append(el("option", { value: String(c), textContent: n, selected: c === this.channel })));
    sel.onchange = () => ((this.channel = Number(sel.value)), this.updatePlan());
    const pts = el("input", { type: "number", min: "1", max: "20", value: String(this.points), className: "narrow" });
    pts.onchange = () => ((this.points = Math.min(20, Math.max(1, Number(pts.value) || 6))), this.updatePlan());
    this.button = el("button", { textContent: "Estimate" });
    this.button.onclick = () => (this.running ? this.ctx.call({ type: "cancel" }) : this.run());
    this.progress = el("progress", { max: 1, value: 0, hidden: true });
    this.controls = el("span", { className: "hint" });
    this.out = el("div");
    this.root.replaceChildren(
      el(
        "p",
        { className: "hint" },
        "Tissue has few objects smaller than the PSF, so spot widths are those of the smallest objects blurred by the PSF: upper bounds, best compared between scans of the same stain. A nuclear stain works best. The extra z blur from the spectra does not depend on object size, but assumes structure that is the same in all directions.",
      ),
      el("div", { className: "zoom-controls" }, el("label", {}, "Channel ", sel), el("label", {}, "Points ", pts), this.button, this.progress, this.controls),
      this.out,
    );
  }

  private async updatePlan() {
    this.plan = await this.ctx.call<PsfPlan>({ type: "psf-plan", channel: this.channel, points: this.points });
    this.controls.textContent = `reads ${(this.plan.bytes / 1e9).toFixed(2)} GB of full-resolution data`;
    if (!this.result) this.ctx.redrawViews();
  }

  private async run() {
    this.running = true;
    this.button.textContent = "Cancel";
    this.progress.hidden = false;
    this.progress.value = 0;
    try {
      this.result = await this.ctx.call<PsfResult>({ type: "psf", channel: this.channel, points: this.points }, (f) => (this.progress.value = f));
      this.render();
    } catch (e) {
      this.out.replaceChildren(el("p", { className: "status error" }, String((e as Error).message)));
    } finally {
      this.running = false;
      this.button.textContent = "Estimate";
      this.progress.hidden = true;
      this.ctx.redrawViews();
    }
  }

  private render() {
    const r = this.result!;
    const names = this.ctx.channelNames();
    const ratio = r.z.median && r.xy.median ? r.z.median / r.xy.median : null;
    const avg = averageWidths(r);
    const summary = el(
      "table",
      { className: "metrics" },
      el("thead", {}, el("tr", {}, el("th", {}, names[r.channel]), el("th", {}, "x-y"), el("th", {}, "z"), el("th", {}, "z / x-y"))),
      el(
        "tbody",
        {},
        el("tr", {}, el("td", { title: "FWHM of the spots, lower quartile: the narrowest spots, closest to the PSF" }, "Spot FWHM, narrow (µm)"), el("td", {}, fmt(r.xy.q25)), el("td", {}, fmt(r.z.q25)), el("td", {}, fmt(r.z.q25 && r.xy.q25 ? r.z.q25 / r.xy.q25 : null, 2))),
        el("tr", {}, el("td", {}, "Spot FWHM, median (µm)"), el("td", {}, fmt(r.xy.median)), el("td", {}, fmt(r.z.median)), el("td", {}, fmt(ratio, 2))),
        el("tr", {}, el("td", { title: "FWHM of the average of all spots" }, "Average spot FWHM (µm)"), el("td", {}, fmt(avg.xy)), el("td", {}, fmt(avg.z)), el("td", {}, fmt(avg.z && avg.xy ? avg.z / avg.xy : null, 2))),
        el(
          "tr",
          {},
          el("td", { title: "FWHM of the Gaussian blur that z has beyond x-y, from the power spectra (median over points)" }, "Extra z blur, spectral (µm)"),
          el("td", {}, ""),
          el("td", {}, fmt(r.extraZFwhm)),
          el("td", {}, ""),
        ),
        el("tr", {}, el("td", {}, "Spots measured"), el("td", {}, String(r.xy.n / 2)), el("td", {}, String(r.z.n)), el("td", {}, "")),
      ),
    );

    // the average spot, x-y and x-z planes through its centre
    const [sz, sy, sx] = r.average.shape;
    const [vz, vy, vx] = r.voxelSize;
    const box = el("div", { className: "avg-spot" });
    if (r.average.n) {
      const d = r.average.data;
      const xy = d.subarray(Math.floor(sz / 2) * sy * sx, (Math.floor(sz / 2) + 1) * sy * sx);
      const xz = new Float32Array(sz * sx);
      for (let k = 0; k < sz; k++) for (let x = 0; x < sx; x++) xz[k * sx + x] = d[(k * sy + Math.floor(sy / 2)) * sx + x];
      const scale = 160 / Math.max(sx * vx, sz * vz);
      const c1 = el("canvas");
      scaleBar(drawGrey(c1, xy, sx, sy, [0, 1], sx * vx * scale, sy * vy * scale), 1 / scale);
      const c2 = el("canvas");
      scaleBar(drawGrey(c2, xz, sx, sz, [0, 1], sx * vx * scale, sz * vz * scale), 1 / scale);
      box.append(
        el("div", {}, el("div", { className: "plane-label" }, "x-y"), c1),
        el("div", {}, el("div", { className: "plane-label" }, "x-z"), c2),
        el("p", { className: "hint" }, `Average of ${r.average.n} spots, each scaled to a peak of 1.`),
      );
    }

    const perPoint = el(
      "table",
      { className: "metrics" },
      el("thead", {}, el("tr", {}, ...["", "spots", "x-y narrow / median", "z narrow / median", "extra z, spectral", "saturated"].map((h) => el("th", {}, h)))),
      el(
        "tbody",
        {},
        ...r.points.map((p, i) =>
          el(
            "tr",
            {},
            el("td", { title: `level-0 voxel z, y, x: ${p.level0.join(", ")}` }, `P${i + 1}`),
            el("td", {}, String(p.spots)),
            el("td", {}, `${fmt(p.xy.q25)} / ${fmt(p.xy.median)}`),
            el("td", {}, `${fmt(p.z.q25)} / ${fmt(p.z.median)}`),
            el("td", {}, fmt(p.spectral.extraZFwhm)),
            el("td", { className: (p.saturated ?? 0) > 0.001 ? "warn" : "" }, `${fmt((p.saturated ?? 0) * 100, 3)}%`),
          ),
        ),
      ),
    );
    this.out.replaceChildren(
      el("div", { className: "psf-results" }, summary, box),
      el("p", { className: "hint" }, `Per point (marked P1… on the views; voxels ${fmt(vx, 2)} × ${fmt(vy, 2)} × ${fmt(vz, 2)} µm):`),
      perPoint,
    );
  }

  summary() {
    const r = this.result;
    if (!r) return null;
    const avg = averageWidths(r);
    return {
      channel: this.ctx.channelNames()[r.channel],
      spotFwhmUm: { xy: r.xy, z: r.z },
      averageSpotFwhmUm: avg,
      extraZBlurFwhmUm: r.extraZFwhm,
      points: r.points.map((p) => ({ level0: p.level0, spots: p.spots, xy: p.xy, z: p.z, extraZ: p.spectral.extraZFwhm, saturated: p.saturated })),
    };
  }
}

/** FWHM of the average spot along x-y (mean of x and y) and z, um. */
function averageWidths(r: PsfResult): { xy: number | null; z: number | null } {
  const [sz, sy, sx] = r.average.shape;
  if (!r.average.n) return { xy: null, z: null };
  const d = r.average.data;
  const cz = Math.floor(sz / 2);
  const cy = Math.floor(sy / 2);
  const cx = Math.floor(sx / 2);
  const line = (n: number, at: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => at(i));
  const w = (p: Float32Array, c: number, v: number) => {
    const f = fitGaussian1d(p, c);
    return f ? f.sigma * FWHM_PER_SIGMA * v : null;
  };
  const fz = w(line(sz, (k) => d[(k * sy + cy) * sx + cx]), cz, r.voxelSize[0]);
  const fy = w(line(sy, (k) => d[(cz * sy + k) * sx + cx]), cy, r.voxelSize[1]);
  const fx = w(line(sx, (k) => d[(cz * sy + cy) * sx + k]), cx, r.voxelSize[2]);
  return { xy: fy !== null && fx !== null ? (fy + fx) / 2 : fy ?? fx, z: fz };
}
