import { parseOpaqueUuidV7 } from "@bop/identity";

/**
 * WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): a Brand Owner who runs the Brand alone may approve
 * their own changes at brand-internal "another person approves" gates. The Brand setting is only
 * the Owner's declaration; the waiver is in effect at an approval only while the actor is the one
 * and only active person holding that gate's approval permission. Platform approvals are never
 * covered. A gate that is not in effect keeps its existing two-person rule unchanged.
 */
export type SoleOperatorSettingState = "On" | "Off";
export type SoleOperatorApprovalStatus = "Effective" | "NotSet" | "OtherApprovers";

/** Reasons the Owner gives (recorded on the setting and its Audit). */
export const soleOperatorSettingReasons = Object.freeze({
  On: Object.freeze(["OWNER_RUNS_STORE_ALONE"] as const),
  Off: Object.freeze(["SECOND_APPROVER_AVAILABLE", "OWNER_CHOICE", "ENTERED_IN_ERROR"] as const),
});
export type SoleOperatorSettingReason =
  (typeof soleOperatorSettingReasons.On)[number] | (typeof soleOperatorSettingReasons.Off)[number];

/** The brand-internal approval permissions a sole operator may satisfy alone. Each gate is added
 * here when its own owner implements the sole-operator path; any other code is refused. */
export const soleOperatorApprovalPermissionCodes: ReadonlySet<string> = new Set([
  // Store gate: escalated ordinary refund approval.
  "payment.refund.approve",
  // Store gate (Owner decision 2026-10-16): Store configuration approval for publication
  // (Store setup step 8), held by the Store's Owners.
  "store.service.approve",
  // Brand gates (WP-2423 Q19 step 2), exactly as each gate checks them: the price book gate
  // still checks the legacy hyphenated code; menu review approval; recipe review; allergen roster.
  "pricing.price-book.approve",
  "catalog.menu.approve",
  "recipe.approve",
  "catalog.allergen_registry.manage",
]);

export class SoleOperatorApprovalError extends Error {
  constructor(
    readonly code:
      | "SOLE_OPERATOR_INPUT_INVALID"
      | "SOLE_OPERATOR_DENIED"
      | "SOLE_OPERATOR_VERSION_CONFLICT"
      | "SOLE_OPERATOR_NO_CHANGE"
      | "SOLE_OPERATOR_NEEDS_REVERIFICATION"
      | "SOLE_OPERATOR_CONFLICT"
      | "SOLE_OPERATOR_UNAVAILABLE",
  ) {
    super(code);
    this.name = "SoleOperatorApprovalError";
  }
}
const invalid = (): never => {
  throw new SoleOperatorApprovalError("SOLE_OPERATOR_INPUT_INVALID");
};
export function parseSoleOperatorReference(value: unknown): string {
  try {
    return String(parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID"));
  } catch {
    return invalid();
  }
}
export function parseSoleOperatorPermissionCode(value: unknown): string {
  if (typeof value !== "string" || !soleOperatorApprovalPermissionCodes.has(value))
    return invalid();
  return value;
}
export function parseSoleOperatorSettingReason(
  state: SoleOperatorSettingState,
  value: unknown,
): SoleOperatorSettingReason {
  const allowed: readonly string[] = soleOperatorSettingReasons[state];
  if (typeof value !== "string" || !allowed.includes(value)) return invalid();
  return value as SoleOperatorSettingReason;
}

/**
 * The decision itself (no I/O): in effect only when the Brand's latest setting is On and the
 * current active holders of the gate's approval permission are exactly this actor. The holder
 * list must come from the Membership and Permission owners in the approving transaction.
 */
export function evaluateSoleOperatorApproval(input: {
  readonly setting: SoleOperatorSettingState | null;
  readonly holderReferences: readonly string[];
  readonly actorReference: string;
}): Readonly<{
  status: SoleOperatorApprovalStatus;
  otherHolderReferences: readonly string[];
}> {
  const actor = parseSoleOperatorReference(input.actorReference);
  if (!Array.isArray(input.holderReferences) || input.holderReferences.length > 1000)
    return invalid();
  const holders = [...new Set(input.holderReferences.map(parseSoleOperatorReference))].sort();
  const others = Object.freeze(holders.filter((holder) => holder !== actor));
  if (input.setting !== "On" && input.setting !== "Off" && input.setting !== null) return invalid();
  if (input.setting !== "On")
    return Object.freeze({ status: "NotSet" as const, otherHolderReferences: others });
  return Object.freeze({
    status:
      holders.length === 1 && holders[0] === actor
        ? ("Effective" as const)
        : ("OtherApprovers" as const),
    otherHolderReferences: others,
  });
}
