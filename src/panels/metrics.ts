/** Per-channel metrics of the overview, as in SPIMquant's QC report, with hints on what to look at. */
import type { ChannelMetrics } from "../worker";
import { el, fmt } from "./context";

interface Row {
  name: string;
  help: string;
  value: (m: ChannelMetrics) => number | null | undefined;
  digits: number;
  /** a hint when the value is outside the usual range */
  warn?: (v: number) => string | null;
}

const ROWS: Row[] = [
  {
    name: "SNR",
    help: "Tissue median above the background median, over the background noise (MAD)",
    value: (m) => m.intensity?.snr,
    digits: 1,
    warn: (v) => (v < 5 ? "low" : null),
  },
  { name: "Tissue / background", help: "Tissue median over background median", value: (m) => m.intensity?.tissueToBackground, digits: 2, warn: (v) => (v < 1.5 ? "low contrast" : null) },
  { name: "Signal range", help: "99.9th percentile of tissue over its median: high for sparse bright labelling, near 1 for flat signal", value: (m) => m.intensity?.signalRange, digits: 2 },
  {
    name: "Depth non-uniformity",
    help: "Variation (CV) of the median tissue intensity from plane to plane along z, the imaging depth: attenuation, uneven clearing or illumination",
    value: (m) => m.profiles[0]?.cv,
    digits: 3,
    warn: (v) => (v > 0.3 ? "intensity varies with depth" : null),
  },
  { name: "Non-uniformity along y / x", help: "As above, along the image y and x axes (worst of the two)", value: (m) => Math.max(m.profiles[1]?.cv ?? 0, m.profiles[2]?.cv ?? 0), digits: 3, warn: (v) => (v > 0.3 ? "uneven across the field" : null) },
  { name: "Tissue volume (mm³)", help: "Volume of the tissue mask", value: (m) => m.tissueVolumeMm3, digits: 0 },
  {
    name: "At the edge of the image",
    help: "Fraction of the tissue surface on the faces of the image: high when the sample is cut off by the field of view",
    value: (m) => m.edgeFraction,
    digits: 3,
    warn: (v) => (v > 0.05 ? "tissue may be cut off" : null),
  },
];

export function renderMetrics(root: HTMLElement, names: string[], metrics: ChannelMetrics[], correlations: (number | null)[][] | null) {
  const head = el("tr", {}, el("th", {}, ""), ...names.map((n) => el("th", {}, n)));
  const rows = ROWS.map((r) =>
    el(
      "tr",
      {},
      el("td", { title: r.help }, r.name),
      ...metrics.map((m) => {
        const v = r.value(m);
        const w = v !== null && v !== undefined && r.warn ? r.warn(v) : null;
        const td = el("td", { className: w ? "warn" : "" }, fmt(v, r.digits));
        if (w) td.title = w;
        return td;
      }),
    ),
  );
  const children: Node[] = [el("table", { className: "metrics" }, el("thead", {}, head), el("tbody", {}, ...rows))];
  if (correlations && names.length > 1) {
    const ch = el("tr", {}, el("th", {}, ""), ...names.map((n) => el("th", {}, n)));
    const cr = correlations.map((row, i) =>
      el(
        "tr",
        {},
        el("td", {}, names[i]),
        ...row.map((v, j) => {
          const td = el("td", { className: i !== j && v !== null && v > 0.9 ? "warn" : "" }, i === j ? "" : fmt(v, 2));
          if (i !== j && v !== null && v > 0.9) td.title = "very similar: bleed-through, or a shared background";
          return td;
        }),
      ),
    );
    children.push(
      el("p", { className: "hint" }, "Correlation of log intensities in tissue between channels (near 1 suggests bleed-through):"),
      el("table", { className: "metrics" }, el("thead", {}, ch), el("tbody", {}, ...cr)),
    );
  }
  const g = metrics[0]?.gridVoxelSize;
  if (g) children.push(el("p", { className: "hint" }, `Computed on the overview at ${g.map((v) => fmt(v, 0)).reverse().join(" × ")} µm (x × y × z), in a tissue mask (Otsu threshold of the smoothed log intensities). Hover a name for its definition.`));
  root.replaceChildren(...children);
}
