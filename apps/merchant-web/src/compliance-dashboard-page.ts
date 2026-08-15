export type ComplianceDashboardErrorCode = "PermissionDenied" | "Stale" | "Offline" | "Unavailable";
export class ComplianceDashboardPageError extends Error {
  constructor(readonly code: ComplianceDashboardErrorCode) {
    super("Compliance dashboard unavailable");
    this.name = "ComplianceDashboardPageError";
  }
}
export type ComplianceSeverity = "Observation" | "Minor" | "Major" | "Critical" | "ImmediateDanger";
export type ComplianceDueDisposition = "NotDue" | "Due" | "Overdue" | "NoDueDate";
export interface ComplianceDashboardSignal {
  readonly signalReference: string;
  readonly owningReference: string;
  readonly owningKind: "ComplianceCase" | "ComplianceRecord";
  readonly scope: ComplianceScope;
  readonly kind:
    | "OpenCase"
    | "ExpiringLicense"
    | "OverdueCorrectiveAction"
    | "UnverifiedFinding"
    | "TemperatureExcursion"
    | "MissingCleaningRecord"
    | "EmployeeQualificationExpiry"
    | "RecallScope"
    | "AllergenPublicationBlock";
  readonly caseTypeCode: string;
  readonly severity: ComplianceSeverity;
  readonly dueAt: string | null;
  readonly occurredAt: string;
  readonly evidenceRequiredCount: string;
  readonly evidencePresentCount: string;
  readonly dueDisposition: ComplianceDueDisposition;
  readonly evidenceComplete: boolean;
}
export interface ComplianceScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string | null;
}
export interface ComplianceDashboardView {
  readonly screenId: "CMP-DASHBOARD";
  readonly queryName: "compliance_dashboard_v1";
  readonly queryVersion: 1;
  readonly scope: ComplianceScope;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly projectionVersionReference: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly filter: {
    readonly caseTypeCode: string | null;
    readonly severity: ComplianceSeverity | null;
    readonly dueDisposition: ComplianceDueDisposition | null;
  };
  readonly signals: readonly ComplianceDashboardSignal[];
}
export interface ComplianceDashboardClient {
  load(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const count = /^(?:0|[1-9][0-9]{0,29})$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new ComplianceDashboardPageError("Unavailable");
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
const severities = ["Observation", "Minor", "Major", "Critical", "ImmediateDanger"] as const;
const dueStates = ["NotDue", "Due", "Overdue", "NoDueDate"] as const;
const kinds = [
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
function parseScope(value: unknown): ComplianceScope {
  const raw = object(value, ["tenantReference", "brandReference", "storeReference"]);
  return Object.freeze({
    tenantReference: reference(raw.tenantReference),
    brandReference: reference(raw.brandReference),
    storeReference: nullable(raw.storeReference, reference),
  });
}
export function parseComplianceDashboardView(value: unknown): ComplianceDashboardView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "scope",
    "generatedAt",
    "sourceAsOf",
    "projectionVersionReference",
    "freshness",
    "completeness",
    "filter",
    "signals",
  ]);
  if (
    raw.screenId !== "CMP-DASHBOARD" ||
    raw.queryName !== "compliance_dashboard_v1" ||
    raw.queryVersion !== 1 ||
    !Array.isArray(raw.signals) ||
    raw.signals.length > 500
  )
    fail();
  const scope = parseScope(raw.scope);
  const generatedAt = instant(raw.generatedAt);
  const sourceAsOf = instant(raw.sourceAsOf);
  if (Date.parse(sourceAsOf) > Date.parse(generatedAt)) fail();
  const filter = object(raw.filter, ["caseTypeCode", "severity", "dueDisposition"]);
  const signals = Object.freeze(
    (raw.signals as unknown[]).map((value) => {
      const item = object(value, [
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
        "dueDisposition",
        "evidenceComplete",
      ]);
      const itemScope = parseScope(item.scope);
      const required =
        typeof item.evidenceRequiredCount === "string" && count.test(item.evidenceRequiredCount)
          ? item.evidenceRequiredCount
          : fail();
      const present =
        typeof item.evidencePresentCount === "string" && count.test(item.evidencePresentCount)
          ? item.evidencePresentCount
          : fail();
      if (
        BigInt(present) > BigInt(required) ||
        itemScope.tenantReference !== scope.tenantReference ||
        itemScope.brandReference !== scope.brandReference ||
        itemScope.storeReference !== scope.storeReference
      )
        fail();
      return Object.freeze({
        signalReference: reference(item.signalReference),
        owningReference: reference(item.owningReference),
        owningKind: oneOf(item.owningKind, ["ComplianceCase", "ComplianceRecord"] as const),
        scope: itemScope,
        kind: oneOf(item.kind, kinds),
        caseTypeCode: coded(item.caseTypeCode),
        severity: oneOf(item.severity, severities),
        dueAt: nullable(item.dueAt, instant),
        occurredAt: instant(item.occurredAt),
        evidenceRequiredCount: required,
        evidencePresentCount: present,
        dueDisposition: oneOf(item.dueDisposition, dueStates),
        evidenceComplete: bool(item.evidenceComplete),
      });
    }),
  );
  if (
    new Set(signals.map((item) => item.signalReference)).size !== signals.length ||
    signals.some((item) => {
      const expectedDue =
        item.dueAt === null
          ? "NoDueDate"
          : Date.parse(item.dueAt) < Date.parse(generatedAt)
            ? "Overdue"
            : Date.parse(item.dueAt) === Date.parse(generatedAt)
              ? "Due"
              : "NotDue";
      return (
        item.dueDisposition !== expectedDue ||
        item.evidenceComplete !==
          (BigInt(item.evidencePresentCount) === BigInt(item.evidenceRequiredCount))
      );
    })
  )
    fail();
  return Object.freeze({
    screenId: "CMP-DASHBOARD",
    queryName: "compliance_dashboard_v1",
    queryVersion: 1,
    scope,
    generatedAt,
    sourceAsOf,
    projectionVersionReference: reference(raw.projectionVersionReference),
    freshness: oneOf(raw.freshness, ["Current", "Stale"] as const),
    completeness: oneOf(raw.completeness, ["Complete", "Partial"] as const),
    filter: Object.freeze({
      caseTypeCode: nullable(filter.caseTypeCode, coded),
      severity: nullable(filter.severity, (item) => oneOf(item, severities)),
      dueDisposition: nullable(filter.dueDisposition, (item) => oneOf(item, dueStates)),
    }),
    signals,
  });
}
export const unavailableComplianceDashboardClient: ComplianceDashboardClient = Object.freeze({
  async load() {
    throw new ComplianceDashboardPageError("Unavailable");
  },
});
