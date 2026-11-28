/**
 * Resolution estimate (experimental): full-resolution blocks at points spread
 * through the tissue; widths of small bright spots along x, y and z, the extra
 * blur along z from the spectra, and the average spot.
 *
 * Optionally per light-sheet side: the tissue is split at its midline along the
 * axis the sheets travel (image x by default), and each half is measured
 * separately, to show a sheet that is out of alignment.
 */
import { fitGaussian1d, FWHM_PER_SIGMA } from "../analysis/psf";
import type { PsfPlan, PsfResult, SidesResult } from "../worker";
import { drawGrey, el, fmt, scaleBar, type AppContext, type Marker, type SplitLine } from "./context";

const NUCLEAR = /yo-?pro|to-?pro|dapi|hoechst|syto|nuc|draq|propidium|\bpi\b/i;

/** Colours of the two sides, on the views and in the tables. */
export const SIDE_COLORS = { low: "#4cc9f0", high: "#ff6b9d" } as const;

/** A side is flagged when its value is this much larger than the other's. */
const SIDE_DIFFERENCE = 0.2;

export class PsfPanel {
  private channel: number;
  private points = 6;
  /** array axis the sheets travel along, or null to not compare sides */
  private sides: 1 | 2 | null = 2;
  private plan: PsfPlan | null = null;
  private result: PsfResult | SidesResult | null = null;
  private running = false;

  constructor(private ctx: AppContext, private root: HTMLElement) {
    const names = ctx.channelNames();
    const nuclear = names.findIndex((n) => NUCLEAR.test(n));
    this.channel = nuclear >= 0 ? nuclear : names.length - 1;
    this.build();
    this.updatePlan();
  }

  markers(): Marker[] {
    const p = this.plan;
    if (!p) return [];
    const count = { low: 0, high: 0, all: 0 };
    return p.level0.map((l0, i) => {
      const side = p.side[i];
      const n = ++count[side ?? "all"];
      return { level0: l0, label: side ? `${side === "low" ? "a" : "b"}${n}` : `P${n}`, kind: "psf" as const, side };
    });
  }

  splitLine(): SplitLine | null {
    return this.plan?.split ? { axis: this.plan.split.axis, level0: this.plan.split.level0 } : null;
  }

  private controls!: HTMLElement;
  private out!: HTMLElement;
  private button!: HTMLButtonElement;
  private progress!: HTMLProgressElement;
  private pointsLabel!: HTMLElement;

  private build() {
    const sel = el("select");
    this.ctx.channelNames().forEach((n, c) => sel.append(el("option", { value: String(c), textContent: n, selected: c === this.channel })));
    sel.onchange = () => ((this.channel = Number(sel.value)), this.updatePlan());
    const pts = el("input", { type: "number", min: "1", max: "20", value: String(this.points), className: "narrow" });
    pts.onchange = () => ((this.points = Math.min(20, Math.max(1, Number(pts.value) || 6))), this.updatePlan());
    const sides = el("select");
    sides.append(
      el("option", { value: "2", textContent: "along x", selected: this.sides === 2 }),
      el("option", { value: "1", textContent: "along y", selected: this.sides === 1 }),
      el("option", { value: "", textContent: "no (whole tissue)", selected: this.sides === null }),
    );
    sides.onchange = () => {
      this.sides = sides.value ? (Number(sides.value) as 1 | 2) : null;
      this.pointsLabel.textContent = this.sides ? "Points per side " : "Points ";
      this.updatePlan();
    };
    sides.title = "Measure each half of the tissue separately, split at its midline along the axis the light sheets travel";
    this.pointsLabel = el("span", {}, this.sides ? "Points per side " : "Points ");
    this.button = el("button", { textContent: "Estimate" });
    this.button.onclick = () => (this.running ? this.ctx.call({ type: "cancel" }) : this.run());
    this.progress = el("progress", { max: 1, value: 0, hidden: true });
    this.controls = el("span", { className: "hint" });
    this.out = el("div");
    this.root.replaceChildren(
      el(
        "p",
        { className: "hint" },
        "Tissue has few objects smaller than the PSF, so spot widths are those of the smallest objects blurred by the PSF: upper bounds, best compared between scans of the same stain, or between the two light-sheet sides. A nuclear stain works best. The extra z blur from the spectra does not depend on object size, but assumes structure that is the same in all directions.",
      ),
      el(
        "div",
        { className: "zoom-controls" },
        el("label", {}, "Channel ", sel),
        el("label", {}, "Compare light-sheet sides ", sides),
        el("label", {}, this.pointsLabel, pts),
        this.button,
        this.progress,
        this.controls,
      ),
      this.out,
    );
  }

