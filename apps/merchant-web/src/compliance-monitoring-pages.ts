export type ComplianceMonitoringPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ComplianceMonitoringPageError extends Error {
  constructor(readonly code: ComplianceMonitoringPageErrorCode) {
    super("Compliance monitoring unavailable");
    this.name = "ComplianceMonitoringPageError";
  }
}
export interface ComplianceMonitoringClient {
  load(): Promise<unknown>;
}
type Severity = "Observation" | "Minor" | "Major" | "Critical" | "ImmediateDanger";
type Threshold =
  "WithinRange" | "BelowRange" | "AboveRange" | "Missing" | "Unverified" | "DeviceFault";
type CleaningStatus =
  | "Scheduled"
  | "InProgress"
  | "Completed"
  | "CannotComplete"
  | "Missed"
  | "VerificationFailed"
  | "Verified"
  | "Cancelled";
export interface TemperatureLogView {
  readonly screenId: "CMP-TEMP-LOG";
  readonly queryName: "compliance_temperature_log_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: {
    readonly mayRecordManual: boolean;
    readonly mayAcknowledgeExcursion: boolean;
    readonly mayOpenIncident: boolean;
    readonly mayCreateCorrectiveAction: boolean;
  };
  readonly filters: {
    readonly targetReference: string | null;
    readonly deviceReference: string | null;
    readonly thresholdResult: Threshold | null;
    readonly method: "Manual" | "Sensor" | "Imported" | null;
    readonly dateFrom: string | null;
    readonly dateTo: string | null;
    readonly unverifiedOnly: boolean;
  };
  readonly readings: readonly {
    readonly readingReference: string;
    readonly correctionOfReadingReference: string | null;
    readonly targetReference: string;
    readonly targetCode: string;
    readonly measurementTypeCode: string;
    readonly value: string | null;
    readonly unitCode: string;
    readonly measuredAt: string;
    readonly capturedAt: string;
    readonly method: "Manual" | "Sensor" | "Imported";
    readonly operatorReference: string;
    readonly deviceReference: string | null;
    readonly policyVersionReference: string;
    readonly thresholdResult: Threshold;
    readonly calibrationReference: string | null;
    readonly excursion: null | {
      readonly excursionReference: string;
      readonly severity: Severity;
      readonly status: "Open" | "Contained" | "DispositionPending" | "Resolved" | "Cancelled";
      readonly containmentReference: string | null;
      readonly dispositionReference: string | null;
    };
  }[];
}
export interface CleaningLogView {
  readonly screenId: "CMP-CLEANING";
  readonly queryName: "compliance_cleaning_log_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: {
    readonly mayComplete: boolean;
    readonly mayReportCannotComplete: boolean;
    readonly mayVerify: boolean;
    readonly mayEscalateMissed: boolean;
  };
  readonly filters: {
    readonly targetReference: string | null;
    readonly status: CleaningStatus | null;
    readonly assigneeReference: string | null;
    readonly dueDisposition: "Due" | "Overdue" | "NotDue" | null;
    readonly missedOnly: boolean;
  };
  readonly records: readonly {
    readonly cleaningReference: string;
    readonly scheduleReference: string;
    readonly taskReference: string;
    readonly targetReference: string;
    readonly targetCode: string;
    readonly procedureVersionReference: string;
    readonly assigneeReference: string;
    readonly dueAt: string;
    readonly dueTimezone: string;
    readonly severity: Severity;
    readonly status: CleaningStatus;
    readonly performedByReference: string | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly methodCode: string;
    readonly chemicalResult:
      "NotRequired" | "WithinRequirement" | "OutsideRequirement" | "Unverified";
    readonly evidenceReferenceCount: string;
    readonly verificationResult: "Pending" | "Passed" | "Failed" | "UnableToVerify";
    readonly verifierReference: string | null;
    readonly safetyReviewReference: string | null;
    readonly missed: boolean;
  }[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const count = /^(?:0|[1-9][0-9]{0,29})$/u;
const decimal = /^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,12})?$/u;
const negativeZero = /^-0(?:\.0+)?$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new ComplianceMonitoringPageError("Unavailable");
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
const nullable = <T>(value: unknown, parse: (item: unknown) => T) =>
  value === null ? null : parse(value);
const exactDecimal = (value: unknown) =>
  typeof value === "string" && decimal.test(value) && !negativeZero.test(value) ? value : fail();
const decimalCount = (value: unknown) =>
  typeof value === "string" && count.test(value) ? value : fail();
