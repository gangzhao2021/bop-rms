import { describe, expect, it } from "vitest";
import { dropIndex, moveTo } from "./reorder.js";

describe("WP-2423 Q32 reordering", () => {
  it("moves one entry to any position, clamped, and keeps the list when nothing moves", () => {
    const list = ["a", "b", "c", "d"] as const;
    expect(moveTo(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveTo(list, 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(moveTo(list, 1, 2)).toEqual(["a", "c", "b", "d"]);
    expect(moveTo(list, 2, 99)).toEqual(["a", "b", "d", "c"]);
    expect(moveTo(list, 1, -5)).toEqual(["b", "a", "c", "d"]);
    expect(moveTo(list, 1, 1)).toBe(list);
    expect(moveTo(list, 7, 0)).toBe(list);
  });
  it("drops a dragged row where the pointer is, counting only the other rows above it", () => {
    // Rows with middles at 10, 30, 50, 70.
    const middles = [10, 30, 50, 70];
    expect(dropIndex(5, middles, 2)).toBe(0);
    expect(dropIndex(35, middles, 0)).toBe(1);
    expect(dropIndex(55, middles, 0)).toBe(2);
    expect(dropIndex(99, middles, 0)).toBe(3);
    expect(dropIndex(45, middles, 2)).toBe(2);
    expect(moveTo(["a", "b", "c", "d"], 0, dropIndex(55, middles, 0))).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });
});
