export type SupportCasePageErrorCode =
  | "PermissionDenied"
  | "PurposeRequired"
  | "MfaRequired"
  | "Stale"
  | "Conflict"
  | "Offline"
  | "Unavailable";
export class SupportCasePageError extends Error {
  constructor(readonly code: SupportCasePageErrorCode) {
    super("Support Case workflow is unavailable");
    this.name = "SupportCasePageError";
  }
}
export interface SupportCaseSummaryView {
  readonly caseReference: string;
  readonly caseCode: string;
  readonly tenant: string;
  readonly store: string | null;
  readonly caseType: string;
  readonly purpose: string;
  readonly requesterVerified: boolean;
  readonly assignedRole: string | null;
  readonly status:
    "Open" | "Assigned" | "AccessPendingApproval" | "AccessGranted" | "Revoked" | "Closed";
  readonly dueAt: string;
  readonly accessExpiresAt: string | null;
  readonly actionCount: number;
  readonly evidenceReferences: readonly string[];
  readonly mayAssign: boolean;
  readonly mayGrant: boolean;
  readonly mayRecordAction: boolean;
  readonly mayRevoke: boolean;
  readonly mayClose: boolean;
}
export interface SupportCasePageView {
  readonly screenId: "PLT-SUPPORT-CASE";
  readonly sourceAsOf: string;
  readonly freshness: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly environment: "NonProduction" | "Production";
  readonly actor: string;
  readonly purpose: string;
  readonly recentMfa: boolean;
  readonly cases: readonly SupportCaseSummaryView[];
  readonly mayCreate: boolean;
}
export interface SupportCasePageClient {
  loadCases(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  safe = /^[^\p{Cc}\p{Cf}]{1,180}$/u;
const fail = (): never => {
  throw new Error("SUPPORT_CASE_PAGE_INVALID");
};
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  return value as Record<string, unknown>;
}
const text = (value: unknown): string => {
  if (typeof value !== "string" || !safe.test(value)) fail();
  return value as string;
};
const reference = (value: unknown): string => {
  if (typeof value !== "string" || !uuid.test(value)) fail();
  return value as string;
};
const time = (value: unknown): string => {
  if (typeof value !== "string" || !instant.test(value) || new Date(value).toISOString() !== value)
    fail();
  return value as string;
};
const flag = (value: unknown): boolean => {
  if (typeof value !== "boolean") fail();
  return value as boolean;
};
function item(value: unknown): SupportCaseSummaryView {
  const r = closed(value, [
    "caseReference",
    "caseCode",
    "tenant",
    "store",
    "caseType",
    "purpose",
    "requesterVerified",
    "assignedRole",
    "status",
    "dueAt",
    "accessExpiresAt",
    "actionCount",
    "evidenceReferences",
    "mayAssign",
    "mayGrant",
    "mayRecordAction",
    "mayRevoke",
    "mayClose",
  ]);
  if (
    !["Open", "Assigned", "AccessPendingApproval", "AccessGranted", "Revoked", "Closed"].includes(
      String(r.status),
    ) ||
    !Number.isSafeInteger(r.actionCount) ||
    (r.actionCount as number) < 0 ||
    !Array.isArray(r.evidenceReferences) ||
    r.evidenceReferences.length > 100
  )
    fail();
  const evidenceInput = r.evidenceReferences as unknown[];
  const evidenceReferences = Object.freeze(evidenceInput.map(reference));
  if (new Set(evidenceReferences).size !== evidenceReferences.length) fail();
  return Object.freeze({
    caseReference: reference(r.caseReference),
    caseCode: text(r.caseCode),
    tenant: text(r.tenant),
    store: r.store === null ? null : text(r.store),
    caseType: text(r.caseType),
    purpose: text(r.purpose),
    requesterVerified: flag(r.requesterVerified),
    assignedRole: r.assignedRole === null ? null : text(r.assignedRole),
    status: r.status,
    dueAt: time(r.dueAt),
    accessExpiresAt: r.accessExpiresAt === null ? null : time(r.accessExpiresAt),
    actionCount: r.actionCount,
    evidenceReferences,
    mayAssign: flag(r.mayAssign),
    mayGrant: flag(r.mayGrant),
    mayRecordAction: flag(r.mayRecordAction),
    mayRevoke: flag(r.mayRevoke),
    mayClose: flag(r.mayClose),
  }) as SupportCaseSummaryView;
}
export function parseSupportCasePageView(value: unknown): SupportCasePageView {
  const r = closed(value, [
    "screenId",
    "sourceAsOf",
    "freshness",
    "completeness",
    "environment",
    "actor",
    "purpose",
    "recentMfa",
    "cases",
    "mayCreate",
  ]);
  if (
    r.screenId !== "PLT-SUPPORT-CASE" ||
    !["Fresh", "Stale"].includes(String(r.freshness)) ||
    !["Complete", "Partial"].includes(String(r.completeness)) ||
    !["NonProduction", "Production"].includes(String(r.environment)) ||
    !Array.isArray(r.cases)
  )
    fail();
  const caseInput = r.cases as unknown[];
  const cases = Object.freeze(caseInput.map(item));
  if (new Set(cases.map((entry) => entry.caseReference)).size !== cases.length) fail();
  return Object.freeze({
    screenId: "PLT-SUPPORT-CASE",
    sourceAsOf: time(r.sourceAsOf),
    freshness: r.freshness,
    completeness: r.completeness,
    environment: r.environment,
    actor: text(r.actor),
    purpose: text(r.purpose),
    recentMfa: flag(r.recentMfa),
    cases,
    mayCreate: flag(r.mayCreate),
  }) as SupportCasePageView;
}
export const unavailableSupportCasePageClient: SupportCasePageClient = Object.freeze({
  loadCases: async () => {
    throw new SupportCasePageError("Unavailable");
  },
});
