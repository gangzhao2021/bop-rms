export type OperatingEntityPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class OperatingEntityPageError extends Error {
  constructor(readonly code: OperatingEntityPageErrorCode) {
    super("Operating Entity page unavailable");
    this.name = "OperatingEntityPageError";
  }
}
export interface OperatingEntityPageClient {
  load(): Promise<unknown>;
}
type Lifecycle = "Draft" | "PendingExternalEvidence" | "Active" | "Suspended" | "Archived";
type BusinessFunction =
  | "SalesReceiptIssuer"
  | "TaxRegistrant"
  | "PaymentSettlementOwner"
  | "ProcurementBuyer"
  | "LicenseHolder"
  | "Employer";
export interface OperatingEntityAdminView {
  readonly screenId: "ORG-ENTITY-LIST" | "ORG-ENTITY-DETAIL";
  readonly queryName: "operating_entity_admin_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: {
    readonly mayCreate: boolean;
    readonly mayEdit: boolean;
    readonly maySubmit: boolean;
    readonly mayApprove: boolean;
    readonly mayActivate: boolean;
    readonly maySuspend: boolean;
    readonly mayManageAssignment: boolean;
    readonly mayViewRestricted: boolean;
  };
  readonly recentMfa: boolean;
  readonly filters: {
    readonly name: string | null;
    readonly registrationExact: string | null;
    readonly status: Lifecycle | null;
    readonly jurisdictionCode: "CA-ON" | null;
  };
  readonly entities: readonly {
    readonly operatingEntityReference: string;
    readonly legalName: string;
    readonly tradeName: string | null;
    readonly jurisdictionCode: "CA-ON";
    readonly lifecycle: Lifecycle;
    readonly aggregateVersion: number;
    readonly profileVersion: number;
    readonly brandCount: number;
    readonly storeCount: number;
    readonly effectiveFrom: string;
    readonly effectiveUntil: string | null;
    readonly registrationReference: string | null;
    readonly taxRegistrationReference: string | null;
    readonly registeredAddressReference: string | null;
    readonly restrictedFieldsRevealed: boolean;
    readonly approvalStatus: "NotSubmitted" | "Pending" | "Approved" | "Rejected";
    readonly authoritySummaries: readonly {
      readonly roleCode: "Director" | "Officer" | "SigningAuthority";
      readonly titleCode: string;
      readonly status: "Proposed" | "Active" | "Revoked" | "Expired";
      readonly effectiveFrom: string;
      readonly effectiveUntil: string | null;
    }[];
    readonly assignments: readonly {
      readonly assignmentReference: string;
      readonly brandReference: string;
      readonly storeReference: string | null;
      readonly businessFunction: BusinessFunction;
      readonly status: "Active" | "Suspended" | "Archived";
      readonly effectiveFrom: string;
      readonly effectiveUntil: string | null;
    }[];
    readonly evidenceReferences: readonly string[];
    readonly auditSummaryReference: string;
  }[];
}
const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u,
  INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new OperatingEntityPageError("Unavailable");
};
function exact(value: unknown, fields: readonly string[]) {
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
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    return fail();
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(v: unknown, x: readonly T[]) =>
  typeof v === "string" && x.includes(v as T) ? (v as T) : fail();
const ref = (v: unknown) => (typeof v === "string" && REF.test(v) ? v : fail()),
  nullableRef = (v: unknown) => (v === null ? null : ref(v));
const instant = (v: unknown) =>
    typeof v === "string" && INSTANT.test(v) && new Date(Date.parse(v)).toISOString() === v
      ? v
      : fail(),
  nullableInstant = (v: unknown) => (v === null ? null : instant(v));
const text = (v: unknown, max = 200) =>
    typeof v === "string" && v.length > 0 && v.length <= max && v.trim() === v ? v : fail(),
  nullableText = (v: unknown) => (v === null ? null : text(v));
const bool = (v: unknown) => (typeof v === "boolean" ? v : fail()),
  count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail()),
  positive = (v: unknown) => (count(v) > 0 ? (v as number) : fail());
