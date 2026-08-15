export type ComplianceInspectionActionPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ComplianceInspectionActionPageError extends Error {
  constructor(readonly code: ComplianceInspectionActionPageErrorCode) {
    super("Compliance Inspection/Action unavailable");
    this.name = "ComplianceInspectionActionPageError";
  }
}
export type InspectionType =
  | "InternalSelfInspection"
  | "ManagerInspection"
  | "ThirdPartyAudit"
  | "RegulatoryInspection"
  | "TriggeredInvestigation";
export type InspectionStatus = "Draft" | "Scheduled" | "InProgress" | "Finalized" | "Cancelled";
export type FindingSeverity = "Observation" | "Minor" | "Major" | "Critical" | "ImmediateDanger";
export type CorrectiveActionStatus =
  | "Planned"
  | "InProgress"
  | "Blocked"
  | "Completed"
  | "VerificationFailed"
  | "Verified"
  | "Cancelled";
export type VerificationResult = "Passed" | "PassedWithConditions" | "Failed" | "UnableToVerify";

export interface ComplianceInspectionPermissions {
  readonly maySchedule: boolean;
  readonly mayRecord: boolean;
  readonly mayAddFinding: boolean;
  readonly mayFinalize: boolean;
  readonly mayCorrect: boolean;
}
export interface ComplianceInspectionSummary {
  readonly inspectionReference: string;
  readonly caseReference: string;
  readonly inspectionType: InspectionType;
  readonly status: InspectionStatus;
  readonly storeReference: string | null;
  readonly scopeCode: string;
  readonly inspectorReference: string;
  readonly authorityReference: string | null;
  readonly scheduledAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly checklistVersionReference: string;
  readonly requirementVersionReference: string;
  readonly findingCount: string;
  readonly highestSeverity: FindingSeverity | null;
  readonly evidenceReferenceCount: string;
  readonly recordVersion: string;
}
export interface ComplianceInspectionView {
  readonly screenId: "CMP-INSPECTION";
  readonly queryName: "compliance_inspection_list_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: ComplianceInspectionPermissions;
  readonly filters: {
    readonly inspectionReference: string | null;
    readonly inspectionType: InspectionType | null;
    readonly storeReference: string | null;
    readonly status: InspectionStatus | null;
    readonly dateDisposition: "Scheduled" | "Started" | "Completed" | null;
    readonly findingSeverity: FindingSeverity | null;
  };
  readonly inspections: readonly ComplianceInspectionSummary[];
}

