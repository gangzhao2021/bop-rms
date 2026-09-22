import { exactPaymentObject } from "./payment-intent-creation.js";
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_ROLE_MAPPING_INVALID");
};
const roles = ["Manager", "Owner", "Finance"] as const;
type RefundRole = (typeof roles)[number];
function codes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 1024) return fail();
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(i));
    if (
      !entry ||
      !("value" in entry) ||
      !entry.enumerable ||
      typeof entry.value !== "string" ||
      entry.value.length < 1 ||
      entry.value.length > 128
    )
      return fail();
    if (result.includes(entry.value)) return fail();
    result.push(entry.value);
  }
  return Object.freeze(result);
}
/** Mapping is trusted scoped configuration, never supplied by a request body.
 * This selects business eligibility only; current action permission, identity,
 * independent actors and MFA are still required by approval evaluation.
 */
export function createOrdinaryRefundRoleResolver(value: unknown) {
  const raw = exactPaymentObject(value, roles);
  const bindings = new Map<string, RefundRole>();
  for (const role of roles) {
    for (const code of codes(raw[role])) {
      if (bindings.has(code)) return fail();
      bindings.set(code, role);
    }
  }
  return (permissionCode: unknown, activeRoleCodes: unknown): RefundRole | null => {
    const current = new Set(codes(activeRoleCodes).map((code) => bindings.get(code)));
    if (permissionCode === "payment.refund.request")
      return current.has("Manager") ? "Manager" : null;
    if (permissionCode === "payment.refund.approve") {
      if (current.has("Owner")) return "Owner";
      if (current.has("Finance")) return "Finance";
      return null;
    }
    return fail();
  };
}
