import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOftenOrdered, recordOrdered } from "./counter-often-ordered.js";
import { counterMenuSearch, parseCounterMenu, type CounterMenuItem } from "./staff-order-entry.js";

describe("counter: often-ordered dishes", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
  });

  it("lists a dish only after it was sent often, most sent first, per Store", () => {
    recordOrdered("store-1", [
      ["soup", 2],
      ["rice", 5],
    ]);
    expect(loadOftenOrdered("store-1")).toEqual(["rice"]);
    recordOrdered("store-1", [["soup", 4]]);
    expect(loadOftenOrdered("store-1")).toEqual(["soup", "rice"]);
    expect(loadOftenOrdered("store-2")).toEqual([]);
  });

  it("shows nothing when the browser's storage can't be read", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    recordOrdered("store-1", [["soup", 9]]);
    expect(loadOftenOrdered("store-1")).toEqual([]);
  });
});

describe("counter: menu search", () => {
  const item = (name: string, otherName?: string): CounterMenuItem => ({
    sellableReference: name,
    productVersionReference: null,
    name,
    ...(otherName ? { otherName } : {}),
    available: true,
    priceMinor: "100",
    rules: [],
  });
  const sections = [
    { sectionReference: "a", name: "Dim sum", items: [item("虾饺", "Har gow"), item("烧卖")] },
    { sectionReference: "b", name: "Rice", items: [item("白饭", "Steamed rice")] },
  ];

  it("finds a dish by either language, ignoring case, and drops empty sections", () => {
    expect(counterMenuSearch(sections, " har GOW ").map((s) => s.items[0]?.name)).toEqual(["虾饺"]);
    expect(counterMenuSearch(sections, "白饭").map((s) => s.name)).toEqual(["Rice"]);
    expect(counterMenuSearch(sections, "pizza")).toEqual([]);
    expect(counterMenuSearch(sections, "  ")).toBe(sections);
  });

  it("an older server without other names still gives a menu", () => {
    expect(
      parseCounterMenu({
        screenId: "OPS-ORDER-ENTRY",
        menu: {
          status: "Found",
          schemaVersion: 1,
          projection: {},
          scope: {},
          menu: {
            menuReference: "m",
            menuVersionReference: "v",
            releaseReference: "r",
            locale: "en",
            name: "Menu",
            effectiveFrom: null,
            effectiveUntil: null,
            sections: [],
          },
        },
      }).sections,
    ).toEqual([]);
  });
});
