import { describe, expect, it } from "vitest";
import {
  brandRoleTemplates,
  legacyPermissionReplacements,
  storePermissionCatalog,
  storePermissionCodes,
  brandRoleTemplateActions,
  storeRoleTemplateActions,
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
  it("lets the Store Manager draft and submit hours while only the Owner approves and publishes", () => {
    const manager = storeRoleTemplateActions("store-manager");
    for (const action of [
      "store.service.read",
      "store.service.save-draft",
      "store.service.validate",
      "store.service.submit",
    ])
      expect(manager, action).toContain(action);
    expect(manager).not.toContain("store.service.approve");
    expect(manager).not.toContain("store.service.publish");
    const owner = storeRoleTemplateActions("owner");
    for (const action of ["store.service.approve", "store.service.publish"])
      expect(owner, action).toContain(action);
  });
  it("lets Kitchen and Front of House mark items sold out today without managing availability", () => {
    for (const role of ["kitchen", "front-of-house"] as const) {
      const actions = storeRoleTemplateActions(role);
      expect(actions, role).toContain("catalog.sku.sold_out.mark");
      for (const broader of [
        "catalog.sku.availability.manage",
        "catalog.product.availability.manage",
        "catalog.sku.read",
        "catalog.menu.update",
        "pricing.price_book.update",
        "organization.store.update",
      ])
        expect(actions, role + ":" + broader).not.toContain(broader);
    }
    for (const role of ["store-manager", "owner"] as const)
      for (const code of ["catalog.sku.sold_out.mark", "catalog.sku.availability.manage"])
        expect(storeRoleTemplateActions(role), role + ":" + code).toContain(code);
    for (const [role, codes] of Object.entries(brandRoleTemplates))
      expect(codes, role).not.toContain("catalog.sku.sold_out.mark");
  });
  it("lets Kitchen, Store Manager and Owner remake a dish, and nobody on the floor or at Brand level else", () => {
    for (const role of ["kitchen", "store-manager", "owner"] as const)
      expect(storeRoleTemplateActions(role), role).toContain("kitchen.work_item.rework");
    for (const role of ["front-of-house", "inventory-manager"] as const)
      expect(storeRoleTemplateActions(role), role).not.toContain("kitchen.work_item.rework");
    for (const [role, codes] of Object.entries(brandRoleTemplates))
      expect(codes, role).not.toContain("kitchen.work_item.rework");
    expect(
      storePermissionCatalog().find((entry) => entry.code === "kitchen.work_item.rework"),
    ).toMatchObject({
      module: "kitchen",
      risk: "Medium",
    });
  });
  it("lets only Store Manager and Owner close an earlier business day's kitchen ticket (v13)", () => {
    for (const role of ["store-manager", "owner"] as const)
      expect(storeRoleTemplateActions(role), role).toContain("kitchen.ticket.close_stale");
    for (const role of ["kitchen", "front-of-house", "inventory-manager"] as const)
      expect(storeRoleTemplateActions(role), role).not.toContain("kitchen.ticket.close_stale");
    for (const [role, codes] of Object.entries(brandRoleTemplates))
      expect(codes, role).not.toContain("kitchen.ticket.close_stale");
    expect(
      storePermissionCatalog().find((entry) => entry.code === "kitchen.ticket.close_stale"),
    ).toMatchObject({ module: "kitchen", risk: "Medium" });
  });
  it("lets the Brand Owner and Menu Manager read fee classification choices (v14)", () => {
    for (const role of ["brand-owner", "menu-manager"] as const)
      expect(brandRoleTemplateActions(role), role).toContain("catalog.tax-classification.read");
    for (const role of ["recipe-developer", "recipe-reviewer"] as const)
      expect(brandRoleTemplateActions(role), role).not.toContain("catalog.tax-classification.read");
    for (const role of ["brand-owner", "menu-manager"] as const)
      expect(brandRoleTemplateActions(role), role).not.toContain(
        "catalog.tax-classification.manage",
      );
  });
});