  private async updatePlan() {
    this.result = null;
    this.out.replaceChildren();
    this.plan = await this.ctx.call<PsfPlan>({ type: "psf-plan", channel: this.channel, points: this.points, sides: this.sides });
    this.controls.textContent = `reads ${(this.plan.bytes / 1e9).toFixed(2)} GB of full-resolution data`;
    this.ctx.redrawViews();
  }

  private async run() {
    this.running = true;
    this.button.textContent = "Cancel";
    this.progress.hidden = false;
    this.progress.value = 0;
    try {
      this.result = await this.ctx.call<PsfResult | SidesResult>(
        { type: "psf", channel: this.channel, points: this.points, sides: this.sides },
        (f) => (this.progress.value = f),
      );
      if ("low" in this.result) this.renderSides(this.result);
      else this.renderSingle(this.result);
    } catch (e) {
      this.out.replaceChildren(el("p", { className: "status error" }, String((e as Error).message)));
    } finally {
      this.running = false;
      this.button.textContent = "Estimate";
      this.progress.hidden = true;
      this.ctx.redrawViews();
    }
  }

  // ---- one set of points ------------------------------------------------------------

  private renderSingle(r: PsfResult) {
    const names = this.ctx.channelNames();
    const avg = averageWidths(r);
    const ratio = (a: number | null, b: number | null) => (a && b ? a / b : null);
    const summary = el(
      "table",
      { className: "metrics" },
      el("thead", {}, el("tr", {}, el("th", {}, names[r.channel]), el("th", {}, "x-y"), el("th", {}, "z"), el("th", {}, "z / x-y"))),
      el(
        "tbody",
        {},
        ...measures(r, avg).map((m) =>
          el(
            "tr",
            {},
            el("td", { title: m.help }, m.name),
            el("td", {}, m.xy === undefined ? "" : fmt(m.xy)),
            el("td", {}, fmt(m.z)),
            el("td", {}, m.xy === undefined ? "" : fmt(ratio(m.z, m.xy ?? null), 2)),
          ),
        ),
        el("tr", {}, el("td", {}, "Spots measured"), el("td", {}, String(r.xy.n / 2)), el("td", {}, String(r.z.n)), el("td", {}, "")),
      ),
    );
    this.out.replaceChildren(
      el("div", { className: "psf-results" }, summary, averageSpotView(r, "")),
      el("p", { className: "hint" }, `Per point (marked P1… on the views; voxels ${voxelText(r)} µm):`),
      pointsTable(r.points.map((p, i) => ({ p, label: `P${i + 1}`, side: null }))),
    );
  }

  // ---- two sides ------------------------------------------------------------------

