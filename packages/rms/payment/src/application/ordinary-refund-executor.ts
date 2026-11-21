import { exactPaymentObject, parsePaymentInstant } from "./payment-intent-creation.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";

const keys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "actorReference",
] as const;
const denied = (): never => {
  throw new Error("ORDINARY_REFUND_EXECUTOR_DENIED");
};
/** First-dispatch executor capability only. This never replaces requester or
 * independent approver checks, refund escalation, balance or operation fencing.
 * Authority is a current owner observation, not a browser claim.
 */
export function assertOrdinaryRefundExecutor(value: unknown) {
  const raw = exactPaymentObject(value, ["expected", "authority", "observedAt"]);
  const expected = exactPaymentObject(raw.expected, keys);
  const authority = exactPaymentObject(raw.authority, [
    ...keys,
    "permissionCode",
    "active",
    "allowed",
    "observedAt",
  ]);
  const observedAt = parsePaymentInstant(raw.observedAt);
  for (const key of keys) {
    if (parsePaymentReference(expected[key]) !== parsePaymentReference(authority[key]))
      return denied();
  }
  if (
    authority.permissionCode !== "payment.refund.execute" ||
    authority.active !== true ||
    authority.allowed !== true ||
    parsePaymentInstant(authority.observedAt) !== observedAt
  )
    return denied();
}
