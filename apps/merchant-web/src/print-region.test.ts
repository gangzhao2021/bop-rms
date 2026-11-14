import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { printRegion } from "./print-region.js";

/**
 * M50: a print rule that hides `body *` without a scope blanks every other page's print (Today's
 * summary printed a white page). Print hiding is allowed only under `body[data-printing]`, which
 * printRegion sets for the one region being printed.
 */
describe("print styles", () => {
  const dir = join(import.meta.dirname, "ui-refresh");
  const sheets = readdirSync(dir).filter((name) => name.endsWith(".css"));

  it.each(sheets)("%s never hides the whole page in print without a print region", (name) => {
    const css = readFileSync(join(dir, name), "utf8");
    const unscoped = css
      .split("\n")
      .filter((line) => /(^|[\s,])body\s+\*/.test(line) && !line.includes("body[data-printing]"));
    expect(unscoped).toEqual([]);
  });
});

describe("printRegion", () => {
  it("marks only the region being printed and clears the marks after printing", () => {
    const listeners = new Map<string, () => void>();
    const bodyAttributes = new Map<string, string>();
    const regionAttributes = new Map<string, string>();
    const region = {
      setAttribute: (name: string, value: string) => regionAttributes.set(name, value),
      removeAttribute: (name: string) => regionAttributes.delete(name),
    };
    const print = vi.fn(() => {
      expect(bodyAttributes.get("data-printing")).toBe("receipt");
      expect(regionAttributes.has("data-print-root")).toBe(true);
    });
    vi.stubGlobal("document", {
      body: {
        setAttribute: (name: string, value: string) => bodyAttributes.set(name, value),
        removeAttribute: (name: string) => bodyAttributes.delete(name),
      },
    });
    vi.stubGlobal("window", {
      print,
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    });
    printRegion(region as unknown as HTMLElement, "receipt");
    expect(print).toHaveBeenCalledOnce();
    listeners.get("afterprint")?.();
    expect(bodyAttributes.has("data-printing")).toBe(false);
    expect(regionAttributes.has("data-print-root")).toBe(false);
    vi.unstubAllGlobals();
  });
});
