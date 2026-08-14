export type DataQualityPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class DataQualityPageError extends Error {
  constructor(readonly code: DataQualityPageErrorCode) {
    super("Data Quality unavailable");
    this.name = "DataQualityPageError";
  }
}
export interface DataQualityView {
  readonly screenId: "BI-DATA-QUALITY";
  readonly queryName: "reporting_data_quality_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly permissions: {
    readonly mayAcknowledge: boolean;
    readonly mayAssign: boolean;
    readonly mayRunCheck: boolean;
    readonly mayRequestBackfill: boolean;
    readonly mayOpenIncident: boolean;
  };
  readonly filters: {
    readonly checkReference: string | null;
    readonly datasetVersionReference: string | null;
    readonly status: string | null;
    readonly severity: "Info" | "Warning" | "Error" | "Critical" | null;
    readonly ownerReference: string | null;
    readonly dateFrom: string | null;
  };
  readonly issues: readonly {
    readonly resultReference: string;
    readonly checkReference: string;
    readonly checkKind: string;
    readonly datasetVersionReference: string;
    readonly partitionCode: string;
    readonly severity: "Info" | "Warning" | "Error" | "Critical";
    readonly status:
      "Open" | "Acknowledged" | "Assigned" | "IncidentOpened" | "BackfillRequested" | "Resolved";
    readonly firstFailureAt: string;
    readonly lastFailureAt: string;
    readonly affectedFrom: string;
    readonly affectedUntil: string;
    readonly scopeCode: string;
    readonly ownerReference: string | null;
    readonly reconciliationExceptionReference: string | null;
  }[];
}
export interface ReconciliationView {
  readonly screenId: "BI-RECONCILIATION";
  readonly queryName: "reporting_reconciliation_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly permissions: {
    readonly mayRun: boolean;
    readonly mayDrill: boolean;
    readonly mayCreateException: boolean;
    readonly mayRecordResolution: boolean;
  };
  readonly filters: {
    readonly control: string | null;
    readonly periodFrom: string | null;
    readonly scopeCode: string | null;
    readonly status: string | null;
    readonly differenceOnly: boolean;
  };
  readonly controls: readonly {
    readonly runReference: string;
    readonly exceptionReference: string | null;
    readonly control:
      | "OrderItemTotal"
      | "PaymentLedger"
      | "InventoryLedger"
      | "PurchaseOrderReceipt"
      | "LoyaltyLedger"
      | "OutputAttempt";
    readonly periodFrom: string;
    readonly periodUntil: string;
    readonly differenceValue: string;
    readonly unitCode: string;
    readonly status: "Matched" | "Open" | "Investigating" | "Resolved";
    readonly scopeCode: string;
    readonly ownerReference: string | null;
  }[];
}
export interface DataQualityClient {
  load(): Promise<unknown>;
}
export interface ReconciliationClient {
  load(): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const codePattern = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const decimalPattern = /^-?(?:0|[1-9][0-9]{0,20})(?:\.[0-9]{1,9})?$/u;
const fail = (): never => {
  throw new DataQualityPageError("Unavailable");
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
const reference = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : fail();
const code = (value: unknown) =>
  typeof value === "string" && codePattern.test(value) ? value : fail();
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const nullable = <T>(value: unknown, parse: (item: unknown) => T) =>
  value === null ? null : parse(value);
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const search = (value: unknown) =>
  value === null
    ? null
    : typeof value === "string" && /^[A-Za-z0-9 _.:-]{1,80}$/u.test(value)
      ? value
      : fail();
function list(value: unknown) {
  if (!Array.isArray(value) || value.length > 500) fail();
  return value as unknown[];
}

export function parseDataQualityView(value: unknown): DataQualityView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "permissions",
    "filters",
    "issues",
  ]);
  if (
    raw.screenId !== "BI-DATA-QUALITY" ||
    raw.queryName !== "reporting_data_quality_v1" ||
    raw.queryVersion !== 1
  )
    fail();
  const permissions = object(raw.permissions, [
    "mayAcknowledge",
    "mayAssign",
    "mayRunCheck",
    "mayRequestBackfill",
    "mayOpenIncident",
  ]);
  const filters = object(raw.filters, [
    "checkReference",
    "datasetVersionReference",
    "status",
    "severity",
    "ownerReference",
    "dateFrom",
  ]);
  return Object.freeze({
    screenId: "BI-DATA-QUALITY",
    queryName: "reporting_data_quality_v1",
    queryVersion: 1,
    generatedAt: instant(raw.generatedAt),
    permissions: Object.freeze({
      mayAcknowledge: bool(permissions.mayAcknowledge),
      mayAssign: bool(permissions.mayAssign),
      mayRunCheck: bool(permissions.mayRunCheck),
      mayRequestBackfill: bool(permissions.mayRequestBackfill),
      mayOpenIncident: bool(permissions.mayOpenIncident),
    }),
    filters: Object.freeze({
      checkReference: nullable(filters.checkReference, reference),
      datasetVersionReference: nullable(filters.datasetVersionReference, reference),
      status: search(filters.status),
      severity: nullable(filters.severity, (item) =>
        oneOf(item, ["Info", "Warning", "Error", "Critical"] as const),
      ),
      ownerReference: nullable(filters.ownerReference, reference),
      dateFrom: nullable(filters.dateFrom, instant),
    }),
    issues: Object.freeze(
      list(raw.issues).map((entry) => {
        const item = object(entry, [
          "resultReference",
          "checkReference",
          "checkKind",
          "datasetVersionReference",
          "partitionCode",
          "severity",
          "status",
          "firstFailureAt",
          "lastFailureAt",
          "affectedFrom",
          "affectedUntil",
          "scopeCode",
          "ownerReference",
          "reconciliationExceptionReference",
        ]);
        const firstFailureAt = instant(item.firstFailureAt);
        const lastFailureAt = instant(item.lastFailureAt);
        const affectedFrom = instant(item.affectedFrom);
        const affectedUntil = instant(item.affectedUntil);
        if (
          Date.parse(lastFailureAt) < Date.parse(firstFailureAt) ||
          Date.parse(affectedUntil) <= Date.parse(affectedFrom)
        )
          fail();
        return Object.freeze({
          resultReference: reference(item.resultReference),
          checkReference: reference(item.checkReference),
          checkKind: code(item.checkKind),
          datasetVersionReference: reference(item.datasetVersionReference),
          partitionCode: code(item.partitionCode),
          severity: oneOf(item.severity, ["Info", "Warning", "Error", "Critical"] as const),
          status: oneOf(item.status, [
            "Open",
            "Acknowledged",
            "Assigned",
            "IncidentOpened",
            "BackfillRequested",
            "Resolved",
          ] as const),
          firstFailureAt,
          lastFailureAt,
          affectedFrom,
          affectedUntil,
          scopeCode: code(item.scopeCode),
          ownerReference: nullable(item.ownerReference, reference),
          reconciliationExceptionReference: nullable(
            item.reconciliationExceptionReference,
            reference,
          ),
        });
      }),
    ),
  });
}

