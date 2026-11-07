import {
  exactPaymentObject,
  parsePaymentDigest,
  parsePaymentInstant,
} from "./payment-intent-creation.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { ordinaryRefundPolicyVersion } from "./ordinary-refund-escalation.js";

const scopeKeys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
] as const;
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_APPROVAL_INPUT_INVALID");
};
function parseScope(raw: Record<string, unknown>) {
  return Object.freeze({
    tenantReference: parsePaymentReference(raw.tenantReference),
    brandReference: parsePaymentReference(raw.brandReference),
    storeReference: parsePaymentReference(raw.storeReference),
    orderReference: parsePaymentReference(raw.orderReference),
  });
}
function subject(value: unknown) {
  const raw = exactPaymentObject(value, [
    ...scopeKeys,
    "requestReference",
    "claimsDigest",
    "allocationDigest",
    "policyVersion",
  ]);
  const scope = parseScope(raw);
  if (typeof raw.policyVersion !== "string" || !/^[A-Z0-9_]{1,100}$/.test(raw.policyVersion))
    return fail();
  return Object.freeze({
    ...scope,
    requestReference: parsePaymentReference(raw.requestReference),
    claimsDigest: parsePaymentDigest(raw.claimsDigest),
    allocationDigest: parsePaymentDigest(raw.allocationDigest),
    policyVersion: raw.policyVersion,
  });
}
/** WP-2423 Q19: the Organization `soleOperatorApproval` result for the actor and
 * `payment.refund.approve`, read in the same transaction at the same instant. Absent = NotSet. */
export type OrdinaryRefundSoleOperatorStatus = "Effective" | "NotSet" | "OtherApprovers";
const authorityKeys = [
  ...scopeKeys,
  "actorReference",
  "role",
  "active",
  "permissionCode",
  "allowed",
  "recentMfaAt",
  "observedAt",
] as const;
function authority(value: unknown) {
  const withSoleOperator =
    value !== null &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "soleOperator");
  const raw = exactPaymentObject(
    value,
    withSoleOperator ? [...authorityKeys, "soleOperator"] : authorityKeys,
  );
  const soleOperator = withSoleOperator ? raw.soleOperator : "NotSet";
  if (
    soleOperator !== "Effective" &&
    soleOperator !== "NotSet" &&
    soleOperator !== "OtherApprovers"
  )
    return fail();
  const scope = parseScope(raw);
  if (
    !["Manager", "Owner", "Finance"].includes(String(raw.role)) ||
    typeof raw.active !== "boolean" ||
    typeof raw.allowed !== "boolean" ||
    !["payment.refund.request", "payment.refund.approve"].includes(String(raw.permissionCode))
  )
    return fail();
  return Object.freeze({
    ...scope,
    actorReference: parsePaymentReference(raw.actorReference),
    role: raw.role,
    active: raw.active,
    allowed: raw.allowed,
    permissionCode: raw.permissionCode,
    recentMfaAt: raw.recentMfaAt === null ? null : parsePaymentInstant(raw.recentMfaAt),
    observedAt: parsePaymentInstant(raw.observedAt),
    soleOperator: soleOperator as OrdinaryRefundSoleOperatorStatus,
  });
}
/** WP-2423 Q19: how the approval satisfied the "another person" rule. Independent approvals keep
 * their original encoding (no key); a sole-operator approval is marked explicitly. */
export type OrdinaryRefundApprovalMode = "Independent" | "SoleOperator";
export function ordinaryRefundApprovalModeOf(approval: {
  readonly approvalMode?: "SoleOperator";
}): OrdinaryRefundApprovalMode {
  return approval.approvalMode === "SoleOperator" ? "SoleOperator" : "Independent";
}
function recent(mfa: string | null, at: string) {
  if (mfa === null) return false;
  const age = Date.parse(at) - Date.parse(mfa);
  return age >= 0 && age <= 15 * 60 * 1000;
}
const unusable = () => Object.freeze({ status: "NeedsReapproval" as const });

