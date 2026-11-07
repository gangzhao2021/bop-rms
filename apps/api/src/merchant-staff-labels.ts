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
  // v20 DEC-BRAND-MULTI-STORE.
  ["area_manager", "Area manager"],
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
 * One label per person for a list staff choose from: everyone eligible appears, named by the
 * directory name or, without one, by their role ("Store owner", last resort "Staff member").
 * Two people with the same label are told apart as "Staff member", "Staff member (2)" (in the
 * directory's stable order), so a lock-screen choice is never ambiguous.
 */
export function distinctStaffLabels(
  people: readonly { readonly actorReference: string; readonly label: string }[],
): ReadonlyMap<string, string> {
  const seen = new Map<string, number>();
  const result = new Map<string, string>();
  for (const person of people) {
    const count = (seen.get(person.label) ?? 0) + 1;
    seen.set(person.label, count);
    result.set(person.actorReference, count === 1 ? person.label : `${person.label} (${count})`);
  }
  return result;
}

/**
 * The label function for one read: `names` is the directory name by actor (it may gain entries
 * after this is created); a person without a name is labelled by their current Store and Brand roles.
 * `viewer` is the signed-in person ("You"); null on a screen nobody is signed in to (the shared
 * tablet's lock screen), where everyone is named.
 */
export async function createStaffLabels(
  tx: RoleAssignmentTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly viewer: string | null;
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
