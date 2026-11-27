import { describe, expect, it } from "vitest";
import {
  lockedRoleCodes,
  rolePresetActions,
  sameShownRoleName,
  starterRole,
  starterRoleKeys,
  starterRoleSet,
  starterStoreTypes,
  storePermissionCatalog,
  storeRoleTemplateActions,
  storeRoleTemplateProfiles,
} from "../index.js";

/**
 * WP-2423 store-type starter roles (Owner 2026-11-06 "预设一些角色与权限，另外允许店家自定义；店家也
 * 可以对预设进行增删改"): each kind of shop starts from roles named for how it staffs, built only
 * from the permission catalog.
 */
const catalog = new Map(storePermissionCatalog().map((entry) => [entry.code, entry]));
const presetCodes = new Set(Object.values(storeRoleTemplateProfiles).map((p) => p.roleCode));
const names = (type: (typeof starterStoreTypes)[number]) =>
  starterRoleSet(type).add.map((key) => starterRole(key).displayName);

describe("starter role sets per kind of shop", () => {
  it("names the roles each kind of shop really staffs", () => {
    expect(starterStoreTypes).toEqual([
      "TeaShop",
      "DessertShop",
      "Hotpot",
      "FullService",
      "CounterOnly",
    ]);
    expect(names("TeaShop")).toEqual(["Counter", "Drink maker"]);
    expect(names("DessertShop")).toEqual(["Counter", "Dessert maker"]);
    expect(names("Hotpot")).toEqual(["Floor", "Runner", "Cashier"]);
    expect(names("FullService")).toEqual(["Runner", "Cashier"]);
    expect(names("CounterOnly")).toEqual(["Counter"]);
    // The presets each kind of shop keeps working with (hotpot and full service keep Kitchen).
    expect(starterRoleSet("Hotpot").keep).toEqual([
      "store_manager",
      "kitchen",
      "inventory_manager",
    ]);
    expect(starterRoleSet("FullService").keep).toEqual([
      "store_manager",
      "front_of_house",
      "kitchen",
      "inventory_manager",
    ]);
    expect(starterRoleSet("CounterOnly").keep).toEqual(["store_manager", "kitchen"]);
    expect(starterRoleSet("TeaShop").putAway).toEqual([
      "front_of_house",
      "kitchen",
      "inventory_manager",
    ]);
  });

  it("builds every role only from current catalog permissions, never a preset's code", () => {
    for (const key of starterRoleKeys) {
      const role = starterRole(key);
      expect(role.roleCode).toMatch(/^starter_[a-z0-9_]+[a-z0-9]$/u);
      expect(presetCodes.has(role.roleCode)).toBe(false);
      expect(rolePresetActions(role.roleCode, "Store")).toBeNull();
      expect(role.actions).toContain("merchant.access");
      // Stored as a role's name and description (1 to 180 characters).
      expect(role.displayName.length).toBeLessThanOrEqual(80);
      expect(role.description.length).toBeLessThanOrEqual(180);
      expect(new Set(role.actions).size).toBe(role.actions.length);
      for (const action of role.actions) expect(catalog.has(action), action).toBe(true);
    }
    for (const type of starterStoreTypes) {
      const set = starterRoleSet(type);
      for (const code of [...set.keep, ...set.putAway]) {
        expect(presetCodes.has(code), code).toBe(true);
        expect(lockedRoleCodes.has(code)).toBe(false);
      }
      // Area Manager belongs to a Brand's several Stores, never to a kind of shop.
      expect([...set.keep, ...set.putAway]).not.toContain("area_manager");
      expect(set.keep.filter((code) => set.putAway.includes(code))).toEqual([]);
      expect(set.keep).toContain("store_manager");
    }
  });

  it("gives no starter role a money or approval power a manager keeps", () => {
    const managerOnly = [
      "payment.refund.approve",
      "payment.refund.execute",
      "payment.refund.recover",
      "ordering.order.cancel",
      "ordering.order.comp",
      "ordering.order.write_off",
      "identity.role.approve",
      "organization.staff.manage",
      "payment.settlement.read",
    ];
    for (const key of starterRoleKeys)
      expect(starterRole(key).actions.filter((code) => managerOnly.includes(code))).toEqual([]);
  });

  it("splits the work as the floor runs: makers make, runners serve, the cashier settles", () => {
    const can = (key: (typeof starterRoleKeys)[number], code: string) =>
      starterRole(key).actions.includes(code);
    // Counter staff do what Front of House does at a counter: orders, payment, pickups, tables.
    expect([...starterRole("counter").actions].sort()).toEqual(
      storeRoleTemplateActions("front-of-house")
        .filter((code) => catalog.has(code))
        .sort(),
    );
    for (const maker of ["drink_maker", "dessert_maker"] as const) {
      expect(can(maker, "kitchen.work_item.complete")).toBe(true);
      expect(can(maker, "kitchen.work_item.rework")).toBe(true);
      expect(can(maker, "catalog.sku.sold_out.mark")).toBe(true);
      expect(can(maker, "fulfillment.pickup.complete")).toBe(true);
      expect(can(maker, "ordering.order.create_staff")).toBe(false);
      expect(can(maker, "dining.session.close")).toBe(false);
    }
    // Hotpot floor staff seat, take orders and serve; the cashier starts checkout and closes.
    expect(can("floor", "ordering.order.create_staff")).toBe(true);
    expect(can("floor", "dining.item.serve")).toBe(true);
    expect(can("floor", "dining.session.close")).toBe(false);
    expect(can("floor", "payment.refund.request")).toBe(false);
    expect(can("runner", "dining.item.serve")).toBe(true);
    expect(can("runner", "ordering.order.create_staff")).toBe(false);
    expect(can("runner", "kitchen.work_item.complete")).toBe(false);
    expect(can("cashier", "dining.session.close")).toBe(true);
    expect(can("cashier", "ordering.order.close")).toBe(true);
    expect(can("cashier", "payment.refund.request")).toBe(true);
    expect(can("cashier", "fulfillment.pickup.complete")).toBe(true);
    expect(can("cashier", "kitchen.work_item.read")).toBe(false);
  });

  it("treats a starter role's name and its Chinese name as one name", () => {
    expect(sameShownRoleName("收银", "Cashier")).toBe(true);
    expect(sameShownRoleName(" cashier ", "收银")).toBe(true);
    expect(sameShownRoleName("楼面", "Floor")).toBe(true);
    expect(sameShownRoleName("柜台", "counter")).toBe(true);
    expect(sameShownRoleName("收银", "Floor")).toBe(false);
    expect(sameShownRoleName("Bar", "bar")).toBe(true);
    expect(sameShownRoleName("Bar", "Cashier")).toBe(false);
    for (const key of starterRoleKeys)
      expect(starterRole(key).shownNames["zh-Hans"]).toMatch(/^\p{Script=Han}+$/u);
  });
});
