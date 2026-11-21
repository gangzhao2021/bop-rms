import { storeRoleTemplates } from "@bop/permission";
import { describe, expect, it } from "vitest";
import { pickupContactRemovalPermission } from "./merchant-pickup-contact-removal.js";

describe("M108: who may remove a guest's pickup contact (decision recorded in WP-2423)", () => {
  it("is whoever hands orders over: owner, managers and front of house, never the kitchen", () => {
    expect(pickupContactRemovalPermission).toBe("ordering.order.close");
    for (const preset of ["owner", "store-manager", "area-manager", "front-of-house"] as const)
      expect(storeRoleTemplates[preset]).toContain(pickupContactRemovalPermission);
    for (const preset of ["kitchen", "inventory-manager"] as const)
      expect(storeRoleTemplates[preset]).not.toContain(pickupContactRemovalPermission);
  });
});
