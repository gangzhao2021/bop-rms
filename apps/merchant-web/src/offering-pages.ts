export type OfferingClientErrorCode =
  | "Empty"
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "ValidationFailed"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class OfferingClientError extends Error {
  constructor(readonly code: OfferingClientErrorCode) {
    super("Offering view is unavailable");
    this.name = "OfferingClientError";
  }
}
export interface OfferingView {
  readonly screenId: "SUP-OFFERING-LIST" | "SUP-OFFERING-EDITOR";
  readonly projectionName: "procurement_offering_v1";
  readonly projectionVersion: 1;
  readonly brandReference: string;
  readonly brandLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly manage: boolean;
    readonly approve: boolean;
    readonly publish: boolean;
    readonly cost: boolean;
    readonly qualification: boolean;
    readonly history: boolean;
  };
  readonly rows: readonly {
    readonly offeringReference: string;
    readonly aggregateVersion: number;
    readonly supplierReference: string;
    readonly supplierName: string;
    readonly inventoryItemReference: string;
    readonly inventoryItemName: string;
    readonly supplierItemCode: string;
    readonly purchaseUnit: string;
    readonly packSummary: string;
    readonly leadTimeDays: number;
    readonly minimumOrderQuantity: string;
    readonly orderMultiple: string;
    readonly unitCost: string | null;
    readonly currency: string | null;
    readonly effectiveUntil: string | null;
    readonly qualificationStatus: "Current" | "Expiring" | "Blocked";
    readonly lifecycle: "Draft" | "Submitted" | "Approved" | "Published" | "Suspended" | "Archived";
  }[];
  readonly detail: null | {
    readonly offeringReference: string;
    readonly configVersions: readonly {
      readonly versionReference: string;
      readonly version: number;
      readonly purchaseUnit: string;
      readonly packQuantity: string;
      readonly baseUnit: string;
      readonly baseQuantity: string;
      readonly minimumOrderQuantity: string;
      readonly orderMultiple: string;
      readonly leadTimeDays: number;
    }[];
    readonly priceRecords: readonly {
      readonly priceRecordReference: string;
      readonly priceVersionReference: string;
      readonly currency: string | null;
      readonly unitCost: string | null;
      readonly priceUnit: string;
      readonly source: string;
      readonly scope: string;
      readonly effectiveFrom: string;
      readonly effectiveUntil: string | null;
    }[];
    readonly qualificationReferences: readonly string[] | null;
    readonly historyReferences: readonly string[] | null;
    readonly validationIssues: readonly {
      readonly code: string;
      readonly severity: "Blocking" | "Warning";
      readonly message: string;
    }[];
  };
  readonly nextCursor: string | null;
}
export interface OfferingProjectionClient {
  load(input: { offeringReference: string | null }): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const codePattern = /^[A-Z0-9][A-Z0-9._-]{0,63}$/u;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,200}$/u;
function object(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new OfferingClientError("Unavailable");
  return value as Record<string, unknown>;
}
const ref = (value: unknown) =>
  typeof value === "string" && uuid.test(value)
    ? value
    : (() => {
        throw new OfferingClientError("Unavailable");
      })();
const text = (value: unknown) =>
  typeof value === "string" && value.trim() === value && safe.test(value)
    ? value
    : (() => {
        throw new OfferingClientError("Unavailable");
      })();
const code = (value: unknown, pattern = codePattern) =>
  typeof value === "string" && pattern.test(value)
    ? value
    : (() => {
        throw new OfferingClientError("Unavailable");
      })();
const decimal = (value: unknown) =>
  typeof value === "string" && decimalPattern.test(value) && !/^0(?:\.0+)?$/u.test(value)
    ? value
    : (() => {
        throw new OfferingClientError("Unavailable");
      })();
