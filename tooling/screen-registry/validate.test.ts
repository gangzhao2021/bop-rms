import { describe, expect, it } from "vitest";
import {
  readRegistry,
  readSchema,
  validateRegistry,
  type ScreenRecord,
  type ScreenRegistry,
} from "./validate.js";
const registry = readRegistry();
const schema = readSchema();
function changed(mutate: (copy: ScreenRegistry) => void) {
  const copy = structuredClone(registry);
  mutate(copy);
  return validateRegistry(copy, schema).errors.join("\n");
}
function first(copy: ScreenRegistry) {
  const value = copy.screens[0];
  if (!value) throw new Error("registry unexpectedly empty");
  return value;
}
function find(copy: ScreenRegistry, predicate: (screen: ScreenRecord) => boolean) {
  const value = copy.screens.find(predicate);
  if (!value) throw new Error("expected screen fixture");
  return value;
}
describe("Screen Registry validation", () => {
  it("accepts the exact 210-record mirror", () => {
    const result = validateRegistry(registry, schema);
    expect(result.errors).toEqual([]);
    expect(registry.screens).toHaveLength(210);
  });
  it("rejects duplicate IDs and standalone routes", () => {
    expect(
      changed((copy) => {
        const a = copy.screens[0],
          b = copy.screens[1];
        if (!a || !b) throw new Error("expected fixtures");
        b.screen_id = a.screen_id;
      }),
    ).toContain("duplicate screen_id");
    expect(
      changed((copy) => {
        const pages = copy.screens.filter((screen) => screen.route_mode === "standalone");
        const a = pages[0],
          b = pages[1];
        if (!a?.canonical_route || !b) throw new Error("expected standalone fixtures");
        b.canonical_route = a.canonical_route;
      }),
    ).toContain("duplicate standalone route");
  });
  it("rejects alias cycles and invalid parents/families", () => {
    expect(
      changed((copy) => {
        const alias = find(copy, (screen) => screen.route_mode === "alias");
        alias.alias_of = alias.screen_id;
      }),
    ).toContain("alias cycle");
    expect(
      changed((copy) => {
        const contextual = find(copy, (screen) => screen.route_mode === "contextual");
        contextual.parent_screen_ids = ["UNKNOWN-SCREEN"];
        delete contextual.allowed_family;
      }),
    ).toContain("invalid parent");
    expect(
      changed((copy) => {
        first(copy).family = "unknown_family";
      }),
    ).toContain("invalid family");
  });
  it("rejects unknown permission, projection, and WP references", () => {
    expect(
      changed((copy) => {
        first(copy).permission_ref = "unknown.permission";
      }),
    ).toContain("unknown permission");
    expect(
      changed((copy) => {
        first(copy).projection_ref = "unknown_projection";
      }),
    ).toContain("unknown projection");
    expect(
      changed((copy) => {
        find(copy, (screen) => screen.work_package_mode === "resolved").work_packages = ["WP-9999"];
      }),
    ).toContain("unknown work package");
  });
  it("rejects missing phase/gate, surface collision, action, and navigation mapping", () => {
    expect(
      changed((copy) => {
        first(copy).feature_gate = "";
      }),
    ).toContain("missing phase/feature gate");
    expect(
      changed((copy) => {
        find(
          copy,
          (screen) => screen.surface === "merchant_web" && screen.route_mode === "standalone",
        ).canonical_route = "/platform/collision";
      }),
    ).toContain("surface collision");
    expect(
      changed((copy) => {
        find(copy, (screen) => screen.route_mode !== "alias").command_refs = [];
      }),
    ).toContain("action mapping missing command");
    expect(
      changed((copy) => {
        first(copy).navigation_targets = ["UNKNOWN-SCREEN"];
      }),
    ).toContain("broken navigation target");
  });
  it.each([
    "phase",
    "feature_gate",
    "action_summary",
    "search_filter_sort_export",
    "work_package_mode",
    "permission_ref",
    "projection_ref",
  ] as const)("rejects standalone inherited %s even with a claimed parent", (field) => {
    expect(
      changed((copy) => {
        const screen = find(copy, (item) => item.screen_id === "CUST-PROFILE");
        screen[field] = "inherited";
        screen.parent_screen_ids = ["CUST-LOYALTY"];
      }),
    ).toContain("unsupported standalone inheritance");
  });
  it("accepts explicit parent and family inheritance for shared utilities", () => {
    expect(
      changed((copy) => {
        const screen = find(copy, (item) => item.screen_id === "HISTORY-TIMELINE");
        screen.parent_screen_ids = ["CAT-PRODUCT-DETAIL"];
        delete screen.allowed_family;
      }),
    ).toBe("");
    expect(
      changed((copy) => {
        const screen = find(copy, (item) => item.screen_id === "HISTORY-TIMELINE");
        screen.allowed_family = "master_detail";
        delete screen.parent_screen_ids;
      }),
    ).toBe("");
  });
  it("rejects inherited utilities without a source or with an unknown source", () => {
    expect(
      changed((copy) => {
        const screen = find(copy, (item) => item.screen_id === "HISTORY-TIMELINE");
        delete screen.allowed_family;
        delete screen.parent_screen_ids;
      }),
    ).toContain("unresolved inheritance source");
    expect(
      changed((copy) => {
        const screen = find(copy, (item) => item.screen_id === "HISTORY-TIMELINE");
        delete screen.allowed_family;
        delete screen.parent_screen_ids;
        screen.alias_of = "CAT-PRODUCT-DETAIL";
      }),
    ).toContain("unresolved inheritance source");
    expect(
      changed((copy) => {
        const screen = find(copy, (item) => item.screen_id === "HISTORY-TIMELINE");
        screen.parent_screen_ids = ["UNKNOWN-SCREEN"];
      }),
    ).toContain("invalid parent");
  });
  it("rejects direct and indirect parent cycles, including aliases", () => {
    expect(
      changed((copy) => {
        const screen = find(copy, (item) => item.screen_id === "HISTORY-TIMELINE");
        screen.parent_screen_ids = [screen.screen_id];
      }),
    ).toContain("inheritance cycle");
    expect(
      changed((copy) => {
        const history = find(copy, (item) => item.screen_id === "HISTORY-TIMELINE");
        const compare = find(copy, (item) => item.screen_id === "VERSION-COMPARE");
        history.parent_screen_ids = [compare.screen_id];
        compare.parent_screen_ids = [history.screen_id];
      }),
    ).toContain("inheritance cycle");
    expect(
      changed((copy) => {
        const alias = find(copy, (item) => item.route_mode === "alias");
        const target = find(copy, (item) => item.screen_id === alias.alias_of);
        target.parent_screen_ids = [alias.screen_id];
      }),
    ).toContain("inheritance cycle");
  });
  it.each([
    ["CUST-ACCOUNT-AUTH", ["WP-2140"]],
    ["CUST-PROFILE", ["WP-2140", "WP-2144", "WP-2146"]],
    ["CUST-RESERVATION-SEARCH", ["WP-2113"]],
    ["CUST-RESERVATION-DETAIL", ["WP-2113"]],
    ["CUST-WAITLIST", ["WP-2114"]],
  ] as const)("retains the accepted future contract for %s", (id, packages) => {
    const screen = find(registry, (item) => item.screen_id === id);
    expect(screen.route_mode).toBe("standalone");
    expect(screen.phase).toBe("phase_3");
    expect(screen.feature_gate).toBe("phase_capability");
    expect(screen.action_summary).not.toMatch(/inherit/i);
    expect(screen.work_package_mode).toBe("resolved");
    expect(screen.work_packages).toEqual(packages);
  });
  it("keeps abbreviated receipt ownership and later accepted refinements", () => {
    const receipt = find(registry, (item) => item.screen_id === "CUST-RECEIPT-SUPPORT");
    expect(receipt.work_packages).toEqual([
      "WP-1709",
      "WP-1720",
      "WP-1721",
      "WP-1722",
      "WP-1723",
      "WP-1724",
      "WP-2028",
    ]);
    const publish = find(registry, (item) => item.screen_id === "CAT-MENU-PUBLISH");
    expect(publish.work_packages).toEqual(["WP-1024", "WP-1027", "WP-1802"]);
  });
});