export function parseReconciliationView(value: unknown): ReconciliationView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "permissions",
    "filters",
    "controls",
  ]);
  if (
    raw.screenId !== "BI-RECONCILIATION" ||
    raw.queryName !== "reporting_reconciliation_v1" ||
    raw.queryVersion !== 1
  )
    fail();
  const permissions = object(raw.permissions, [
    "mayRun",
    "mayDrill",
    "mayCreateException",
    "mayRecordResolution",
  ]);
  const filters = object(raw.filters, [
    "control",
    "periodFrom",
    "scopeCode",
    "status",
    "differenceOnly",
  ]);
  return Object.freeze({
    screenId: "BI-RECONCILIATION",
    queryName: "reporting_reconciliation_v1",
    queryVersion: 1,
    generatedAt: instant(raw.generatedAt),
    permissions: Object.freeze({
      mayRun: bool(permissions.mayRun),
      mayDrill: bool(permissions.mayDrill),
      mayCreateException: bool(permissions.mayCreateException),
      mayRecordResolution: bool(permissions.mayRecordResolution),
    }),
    filters: Object.freeze({
      control: search(filters.control),
      periodFrom: nullable(filters.periodFrom, instant),
      scopeCode: nullable(filters.scopeCode, code),
      status: search(filters.status),
      differenceOnly: bool(filters.differenceOnly),
    }),
    controls: Object.freeze(
      list(raw.controls).map((entry) => {
        const item = object(entry, [
          "runReference",
          "exceptionReference",
          "control",
          "periodFrom",
          "periodUntil",
          "differenceValue",
          "unitCode",
          "status",
          "scopeCode",
          "ownerReference",
        ]);
        const periodFrom = instant(item.periodFrom);
        const periodUntil = instant(item.periodUntil);
        if (Date.parse(periodUntil) <= Date.parse(periodFrom)) fail();
        const differenceValue =
          typeof item.differenceValue === "string" && decimalPattern.test(item.differenceValue)
            ? item.differenceValue
            : fail();
        const status = oneOf(item.status, [
          "Matched",
          "Open",
          "Investigating",
          "Resolved",
        ] as const);
        const exceptionReference = nullable(item.exceptionReference, reference);
        if (
          (status === "Matched") !== /^-?0(?:\.0+)?$/u.test(differenceValue) ||
          (status === "Matched") !== (exceptionReference === null)
        )
          fail();
        return Object.freeze({
          runReference: reference(item.runReference),
          exceptionReference,
          control: oneOf(item.control, [
            "OrderItemTotal",
            "PaymentLedger",
            "InventoryLedger",
            "PurchaseOrderReceipt",
            "LoyaltyLedger",
            "OutputAttempt",
          ] as const),
          periodFrom,
          periodUntil,
          differenceValue,
          unitCode: code(item.unitCode),
          status,
          scopeCode: code(item.scopeCode),
          ownerReference: nullable(item.ownerReference, reference),
        });
      }),
    ),
  });
}

export const unavailableDataQualityClient: DataQualityClient = Object.freeze({
  load: async () => {
    throw new DataQualityPageError("Unavailable");
  },
});
export const unavailableReconciliationClient: ReconciliationClient = Object.freeze({
  load: async () => {
    throw new DataQualityPageError("Unavailable");
  },
});