const lifecycles = ["Draft", "PendingExternalEvidence", "Active", "Suspended", "Archived"] as const;
const functions = [
  "SalesReceiptIssuer",
  "TaxRegistrant",
  "PaymentSettlementOwner",
  "ProcurementBuyer",
  "LicenseHolder",
  "Employer",
] as const;
const refs = (v: unknown) => {
  if (!Array.isArray(v) || v.length > 50) return fail();
  const r = v.map(ref);
  return new Set(r).size === r.length ? Object.freeze(r) : fail();
};
function authority(value: unknown) {
  const r = exact(value, ["roleCode", "titleCode", "status", "effectiveFrom", "effectiveUntil"]);
  const from = instant(r.effectiveFrom),
    until = nullableInstant(r.effectiveUntil),
    status = oneOf(r.status, ["Proposed", "Active", "Revoked", "Expired"] as const);
  if (
    (status === "Expired") !== (until !== null) ||
    (until !== null && Date.parse(until) <= Date.parse(from))
  )
    return fail();
  return Object.freeze({
    roleCode: oneOf(r.roleCode, ["Director", "Officer", "SigningAuthority"] as const),
    titleCode: typeof r.titleCode === "string" && CODE.test(r.titleCode) ? r.titleCode : fail(),
    status,
    effectiveFrom: from,
    effectiveUntil: until,
  });
}
function assignment(value: unknown) {
  const r = exact(value, [
    "assignmentReference",
    "brandReference",
    "storeReference",
    "businessFunction",
    "status",
    "effectiveFrom",
    "effectiveUntil",
  ]);
  const from = instant(r.effectiveFrom),
    until = nullableInstant(r.effectiveUntil);
  if (until !== null && Date.parse(until) <= Date.parse(from)) return fail();
  return Object.freeze({
    assignmentReference: ref(r.assignmentReference),
    brandReference: ref(r.brandReference),
    storeReference: nullableRef(r.storeReference),
    businessFunction: oneOf(r.businessFunction, functions),
    status: oneOf(r.status, ["Active", "Suspended", "Archived"] as const),
    effectiveFrom: from,
    effectiveUntil: until,
  });
}
function entity(
  value: unknown,
  mayReveal: boolean,
  recentMfa: boolean,
): OperatingEntityAdminView["entities"][number] {
  const r = exact(value, [
    "operatingEntityReference",
    "legalName",
    "tradeName",
    "jurisdictionCode",
    "lifecycle",
    "aggregateVersion",
    "profileVersion",
    "brandCount",
    "storeCount",
    "effectiveFrom",
    "effectiveUntil",
    "registrationReference",
    "taxRegistrationReference",
    "registeredAddressReference",
    "restrictedFieldsRevealed",
    "approvalStatus",
    "authoritySummaries",
    "assignments",
    "evidenceReferences",
    "auditSummaryReference",
  ]);
  const revealed = bool(r.restrictedFieldsRevealed);
  if (revealed && (!mayReveal || !recentMfa)) return fail();
  const registration = nullableRef(r.registrationReference),
    tax = nullableRef(r.taxRegistrationReference),
    address = nullableRef(r.registeredAddressReference);
  if (!revealed && (registration !== null || tax !== null || address !== null)) return fail();
  if (
    !Array.isArray(r.authoritySummaries) ||
    r.authoritySummaries.length > 50 ||
    !Array.isArray(r.assignments) ||
    r.assignments.length > 100
  )
    return fail();
  const assignments = r.assignments.map(assignment);
  if (new Set(assignments.map((a) => a.assignmentReference)).size !== assignments.length)
    return fail();
  return Object.freeze({
    operatingEntityReference: ref(r.operatingEntityReference),
    legalName: text(r.legalName),
    tradeName: nullableText(r.tradeName),
    jurisdictionCode: r.jurisdictionCode === "CA-ON" ? "CA-ON" : fail(),
    lifecycle: oneOf(r.lifecycle, lifecycles),
    aggregateVersion: positive(r.aggregateVersion),
    profileVersion: positive(r.profileVersion),
    brandCount: count(r.brandCount),
    storeCount: count(r.storeCount),
    effectiveFrom: instant(r.effectiveFrom),
    effectiveUntil: nullableInstant(r.effectiveUntil),
    registrationReference: registration,
    taxRegistrationReference: tax,
    registeredAddressReference: address,
    restrictedFieldsRevealed: revealed,
    approvalStatus: oneOf(r.approvalStatus, [
      "NotSubmitted",
      "Pending",
      "Approved",
      "Rejected",
    ] as const),
    authoritySummaries: Object.freeze(r.authoritySummaries.map(authority)),
    assignments: Object.freeze(assignments),
    evidenceReferences: refs(r.evidenceReferences),
    auditSummaryReference: ref(r.auditSummaryReference),
  });
}
export function parseOperatingEntityAdminView(value: unknown): OperatingEntityAdminView {
  const r = exact(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "sourceAsOf",
    "freshness",
    "completeness",
    "permissions",
    "recentMfa",
    "filters",
    "entities",
  ]);
  const screen = oneOf(r.screenId, ["ORG-ENTITY-LIST", "ORG-ENTITY-DETAIL"] as const);
  if (r.queryName !== "operating_entity_admin_v1" || r.queryVersion !== 1) return fail();
  const p = exact(r.permissions, [
      "mayCreate",
      "mayEdit",
      "maySubmit",
      "mayApprove",
      "mayActivate",
      "maySuspend",
      "mayManageAssignment",
      "mayViewRestricted",
    ]),
    permissions = Object.freeze({
      mayCreate: bool(p.mayCreate),
      mayEdit: bool(p.mayEdit),
      maySubmit: bool(p.maySubmit),
      mayApprove: bool(p.mayApprove),
      mayActivate: bool(p.mayActivate),
      maySuspend: bool(p.maySuspend),
      mayManageAssignment: bool(p.mayManageAssignment),
      mayViewRestricted: bool(p.mayViewRestricted),
    }),
    mfa = bool(r.recentMfa),
    f = exact(r.filters, ["name", "registrationExact", "status", "jurisdictionCode"]);
  if (
    !Array.isArray(r.entities) ||
    r.entities.length > 100 ||
    (screen === "ORG-ENTITY-DETAIL" && r.entities.length !== 1)
  )
    return fail();
  const entities = r.entities.map((v) => entity(v, permissions.mayViewRestricted, mfa));
  if (new Set(entities.map((e) => e.operatingEntityReference)).size !== entities.length)
    return fail();
  const registrationExact =
    r.filters && f.registrationExact === null ? null : ref(f.registrationExact);
  if (registrationExact !== null && (!permissions.mayViewRestricted || !mfa)) return fail();
  return Object.freeze({
    screenId: screen,
    queryName: "operating_entity_admin_v1",
    queryVersion: 1,
    generatedAt: instant(r.generatedAt),
    sourceAsOf: instant(r.sourceAsOf),
    freshness: oneOf(r.freshness, ["Fresh", "Stale"] as const),
    completeness: oneOf(r.completeness, ["Complete", "Partial"] as const),
    permissions,
    recentMfa: mfa,
    filters: Object.freeze({
      name: f.name === null ? null : text(f.name, 100),
      registrationExact,
      status: f.status === null ? null : oneOf(f.status, lifecycles),
      jurisdictionCode:
        f.jurisdictionCode === null ? null : f.jurisdictionCode === "CA-ON" ? "CA-ON" : fail(),
    }),
    entities: Object.freeze(entities),
  });
}
export const unavailableOperatingEntityPageClient: OperatingEntityPageClient = {
  async load() {
    throw new OperatingEntityPageError("Unavailable");
  },
};
