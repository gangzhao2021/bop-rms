export type ApiClientPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ApiClientPageError extends Error {
  constructor(readonly code: ApiClientPageErrorCode) {
    super("API Client page unavailable");
    this.name = "ApiClientPageError";
  }
}
export interface ApiClientPageClient {
  load(): Promise<unknown>;
}
type Status = "Requested" | "PendingApproval" | "Active" | "Suspended" | "Revoked";
export interface ApiClientAdminView {
  readonly screenId: "INT-API-CLIENT";
  readonly queryName: "api_client_admin_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: {
    readonly mayRequest: boolean;
    readonly maySubmitApproval: boolean;
    readonly mayRotate: boolean;
    readonly mayRevoke: boolean;
    readonly mayViewAudit: boolean;
  };
  readonly filters: {
    readonly nameCode: string | null;
    readonly status: Status | null;
    readonly scopeCode: string | null;
    readonly environment: "Sandbox" | "Production" | null;
    readonly unusedOnly: boolean;
  };
  readonly clients: readonly {
    readonly clientReference: string;
    readonly nameCode: string;
    readonly ownerReference: string;
    readonly storeReference: string | null;
    readonly environment: "Sandbox" | "Production";
    readonly status: Status;
    readonly scopeCodes: readonly string[];
    readonly grantCodes: readonly string[];
    readonly aggregateVersion: number;
    readonly credentialVersion: number | null;
    readonly credentialAgeDays: number | null;
    readonly credentialExpiresAt: string | null;
    readonly lastUsedAt: string | null;
    readonly auditSummaryReference: string;
  }[];
}
const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new ApiClientPageError("Unavailable");
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
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const ref = (value: unknown) => (typeof value === "string" && REF.test(value) ? value : fail());
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const code = (value: unknown) => (typeof value === "string" && CODE.test(value) ? value : fail());
const nullableCode = (value: unknown) => (value === null ? null : code(value));
const instant = (value: unknown) =>
  typeof value === "string" &&
  INSTANT.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const nullableInstant = (value: unknown) => (value === null ? null : instant(value));
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail();
const positive = (value: unknown) => (count(value) > 0 ? (value as number) : fail());
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const statuses = ["Requested", "PendingApproval", "Active", "Suspended", "Revoked"] as const;
const codes = (value: unknown) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return fail();
  const result = value.map(code);
  return new Set(result).size === result.length ? Object.freeze(result) : fail();
};
function client(value: unknown): ApiClientAdminView["clients"][number] {
  const raw = exact(value, [
    "clientReference",
    "nameCode",
    "ownerReference",
    "storeReference",
    "environment",
    "status",
    "scopeCodes",
    "grantCodes",
    "aggregateVersion",
    "credentialVersion",
    "credentialAgeDays",
    "credentialExpiresAt",
    "lastUsedAt",
    "auditSummaryReference",
  ]);
  const status = oneOf(raw.status, statuses);
  const credentialVersion = raw.credentialVersion === null ? null : positive(raw.credentialVersion);
  const credentialAgeDays = raw.credentialAgeDays === null ? null : count(raw.credentialAgeDays);
  const credentialExpiresAt = nullableInstant(raw.credentialExpiresAt);
  if (
    (["Requested", "PendingApproval"].includes(status) &&
      (credentialVersion !== null || credentialAgeDays !== null || credentialExpiresAt !== null)) ||
    (["Active", "Suspended", "Revoked"].includes(status) && credentialVersion === null)
  )
    return fail();
  return Object.freeze({
    clientReference: ref(raw.clientReference),
    nameCode: code(raw.nameCode),
    ownerReference: ref(raw.ownerReference),
    storeReference: nullableRef(raw.storeReference),
    environment: oneOf(raw.environment, ["Sandbox", "Production"] as const),
    status,
    scopeCodes: codes(raw.scopeCodes),
    grantCodes: codes(raw.grantCodes),
    aggregateVersion: positive(raw.aggregateVersion),
    credentialVersion,
    credentialAgeDays,
    credentialExpiresAt,
    lastUsedAt: nullableInstant(raw.lastUsedAt),
    auditSummaryReference: ref(raw.auditSummaryReference),
  });
}
export function parseApiClientAdminView(value: unknown): ApiClientAdminView {
  const raw = exact(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "sourceAsOf",
    "freshness",
    "completeness",
    "permissions",
    "filters",
    "clients",
  ]);
  if (
    raw.screenId !== "INT-API-CLIENT" ||
    raw.queryName !== "api_client_admin_v1" ||
    raw.queryVersion !== 1
  )
    return fail();
  const permissions = exact(raw.permissions, [
    "mayRequest",
    "maySubmitApproval",
    "mayRotate",
    "mayRevoke",
    "mayViewAudit",
  ]);
  const filters = exact(raw.filters, [
    "nameCode",
    "status",
    "scopeCode",
    "environment",
    "unusedOnly",
  ]);
  if (!Array.isArray(raw.clients) || raw.clients.length > 100) return fail();
  const clients = raw.clients.map(client);
  if (new Set(clients.map((item) => item.clientReference)).size !== clients.length) return fail();
  return Object.freeze({
    screenId: "INT-API-CLIENT",
    queryName: "api_client_admin_v1",
    queryVersion: 1,
    generatedAt: instant(raw.generatedAt),
    sourceAsOf: instant(raw.sourceAsOf),
    freshness: oneOf(raw.freshness, ["Fresh", "Stale"] as const),
    completeness: oneOf(raw.completeness, ["Complete", "Partial"] as const),
    permissions: Object.freeze({
      mayRequest: bool(permissions.mayRequest),
      maySubmitApproval: bool(permissions.maySubmitApproval),
      mayRotate: bool(permissions.mayRotate),
      mayRevoke: bool(permissions.mayRevoke),
      mayViewAudit: bool(permissions.mayViewAudit),
    }),
    filters: Object.freeze({
      nameCode: nullableCode(filters.nameCode),
      status: filters.status === null ? null : oneOf(filters.status, statuses),
      scopeCode: nullableCode(filters.scopeCode),
      environment:
        filters.environment === null
          ? null
          : oneOf(filters.environment, ["Sandbox", "Production"] as const),
      unusedOnly: bool(filters.unusedOnly),
    }),
    clients: Object.freeze(clients),
  });
}
export const unavailableApiClientPageClient: ApiClientPageClient = {
  async load() {
    throw new ApiClientPageError("Unavailable");
  },
};