  private renderSides(r: SidesResult) {
    const axis = r.axis === 2 ? "x" : "y";
    const lowAvg = averageWidths(r.low);
    const highAvg = averageWidths(r.high);
    const low = measures(r.low, lowAvg);
    const high = measures(r.high, highAvg);
    const sideHead = (side: "low" | "high") =>
      el("th", { style: `color:${SIDE_COLORS[side]}` } as any, side === "low" ? `low ${axis} (a)` : `high ${axis} (b)`);
    const cell = (v: number | null | undefined, other: number | null | undefined) => {
      const worse = v != null && other != null && other > 0 && v > other * (1 + SIDE_DIFFERENCE);
      const td = el("td", { className: worse ? "warn" : "" }, fmt(v));
      if (worse) td.title = `${Math.round((v! / other! - 1) * 100)}% wider than the other side`;
      return td;
    };
    const rows = low.flatMap((m, i) => {
      const h = high[i];
      const out = [];
      if (m.xy !== undefined)
        out.push(el("tr", {}, el("td", { title: m.help }, `${m.name}, x-y`), cell(m.xy, h.xy), cell(h.xy, m.xy), el("td", {}, diff(m.xy, h.xy))));
      out.push(el("tr", {}, el("td", { title: m.help }, `${m.name}${m.xy !== undefined ? ", z" : ""}`), cell(m.z, h.z), cell(h.z, m.z), el("td", {}, diff(m.z, h.z))));
      return out;
    });
    const table = el(
      "table",
      { className: "metrics" },
      el("thead", {}, el("tr", {}, el("th", {}, `${this.ctx.channelNames()[r.low.channel]} (µm)`), sideHead("low"), sideHead("high"), el("th", {}, "b − a"))),
      el(
        "tbody",
        {},
        ...rows,
        el("tr", {}, el("td", {}, "Spots measured (z)"), el("td", {}, String(r.low.z.n)), el("td", {}, String(r.high.z.n)), el("td", {}, "")),
      ),
    );
    const verdict = sidesVerdict(r, lowAvg, highAvg, axis);
    this.out.replaceChildren(
      el("p", { className: verdict.warn ? "warning" : "hint" }, verdict.text),
      el(
        "div",
        { className: "psf-results" },
        table,
        averageSpotView(r.low, `low ${axis} (a)`, SIDE_COLORS.low),
        averageSpotView(r.high, `high ${axis} (b)`, SIDE_COLORS.high),
      ),
      el(
        "p",
        { className: "hint" },
        `The tissue is split at its midline along image ${axis} (dashed line on the views; level-0 ${axis} = ${r.splitLevel0}). "Low" and "high" are image ${axis}; which laser lights which side depends on the microscope. Per point (marked a1…, b1… on the views; voxels ${voxelText(r.low)} µm):`,
      ),
      pointsTable([
        ...r.low.points.map((p, i) => ({ p, label: `a${i + 1}`, side: "low" as const })),
        ...r.high.points.map((p, i) => ({ p, label: `b${i + 1}`, side: "high" as const })),
      ]),
    );
  }

  summary() {
    const r = this.result;
    if (!r) return null;
    const one = (s: PsfResult) => ({
      spotFwhmUm: { xy: s.xy, z: s.z },
      averageSpotFwhmUm: averageWidths(s),
      extraZBlurFwhmUm: s.extraZFwhm,
      points: s.points.map((p) => ({ level0: p.level0, spots: p.spots, xy: p.xy, z: p.z, extraZ: p.spectral.extraZFwhm, saturated: p.saturated })),
    });
    if ("low" in r)
      return {
        channel: this.ctx.channelNames()[r.low.channel],
        sides: { axis: r.axis === 2 ? "x" : "y", splitLevel0: r.splitLevel0, low: one(r.low), high: one(r.high) },
      };
    return { channel: this.ctx.channelNames()[r.channel], ...one(r) };
  }
}

// ---- shared pieces ---------------------------------------------------------------------

interface Measure {
  name: string;
  help: string;
  /** undefined: no x-y value for this measure */
  xy?: number | null;
  z: number | null;
}

function measures(r: PsfResult, avg: { xy: number | null; z: number | null }): Measure[] {
  return [
    { name: "Spot FWHM, narrow", help: "FWHM of the spots, lower quartile: the narrowest spots, closest to the PSF", xy: r.xy.q25, z: r.z.q25 },
    { name: "Spot FWHM, median", help: "Median FWHM of the spots", xy: r.xy.median, z: r.z.median },
    { name: "Average spot FWHM", help: "FWHM of the average of all spots", xy: avg.xy, z: avg.z },
    {
      name: "Extra z blur, spectral",
      help: "FWHM of the Gaussian blur that z has beyond x-y, from the power spectra (median over points)",
      z: r.extraZFwhm,
    },
  ];
}

