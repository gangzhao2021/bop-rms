import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { merchantRoutes, pilotHiddenRedirect } from "./pilot-routes.js";

// v15 aa3d9fac D3 (pilot rule "no reachable stubs"): typing /app/reports opened a layout review
// ("PHASE 2 · DESIGN REVIEW", "source values unavailable") and /app/reports/reconciliation an
// empty page. Every registered route is classified; screens without sources are hidden.
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

function registeredPaths(): string[] {
  const literal = [...appSource.matchAll(/<Route\s+path="([^"]+)"/gu)].map((match) => match[1]);
  // Routes registered from a list: {["/a", "/b"].map((path) => (<Route key={path} path={path} …
  const mapped = [...appSource.matchAll(/\{\[([^\]]+)\]\.map\(\(path\) => \(\s*<Route/gu)].flatMap(
    (match) => [...(match[1] ?? "").matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]),
  );
  return [...literal, ...mapped].filter(
    (path): path is string => path !== undefined && path !== "*",
  );
}

describe("merchant route classification", () => {
  it("classifies every route App.tsx registers, once", () => {
    const registered = registeredPaths();
    expect(registered.length).toBeGreaterThan(100);
    expect([...merchantRoutes.map((entry) => entry.path)].sort()).toEqual([...registered].sort());
    expect(new Set(merchantRoutes.map((entry) => entry.path)).size).toBe(merchantRoutes.length);
  });

  it("sends report layout reviews to the Store's sales reports", () => {
    for (const path of [
      "/app/reports",
      "/app/reports/reconciliation",
      "/app/reports/runs",
      "/app/reports/data-quality",
      "/app/reports/pipelines",
      "/app/reports/metrics",
      "/app/reports/review/edit",
    ])
      expect(pilotHiddenRedirect(path)).toBe("/app/reports/operations");
    expect(pilotHiddenRedirect("/app/reports/operations")).toBeNull();
  });

  it("keeps every working screen, including ones a hidden pattern would also match", () => {
    for (const entry of merchantRoutes.filter((candidate) => !candidate.hiddenTo))
      expect(pilotHiddenRedirect(entry.sample), entry.path).toBeNull();
    expect(pilotHiddenRedirect("/app/supply/items/x")).toBeNull();
    expect(pilotHiddenRedirect("/app/supply/items/x/movements")).toBe("/app/supply/items");
    expect(pilotHiddenRedirect("/operations/inventory/counts")).toBeNull();
    expect(pilotHiddenRedirect("/operations/inventory")).toBe("/operations/inventory/counts");
    expect(pilotHiddenRedirect("/app/organization/stores/x/setup")).toBeNull();
    expect(pilotHiddenRedirect("/app/organization/stores/x")).toBe("/app");
  });

  it("serves the tax configuration workbench only where the session lists it", () => {
    expect(pilotHiddenRedirect("/app/commerce/tax", ["HOME-OVERVIEW", "TAX-STORE-REVIEW"])).toBe(
      "/app/commerce/tax-review",
    );
    expect(pilotHiddenRedirect("/app/commerce/tax", ["HOME-OVERVIEW", "TAX-CONFIG"])).toBeNull();
    // Without a session the page shows its own sign-in state.
    expect(pilotHiddenRedirect("/app/commerce/tax", null)).toBeNull();
    expect(pilotHiddenRedirect("/app/organization/stores/x/capabilities", null)).toBe("/app");
  });

  it("sends each hidden screen to a working screen", () => {
    for (const entry of merchantRoutes.filter((candidate) => candidate.hiddenTo)) {
      expect(pilotHiddenRedirect(entry.sample), entry.path).toBe(entry.hiddenTo);
      expect(pilotHiddenRedirect(entry.hiddenTo ?? ""), entry.path).toBeNull();
      expect(
        merchantRoutes.some((target) => !target.hiddenTo && target.path === entry.hiddenTo),
        entry.path,
      ).toBe(true);
    }
  });
});