/** Verify an existing independent approval at first-dispatch time.
 * Authority facts must be read from current owners under retained fences.
 * This does not grant executor permission, reserve balance or authorize a new
 * Provider operation for an already-dispatched Unknown refund.
 */
export function evaluateOrdinaryRefundIndependentApproval(value: unknown) {
  try {
    const raw = exactPaymentObject(value, [
      "subject",
      "approval",
      "requester",
      "approver",
      "observedAt",
    ]);
    const expected = subject(raw.subject);
    const observedAt = parsePaymentInstant(raw.observedAt);
    if (expected.policyVersion !== ordinaryRefundPolicyVersion) return fail();
    const requester = authority(raw.requester),
      approver = authority(raw.approver);
    if (raw.approval === null) return unusable();
    const approval = parseApproval(raw.approval, false);
    const {
      approvalReference,
      subject: approvedSubject,
      requesterReference,
      approverReference,
      approvedAt,
      requesterMfaAt,
      approverMfaAt,
    } = approval;
    // WP-2423 Q19: one Owner may be both people only for a SoleOperator approval and only while
    // sole operator is in effect for them now; otherwise the two people must differ and the
    // requester must be a Manager (unchanged).
    const sole = ordinaryRefundApprovalModeOf(approval) === "SoleOperator";
    const peopleValid = sole
      ? requesterReference === approverReference &&
        ["Manager", "Owner"].includes(String(requester.role)) &&
        approver.role === "Owner" &&
        requester.soleOperator === "Effective" &&
        approver.soleOperator === "Effective"
      : requesterReference !== approverReference &&
        requester.role === "Manager" &&
        ["Owner", "Finance"].includes(String(approver.role));
    if (
      JSON.stringify(expected) !== JSON.stringify(approvedSubject) ||
      approvedAt > observedAt ||
      !peopleValid ||
      requester.actorReference !== requesterReference ||
      approver.actorReference !== approverReference ||
      requester.permissionCode !== "payment.refund.request" ||
      approver.permissionCode !== "payment.refund.approve" ||
      !requester.active ||
      !approver.active ||
      !requester.allowed ||
      !approver.allowed ||
      requester.observedAt !== observedAt ||
      approver.observedAt !== observedAt ||
      scopeKeys.some(
        (key) => requester[key] !== expected[key] || approver[key] !== expected[key],
      ) ||
      !recent(requesterMfaAt, approvedAt) ||
      !recent(approverMfaAt, approvedAt) ||
      !recent(requester.recentMfaAt, observedAt) ||
      !recent(approver.recentMfaAt, observedAt)
    )
      return unusable();
    return Object.freeze({ status: "ApprovalCurrent" as const, approvalReference });
  } catch {
    return fail();
  }
}

/** Construct an approval only from freshly resolved owner authority facts.
 * The caller must persist this result with Audit atomically before treating it
 * as accepted. This function itself performs no durable approval or dispatch.
 */
export function createOrdinaryRefundIndependentApproval(value: unknown) {
  const withMode =
    value !== null &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "approvalMode");
  const keys = ["approvalReference", "subject", "requester", "approver", "observedAt"];
  const raw = exactPaymentObject(value, withMode ? [...keys, "approvalMode"] : keys);
  if (withMode && raw.approvalMode !== "Independent" && raw.approvalMode !== "SoleOperator")
    throw new Error("ORDINARY_REFUND_APPROVAL_DENIED");
  const sole = withMode && raw.approvalMode === "SoleOperator";
  const approvalReference = parsePaymentReference(raw.approvalReference);
  const approvedSubject = subject(raw.subject);
  const observedAt = parsePaymentInstant(raw.observedAt);
  const requester = authority(raw.requester);
  const approver = authority(raw.approver);
  if (requester.recentMfaAt === null || approver.recentMfaAt === null)
    throw new Error("ORDINARY_REFUND_APPROVAL_DENIED");
  const approval = Object.freeze({
    approvalReference,
    subject: approvedSubject,
    requesterReference: requester.actorReference,
    approverReference: approver.actorReference,
    approvedAt: observedAt,
    requesterMfaAt: requester.recentMfaAt,
    approverMfaAt: approver.recentMfaAt,
    ...(sole ? { approvalMode: "SoleOperator" as const } : {}),
  });
  if (
    evaluateOrdinaryRefundIndependentApproval({
      subject: approvedSubject,
      approval,
      requester,
      approver,
      observedAt,
    }).status !== "ApprovalCurrent"
  )
    throw new Error("ORDINARY_REFUND_APPROVAL_DENIED");
  return approval;
}

