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
  });

  it("WP-2423 item 8 ⑦: serves a module's screens only while the Store uses it", () => {
    const listed = ["HOME-OVERVIEW", "STORE-CAPABILITY", "OPS-ORDER-ENTRY", "INV-ITEM-LIST"];
    expect(pilotHiddenRedirect("/app/organization/stores/x/capabilities", listed)).toBeNull();
    expect(pilotHiddenRedirect("/app/organization/stores/x/capabilities", ["HOME-OVERVIEW"])).toBe(
      "/app",
    );
    expect(pilotHiddenRedirect("/operations/order-entry", listed)).toBeNull();
    // Counter ordering turned off: the address goes to Tables.
    expect(pilotHiddenRedirect("/operations/order-entry", ["HOME-OVERVIEW"])).toBe(
      "/operations/dining",
    );
    expect(pilotHiddenRedirect("/app/supply/items/x", listed)).toBeNull();
    expect(pilotHiddenRedirect("/operations/receiving", listed)).toBe("/app");
    expect(pilotHiddenRedirect("/app/commerce/recipes", ["HOME-OVERVIEW"])).toBe("/app");
  });

  it("serves the Brand and Platform consoles only where the session lists them", () => {
    // v15 9b2b3f21 B4: the pilot Store session lists neither; its Owner went to pages that never
    // loaded ("Brand access could not be confirmed").
    const pilot = ["HOME-OVERVIEW", "STORE-SETUP", "OPS-ORDER-QUEUE", "IAM-USER-LIST"];
    for (const path of [
      "/app/organization/brands",
      "/app/organization/brands/x",
      "/platform/tenants",
    ])
      expect(pilotHiddenRedirect(path, pilot), path).toBe("/app");
    expect(
      pilotHiddenRedirect("/app/organization/brands", [...pilot, "ORG-BRAND-LIST"]),
    ).toBeNull();
    expect(
      pilotHiddenRedirect("/app/organization/brands/x", [...pilot, "ORG-BRAND-DETAIL"]),
    ).toBeNull();
    expect(pilotHiddenRedirect("/platform/tenants", ["PLT-TENANT-LIST"])).toBeNull();
    // The Brand and Platform sign-ins run without a Store session; their pages show their own state.
    expect(pilotHiddenRedirect("/app/organization/brands", null)).toBeNull();
    expect(pilotHiddenRedirect("/platform/tenants", null)).toBeNull();
    for (const path of ["/platform/tenants/x", "/platform/live-gates", "/platform/support-cases"])
      expect(pilotHiddenRedirect(path, pilot), path).toBe("/app");
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
