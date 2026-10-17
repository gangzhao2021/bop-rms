import { listStoreRoleAssignments, type RoleAssignmentTransaction } from "@bop/permission";

/**
 * v15 run: how staff screens name a person. Staff read the name their administrator keeps in the
 * Store member directory, and "You" for themselves. Every staff member is someone in a real store:
 * when no name has been recorded yet (an Owner created by Brand provisioning, before anyone named
 * them), they are named by their role ("Store owner", "Store manager", a role's maintained name),
 * never "Unnamed staff member", an identifier fragment or a role code.
 */
export interface StaffRole {
  readonly roleCode: string;
  readonly roleName: string;
  readonly scope: "Store" | "Brand";
}
const fixedRoleLabels: readonly (readonly [string, string])[] = [
  ["store_owner", "Store owner"],
  ["brand_owner", "Brand owner"],
  ["store_manager", "Store manager"],
];
/** The role a person is known by when they have no recorded name. */
export function staffRoleLabel(roles: readonly StaffRole[]): string {
  for (const [code, label] of fixedRoleLabels)
    if (roles.some((role) => role.roleCode === code)) return label;
  // A role's maintained name ("Kitchen"); a role without one shows only its code, never shown.
  const named = (scope: StaffRole["scope"]) =>
    roles.find((role) => role.scope === scope && role.roleName.trim() !== role.roleCode)?.roleName;
  return named("Store") ?? named("Brand") ?? "Staff member";
}

/**
 * The label function for one read: `names` is the directory name by actor (it may gain entries
 * after this is created); a person without a name is labelled by their current Store and Brand roles.
 */
export async function createStaffLabels(
  tx: RoleAssignmentTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly viewer: string;
    readonly at: string;
    readonly names: ReadonlyMap<string, string | null>;
  },
): Promise<(actor: string) => string> {
  // Brand roles first, then the Store's: the Store scope stays selected for the rest of the read.
  const brand = await listStoreRoleAssignments(
    tx,
    { brandReference: scope.brandReference, storeReference: null },
    input.at,
  );
  const store = await listStoreRoleAssignments(tx, scope, input.at);
  const roles = new Map<string, StaffRole[]>();
  for (const [items, roleScope] of [
    [store.assignments, "Store"],
    [brand.assignments, "Brand"],
  ] as const)
    for (const item of items)
      roles.set(item.actorReference, [
        ...(roles.get(item.actorReference) ?? []),
        { roleCode: item.roleCode, roleName: item.roleName, scope: roleScope },
      ]);
  return (actor) =>
    actor === input.viewer
      ? "You"
      : (input.names.get(actor) ?? staffRoleLabel(roles.get(actor) ?? []));
}
