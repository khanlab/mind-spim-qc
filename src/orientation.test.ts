import { describe, expect, it } from "vitest";
import {
  allOrientations,
  handedness,
  isValid,
  mirrorLR,
  orientationsWithHandedness,
  rasAxisMap,
  rotate,
} from "./orientation";

describe("orientation strings", () => {
  it("validates", () => {
    expect(isValid("RAI")).toBe(true);
    expect(isValid("RLA")).toBe(false);
    expect(isValid("RA")).toBe(false);
    expect(isValid("rai")).toBe(false);
  });

  it("has 48 orientations, 24 of each handedness", () => {
    expect(allOrientations()).toHaveLength(48);
    expect(orientationsWithHandedness(1)).toHaveLength(24);
    expect(orientationsWithHandedness(-1)).toHaveLength(24);
  });

  it("gives the handedness of the presets", () => {
    expect(handedness("RAS")).toBe(1);
    expect(handedness("RPI")).toBe(1);
    expect(handedness("RAI")).toBe(-1);
  });

  it("rotates about S: R goes to A", () => {
    expect(rotate("RAS", "S", 1)).toBe("ALS");
    expect(rotate("RAS", "S", 2)).toBe("LPS");
    expect(rotate("RAS", "S", 4)).toBe("RAS");
    expect(rotate("RAS", "S", -1)).toBe(rotate("RAS", "S", 3));
  });

  it("rotates about R and A", () => {
    expect(rotate("RAS", "R", 1)).toBe("RSP"); // A -> S, S -> P
    expect(rotate("RAS", "A", 1)).toBe("IAR"); // S -> R, R -> I
  });

  it("keeps handedness under every rotation, and mirror flips it", () => {
    for (const s of allOrientations()) {
      for (const ax of ["R", "A", "S"] as const) {
        expect(handedness(rotate(s, ax, 1))).toBe(handedness(s));
      }
      expect(handedness(mirrorLR(s))).toBe(-handedness(s));
      expect(mirrorLR(mirrorLR(s))).toBe(s);
    }
  });

  it("reaches every orientation of a handedness by rotations", () => {
    const seen = new Set(["RAI"]);
    let frontier = ["RAI"];
    while (frontier.length) {
      const next: string[] = [];
      for (const s of frontier)
        for (const ax of ["R", "A", "S"] as const) {
          const t = rotate(s, ax, 1);
          if (!seen.has(t)) (seen.add(t), next.push(t));
        }
      frontier = next;
    }
    expect([...seen].sort()).toEqual(orientationsWithHandedness(-1).sort());
  });

  it("maps RAS axes to image axes", () => {
    // RAI: R along X, A along Y, S against Z
    expect(rasAxisMap("RAI")).toEqual([
      { imageAxis: 0, flip: false },
      { imageAxis: 1, flip: false },
      { imageAxis: 2, flip: true },
    ]);
    // PIR: X increases posteriorly, Y inferiorly, Z to the right
    expect(rasAxisMap("PIR")).toEqual([
      { imageAxis: 2, flip: false },
      { imageAxis: 0, flip: true },
      { imageAxis: 1, flip: true },
    ]);
  });
});
