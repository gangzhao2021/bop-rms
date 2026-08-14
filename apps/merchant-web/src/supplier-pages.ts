export type SupplierClientErrorCode =
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
export class SupplierClientError extends Error {
  constructor(readonly code: SupplierClientErrorCode) {
    super("Supplier view is unavailable");
    this.name = "SupplierClientError";
  }
}
export interface SupplierListRow {
  readonly supplierReference: string;
  readonly supplierVersion: number;
  readonly supplierCode: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly supplierType: string;
  readonly status: "Draft" | "Active" | "Suspended" | "Inactive" | "Archived";
  readonly qualificationStatus: "Current" | "Expiring" | "Expired" | "Missing";
  readonly nextQualificationExpiry: string | null;
  readonly offeringCount: number | null;
  readonly openPurchaseOrderCount: number | null;
  readonly performanceSummary: string | null;
  readonly performanceFlag: boolean | null;
}
export interface SupplierView {
  readonly screenId: "SUP-SUPPLIER-LIST" | "SUP-SUPPLIER-DETAIL";
  readonly projectionName: "procurement_supplier_v1";
  readonly projectionVersion: 1;
  readonly brandReference: string;
  readonly brandLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly contactFields: boolean;
    readonly qualificationEvidence: boolean;
    readonly purchaseOrderReferences: boolean;
    readonly performance: boolean;
    readonly manageSupplier: boolean;
    readonly reviewQualification: boolean;
  };
  readonly rows: readonly SupplierListRow[];
  readonly detail: null | {
    readonly supplierReference: string;
    readonly taxRegistrationReference: string | null;
    readonly contacts: readonly {
      readonly contactReference: string;
      readonly roleCode: string;
      readonly displayName: string | null;
      readonly email: string | null;
      readonly phone: string | null;
    }[];
    readonly addresses: readonly {
      readonly addressReference: string;
      readonly addressType: "Registered" | "Ordering" | "Remittance" | "Shipping";
      readonly addressSummary: string | null;
      readonly countryCode: string;
      readonly regionCode: string;
    }[];
    readonly qualifications: readonly {
      readonly qualificationReference: string;
      readonly qualificationType: string;
      readonly jurisdiction: string;
      readonly certificateNumber: string | null;
      readonly issuer: string | null;
      readonly effectiveFrom: string;
      readonly effectiveUntil: string | null;
      readonly documentReference: string | null;
      readonly status: "Pending" | "Rejected" | "Scheduled" | "Effective" | "Expired";
    }[];
    readonly offeringCount: number | null;
    readonly openPurchaseOrderCount: number | null;
    readonly performanceSummary: string | null;
    readonly historyCount: number;
    readonly auditAvailable: boolean;
  };
  readonly nextCursor: string | null;
}
export interface SupplierProjectionClient {
  load(input: { supplierReference: string | null }): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const supplierCodePattern = /^[A-Z0-9][A-Z0-9_-]{1,31}$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,160}$/u;
