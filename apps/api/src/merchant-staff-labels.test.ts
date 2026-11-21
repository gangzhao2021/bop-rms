import { describe, expect, it } from "vitest";
import type { RoleAssignmentTransaction } from "@bop/permission";
import { createStaffLabels, distinctStaffLabels, staffRoleLabel } from "./merchant-staff-labels.js";

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

describe("staff lists name everyone once", () => {
  it("tells people with the same label apart in directory order", () => {
    expect([
      ...distinctStaffLabels([
        { actorReference: "a", label: "Staff member" },
        { actorReference: "b", label: "Mia" },
        { actorReference: "c", label: "Staff member" },
        { actorReference: "d", label: "Staff member" },
      ]),
    ]).toEqual([
      ["a", "Staff member"],
      ["b", "Mia"],
      ["c", "Staff member (2)"],
      ["d", "Staff member (3)"],
    ]);
  });

  const id = (n: number) => "01909a0c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  // Store rows: the owner holds store_owner; a Brand row for a Recipe Reviewer.
  const tx = {
    async query(sql: string, values: readonly unknown[]) {
      if (!sql.includes("role_assignment a")) return { rows: [] };
      const atStore = values[1] !== null;
      return {
        rows: atStore
          ? [
              {
                assignment: id(20),
                role: id(30),
                role_code: "store_owner",
                role_name: "Owner",
                actor: id(1),
                effective_from: "2026-10-01T00:00:00.000Z",
              },
            ]
          : [
              {
                assignment: id(21),
                role: id(31),
                role_code: "recipe_reviewer",
                role_name: "Recipe Reviewer",
                actor: id(2),
                effective_from: "2026-10-01T00:00:00.000Z",
              },
            ],
      };
    },
  } as unknown as RoleAssignmentTransaction;
  const scope = { brandReference: id(100), storeReference: id(101) };

  it("names an unnamed owner by role, and nobody 'You' on a screen nobody signed in to", async () => {
    const label = await createStaffLabels(tx, scope, {
      viewer: null,
      at: "2026-10-16T00:00:00.000Z",
      names: new Map([[id(3), "Ava"]]),
    });
    expect([id(1), id(2), id(3), id(4)].map(label)).toEqual([
      "Store owner",
      "Recipe Reviewer",
      "Ava",
      "Staff member",
    ]);
  });

  it("names the signed-in person 'You'", async () => {
    const label = await createStaffLabels(tx, scope, {
      viewer: id(1),
      at: "2026-10-16T00:00:00.000Z",
      names: new Map(),
    });
    expect(label(id(1))).toBe("You");
  });
});