export interface ComplianceCorrectiveActionPermissions {
  readonly mayAssign: boolean;
  readonly mayStart: boolean;
  readonly maySubmitEvidence: boolean;
  readonly mayRequestVerification: boolean;
  readonly mayVerify: boolean;
  readonly mayReject: boolean;
  readonly mayClose: boolean;
}
export interface ComplianceCorrectiveActionSummary {
  readonly actionReference: string;
  readonly caseReference: string;
  readonly findingReference: string;
  readonly storeReference: string | null;
  readonly severity: FindingSeverity;
  readonly requiredActionCode: string;
  readonly ownerReference: string;
  readonly dueAt: string;
  readonly dueTimezone: string;
  readonly priority: "Low" | "Medium" | "High" | "Critical";
  readonly status: CorrectiveActionStatus;
  readonly completionEvidenceCount: string;
  readonly ownerOutcomeReference: string | null;
  readonly verifierReference: string | null;
  readonly verificationResult: VerificationResult | null;
  readonly independenceRequired: boolean;
  readonly overdue: boolean;
  readonly followUpTaskReference: string | null;
  readonly recordVersion: string;
}
export interface ComplianceCorrectiveActionView {
  readonly screenId: "CMP-CORRECTIVE-ACTION";
  readonly queryName: "compliance_corrective_action_list_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: ComplianceCorrectiveActionPermissions;
  readonly filters: {
    readonly actionReference: string | null;
    readonly status: CorrectiveActionStatus | null;
    readonly ownerReference: string | null;
    readonly dueDisposition: "Due" | "Overdue" | "NotDue" | null;
    readonly severity: FindingSeverity | null;
    readonly storeReference: string | null;
  };
  readonly actions: readonly ComplianceCorrectiveActionSummary[];
}
export interface ComplianceInspectionActionClient {
  load(): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const count = /^(?:0|[1-9][0-9]{0,29})$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new ComplianceInspectionActionPageError("Unavailable");
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
function timezone(value: unknown) {
  if (typeof value !== "string" || value.length > 64) return fail();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(0);
  } catch {
    return fail();
  }
  return value;
}
function list<T>(value: unknown, maximum: number, parse: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) return fail();
  return Object.freeze(value.map(parse));
}
const inspectionTypes = [
  "InternalSelfInspection",
  "ManagerInspection",
  "ThirdPartyAudit",
  "RegulatoryInspection",
  "TriggeredInvestigation",
] as const;
const inspectionStatuses = ["Draft", "Scheduled", "InProgress", "Finalized", "Cancelled"] as const;
const severities = ["Observation", "Minor", "Major", "Critical", "ImmediateDanger"] as const;
const actionStatuses = [
  "Planned",
  "InProgress",
  "Blocked",
  "Completed",
  "VerificationFailed",
  "Verified",
  "Cancelled",
] as const;
const verificationResults = ["Passed", "PassedWithConditions", "Failed", "UnableToVerify"] as const;
function common(value: Record<string, unknown>) {
  const generatedAt = instant(value.generatedAt);
  const sourceAsOf = instant(value.sourceAsOf);
  const freshness = oneOf(value.freshness, ["Current", "Stale"] as const);
  const completeness = oneOf(value.completeness, ["Complete", "Partial"] as const);
  if (
    Date.parse(sourceAsOf) > Date.parse(generatedAt) ||
    (freshness === "Current" && completeness === "Partial")
  )
    fail();
  return { generatedAt, sourceAsOf, freshness, completeness };
}
function inspectionPermissions(value: unknown): ComplianceInspectionPermissions {
  const raw = object(value, [
    "maySchedule",
    "mayRecord",
    "mayAddFinding",
    "mayFinalize",
    "mayCorrect",
  ]);
  return Object.freeze({
    maySchedule: bool(raw.maySchedule),
    mayRecord: bool(raw.mayRecord),
    mayAddFinding: bool(raw.mayAddFinding),
    mayFinalize: bool(raw.mayFinalize),
    mayCorrect: bool(raw.mayCorrect),
  });
}
function inspectionSummary(value: unknown): ComplianceInspectionSummary {
  const raw = object(value, [
    "inspectionReference",
    "caseReference",
    "inspectionType",
    "status",
    "storeReference",
    "scopeCode",
    "inspectorReference",
    "authorityReference",
    "scheduledAt",
    "startedAt",
    "completedAt",
    "checklistVersionReference",
    "requirementVersionReference",
    "findingCount",
    "highestSeverity",
    "evidenceReferenceCount",
    "recordVersion",
  ]);
  const inspectionType = oneOf(raw.inspectionType, inspectionTypes);
  const status = oneOf(raw.status, inspectionStatuses);
  const authorityReference = nullable(raw.authorityReference, reference);
  const scheduledAt = nullable(raw.scheduledAt, instant);
  const startedAt = nullable(raw.startedAt, instant);
  const completedAt = nullable(raw.completedAt, instant);
  const findingCount = decimal(raw.findingCount);
  const highestSeverity = nullable(raw.highestSeverity, (item) => oneOf(item, severities));
  if (
    ((inspectionType === "ThirdPartyAudit" || inspectionType === "RegulatoryInspection") &&
      authorityReference === null) ||
    (status === "Scheduled" &&
      (scheduledAt === null || startedAt !== null || completedAt !== null)) ||
    (status === "InProgress" &&
      (scheduledAt === null || startedAt === null || completedAt !== null)) ||
    (status === "Finalized" && (startedAt === null || completedAt === null)) ||
    (status === "Draft" && (startedAt !== null || completedAt !== null)) ||
    (status !== "Finalized" && completedAt !== null) ||
    (findingCount === "0") !== (highestSeverity === null)
  )
    fail();
  return Object.freeze({
    inspectionReference: reference(raw.inspectionReference),
    caseReference: reference(raw.caseReference),
    inspectionType,
    status,
    storeReference: nullable(raw.storeReference, reference),
    scopeCode: coded(raw.scopeCode),
    inspectorReference: reference(raw.inspectorReference),
    authorityReference,
    scheduledAt,
    startedAt,
    completedAt,
    checklistVersionReference: reference(raw.checklistVersionReference),
    requirementVersionReference: reference(raw.requirementVersionReference),
    findingCount,
    highestSeverity,
    evidenceReferenceCount: decimal(raw.evidenceReferenceCount),
    recordVersion: decimal(raw.recordVersion),
  });
}
export function parseComplianceInspectionView(value: unknown): ComplianceInspectionView {
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
    "inspections",
  ]);
  if (
    raw.screenId !== "CMP-INSPECTION" ||
    raw.queryName !== "compliance_inspection_list_v1" ||
    raw.queryVersion !== 1
  )
    fail();
  const filters = object(raw.filters, [
    "inspectionReference",
    "inspectionType",
    "storeReference",
    "status",
    "dateDisposition",
    "findingSeverity",
  ]);
  return Object.freeze({
    screenId: "CMP-INSPECTION",
    queryName: "compliance_inspection_list_v1",
    queryVersion: 1,
    ...common(raw),
    permissions: inspectionPermissions(raw.permissions),
    filters: Object.freeze({
      inspectionReference: nullable(filters.inspectionReference, reference),
      inspectionType: nullable(filters.inspectionType, (item) => oneOf(item, inspectionTypes)),
      storeReference: nullable(filters.storeReference, reference),
      status: nullable(filters.status, (item) => oneOf(item, inspectionStatuses)),
      dateDisposition: nullable(filters.dateDisposition, (item) =>
        oneOf(item, ["Scheduled", "Started", "Completed"] as const),
      ),
      findingSeverity: nullable(filters.findingSeverity, (item) => oneOf(item, severities)),
    }),
    inspections: list(raw.inspections, 500, inspectionSummary),
  });
}
function actionPermissions(value: unknown): ComplianceCorrectiveActionPermissions {
  const raw = object(value, [
    "mayAssign",
    "mayStart",
    "maySubmitEvidence",
    "mayRequestVerification",
    "mayVerify",
    "mayReject",
    "mayClose",
  ]);
  return Object.freeze({
    mayAssign: bool(raw.mayAssign),
    mayStart: bool(raw.mayStart),
    maySubmitEvidence: bool(raw.maySubmitEvidence),
    mayRequestVerification: bool(raw.mayRequestVerification),
    mayVerify: bool(raw.mayVerify),
    mayReject: bool(raw.mayReject),
    mayClose: bool(raw.mayClose),
  });
}
function actionSummary(value: unknown): ComplianceCorrectiveActionSummary {
  const raw = object(value, [
    "actionReference",
    "caseReference",
    "findingReference",
    "storeReference",
    "severity",
    "requiredActionCode",
    "ownerReference",
    "dueAt",
    "dueTimezone",
    "priority",
    "status",
    "completionEvidenceCount",
    "ownerOutcomeReference",
    "verifierReference",
    "verificationResult",
    "independenceRequired",
    "overdue",
    "followUpTaskReference",
    "recordVersion",
  ]);
  const status = oneOf(raw.status, actionStatuses);
  const completionEvidenceCount = decimal(raw.completionEvidenceCount);
  const ownerOutcomeReference = nullable(raw.ownerOutcomeReference, reference);
  const verifierReference = nullable(raw.verifierReference, reference);
  const verificationResult = nullable(raw.verificationResult, (item) =>
    oneOf(item, verificationResults),
  );
  const followUpTaskReference = nullable(raw.followUpTaskReference, reference);
  const completed = ["Completed", "VerificationFailed", "Verified"].includes(status);
  const verified = status === "Verified";
  const failed = status === "VerificationFailed";
  const unable = status === "Completed" && verificationResult === "UnableToVerify";
  if (
    completed !== (completionEvidenceCount !== "0" && ownerOutcomeReference !== null) ||
    (verified && !["Passed", "PassedWithConditions"].includes(verificationResult ?? "")) ||
    (failed && verificationResult !== "Failed") ||
    (!verified && !failed && !unable && verificationResult !== null) ||
    (verificationResult === null) !== (verifierReference === null) ||
    unable !== (followUpTaskReference !== null)
  )
    fail();
  return Object.freeze({
    actionReference: reference(raw.actionReference),
    caseReference: reference(raw.caseReference),
    findingReference: reference(raw.findingReference),
    storeReference: nullable(raw.storeReference, reference),
    severity: oneOf(raw.severity, severities),
    requiredActionCode: coded(raw.requiredActionCode),
    ownerReference: reference(raw.ownerReference),
    dueAt: instant(raw.dueAt),
    dueTimezone: timezone(raw.dueTimezone),
    priority: oneOf(raw.priority, ["Low", "Medium", "High", "Critical"] as const),
    status,
    completionEvidenceCount,
    ownerOutcomeReference,
    verifierReference,
    verificationResult,
    independenceRequired: bool(raw.independenceRequired),
    overdue: bool(raw.overdue),
    followUpTaskReference,
    recordVersion: decimal(raw.recordVersion),
  });
}
export function parseComplianceCorrectiveActionView(
  value: unknown,
): ComplianceCorrectiveActionView {
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
    "actions",
  ]);
  if (
    raw.screenId !== "CMP-CORRECTIVE-ACTION" ||
    raw.queryName !== "compliance_corrective_action_list_v1" ||
    raw.queryVersion !== 1
  )
    fail();
  const filters = object(raw.filters, [
    "actionReference",
    "status",
    "ownerReference",
    "dueDisposition",
    "severity",
    "storeReference",
  ]);
  return Object.freeze({
    screenId: "CMP-CORRECTIVE-ACTION",
    queryName: "compliance_corrective_action_list_v1",
    queryVersion: 1,
    ...common(raw),
    permissions: actionPermissions(raw.permissions),
    filters: Object.freeze({
      actionReference: nullable(filters.actionReference, reference),
      status: nullable(filters.status, (item) => oneOf(item, actionStatuses)),
      ownerReference: nullable(filters.ownerReference, reference),
      dueDisposition: nullable(filters.dueDisposition, (item) =>
        oneOf(item, ["Due", "Overdue", "NotDue"] as const),
      ),
      severity: nullable(filters.severity, (item) => oneOf(item, severities)),
      storeReference: nullable(filters.storeReference, reference),
    }),
    actions: list(raw.actions, 500, actionSummary),
  });
}

export const unavailableComplianceInspectionActionClient: ComplianceInspectionActionClient =
  Object.freeze({
    async load() {
      throw new ComplianceInspectionActionPageError("Unavailable");
    },
  });