const integer = (value: unknown, min = 0) =>
  Number.isSafeInteger(value) && (value as number) >= min
    ? (value as number)
    : (() => {
        throw new OfferingClientError("Unavailable");
      })();
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : (() => {
        throw new OfferingClientError("Unavailable");
      })();
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new OfferingClientError("Unavailable");
  return value as T;
}
export function parseOfferingView(value: unknown): OfferingView {
  const raw = object(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "brandReference",
    "brandLabel",
    "asOfUtc",
    "freshness",
    "partial",
    "permissions",
    "rows",
    "detail",
    "nextCursor",
  ]);
  if (
    raw.projectionName !== "procurement_offering_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 200 ||
    (raw.nextCursor !== null &&
      (typeof raw.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(raw.nextCursor)))
  )
    throw new OfferingClientError("Unavailable");
  const screenId = oneOf(raw.screenId, ["SUP-OFFERING-LIST", "SUP-OFFERING-EDITOR"]);
  const access = object(raw.permissions, [
    "manage",
    "approve",
    "publish",
    "cost",
    "qualification",
    "history",
  ]);
  if (Object.values(access).some((entry) => typeof entry !== "boolean"))
    throw new OfferingClientError("Unavailable");
  const permissions = access as unknown as OfferingView["permissions"];
  const rows = Object.freeze(
    raw.rows.map((entry) => {
      const row = object(entry, [
        "offeringReference",
        "aggregateVersion",
        "supplierReference",
        "supplierName",
        "inventoryItemReference",
        "inventoryItemName",
        "supplierItemCode",
        "purchaseUnit",
        "packSummary",
        "leadTimeDays",
        "minimumOrderQuantity",
        "orderMultiple",
        "unitCost",
        "currency",
        "effectiveUntil",
        "qualificationStatus",
        "lifecycle",
      ]);
      if (!permissions.cost && (row.unitCost !== null || row.currency !== null))
        throw new OfferingClientError("Unavailable");
      return Object.freeze({
        offeringReference: ref(row.offeringReference),
        aggregateVersion: integer(row.aggregateVersion, 1),
        supplierReference: ref(row.supplierReference),
        supplierName: text(row.supplierName),
        inventoryItemReference: ref(row.inventoryItemReference),
        inventoryItemName: text(row.inventoryItemName),
        supplierItemCode: code(row.supplierItemCode),
        purchaseUnit: code(row.purchaseUnit),
        packSummary: text(row.packSummary),
        leadTimeDays: integer(row.leadTimeDays),
        minimumOrderQuantity: decimal(row.minimumOrderQuantity),
        orderMultiple: decimal(row.orderMultiple),
        unitCost: row.unitCost === null ? null : decimal(row.unitCost),
        currency: row.currency === null ? null : code(row.currency, /^[A-Z]{3}$/u),
        effectiveUntil: row.effectiveUntil === null ? null : instant(row.effectiveUntil),
        qualificationStatus: oneOf(row.qualificationStatus, ["Current", "Expiring", "Blocked"]),
        lifecycle: oneOf(row.lifecycle, [
          "Draft",
          "Submitted",
          "Approved",
          "Published",
          "Suspended",
          "Archived",
        ]),
      });
    }),
  );
  let detail: OfferingView["detail"] = null;
  if (raw.detail !== null) {
    const source = object(raw.detail, [
      "offeringReference",
      "configVersions",
      "priceRecords",
      "qualificationReferences",
      "historyReferences",
      "validationIssues",
    ]);
    if (
      screenId !== "SUP-OFFERING-EDITOR" ||
      !Array.isArray(source.configVersions) ||
      !Array.isArray(source.priceRecords) ||
      !Array.isArray(source.validationIssues) ||
      (source.qualificationReferences !== null && !Array.isArray(source.qualificationReferences)) ||
      (source.historyReferences !== null && !Array.isArray(source.historyReferences)) ||
      source.configVersions.length > 100 ||
      source.priceRecords.length > 200 ||
      (!permissions.qualification && source.qualificationReferences !== null) ||
      (!permissions.history && source.historyReferences !== null)
    )
      throw new OfferingClientError("Unavailable");
    if (
      !permissions.cost &&
      source.priceRecords.some((entry) => {
        const item = object(entry, [
          "priceRecordReference",
          "priceVersionReference",
          "currency",
          "unitCost",
          "priceUnit",
          "source",
          "scope",
          "effectiveFrom",
          "effectiveUntil",
        ]);
        return item.currency !== null || item.unitCost !== null;
      })
    )
      throw new OfferingClientError("Unavailable");
    const configVersions = source.configVersions.map((entry) => {
      const item = object(entry, [
        "versionReference",
        "version",
        "purchaseUnit",
        "packQuantity",
        "baseUnit",
        "baseQuantity",
        "minimumOrderQuantity",
        "orderMultiple",
        "leadTimeDays",
      ]);
      return Object.freeze({
        versionReference: ref(item.versionReference),
        version: integer(item.version, 1),
        purchaseUnit: code(item.purchaseUnit),
        packQuantity: decimal(item.packQuantity),
        baseUnit: code(item.baseUnit),
        baseQuantity: decimal(item.baseQuantity),
        minimumOrderQuantity: decimal(item.minimumOrderQuantity),
        orderMultiple: decimal(item.orderMultiple),
        leadTimeDays: integer(item.leadTimeDays),
      });
    });
    const priceRecords = source.priceRecords.map((entry) => {
      const item = object(entry, [
        "priceRecordReference",
        "priceVersionReference",
        "currency",
        "unitCost",
        "priceUnit",
        "source",
        "scope",
        "effectiveFrom",
        "effectiveUntil",
      ]);
      return Object.freeze({
        priceRecordReference: ref(item.priceRecordReference),
        priceVersionReference: ref(item.priceVersionReference),
        currency: item.currency === null ? null : code(item.currency, /^[A-Z]{3}$/u),
        unitCost: item.unitCost === null ? null : decimal(item.unitCost),
        priceUnit: code(item.priceUnit),
        source: text(item.source),
        scope: text(item.scope),
        effectiveFrom: instant(item.effectiveFrom),
        effectiveUntil: item.effectiveUntil === null ? null : instant(item.effectiveUntil),
      });
    });
    const validationIssues = source.validationIssues.map((entry) => {
      const item = object(entry, ["code", "severity", "message"]);
      return Object.freeze({
        code: code(item.code),
        severity: oneOf(item.severity, ["Blocking", "Warning"]),
        message: text(item.message),
      });
    });
    detail = Object.freeze({
      offeringReference: ref(source.offeringReference),
      configVersions: Object.freeze(configVersions),
      priceRecords: Object.freeze(priceRecords),
      qualificationReferences:
        source.qualificationReferences === null
          ? null
          : Object.freeze((source.qualificationReferences as unknown[]).map(ref)),
      historyReferences:
        source.historyReferences === null
          ? null
          : Object.freeze((source.historyReferences as unknown[]).map(ref)),
      validationIssues: Object.freeze(validationIssues),
    });
    if (detail.offeringReference !== rows[0]?.offeringReference)
      throw new OfferingClientError("Unavailable");
  }
  return Object.freeze({
    screenId,
    projectionName: "procurement_offering_v1",
    projectionVersion: 1,
    brandReference: ref(raw.brandReference),
    brandLabel: text(raw.brandLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial,
    permissions,
    rows,
    detail,
    nextCursor: raw.nextCursor as string | null,
  });
}
export const unavailableOfferingClient: OfferingProjectionClient = Object.freeze({
  async load() {
    throw new OfferingClientError("Unavailable");
  },
});
