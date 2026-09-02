export type PlatformTenantPageErrorCode =
  | "PermissionDenied"
  | "PurposeRequired"
  | "MfaRequired"
  | "NotFound"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class PlatformTenantPageError extends Error {
  constructor(readonly code: PlatformTenantPageErrorCode) {
    super("Platform Tenant operations are unavailable");
    this.name = "PlatformTenantPageError";
  }
}
export interface PlatformAccessContextView {
  readonly actor: string;
  readonly purpose: string;
  readonly supportCaseReference: string;
  readonly recentMfa: boolean;
  readonly environment: "NonProduction" | "Production";
}
export interface PlatformTenantSummaryView {
  readonly tenantReference: string;
  readonly displayName: string;
  readonly region: string;
  readonly status:
    | "Draft"
    | "PendingApproval"
    | "Approved"
    | "Active"
    | "SuspensionPending"
    | "Suspended"
    | "RestorePending";
  readonly plan: string;
  readonly capabilityCount: number;
  readonly storeCount: number;
  readonly health: "Unknown" | "Healthy" | "Degraded" | "Critical";
  readonly openIncidentReference: string | null;
  readonly mayView: boolean;
  readonly mayRequestSuspension: boolean;
}
export interface PlatformTenantListView {
  readonly screenId: "PLT-TENANT-LIST";
  readonly sourceAsOf: string;
  readonly freshness: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly access: PlatformAccessContextView;
  readonly tenants: readonly PlatformTenantSummaryView[];
  readonly mayStartOnboarding: boolean;
}
export interface PlatformTenantDetailView {
  readonly screenId: "PLT-TENANT-DETAIL";
  readonly sourceAsOf: string;
  readonly freshness: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly access: PlatformAccessContextView;
  readonly tenant: PlatformTenantSummaryView;
  readonly environments: readonly string[];
  readonly capabilities: readonly string[];
  readonly storeHealthSummary: string;
  readonly providerHealthSummary: string;
  readonly supportCaseReferences: readonly string[];
  readonly dataPolicyReference: string;
  readonly retentionPolicyReference: string;
  readonly auditReferences: readonly string[];
  readonly mayOpenDiagnostic: boolean;
  readonly mayManageCapabilities: boolean;
  readonly mayStartExport: boolean;
  readonly mayRequestRestore: boolean;
}
export interface PlatformTenantPageClient {
  loadTenants(): Promise<unknown>;
  loadTenant(reference: string): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  region = /^[A-Z]{2}(?:-[A-Z0-9]{2,12}){1,3}$/u,
  safe = /^[^\p{Cc}\p{Cf}]{1,180}$/u;
function fail(): never {
  throw new Error("PLATFORM_TENANT_PAGE_INVALID");
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    fail();
  return value as Record<string, unknown>;
}
export function parsePlatformTenantRouteReference(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) fail();
  return value;
}
const text = (value: unknown) => {
  if (typeof value !== "string" || !safe.test(value)) fail();
  return value;
};
const time = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !instant.test(value) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    fail();
  return value;
};
const flag = (value: unknown) => {
  if (typeof value !== "boolean") fail();
  return value;
};
function refs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) fail();
  const result = Object.freeze(value.map(parsePlatformTenantRouteReference));
  if (new Set(result).size !== result.length) fail();
  return result;
}
function access(value: unknown): PlatformAccessContextView {
  const r = closed(value, ["actor", "purpose", "supportCaseReference", "recentMfa", "environment"]);
  if (!["NonProduction", "Production"].includes(String(r.environment))) fail();
  return Object.freeze({
    actor: text(r.actor),
    purpose: text(r.purpose),
    supportCaseReference: parsePlatformTenantRouteReference(r.supportCaseReference),
    recentMfa: flag(r.recentMfa),
    environment: r.environment,
  }) as PlatformAccessContextView;
}
function tenant(value: unknown): PlatformTenantSummaryView {
  const r = closed(value, [
    "tenantReference",
    "displayName",
    "region",
    "status",
    "plan",
    "capabilityCount",
    "storeCount",
    "health",
    "openIncidentReference",
    "mayView",
    "mayRequestSuspension",
  ]);
  if (
    typeof r.region !== "string" ||
    !region.test(r.region) ||
    ![
      "Draft",
      "PendingApproval",
      "Approved",
      "Active",
      "SuspensionPending",
      "Suspended",
      "RestorePending",
    ].includes(String(r.status)) ||
    !["Unknown", "Healthy", "Degraded", "Critical"].includes(String(r.health)) ||
    !Number.isSafeInteger(r.capabilityCount) ||
    (r.capabilityCount as number) < 0 ||
    (r.capabilityCount as number) > 100 ||
    !Number.isSafeInteger(r.storeCount) ||
    (r.storeCount as number) < 0 ||
    (r.storeCount as number) > 100_000
  )
    fail();
  return Object.freeze({
    tenantReference: parsePlatformTenantRouteReference(r.tenantReference),
    displayName: text(r.displayName),
    region: r.region,
    status: r.status,
    plan: text(r.plan),
    capabilityCount: r.capabilityCount,
    storeCount: r.storeCount,
    health: r.health,
    openIncidentReference:
      r.openIncidentReference === null
        ? null
        : parsePlatformTenantRouteReference(r.openIncidentReference),
    mayView: flag(r.mayView),
    mayRequestSuspension: flag(r.mayRequestSuspension),
  }) as PlatformTenantSummaryView;
}
function base(
  value: unknown,
  screenId: "PLT-TENANT-LIST" | "PLT-TENANT-DETAIL",
  extra: readonly string[],
): Record<string, unknown> & {
  readonly sourceAsOf: string;
  readonly access: PlatformAccessContextView;
} {
  const r = closed(value, [
    "screenId",
    "sourceAsOf",
    "freshness",
    "completeness",
    "access",
    ...extra,
  ]);
  if (
    r.screenId !== screenId ||
    !["Fresh", "Stale"].includes(String(r.freshness)) ||
    !["Complete", "Partial"].includes(String(r.completeness))
  )
    fail();
  return { ...r, sourceAsOf: time(r.sourceAsOf), access: access(r.access) };
}
export function parsePlatformTenantListView(value: unknown): PlatformTenantListView {
  const r = base(value, "PLT-TENANT-LIST", ["tenants", "mayStartOnboarding"]);
  if (!Array.isArray(r.tenants)) fail();
  const tenants = Object.freeze(r.tenants.map(tenant));
  if (new Set(tenants.map((item) => item.tenantReference)).size !== tenants.length) fail();
  return Object.freeze({
    ...r,
    tenants,
    mayStartOnboarding: flag(r.mayStartOnboarding),
  }) as PlatformTenantListView;
}
export function parsePlatformTenantDetailView(
  value: unknown,
  routeReference: unknown,
): PlatformTenantDetailView {
  const exact = parsePlatformTenantRouteReference(routeReference),
    r = base(value, "PLT-TENANT-DETAIL", [
      "tenant",
      "environments",
      "capabilities",
      "storeHealthSummary",
      "providerHealthSummary",
      "supportCaseReferences",
      "dataPolicyReference",
      "retentionPolicyReference",
      "auditReferences",
      "mayOpenDiagnostic",
      "mayManageCapabilities",
      "mayStartExport",
      "mayRequestRestore",
    ]),
    summary = tenant(r.tenant);
  if (
    summary.tenantReference !== exact ||
    !Array.isArray(r.environments) ||
    !Array.isArray(r.capabilities)
  )
    fail();
  const environments = Object.freeze(r.environments.map(text)),
    capabilities = Object.freeze(r.capabilities.map(text));
  if (
    new Set(environments).size !== environments.length ||
    new Set(capabilities).size !== capabilities.length
  )
    fail();
  return Object.freeze({
    ...r,
    tenant: summary,
    environments,
    capabilities,
    storeHealthSummary: text(r.storeHealthSummary),
    providerHealthSummary: text(r.providerHealthSummary),
    supportCaseReferences: refs(r.supportCaseReferences),
    dataPolicyReference: parsePlatformTenantRouteReference(r.dataPolicyReference),
    retentionPolicyReference: parsePlatformTenantRouteReference(r.retentionPolicyReference),
    auditReferences: refs(r.auditReferences),
    mayOpenDiagnostic: flag(r.mayOpenDiagnostic),
    mayManageCapabilities: flag(r.mayManageCapabilities),
    mayStartExport: flag(r.mayStartExport),
    mayRequestRestore: flag(r.mayRequestRestore),
  }) as PlatformTenantDetailView;
}
export const unavailablePlatformTenantPageClient: PlatformTenantPageClient = {
  loadTenants: async () => {
    throw new PlatformTenantPageError("Unavailable");
  },
  loadTenant: async () => {
    throw new PlatformTenantPageError("Unavailable");
  },
};
