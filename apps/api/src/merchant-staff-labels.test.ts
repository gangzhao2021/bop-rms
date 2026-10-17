import { describe, expect, it } from "vitest";
import { staffRoleLabel } from "./merchant-staff-labels.js";

const store = (roleCode: string, roleName: string) => ({
  roleCode,
  roleName,
  scope: "Store" as const,
});
const brand = (roleCode: string, roleName: string) => ({
  roleCode,
  roleName,
  scope: "Brand" as const,
});
describe("v15 run: a staff member without a recorded name is named by role", () => {
  it.each([
    [[store("kitchen", "Kitchen"), store("store_owner", "Owner")], "Store owner"],
    [[brand("menu_manager", "Menu Manager"), brand("brand_owner", "Brand Owner")], "Brand owner"],
    [[store("store_manager", "Store Manager"), brand("brand_owner", "Brand Owner")], "Brand owner"],
    [[store("store_manager", "Store Manager")], "Store manager"],
    [[brand("recipe_reviewer", "Recipe Reviewer"), store("kitchen", "Kitchen")], "Kitchen"],
    [[brand("recipe_reviewer", "Recipe Reviewer")], "Recipe Reviewer"],
    // A role whose name was never maintained shows only its code: it is never shown to staff.
    [
      [store("internal_pilot_exception_operator", "internal_pilot_exception_operator")],
      "Staff member",
    ],
    [[], "Staff member"],
  ])("%j is %s", (roles, label) => {
    expect(staffRoleLabel(roles)).toBe(label);
  });
});