const cursor = /^[A-Za-z0-9_-]{1,200}$/u;
const emailMasked = /^[^@\s]{1,64}@[A-Za-z0-9.-]{1,190}$/u;
const phoneMasked = /^\+[0-9* -]{7,20}$/u;
function object(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new SupplierClientError("Unavailable");
  return value as Record<string, unknown>;
}
function ref(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new SupplierClientError("Unavailable");
  return value;
}
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !safe.test(value))
    throw new SupplierClientError("Unavailable");
  return value;
}
const nullableText = (value: unknown) => (value === null ? null : text(value));
function code(value: unknown, pattern = codePattern): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new SupplierClientError("Unavailable");
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new SupplierClientError("Unavailable");
  return value as T;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new SupplierClientError("Unavailable");
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new SupplierClientError("Unavailable");
  return value as number;
}
const nullableInteger = (value: unknown) => (value === null ? null : integer(value));
function row(value: unknown, performance: boolean): SupplierListRow {
  const raw = object(value, [
    "supplierReference",
    "supplierVersion",
    "supplierCode",
    "legalName",
    "displayName",
    "supplierType",
    "status",
    "qualificationStatus",
    "nextQualificationExpiry",
    "offeringCount",
    "openPurchaseOrderCount",
    "performanceSummary",
    "performanceFlag",
  ]);
  const summary = nullableText(raw.performanceSummary);
  if (
    (!performance && (summary !== null || raw.performanceFlag !== null)) ||
    (summary === null) !== (raw.performanceFlag === null) ||
    (raw.performanceFlag !== null && typeof raw.performanceFlag !== "boolean")
  )
    throw new SupplierClientError("Unavailable");
  return Object.freeze({
    supplierReference: ref(raw.supplierReference),
    supplierVersion: integer(raw.supplierVersion, 1),
    supplierCode: code(raw.supplierCode, supplierCodePattern),
    legalName: text(raw.legalName),
    displayName: text(raw.displayName),
    supplierType: code(raw.supplierType),
    status: oneOf(raw.status, ["Draft", "Active", "Suspended", "Inactive", "Archived"]),
    qualificationStatus: oneOf(raw.qualificationStatus, [
      "Current",
      "Expiring",
      "Expired",
      "Missing",
    ]),
    nextQualificationExpiry:
      raw.nextQualificationExpiry === null ? null : instant(raw.nextQualificationExpiry),
    offeringCount: nullableInteger(raw.offeringCount),
    openPurchaseOrderCount: nullableInteger(raw.openPurchaseOrderCount),
    performanceSummary: summary,
    performanceFlag: raw.performanceFlag as boolean | null,
  });
}
export function parseSupplierView(value: unknown): SupplierView {
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
    !Array.isArray(raw.rows) ||
    raw.rows.length > 200 ||
    raw.projectionName !== "procurement_supplier_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean" ||
    (raw.nextCursor !== null &&
      (typeof raw.nextCursor !== "string" || !cursor.test(raw.nextCursor)))
  )
    throw new SupplierClientError("Unavailable");
  const screenId = oneOf(raw.screenId, ["SUP-SUPPLIER-LIST", "SUP-SUPPLIER-DETAIL"]);
  const access = object(raw.permissions, [
    "contactFields",
    "qualificationEvidence",
    "purchaseOrderReferences",
    "performance",
    "manageSupplier",
    "reviewQualification",
  ]);
  if (Object.values(access).some((entry) => typeof entry !== "boolean"))
    throw new SupplierClientError("Unavailable");
  const permissions = access as unknown as SupplierView["permissions"];
  const rows = Object.freeze(raw.rows.map((entry) => row(entry, permissions.performance)));
  let detail: SupplierView["detail"] = null;
  if (raw.detail !== null) {
    const source = object(raw.detail, [
      "supplierReference",
      "taxRegistrationReference",
      "contacts",
      "addresses",
      "qualifications",
      "offeringCount",
      "openPurchaseOrderCount",
      "performanceSummary",
      "historyCount",
      "auditAvailable",
    ]);
    if (
      screenId !== "SUP-SUPPLIER-DETAIL" ||
      !Array.isArray(source.contacts) ||
      !Array.isArray(source.addresses) ||
      !Array.isArray(source.qualifications) ||
      typeof source.auditAvailable !== "boolean" ||
      (!permissions.contactFields && source.taxRegistrationReference !== null) ||
      (!permissions.performance && source.performanceSummary !== null)
    )
      throw new SupplierClientError("Unavailable");
    const contacts = source.contacts.map((entry) => {
      const item = object(entry, ["contactReference", "roleCode", "displayName", "email", "phone"]);
      if (
        !permissions.contactFields &&
        (item.displayName !== null || item.email !== null || item.phone !== null)
      )
        throw new SupplierClientError("Unavailable");
      if (item.email !== null && (typeof item.email !== "string" || !emailMasked.test(item.email)))
        throw new SupplierClientError("Unavailable");
      if (item.phone !== null && (typeof item.phone !== "string" || !phoneMasked.test(item.phone)))
        throw new SupplierClientError("Unavailable");
      return Object.freeze({
        contactReference: ref(item.contactReference),
        roleCode: code(item.roleCode),
        displayName: nullableText(item.displayName),
        email: item.email as string | null,
        phone: item.phone as string | null,
      });
    });
    const addresses = source.addresses.map((entry) => {
      const item = object(entry, [
        "addressReference",
        "addressType",
        "addressSummary",
        "countryCode",
        "regionCode",
      ]);
      if (!permissions.contactFields && item.addressSummary !== null)
        throw new SupplierClientError("Unavailable");
      return Object.freeze({
        addressReference: ref(item.addressReference),
        addressType: oneOf(item.addressType, ["Registered", "Ordering", "Remittance", "Shipping"]),
        addressSummary: nullableText(item.addressSummary),
        countryCode: code(item.countryCode, /^[A-Z]{2}$/u),
        regionCode: code(item.regionCode, /^[A-Z0-9][A-Z0-9-]{0,15}$/u),
      });
    });
    const qualifications = source.qualifications.map((entry) => {
      const item = object(entry, [
        "qualificationReference",
        "qualificationType",
        "jurisdiction",
        "certificateNumber",
        "issuer",
        "effectiveFrom",
        "effectiveUntil",
        "documentReference",
        "status",
      ]);
      if (
        !permissions.qualificationEvidence &&
        (item.certificateNumber !== null || item.issuer !== null || item.documentReference !== null)
      )
        throw new SupplierClientError("Unavailable");
      return Object.freeze({
        qualificationReference: ref(item.qualificationReference),
        qualificationType: code(item.qualificationType),
        jurisdiction: code(item.jurisdiction),
        certificateNumber: nullableText(item.certificateNumber),
        issuer: nullableText(item.issuer),
        effectiveFrom: instant(item.effectiveFrom),
        effectiveUntil: item.effectiveUntil === null ? null : instant(item.effectiveUntil),
        documentReference: nullableRef(item.documentReference),
        status: oneOf(item.status, ["Pending", "Rejected", "Scheduled", "Effective", "Expired"]),
      });
    });
    detail = Object.freeze({
      supplierReference: ref(source.supplierReference),
      taxRegistrationReference: nullableRef(source.taxRegistrationReference),
      contacts: Object.freeze(contacts),
      addresses: Object.freeze(addresses),
      qualifications: Object.freeze(qualifications),
      offeringCount: nullableInteger(source.offeringCount),
      openPurchaseOrderCount: permissions.purchaseOrderReferences
        ? nullableInteger(source.openPurchaseOrderCount)
        : source.openPurchaseOrderCount === null
          ? null
          : (() => {
              throw new SupplierClientError("Unavailable");
            })(),
      performanceSummary: nullableText(source.performanceSummary),
      historyCount: integer(source.historyCount),
      auditAvailable: source.auditAvailable,
    });
  }
  if (
    (screenId === "SUP-SUPPLIER-DETAIL") !== (detail !== null) ||
    (detail && !rows.some((entry) => entry.supplierReference === detail?.supplierReference))
  )
    throw new SupplierClientError("Unavailable");
  return Object.freeze({
    screenId,
    projectionName: "procurement_supplier_v1",
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
export const unavailableSupplierClient: SupplierProjectionClient = Object.freeze({
  async load() {
    throw new SupplierClientError("Unavailable");
  },
});
