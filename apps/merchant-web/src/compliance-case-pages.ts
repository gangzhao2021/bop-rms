export type ComplianceCasePageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ComplianceCasePageError extends Error {
  constructor(readonly code: ComplianceCasePageErrorCode) {
    super("Compliance Cases unavailable");
    this.name = "ComplianceCasePageError";
  }
}
export type CaseSeverity = "Observation" | "Minor" | "Major" | "Critical" | "ImmediateDanger";
export type CaseLifecycle =
  | "Open"
  | "Investigating"
  | "CorrectiveAction"
  | "Verification"
  | "Closed"
  | "OnHold"
  | "Escalated"
  | "Cancelled";
export type CaseType =
  | "LicensePermit"
  | "FoodSafetyInspection"
  | "TemperatureMonitoring"
  | "AllergenControl"
  | "CleaningSanitation"
  | "EmployeeCertification"
  | "SupplierProductCompliance"
  | "RegulatoryAudit"
  | "FoodSafetyIncident"
  | "ComplianceInvestigation"
  | "CorrectiveAction"
  | "RecallWithdrawal"
  | "Other";
export interface CaseSummary {
  readonly caseReference: string;
  readonly caseType: CaseType;
  readonly severity: CaseSeverity;
  readonly lifecycle: CaseLifecycle;
  readonly storeReference: string | null;
  readonly ownerReference: string | null;
  readonly deadlineAt: string | null;
  readonly containmentStatus: "None" | "Requested" | "Applied" | "Released" | "Failed";
  readonly notificationStatus:
    | "None"
    | "Required"
    | "Preparing"
    | "Submitted"
    | "Acknowledged"
    | "RejectedReturned"
    | "Completed"
    | "NotRequired";
  readonly openActionCount: string;
}
export interface ComplianceCasePermissions {
  readonly mayCreate: boolean;
  readonly mayAssign: boolean;
  readonly mayTransition: boolean;
  readonly mayContain: boolean;
  readonly mayRecordNotification: boolean;
  readonly mayClose: boolean;
  readonly mayReviewMergeSplit: boolean;
}
export interface ComplianceCaseListView {
  readonly screenId: "CMP-CASE-LIST";
  readonly queryName: "compliance_case_list_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: ComplianceCasePermissions;
  readonly filters: {
    readonly caseReference: string | null;
    readonly relatedReference: string | null;
    readonly caseType: CaseType | null;
    readonly lifecycle: CaseLifecycle | null;
    readonly severity: CaseSeverity | null;
    readonly storeReference: string | null;
    readonly ownerReference: string | null;
    readonly deadlineDisposition: "Due" | "Overdue" | "NotDue" | "NoDeadline" | null;
    readonly regulatorReference: string | null;
  };
  readonly cases: readonly CaseSummary[];
}
export interface ComplianceCaseDetailView {
  readonly screenId: "CMP-CASE-DETAIL";
  readonly queryName: "compliance_case_detail_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: ComplianceCasePermissions;
  readonly case: CaseSummary;
  readonly requirementVersionReferences: readonly string[];
  readonly relatedScopes: readonly {
    readonly kind: string;
    readonly reference: string;
    readonly snapshotCode: string;
  }[];
  readonly containment: readonly {
    readonly containmentReference: string;
    readonly action: string;
    readonly status: string;
    readonly hardBlock: boolean;
    readonly ownerActionReference: string | null;
    readonly occurredAt: string;
  }[];
  readonly notifications: readonly {
    readonly notificationReference: string;
    readonly authorityReference: string;
    readonly requirementVersionReference: string;
    readonly status: string;
    readonly deadlineAt: string;
    readonly submissionReference: string | null;
    readonly occurredAt: string;
  }[];
  readonly gateCounts: {
    readonly openFindings: string;
    readonly mandatoryActionsIncomplete: string;
    readonly evidenceMissing: string;
    readonly verificationPending: string;
  };
  readonly legalHoldActive: boolean;
  readonly timeline: readonly {
    readonly entryReference: string;
    readonly eventCode: string;
    readonly occurredAt: string;
  }[];
}
export interface ComplianceCaseClient {
  load(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const count = /^(?:0|[1-9][0-9]{0,29})$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new ComplianceCasePageError("Unavailable");
};
function object(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail();
  const keys = Reflect.ownKeys(value as object);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const reference = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : fail();
const coded = (value: unknown) => (typeof value === "string" && code.test(value) ? value : fail());
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const decimal = (value: unknown) =>
  typeof value === "string" && count.test(value) ? value : fail();
const nullable = <T>(value: unknown, parse: (item: unknown) => T) =>
  value === null ? null : parse(value);
const caseTypes = [
  "LicensePermit",
  "FoodSafetyInspection",
  "TemperatureMonitoring",
  "AllergenControl",
  "CleaningSanitation",
  "EmployeeCertification",
  "SupplierProductCompliance",
  "RegulatoryAudit",
  "FoodSafetyIncident",
  "ComplianceInvestigation",
  "CorrectiveAction",
  "RecallWithdrawal",
  "Other",
] as const;
const severities = ["Observation", "Minor", "Major", "Critical", "ImmediateDanger"] as const;
const lifecycles = [
  "Open",
  "Investigating",
  "CorrectiveAction",
  "Verification",
  "Closed",
  "OnHold",
  "Escalated",
  "Cancelled",
] as const;
function permissions(value: unknown): ComplianceCasePermissions {
  const raw = object(value, [
    "mayCreate",
    "mayAssign",
    "mayTransition",
    "mayContain",
    "mayRecordNotification",
    "mayClose",
    "mayReviewMergeSplit",
  ]);
  return Object.freeze({
    mayCreate: bool(raw.mayCreate),
    mayAssign: bool(raw.mayAssign),
    mayTransition: bool(raw.mayTransition),
    mayContain: bool(raw.mayContain),
    mayRecordNotification: bool(raw.mayRecordNotification),
    mayClose: bool(raw.mayClose),
    mayReviewMergeSplit: bool(raw.mayReviewMergeSplit),
  });
}
function summary(value: unknown): CaseSummary {
  const raw = object(value, [
    "caseReference",
    "caseType",
    "severity",
    "lifecycle",
    "storeReference",
    "ownerReference",
    "deadlineAt",
    "containmentStatus",
    "notificationStatus",
    "openActionCount",
  ]);
  const severity = oneOf(raw.severity, severities);
  const ownerReference = nullable(raw.ownerReference, reference);
  const deadlineAt = nullable(raw.deadlineAt, instant);
  if (
    (severity === "Critical" || severity === "ImmediateDanger") &&
    (ownerReference === null || deadlineAt === null)
  )
    fail();
  return Object.freeze({
    caseReference: reference(raw.caseReference),
    caseType: oneOf(raw.caseType, caseTypes),
    severity,
    lifecycle: oneOf(raw.lifecycle, lifecycles),
    storeReference: nullable(raw.storeReference, reference),
    ownerReference,
    deadlineAt,
    containmentStatus: oneOf(raw.containmentStatus, [
      "None",
      "Requested",
      "Applied",
      "Released",
      "Failed",
    ] as const),
    notificationStatus: oneOf(raw.notificationStatus, [
      "None",
      "Required",
      "Preparing",
      "Submitted",
      "Acknowledged",
      "RejectedReturned",
      "Completed",
      "NotRequired",
    ] as const),
    openActionCount: decimal(raw.openActionCount),
  });
}
function header(raw: Record<string, unknown>, screenId: string, queryName: string) {
  if (raw.screenId !== screenId || raw.queryName !== queryName || raw.queryVersion !== 1) fail();
  const generatedAt = instant(raw.generatedAt);
  const sourceAsOf = instant(raw.sourceAsOf);
  if (Date.parse(sourceAsOf) > Date.parse(generatedAt)) fail();
  return {
    generatedAt,
    sourceAsOf,
    freshness: oneOf(raw.freshness, ["Current", "Stale"] as const),
    completeness: oneOf(raw.completeness, ["Complete", "Partial"] as const),
    permissions: permissions(raw.permissions),
  };
}
export function parseComplianceCaseListView(value: unknown): ComplianceCaseListView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "sourceAsOf",
    "freshness",
    "completeness",
    "permissions",
    "filters",
    "cases",
  ]);
  const meta = header(raw, "CMP-CASE-LIST", "compliance_case_list_v1");
  if (!Array.isArray(raw.cases) || raw.cases.length > 500) fail();
  const filters = object(raw.filters, [
    "caseReference",
    "relatedReference",
    "caseType",
    "lifecycle",
    "severity",
    "storeReference",
    "ownerReference",
    "deadlineDisposition",
    "regulatorReference",
  ]);
  const cases = Object.freeze((raw.cases as unknown[]).map(summary));
  if (new Set(cases.map((item) => item.caseReference)).size !== cases.length) fail();
  return Object.freeze({
    screenId: "CMP-CASE-LIST",
    queryName: "compliance_case_list_v1",
    queryVersion: 1,
    ...meta,
    filters: Object.freeze({
      caseReference: nullable(filters.caseReference, reference),
      relatedReference: nullable(filters.relatedReference, reference),
      caseType: nullable(filters.caseType, (item) => oneOf(item, caseTypes)),
      lifecycle: nullable(filters.lifecycle, (item) => oneOf(item, lifecycles)),
      severity: nullable(filters.severity, (item) => oneOf(item, severities)),
      storeReference: nullable(filters.storeReference, reference),
      ownerReference: nullable(filters.ownerReference, reference),
      deadlineDisposition: nullable(filters.deadlineDisposition, (item) =>
        oneOf(item, ["Due", "Overdue", "NotDue", "NoDeadline"] as const),
      ),
      regulatorReference: nullable(filters.regulatorReference, reference),
    }),
    cases,
  });
}
export function parseComplianceCaseDetailView(value: unknown): ComplianceCaseDetailView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "sourceAsOf",
    "freshness",
    "completeness",
    "permissions",
    "case",
    "requirementVersionReferences",
    "relatedScopes",
    "containment",
    "notifications",
    "gateCounts",
    "legalHoldActive",
    "timeline",
  ]);
  const meta = header(raw, "CMP-CASE-DETAIL", "compliance_case_detail_v1");
  if (
    ![
      raw.requirementVersionReferences,
      raw.relatedScopes,
      raw.containment,
      raw.notifications,
      raw.timeline,
    ].every(Array.isArray) ||
    (raw.requirementVersionReferences as unknown[]).length > 20 ||
    (raw.relatedScopes as unknown[]).length > 21 ||
    (raw.containment as unknown[]).length > 100 ||
    (raw.notifications as unknown[]).length > 100 ||
    (raw.timeline as unknown[]).length > 200
  )
    fail();
  const parseScope = (value: unknown) => {
    const item = object(value, ["kind", "reference", "snapshotCode"]);
    return Object.freeze({
      kind: coded(item.kind),
      reference: reference(item.reference),
      snapshotCode: coded(item.snapshotCode),
    });
  };
  const parseContainment = (value: unknown) => {
    const item = object(value, [
      "containmentReference",
      "action",
      "status",
      "hardBlock",
      "ownerActionReference",
      "occurredAt",
    ]);
    const status = oneOf(item.status, [
      "Requested",
      "Applied",
      "Rejected",
      "Failed",
      "Released",
    ] as const);
    const ownerActionReference = nullable(item.ownerActionReference, reference);
    if ((status === "Requested") !== (ownerActionReference === null)) fail();
    return Object.freeze({
      containmentReference: reference(item.containmentReference),
      action: coded(item.action),
      status,
      hardBlock: bool(item.hardBlock),
      ownerActionReference,
      occurredAt: instant(item.occurredAt),
    });
  };
  const parseNotification = (value: unknown) => {
    const item = object(value, [
      "notificationReference",
      "authorityReference",
      "requirementVersionReference",
      "status",
      "deadlineAt",
      "submissionReference",
      "occurredAt",
    ]);
    const status = oneOf(item.status, [
      "Required",
      "Preparing",
      "Submitted",
      "Acknowledged",
      "RejectedReturned",
      "Completed",
      "NotRequired",
    ] as const);
    const submissionReference = nullable(item.submissionReference, reference);
    if (
      ["Submitted", "Acknowledged", "RejectedReturned", "Completed"].includes(status) !==
      (submissionReference !== null)
    )
      fail();
    return Object.freeze({
      notificationReference: reference(item.notificationReference),
      authorityReference: reference(item.authorityReference),
      requirementVersionReference: reference(item.requirementVersionReference),
      status,
      deadlineAt: instant(item.deadlineAt),
      submissionReference,
      occurredAt: instant(item.occurredAt),
    });
  };
  const gate = object(raw.gateCounts, [
    "openFindings",
    "mandatoryActionsIncomplete",
    "evidenceMissing",
    "verificationPending",
  ]);
  const parseTimeline = (value: unknown) => {
    const item = object(value, ["entryReference", "eventCode", "occurredAt"]);
    return Object.freeze({
      entryReference: reference(item.entryReference),
      eventCode: coded(item.eventCode),
      occurredAt: instant(item.occurredAt),
    });
  };
  return Object.freeze({
    screenId: "CMP-CASE-DETAIL",
    queryName: "compliance_case_detail_v1",
    queryVersion: 1,
    ...meta,
    case: summary(raw.case),
    requirementVersionReferences: Object.freeze(
      (raw.requirementVersionReferences as unknown[]).map(reference),
    ),
    relatedScopes: Object.freeze((raw.relatedScopes as unknown[]).map(parseScope)),
    containment: Object.freeze((raw.containment as unknown[]).map(parseContainment)),
    notifications: Object.freeze((raw.notifications as unknown[]).map(parseNotification)),
    gateCounts: Object.freeze({
      openFindings: decimal(gate.openFindings),
      mandatoryActionsIncomplete: decimal(gate.mandatoryActionsIncomplete),
      evidenceMissing: decimal(gate.evidenceMissing),
      verificationPending: decimal(gate.verificationPending),
    }),
    legalHoldActive: bool(raw.legalHoldActive),
    timeline: Object.freeze((raw.timeline as unknown[]).map(parseTimeline)),
  });
}
export const unavailableComplianceCaseClient: ComplianceCaseClient = Object.freeze({
  async load() {
    throw new ComplianceCasePageError("Unavailable");
  },
});
