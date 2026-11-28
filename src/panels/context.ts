/** What the panels below the views need from the page. */
import type { ImageInfo, ReadPlan } from "../readers/types";
import type { Request } from "../worker";

export type Body = Request extends infer R ? (R extends any ? Omit<R, "id"> : never) : never;

export interface AppContext {
  call<T>(body: Body, progress?: (f: number) => void): Promise<T>;
  info: ImageInfo;
  plan: ReadPlan;
  /** stain names as entered */
  channelNames(): string[];
  /** redraw the anatomical views (their markers changed) */
  redrawViews(): void;
}

/** A place marked on the anatomical views. */
export interface Marker {
  /** level-0 voxel, z, y, x */
  level0: [number, number, number];
  label: string;
  kind: "zoom" | "psf";
  /** for resolution points measured per light-sheet side */
  side?: "low" | "high" | null;
}

/** A line across the views: where the two light-sheet sides meet. */
export interface SplitLine {
  /** array axis (1 = y, 2 = x) and level-0 position along it */
  axis: 1 | 2;
  level0: number;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

export const fmt = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(digits));

/** Draws a grey image of `values` (w x h) into a canvas of css size cw x ch, with a window. */
export function drawGrey(canvas: HTMLCanvasElement, values: ArrayLike<number>, w: number, h: number, window: [number, number], cw: number, ch: number) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const [lo, hi] = window;
  const s = 255 / Math.max(1e-9, hi - lo);
  for (let i = 0; i < w * h; i++) {
    const g = Math.min(255, Math.max(0, (values[i] - lo) * s));
    rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = g;
    rgba[4 * i + 3] = 255;
  }
  const off = new OffscreenCanvas(w, h);
  off.getContext("2d")!.putImageData(new ImageData(rgba, w, h), 0, 0);
  canvas.width = Math.round(cw);
  canvas.height = Math.round(ch);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = w < cw / 2; // smooth when enlarging a lot, else show pixels
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  return ctx;
}

/** A scale bar of a round length at the bottom right. */
export function scaleBar(ctx: CanvasRenderingContext2D, umPerPx: number) {
  const target = (ctx.canvas.width / 4) * umPerPx;
  const len = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].reduce((a, b) => (b <= target ? b : a), 1);
  const px = len / umPerPx;
  const x = ctx.canvas.width - px - 8;
  const y = ctx.canvas.height - 10;
  ctx.fillStyle = "#fff";
  ctx.fillRect(x, y, px, 3);
  ctx.font = "11px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(`${len} µm`, x + px / 2, y - 4);
}