function diff(a: number | null | undefined, b: number | null | undefined) {
  return a != null && b != null ? `${b - a >= 0 ? "+" : ""}${(b - a).toFixed(1)}` : "–";
}

/** One sentence on whether the sides differ, from the z measures that both sides have. */
function sidesVerdict(r: SidesResult, lowAvg: { z: number | null }, highAvg: { z: number | null }, axis: string) {
  const pairs: [string, number | null, number | null][] = [
    ["median spot z FWHM", r.low.z.median, r.high.z.median],
    ["average spot z FWHM", lowAvg.z, highAvg.z],
    ["spectral extra z blur", r.low.extraZFwhm, r.high.extraZFwhm],
  ];
  const worse = { low: [] as string[], high: [] as string[] };
  for (const [name, a, b] of pairs) {
    if (a == null || b == null || a <= 0 || b <= 0) continue;
    if (b > a * (1 + SIDE_DIFFERENCE)) worse.high.push(name);
    else if (a > b * (1 + SIDE_DIFFERENCE)) worse.low.push(name);
  }
  const side = worse.high.length > worse.low.length ? "high" : worse.low.length > worse.high.length ? "low" : null;
  if (!side || worse[side].length < 2)
    return { warn: false, text: `The two sides along ${axis} are similar (no z measure differs by more than ${SIDE_DIFFERENCE * 100}% on both of two counts).` };
  return {
    warn: true,
    text: `The ${side} ${axis} side is blurrier along z (${worse[side].join(", ")} over ${SIDE_DIFFERENCE * 100}% wider): check the alignment of the light sheet on that side. Few points and tissue differences can also cause this; compare with other scans.`,
  };
}

function voxelText(r: PsfResult) {
  const [vz, vy, vx] = r.voxelSize;
  return `${fmt(vx, 2)} × ${fmt(vy, 2)} × ${fmt(vz, 2)}`;
}

function pointsTable(rows: { p: PsfResult["points"][number]; label: string; side: "low" | "high" | null }[]) {
  return el(
    "table",
    { className: "metrics" },
    el("thead", {}, el("tr", {}, ...["", "spots", "x-y narrow / median", "z narrow / median", "extra z, spectral", "saturated"].map((h) => el("th", {}, h)))),
    el(
      "tbody",
      {},
      ...rows.map(({ p, label, side }) =>
        el(
          "tr",
          {},
          el("td", { title: `level-0 voxel z, y, x: ${p.level0.join(", ")}`, style: side ? `color:${SIDE_COLORS[side]}` : "" } as any, label),
          el("td", {}, String(p.spots)),
          el("td", {}, `${fmt(p.xy.q25)} / ${fmt(p.xy.median)}`),
          el("td", {}, `${fmt(p.z.q25)} / ${fmt(p.z.median)}`),
          el("td", {}, fmt(p.spectral.extraZFwhm)),
          el("td", { className: (p.saturated ?? 0) > 0.001 ? "warn" : "" }, `${fmt((p.saturated ?? 0) * 100, 3)}%`),
        ),
      ),
    ),
  );
}

/** The average spot, x-y and x-z planes through its centre. */
function averageSpotView(r: PsfResult, title: string, color?: string) {
  const box = el("div", { className: "avg-spot" });
  if (title) box.append(el("p", { className: "plane-label", style: color ? `color:${color}` : "" } as any, title));
  if (!r.average.n) {
    box.append(el("p", { className: "hint" }, "No spots measured."));
    return box;
  }
  const [sz, sy, sx] = r.average.shape;
  const [vz, vy, vx] = r.voxelSize;
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
  return box;
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