function list<T>(value: unknown, parse: (item: unknown) => T) {
  if (!Array.isArray(value) || value.length > 500) return fail();
  return Object.freeze(value.map(parse));
}
function timezone(value: unknown) {
  if (typeof value !== "string" || value.length > 64) return fail();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(0);
  } catch {
    return fail();
  }
  return value;
}
const severities = ["Observation", "Minor", "Major", "Critical", "ImmediateDanger"] as const;
const thresholds = [
  "WithinRange",
  "BelowRange",
  "AboveRange",
  "Missing",
  "Unverified",
  "DeviceFault",
] as const;
const methods = ["Manual", "Sensor", "Imported"] as const;
const cleaningStatuses = [
  "Scheduled",
  "InProgress",
  "Completed",
  "CannotComplete",
  "Missed",
  "VerificationFailed",
  "Verified",
  "Cancelled",
] as const;
function common(raw: Record<string, unknown>) {
  const generatedAt = instant(raw.generatedAt);
  const sourceAsOf = instant(raw.sourceAsOf);
  const freshness = oneOf(raw.freshness, ["Current", "Stale"] as const);
  const completeness = oneOf(raw.completeness, ["Complete", "Partial"] as const);
  if (
    Date.parse(sourceAsOf) > Date.parse(generatedAt) ||
    (freshness === "Current" && completeness === "Partial")
  )
    fail();
  return { generatedAt, sourceAsOf, freshness, completeness };
}
function excursion(value: unknown) {
  if (value === null) return null;
  const raw = object(value, [
    "excursionReference",
    "severity",
    "status",
    "containmentReference",
    "dispositionReference",
  ]);
  const status = oneOf(raw.status, [
    "Open",
    "Contained",
    "DispositionPending",
    "Resolved",
    "Cancelled",
  ] as const);
  const containmentReference = nullable(raw.containmentReference, reference);
  const dispositionReference = nullable(raw.dispositionReference, reference);
  if (
    (["Contained", "DispositionPending", "Resolved"].includes(status) &&
      containmentReference === null) ||
    (status === "Resolved") !== (dispositionReference !== null)
  )
    fail();
  return Object.freeze({
    excursionReference: reference(raw.excursionReference),
    severity: oneOf(raw.severity, severities),
    status,
    containmentReference,
    dispositionReference,
  });
}
function reading(value: unknown) {
  const raw = object(value, [
    "readingReference",
    "correctionOfReadingReference",
    "targetReference",
    "targetCode",
    "measurementTypeCode",
    "value",
    "unitCode",
    "measuredAt",
    "capturedAt",
    "method",
    "operatorReference",
    "deviceReference",
    "policyVersionReference",
    "thresholdResult",
    "calibrationReference",
    "excursion",
  ]);
  const thresholdResult = oneOf(raw.thresholdResult, thresholds);
  const observed = nullable(raw.value, exactDecimal);
  const method = oneOf(raw.method, methods);
  const deviceReference = nullable(raw.deviceReference, reference);
  const calibrationReference = nullable(raw.calibrationReference, reference);
  if (
    ["Missing", "DeviceFault"].includes(thresholdResult) !== (observed === null) ||
    (method === "Sensor" && (deviceReference === null || calibrationReference === null))
  )
    fail();
  return Object.freeze({
    readingReference: reference(raw.readingReference),
    correctionOfReadingReference: nullable(raw.correctionOfReadingReference, reference),
    targetReference: reference(raw.targetReference),
    targetCode: coded(raw.targetCode),
    measurementTypeCode: coded(raw.measurementTypeCode),
    value: observed,
    unitCode: coded(raw.unitCode),
    measuredAt: instant(raw.measuredAt),
    capturedAt: instant(raw.capturedAt),
    method,
    operatorReference: reference(raw.operatorReference),
    deviceReference,
    policyVersionReference: reference(raw.policyVersionReference),
    thresholdResult,
    calibrationReference,
    excursion: excursion(raw.excursion),
  });
}
export function parseTemperatureLogView(value: unknown): TemperatureLogView {
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
    "readings",
  ]);
  if (
    raw.screenId !== "CMP-TEMP-LOG" ||
    raw.queryName !== "compliance_temperature_log_v1" ||
    raw.queryVersion !== 1
  )
    fail();
  const p = object(raw.permissions, [
    "mayRecordManual",
    "mayAcknowledgeExcursion",
    "mayOpenIncident",
    "mayCreateCorrectiveAction",
  ]);
  const f = object(raw.filters, [
    "targetReference",
    "deviceReference",
    "thresholdResult",
    "method",
    "dateFrom",
    "dateTo",
    "unverifiedOnly",
  ]);
  const dateFrom = nullable(f.dateFrom, instant);
  const dateTo = nullable(f.dateTo, instant);
  if (dateFrom && dateTo && Date.parse(dateTo) < Date.parse(dateFrom)) fail();
  return Object.freeze({
    screenId: "CMP-TEMP-LOG",
    queryName: "compliance_temperature_log_v1",
    queryVersion: 1,
    ...common(raw),
    permissions: Object.freeze({
      mayRecordManual: bool(p.mayRecordManual),
      mayAcknowledgeExcursion: bool(p.mayAcknowledgeExcursion),
      mayOpenIncident: bool(p.mayOpenIncident),
      mayCreateCorrectiveAction: bool(p.mayCreateCorrectiveAction),
    }),
    filters: Object.freeze({
      targetReference: nullable(f.targetReference, reference),
      deviceReference: nullable(f.deviceReference, reference),
      thresholdResult: nullable(f.thresholdResult, (x) => oneOf(x, thresholds)),
      method: nullable(f.method, (x) => oneOf(x, methods)),
      dateFrom,
      dateTo,
      unverifiedOnly: bool(f.unverifiedOnly),
    }),
    readings: list(raw.readings, reading),
  });
}
function cleaning(value: unknown) {
  const raw = object(value, [
    "cleaningReference",
    "scheduleReference",
    "taskReference",
    "targetReference",
    "targetCode",
    "procedureVersionReference",
    "assigneeReference",
    "dueAt",
    "dueTimezone",
    "severity",
    "status",
    "performedByReference",
    "startedAt",
    "completedAt",
    "methodCode",
    "chemicalResult",
    "evidenceReferenceCount",
    "verificationResult",
    "verifierReference",
    "safetyReviewReference",
    "missed",
  ]);
  const status = oneOf(raw.status, cleaningStatuses);
  const verificationResult = oneOf(raw.verificationResult, [
    "Pending",
    "Passed",
    "Failed",
    "UnableToVerify",
  ] as const);
  const verifierReference = nullable(raw.verifierReference, reference);
  const chemicalResult = oneOf(raw.chemicalResult, [
    "NotRequired",
    "WithinRequirement",
    "OutsideRequirement",
    "Unverified",
  ] as const);
  const safetyReviewReference = nullable(raw.safetyReviewReference, reference);
  if (
    (status === "Verified") !== (verificationResult === "Passed") ||
    (status === "VerificationFailed") !== (verificationResult === "Failed") ||
    (verificationResult === "Pending") !== (verifierReference === null) ||
    (chemicalResult === "OutsideRequirement" && safetyReviewReference === null) ||
    bool(raw.missed) !== (status === "Missed")
  )
    fail();
  return Object.freeze({
    cleaningReference: reference(raw.cleaningReference),
    scheduleReference: reference(raw.scheduleReference),
    taskReference: reference(raw.taskReference),
    targetReference: reference(raw.targetReference),
    targetCode: coded(raw.targetCode),
    procedureVersionReference: reference(raw.procedureVersionReference),
    assigneeReference: reference(raw.assigneeReference),
    dueAt: instant(raw.dueAt),
    dueTimezone: timezone(raw.dueTimezone),
    severity: oneOf(raw.severity, severities),
    status,
    performedByReference: nullable(raw.performedByReference, reference),
    startedAt: nullable(raw.startedAt, instant),
    completedAt: nullable(raw.completedAt, instant),
    methodCode: coded(raw.methodCode),
    chemicalResult,
    evidenceReferenceCount: decimalCount(raw.evidenceReferenceCount),
    verificationResult,
    verifierReference,
    safetyReviewReference,
    missed: bool(raw.missed),
  });
}
export function parseCleaningLogView(value: unknown): CleaningLogView {
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
    "records",
  ]);
  if (
    raw.screenId !== "CMP-CLEANING" ||
    raw.queryName !== "compliance_cleaning_log_v1" ||
    raw.queryVersion !== 1
  )
    fail();
  const p = object(raw.permissions, [
    "mayComplete",
    "mayReportCannotComplete",
    "mayVerify",
    "mayEscalateMissed",
  ]);
  const f = object(raw.filters, [
    "targetReference",
    "status",
    "assigneeReference",
    "dueDisposition",
    "missedOnly",
  ]);
  return Object.freeze({
    screenId: "CMP-CLEANING",
    queryName: "compliance_cleaning_log_v1",
    queryVersion: 1,
    ...common(raw),
    permissions: Object.freeze({
      mayComplete: bool(p.mayComplete),
      mayReportCannotComplete: bool(p.mayReportCannotComplete),
      mayVerify: bool(p.mayVerify),
      mayEscalateMissed: bool(p.mayEscalateMissed),
    }),
    filters: Object.freeze({
      targetReference: nullable(f.targetReference, reference),
      status: nullable(f.status, (x) => oneOf(x, cleaningStatuses)),
      assigneeReference: nullable(f.assigneeReference, reference),
      dueDisposition: nullable(f.dueDisposition, (x) =>
        oneOf(x, ["Due", "Overdue", "NotDue"] as const),
      ),
      missedOnly: bool(f.missedOnly),
    }),
    records: list(raw.records, cleaning),
  });
}
export const unavailableComplianceMonitoringClient: ComplianceMonitoringClient = Object.freeze({
  async load() {
    throw new ComplianceMonitoringPageError("Unavailable");
  },
});
