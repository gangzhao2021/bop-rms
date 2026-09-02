export type ComplianceReference = string & { readonly __complianceReference: unique symbol };
export type ComplianceCode = string & { readonly __complianceCode: unique symbol };

export const complianceSignalKinds = [
  "OpenCase",
  "ExpiringLicense",
  "OverdueCorrectiveAction",
  "UnverifiedFinding",
  "TemperatureExcursion",
  "MissingCleaningRecord",
  "EmployeeQualificationExpiry",
  "RecallScope",
  "AllergenPublicationBlock",
] as const;
export type ComplianceSignalKind = (typeof complianceSignalKinds)[number];

export const findingSeverities = [
  "Observation",
  "Minor",
  "Major",
  "Critical",
  "ImmediateDanger",
] as const;
export type FindingSeverity = (typeof findingSeverities)[number];
export type DueDisposition = "NotDue" | "Due" | "Overdue" | "NoDueDate";

export interface ComplianceScope {
  readonly tenantReference: ComplianceReference;
  readonly brandReference: ComplianceReference;
  readonly storeReference: ComplianceReference | null;
}

export interface ComplianceDashboardSignalSnapshot {
  readonly signalReference: ComplianceReference;
  readonly owningReference: ComplianceReference;
  readonly owningKind: "ComplianceCase" | "ComplianceRecord";
  readonly scope: ComplianceScope;
  readonly kind: ComplianceSignalKind;
  readonly caseTypeCode: ComplianceCode;
  readonly severity: FindingSeverity;
  readonly dueAt: string | null;
  readonly occurredAt: string;
  readonly evidenceRequiredCount: string;
  readonly evidencePresentCount: string;
}

export interface ComplianceDashboardSourceSnapshot {
  readonly scope: ComplianceScope;
  readonly projectionVersionReference: ComplianceReference;
  readonly sourceAsOf: string;
  readonly completeness: "Complete" | "Partial";
  readonly signals: readonly ComplianceDashboardSignalSnapshot[];
}

export interface ComplianceDashboardFilter {
  readonly caseTypeCode: ComplianceCode | null;
  readonly severity: FindingSeverity | null;
  readonly dueDisposition: DueDisposition | null;
}

export interface ComplianceDashboardSignalView extends ComplianceDashboardSignalSnapshot {
  readonly dueDisposition: DueDisposition;
  readonly evidenceComplete: boolean;
}

export interface ComplianceDashboardView {
  readonly screenId: "CMP-DASHBOARD";
  readonly queryName: "compliance_dashboard_v1";
  readonly queryVersion: 1;
  readonly scope: ComplianceScope;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly projectionVersionReference: ComplianceReference;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly filter: ComplianceDashboardFilter;
  readonly signals: readonly ComplianceDashboardSignalView[];
}

export type ComplianceContractErrorCode = "COMPLIANCE_INPUT_INVALID" | "COMPLIANCE_SCOPE_INVALID";
export class ComplianceContractError extends Error {
  constructor(readonly code: ComplianceContractErrorCode) {
    super("Compliance dashboard input is invalid");
    this.name = "ComplianceContractError";
  }
}

const fail = (code: ComplianceContractErrorCode = "COMPLIANCE_INPUT_INVALID"): never => {
  throw new ComplianceContractError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const count = /^(?:0|[1-9][0-9]{0,29})$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
export function parseComplianceReference(value: unknown): ComplianceReference {
  return typeof value === "string" && uuid.test(value) ? (value as ComplianceReference) : fail();
}
export function parseComplianceCode(value: unknown): ComplianceCode {
  return typeof value === "string" && code.test(value) ? (value as ComplianceCode) : fail();
}
export function parseComplianceInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    return fail();
  return value;
}
function parseCount(value: unknown): string {
  return typeof value === "string" && count.test(value) ? value : fail();
}
export function parseComplianceScope(value: unknown): ComplianceScope {
  const raw = exact(value, ["tenantReference", "brandReference", "storeReference"]);
  return Object.freeze({
    tenantReference: parseComplianceReference(raw.tenantReference),
    brandReference: parseComplianceReference(raw.brandReference),
    storeReference:
      raw.storeReference === null ? null : parseComplianceReference(raw.storeReference),
  });
}
export function parseComplianceDashboardFilter(value: unknown): ComplianceDashboardFilter {
  const raw = exact(value, ["caseTypeCode", "severity", "dueDisposition"]);
  return Object.freeze({
    caseTypeCode: raw.caseTypeCode === null ? null : parseComplianceCode(raw.caseTypeCode),
    severity: raw.severity === null ? null : oneOf(raw.severity, findingSeverities),
    dueDisposition:
      raw.dueDisposition === null
        ? null
        : oneOf(raw.dueDisposition, ["NotDue", "Due", "Overdue", "NoDueDate"] as const),
  });
}
export function createComplianceDashboardSignalSnapshot(
  value: unknown,
): ComplianceDashboardSignalSnapshot {
  const raw = exact(value, [
    "signalReference",
    "owningReference",
    "owningKind",
    "scope",
    "kind",
    "caseTypeCode",
    "severity",
    "dueAt",
    "occurredAt",
    "evidenceRequiredCount",
    "evidencePresentCount",
  ]);
  const required = parseCount(raw.evidenceRequiredCount);
  const present = parseCount(raw.evidencePresentCount);
  if (BigInt(present) > BigInt(required)) return fail();
  return Object.freeze({
    signalReference: parseComplianceReference(raw.signalReference),
    owningReference: parseComplianceReference(raw.owningReference),
    owningKind: oneOf(raw.owningKind, ["ComplianceCase", "ComplianceRecord"] as const),
    scope: parseComplianceScope(raw.scope),
    kind: oneOf(raw.kind, complianceSignalKinds),
    caseTypeCode: parseComplianceCode(raw.caseTypeCode),
    severity: oneOf(raw.severity, findingSeverities),
    dueAt: raw.dueAt === null ? null : parseComplianceInstant(raw.dueAt),
    occurredAt: parseComplianceInstant(raw.occurredAt),
    evidenceRequiredCount: required,
    evidencePresentCount: present,
  });
}
export function createComplianceDashboardSourceSnapshot(
  value: unknown,
): ComplianceDashboardSourceSnapshot {
  const raw = exact(value, [
    "scope",
    "projectionVersionReference",
    "sourceAsOf",
    "completeness",
    "signals",
  ]);
  if (!Array.isArray(raw.signals) || raw.signals.length > 500) return fail();
  const scope = parseComplianceScope(raw.scope);
  const signals = Object.freeze(raw.signals.map(createComplianceDashboardSignalSnapshot));
  if (
    new Set(signals.map((item) => item.signalReference)).size !== signals.length ||
    signals.some(
      (item) =>
        item.scope.tenantReference !== scope.tenantReference ||
        item.scope.brandReference !== scope.brandReference ||
        item.scope.storeReference !== scope.storeReference,
    )
  )
    return fail("COMPLIANCE_SCOPE_INVALID");
  const sourceAsOf = parseComplianceInstant(raw.sourceAsOf);
  if (signals.some((item) => Date.parse(item.occurredAt) > Date.parse(sourceAsOf))) return fail();
  return Object.freeze({
    scope,
    projectionVersionReference: parseComplianceReference(raw.projectionVersionReference),
    sourceAsOf,
    completeness: oneOf(raw.completeness, ["Complete", "Partial"] as const),
    signals,
  });
}