/** Strict durable representation. Historical validity does not establish current
 * dispatch authority; use the evaluator with freshly resolved authority facts.
 */
const approvalKeys = [
  "approvalReference",
  "subject",
  "requesterReference",
  "approverReference",
  "approvedAt",
  "requesterMfaAt",
  "approverMfaAt",
] as const;
function parseApproval(value: unknown, requireHistoricalValidity: boolean) {
  const withMode =
    value !== null &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "approvalMode");
  const raw = exactPaymentObject(
    value,
    withMode ? [...approvalKeys, "approvalMode"] : approvalKeys,
  );
  // Independent approvals are encoded without the key (unchanged history).
  if (withMode && raw.approvalMode !== "SoleOperator") return fail();
  const approvedSubject = subject(raw.subject);
  const result = {
    approvalReference: parsePaymentReference(raw.approvalReference),
    subject: approvedSubject,
    requesterReference: parsePaymentReference(raw.requesterReference),
    approverReference: parsePaymentReference(raw.approverReference),
    approvedAt: parsePaymentInstant(raw.approvedAt),
    requesterMfaAt: parsePaymentInstant(raw.requesterMfaAt),
    approverMfaAt: parsePaymentInstant(raw.approverMfaAt),
    ...(withMode ? { approvalMode: "SoleOperator" as const } : {}),
  };
  if (
    requireHistoricalValidity &&
    (approvedSubject.policyVersion !== ordinaryRefundPolicyVersion ||
      (result.requesterReference === result.approverReference) !== withMode ||
      !recent(result.requesterMfaAt, result.approvedAt) ||
      !recent(result.approverMfaAt, result.approvedAt))
  )
    return fail();
  return Object.freeze(result);
}
export function parseOrdinaryRefundApproval(value: unknown) {
  return parseApproval(value, true);
}
export type OrdinaryRefundApproval = ReturnType<typeof parseOrdinaryRefundApproval>;
export function encodeOrdinaryRefundApproval(value: unknown): string {
  return JSON.stringify(parseOrdinaryRefundApproval(value));
}
export function decodeOrdinaryRefundApproval(value: unknown): OrdinaryRefundApproval {
  if (typeof value !== "string" || value.length > 8192) return fail();
  try {
    return parseOrdinaryRefundApproval(JSON.parse(value));
  } catch {
    return fail();
  }
}

/** Current requester role/capability. MFA is imposed by the independent
 * approval path when escalation requires it, not on a normal Manager request. */
export function assertOrdinaryRefundRequester(value: unknown) {
  const raw = exactPaymentObject(value, ["expected", "authority", "observedAt"]);
  const expected = exactPaymentObject(raw.expected, [...scopeKeys, "actorReference"]);
  const current = authority(raw.authority);
  const at = parsePaymentInstant(raw.observedAt);
  for (const key of [...scopeKeys, "actorReference"] as const)
    if (parsePaymentReference(expected[key]) !== current[key])
      throw new Error("ORDINARY_REFUND_REQUESTER_DENIED");
  // WP-2423 Q19: an Owner may request only while sole operator is in effect for them.
  const roleAllowed =
    current.role === "Manager" ||
    (current.role === "Owner" && current.soleOperator === "Effective");
  if (
    !roleAllowed ||
    current.active !== true ||
    current.allowed !== true ||
    current.permissionCode !== "payment.refund.request" ||
    current.observedAt !== at
  )
    throw new Error("ORDINARY_REFUND_REQUESTER_DENIED");
}
