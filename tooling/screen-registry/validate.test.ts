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
});
