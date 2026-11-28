import { describe, expect, it } from "vitest";
import { apply, type M4 } from "../registration/affine";
import { idx0ToWorld, tplVecToPhys, type Alignment } from "./alignment";
import { derivativePrefix, fcsvText, imageStem, instantiate, parseProtocol, type Protocol } from "./protocol";

const v0: [number, number, number] = [2, 2, 4];

describe("frames", () => {
  it("idx0ToWorld follows the orientation (RPI: x -> R, y -> P, z -> I)", () => {
    const M = idx0ToWorld("RPI", v0);
    expect(apply(M, [1, 0, 0])).toEqual([0.002, 0, 0]);
    expect(apply(M, [0, 1, 0])).toEqual([0, -0.002, 0]);
    expect(apply(M, [0, 0, 1])).toEqual([0, 0, -0.004]);
  });
});

describe("template protocols", () => {
  const text = JSON.stringify({
    protocol: "t", version: 2, space: "template", template: "ABAv3",
    landmarks: [
      { id: "a", name: "a", group: "point3d", definition: "", template_mm: [1, 2, 3], view: { kind: "ortho" }, clicks: ["point"] },
      // a coronal plane: right = R, up = S, normal = P (u x v)
      { id: "b", name: "b", group: "hippo", definition: "", template_mm: [0, 0, 0], view: { kind: "plane", u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0], locked: true }, clicks: ["point"] },
    ],
  });
  it("parses without subject positions", () => {
    const p = parseProtocol(text);
    expect(p.space).toBe("template");
    expect(p.image.channel).toBe(0);
  });
  it("places positions and keeps the anatomical direction of view vectors in a left-handed frame", () => {
    const p = parseProtocol(text);
    // identity alignment, image orientation RPI (left-handed)
    const toWorld = idx0ToWorld("RPI", v0);
    const I: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const al: Alignment = { template: "ABAv3", image: "x", orientation: "RPI", voxel0_um_xyz: v0, tpl2world: I, tpl2idx0: I, method: "", nudges: [], created: "" };
    // template mm -> idx0 = inverse of toWorld
    const toIdx0 = (mm: number[]) => [mm[0] / 0.002, -mm[1] / 0.002, -mm[2] / 0.004] as [number, number, number];
    const q = instantiate(p, toIdx0, (v) => tplVecToPhys(al, v), { name: "x", orientation: "RPI", channel: 0 });
    expect(q.space).toBe("subject");
    q.landmarks[0].position0.forEach((v, i) => expect(apply(toWorld, q.landmarks[0].position0)[i]).toBeCloseTo([1, 2, 3][i], 9));
    const view = q.landmarks[1].view;
    // u (screen right) must still point to R: +x under RPI
    expect(view.u![0]).toBeCloseTo(1, 9);
    // v (screen up) must point to S: -z under RPI (no flip from a cross product)
    expect(view.v![2]).toBeCloseTo(-1, 9);
    // normal to P: +y under RPI
    expect(view.normal![1]).toBeCloseTo(1, 9);
  });
});

describe("export", () => {
  it("names files after the image's BIDS entities", () => {
    expect(imageStem("sub-1_ses-exvivo_sample-brain_acq-4x_SPIM.ims")).toBe("sub-1_ses-exvivo_sample-brain_acq-4x");
    expect(derivativePrefix("sub-1_acq-4x_SPIM.ims", "a.k", "2")).toBe("sub-1_acq-4x_desc-akses2");
    expect(derivativePrefix("sub-1_acq-4x_SPIM.ims", "ak", "1")).toBe("sub-1_acq-4x_desc-ak");
  });
  it("writes Slicer fcsv rows", () => {
    const t = fcsvText([{ label: "Q01_pia", ras: [1, -2, 3.5] }]);
    expect(t.split("\n")[3]).toBe("vtkMRMLMarkupsFiducialNode_1,1.00000,-2.00000,3.50000,0,0,0,1,1,1,1,Q01_pia,,");
  });
});
