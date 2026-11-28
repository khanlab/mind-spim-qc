/**
 * What the steps share about the open image, and moving between the steps:
 *   1 check  - QC and orientation (the QC views)
 *   2 align  - template alignment (ABAv3 by default; also for refining QC later)
 *   3 annotate - landmark placement, shown once a protocol is loaded
 */
import type { ImageInfo } from "./readers/types";
import type { Alignment } from "./landmarks/frames";

export type Step = "check" | "align" | "annotate";

export const app = {
  name: "",
  info: null as ImageInfo | null,
  orientation: "RAS",
  orientationConfirmed: false,
  /** stain names entered on the QC step, by channel */
  stains: [] as string[],
  /** fraction of the overview that is signal (tissue mask on log intensity), by channel */
  coverage: [] as number[],
  /** accepted alignments, by template */
  alignments: {} as Record<string, Alignment>,
  step: "check" as Step,
};

type Listener = () => void;
const listeners: Record<string, Listener[]> = {};
export function on(event: "image" | "orientation" | "alignment" | "step", fn: Listener) {
  (listeners[event] ??= []).push(fn);
}
export function emit(event: "image" | "orientation" | "alignment" | "step") {
  for (const fn of listeners[event] ?? []) fn();
}

const SECTIONS: Record<Step, string[]> = {
  check: ["app"],
  align: ["align"],
  annotate: ["annotate"],
};

export function setStep(step: Step) {
  app.step = step;
  for (const [s, ids] of Object.entries(SECTIONS))
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.hidden = s !== step;
    }
  document.querySelectorAll<HTMLButtonElement>("#stepbar [data-step]").forEach((b) => b.classList.toggle("current", b.dataset.step === step));
  emit("step");
}

/**
 * A channel that shows the anatomy: by stain name (nuclear stains,
 * autofluorescence) if one is given, else the channel whose signal covers the
 * most of the image (nuclei and autofluorescence fill the brain; plaques or
 * vessels are sparse).
 */
export function anatomyChannel(): number {
  const i = app.stains.findIndex((s) => /yo-?pro|to-?pro|dapi|hoechst|syto|nuc|propidium|\bpi\b|autofl|\baf\b/i.test(s));
  if (i >= 0) return i;
  let best = 0;
  app.coverage.forEach((c, k) => {
    if (c > (app.coverage[best] ?? -1)) best = k;
  });
  return best;
}
