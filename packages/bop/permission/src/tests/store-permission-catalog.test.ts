import { describe, expect, it } from "vitest";
import {
  legacyPermissionReplacements,
  storePermissionCatalog,
  storePermissionCodes,
  storeRoleTemplates,
} from "../catalog/store-permission-catalog.js";

// Mirrors the action code check that migration 0300_017 installs (underscore segments allowed).
const databaseFormat =
  /^[a-z][a-z0-9]*(_[a-z0-9]+)*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*(-[a-z0-9]+)*){1,7}$/u;

describe("DEC-PERM-CATALOG Store permission catalog", () => {
  const catalog = storePermissionCatalog();
  it("lists each code once, in the database format, with every Section 88 code", () => {
    expect(storePermissionCodes.size).toBe(catalog.length);
    for (const entry of catalog) expect(entry.code).toMatch(databaseFormat);
    expect(catalog.filter((entry) => entry.specified)).toHaveLength(77);
    for (const code of [
      "kitchen.work_item.read",
      "ordering.order.create_staff",
      "catalog.option_set.read",
    ])
      expect(storePermissionCodes.has(code)).toBe(true);
  });
  it("maps every legacy consolidated code onto catalog codes only", () => {
    for (const [legacy, replacements] of Object.entries(legacyPermissionReplacements)) {
      expect(storePermissionCodes.has(legacy), legacy).toBe(false);
      expect(replacements.length).toBeGreaterThan(0);
      for (const code of replacements) expect(storePermissionCodes.has(code), code).toBe(true);
    }
  });
  it("builds role templates from catalog codes; only the Owner holds every code", () => {
    expect(new Set(storeRoleTemplates.owner)).toEqual(storePermissionCodes);
    for (const [role, codes] of Object.entries(storeRoleTemplates)) {
      expect(new Set(codes).size, role).toBe(codes.length);
      for (const code of codes)
        expect(storePermissionCodes.has(code), role + ":" + code).toBe(true);
      expect(codes).toContain("merchant.access");
    }
    const kitchen = new Set(storeRoleTemplates.kitchen);
    expect(
      [...kitchen].some((code) => /^payment\.|^organization\.|adjustment|approve/u.test(code)),
    ).toBe(false);
    expect(storeRoleTemplates["store-manager"]).not.toContain("payment.refund.approve");
    expect(storeRoleTemplates["store-manager"]).not.toContain("identity.role.change");
    expect(storeRoleTemplates["inventory-manager"]).not.toContain("inventory.opening_balance.post");
  });
});
