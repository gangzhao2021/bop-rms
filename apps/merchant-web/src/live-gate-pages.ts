export type LiveGatePageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class LiveGatePageError extends Error {
  constructor(readonly code: LiveGatePageErrorCode) {
    super("Live Gate workflow is unavailable");
    this.name = "LiveGatePageError";
  }
}
export interface LiveGateRequirementView {
  readonly requirementId: string;
  readonly category: string;
  readonly requirement: string;
  readonly owner: string;
  readonly status:
    "Missing" | "Submitted" | "Accepted" | "Rejected" | "Expired" | "Revoked" | "NotApplicable";
  readonly expiry: string | null;
  readonly blockingReason: string | null;
}
export interface LiveGateDecisionView {
  readonly decision: "Requested" | "Approved" | "Rejected" | "Reopened";
  readonly actor: string;
  readonly occurredAt: string;
}
export interface LiveGateItemView {
  readonly gateReference: string;
  readonly gateId: string;
  readonly tenant: string;
  readonly storeReference: string;
  readonly store: string;
  readonly status: "Draft" | "Blocked" | "InReview" | "Approved" | "Rejected" | "Reopened";
  readonly owner: string;
  readonly lastReviewedAt: string | null;
  readonly requirements: readonly LiveGateRequirementView[];
  readonly history: readonly LiveGateDecisionView[];
}
export interface LiveGatePageView {
  readonly screenId: "STORE-LIVE-GATE" | "PLT-LIVE-GATE";
  readonly sourceAsOf: string;
  readonly freshness: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly gates: readonly LiveGateItemView[];
  readonly mayManage: boolean;
}
export interface LiveGatePageClient {
  loadStoreGate(storeReference: string): Promise<unknown>;
  loadPlatformGates(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  safe = /^[^\p{Cc}\p{Cf}]{1,180}$/u,
  gateId = /^[A-Z][A-Z0-9-]{7,95}$/u;
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    throw new Error("LIVE_GATE_PAGE_INVALID");
  return value as Record<string, unknown>;
}
export function parseLiveGateRouteReference(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("LIVE_GATE_PAGE_INVALID");
  return value;
}
const time = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !instant.test(value) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new Error("LIVE_GATE_PAGE_INVALID");
  return value;
};
const text = (value: unknown) => {
  if (typeof value !== "string" || !safe.test(value)) throw new Error("LIVE_GATE_PAGE_INVALID");
  return value;
};
function requirement(value: unknown): LiveGateRequirementView {
  const input = closed(value, [
    "requirementId",
    "category",
    "requirement",
    "owner",
    "status",
    "expiry",
    "blockingReason",
  ]);
  if (
    ![
      "Missing",
      "Submitted",
      "Accepted",
      "Rejected",
      "Expired",
      "Revoked",
      "NotApplicable",
    ].includes(String(input.status))
  )
    throw new Error("LIVE_GATE_PAGE_INVALID");
  return Object.freeze({
    requirementId: parseLiveGateRouteReference(input.requirementId),
    category: text(input.category),
    requirement: text(input.requirement),
    owner: text(input.owner),
    status: input.status,
    expiry: input.expiry === null ? null : time(input.expiry),
    blockingReason: input.blockingReason === null ? null : text(input.blockingReason),
  }) as LiveGateRequirementView;
}
function decision(value: unknown): LiveGateDecisionView {
  const input = closed(value, ["decision", "actor", "occurredAt"]);
  if (!["Requested", "Approved", "Rejected", "Reopened"].includes(String(input.decision)))
    throw new Error("LIVE_GATE_PAGE_INVALID");
  return Object.freeze({
    decision: input.decision,
    actor: text(input.actor),
    occurredAt: time(input.occurredAt),
  }) as LiveGateDecisionView;
}
function gate(value: unknown): LiveGateItemView {
  const input = closed(value, [
    "gateReference",
    "gateId",
    "tenant",
    "storeReference",
    "store",
    "status",
    "owner",
    "lastReviewedAt",
    "requirements",
    "history",
  ]);
  if (
    typeof input.gateId !== "string" ||
    !gateId.test(input.gateId) ||
    !["Draft", "Blocked", "InReview", "Approved", "Rejected", "Reopened"].includes(
      String(input.status),
    ) ||
    !Array.isArray(input.requirements) ||
    !Array.isArray(input.history)
  )
    throw new Error("LIVE_GATE_PAGE_INVALID");
  const requirements = Object.freeze(input.requirements.map(requirement)),
    history = Object.freeze(input.history.map(decision));
  if (new Set(requirements.map((item) => item.requirementId)).size !== requirements.length)
    throw new Error("LIVE_GATE_PAGE_INVALID");
  return Object.freeze({
    gateReference: parseLiveGateRouteReference(input.gateReference),
    gateId: input.gateId,
    tenant: text(input.tenant),
    storeReference: parseLiveGateRouteReference(input.storeReference),
    store: text(input.store),
    status: input.status,
    owner: text(input.owner),
    lastReviewedAt: input.lastReviewedAt === null ? null : time(input.lastReviewedAt),
    requirements,
    history,
  }) as LiveGateItemView;
}
export function parseLiveGatePageView(
  value: unknown,
  screenId: LiveGatePageView["screenId"],
): LiveGatePageView {
  const input = closed(value, [
    "screenId",
    "sourceAsOf",
    "freshness",
    "completeness",
    "gates",
    "mayManage",
  ]);
  if (
    input.screenId !== screenId ||
    !["Fresh", "Stale"].includes(String(input.freshness)) ||
    !["Complete", "Partial"].includes(String(input.completeness)) ||
    !Array.isArray(input.gates) ||
    typeof input.mayManage !== "boolean"
  )
    throw new Error("LIVE_GATE_PAGE_INVALID");
  const gates = Object.freeze(input.gates.map(gate));
  if (
    new Set(gates.map((item) => item.gateReference)).size !== gates.length ||
    (screenId === "STORE-LIVE-GATE" && gates.length > 1)
  )
    throw new Error("LIVE_GATE_PAGE_INVALID");
  return Object.freeze({ ...input, sourceAsOf: time(input.sourceAsOf), gates }) as LiveGatePageView;
}
export const unavailableLiveGatePageClient: LiveGatePageClient = {
  loadStoreGate: async () => {
    throw new LiveGatePageError("Unavailable");
  },
  loadPlatformGates: async () => {
    throw new LiveGatePageError("Unavailable");
  },
};
