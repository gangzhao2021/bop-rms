export type ProviderIntegrationPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ProviderIntegrationPageError extends Error {
  constructor(readonly code: ProviderIntegrationPageErrorCode) {
    super("Provider integration page unavailable");
    this.name = "ProviderIntegrationPageError";
  }
}
export interface ProviderIntegrationClient {
  load(): Promise<unknown>;
}
type ProviderCode = "STRIPE_CANADA" | "AWS_COGNITO_CA" | "AWS_S3_CA" | "AWS_SES_CA";
type Status = "Draft" | "Disabled" | "Enabled" | "Degraded" | "KillSwitched";
export interface ProviderIntegrationView {
  readonly screenId: "INT-PROVIDER-LIST" | "INT-PROVIDER-DETAIL";
  readonly queryName: "provider_integration_admin_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: {
    readonly mayEnable: boolean;
    readonly mayDisable: boolean;
    readonly mayTestSandbox: boolean;
    readonly mayRotateCredential: boolean;
    readonly mayReplayInbox: boolean;
    readonly mayOpenIncident: boolean;
  };
  readonly filters: {
    readonly providerCode: ProviderCode | null;
    readonly capabilityCode: string | null;
    readonly status: Status | null;
    readonly environment: "Sandbox" | "Live" | null;
    readonly storeReference: string | null;
    readonly degradedOnly: boolean;
  };
  readonly integrations: readonly {
    readonly integrationReference: string;
    readonly providerCode: ProviderCode;
    readonly adapterCode: string;
    readonly ownerModule: "@rms/payment" | "@bop/identity" | "@bop/media" | "@bop/notification";
    readonly capabilityCodes: readonly string[];
    readonly environment: "Sandbox" | "Live";
    readonly storeReference: string | null;
    readonly status: Status;
    readonly effectiveEnablement: "Allowed" | "Blocked";
    readonly aggregateVersion: number;
    readonly contractVersionCode: string;
    readonly regionCode: string;
    readonly lastSuccessAt: string | null;
    readonly lastSafeErrorCode: string | null;
    readonly credentialAgeDays: number | null;
    readonly credentialExpiryDisposition: "NotApplicable" | "Current" | "Expiring" | "Expired";
    readonly webhookHealth: "NotApplicable" | "Healthy" | "Degraded" | "Unavailable" | "Unknown";
    readonly endpointHealth: "Healthy" | "Degraded" | "Unavailable" | "Unknown";
    readonly rateLimitPerMinute: number | null;
    readonly quotaRemaining: number | null;
    readonly retryCount: number;
    readonly deadLetterCount: number;
    readonly eligibleInboxReference: string | null;
    readonly evidenceReferences: readonly string[];
    readonly requiredEvidenceSatisfied: boolean;
    readonly killSwitchState: "Open" | "Closed";
  }[];
}
const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new ProviderIntegrationPageError("Unavailable");
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
const nullableCount = (value: unknown) => (value === null ? null : count(value));
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const providers = ["STRIPE_CANADA", "AWS_COGNITO_CA", "AWS_S3_CA", "AWS_SES_CA"] as const;
const statuses = ["Draft", "Disabled", "Enabled", "Degraded", "KillSwitched"] as const;
const owners = {
  STRIPE_CANADA: "@rms/payment",
  AWS_COGNITO_CA: "@bop/identity",
  AWS_S3_CA: "@bop/media",
  AWS_SES_CA: "@bop/notification",
} as const;
function integration(value: unknown): ProviderIntegrationView["integrations"][number] {
  const raw = exact(value, [
    "integrationReference",
    "providerCode",
    "adapterCode",
    "ownerModule",
    "capabilityCodes",
    "environment",
    "storeReference",
    "status",
    "effectiveEnablement",
    "aggregateVersion",
    "contractVersionCode",
    "regionCode",
    "lastSuccessAt",
    "lastSafeErrorCode",
    "credentialAgeDays",
    "credentialExpiryDisposition",
    "webhookHealth",
    "endpointHealth",
    "rateLimitPerMinute",
    "quotaRemaining",
    "retryCount",
    "deadLetterCount",
    "eligibleInboxReference",
    "evidenceReferences",
    "requiredEvidenceSatisfied",
    "killSwitchState",
  ]);
  if (
    !Array.isArray(raw.capabilityCodes) ||
    raw.capabilityCodes.length === 0 ||
    raw.capabilityCodes.length > 20 ||
    !Array.isArray(raw.evidenceReferences) ||
    raw.evidenceReferences.length > 20
  )
    return fail();
  const capabilityCodes = Object.freeze(raw.capabilityCodes.map(code));
  const evidenceReferences = Object.freeze(raw.evidenceReferences.map(ref));
  if (
    new Set(capabilityCodes).size !== capabilityCodes.length ||
    new Set(evidenceReferences).size !== evidenceReferences.length
  )
    return fail();
  const providerCode = oneOf(raw.providerCode, providers);
  const ownerModule = oneOf(raw.ownerModule, [
    "@rms/payment",
    "@bop/identity",
    "@bop/media",
    "@bop/notification",
  ] as const);
  if (owners[providerCode] !== ownerModule) return fail();
  const status = oneOf(raw.status, statuses);
  const killSwitchState = oneOf(raw.killSwitchState, ["Open", "Closed"] as const);
  const requiredEvidenceSatisfied = bool(raw.requiredEvidenceSatisfied);
  const effectiveEnablement = oneOf(raw.effectiveEnablement, ["Allowed", "Blocked"] as const);
  if (
    (status === "KillSwitched") !== (killSwitchState === "Closed") ||
    (effectiveEnablement === "Allowed" &&
      (!requiredEvidenceSatisfied || killSwitchState !== "Open"))
  )
    return fail();
  return Object.freeze({
    integrationReference: ref(raw.integrationReference),
    providerCode,
    adapterCode: code(raw.adapterCode),
    ownerModule,
    capabilityCodes,
    environment: oneOf(raw.environment, ["Sandbox", "Live"] as const),
    storeReference: nullableRef(raw.storeReference),
    status,
    effectiveEnablement,
    aggregateVersion: count(raw.aggregateVersion) > 0 ? (raw.aggregateVersion as number) : fail(),
    contractVersionCode: code(raw.contractVersionCode),
    regionCode: code(raw.regionCode),
    lastSuccessAt: nullableInstant(raw.lastSuccessAt),
    lastSafeErrorCode: nullableCode(raw.lastSafeErrorCode),
    credentialAgeDays: nullableCount(raw.credentialAgeDays),
    credentialExpiryDisposition: oneOf(raw.credentialExpiryDisposition, [
      "NotApplicable",
      "Current",
      "Expiring",
      "Expired",
    ] as const),
    webhookHealth: oneOf(raw.webhookHealth, [
      "NotApplicable",
      "Healthy",
      "Degraded",
      "Unavailable",
      "Unknown",
    ] as const),
    endpointHealth: oneOf(raw.endpointHealth, [
      "Healthy",
      "Degraded",
      "Unavailable",
      "Unknown",
    ] as const),
    rateLimitPerMinute: nullableCount(raw.rateLimitPerMinute),
    quotaRemaining: nullableCount(raw.quotaRemaining),
    retryCount: count(raw.retryCount),
    deadLetterCount: count(raw.deadLetterCount),
    eligibleInboxReference: nullableRef(raw.eligibleInboxReference),
    evidenceReferences,
    requiredEvidenceSatisfied,
    killSwitchState,
  });
}
export function parseProviderIntegrationView(value: unknown): ProviderIntegrationView {
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
    "integrations",
  ]);
  const permissions = exact(raw.permissions, [
    "mayEnable",
    "mayDisable",
    "mayTestSandbox",
    "mayRotateCredential",
    "mayReplayInbox",
    "mayOpenIncident",
  ]);
  const filters = exact(raw.filters, [
    "providerCode",
    "capabilityCode",
    "status",
    "environment",
    "storeReference",
    "degradedOnly",
  ]);
  if (!Array.isArray(raw.integrations) || raw.integrations.length > 100) return fail();
  const integrations = Object.freeze(raw.integrations.map(integration));
  if (new Set(integrations.map((item) => item.integrationReference)).size !== integrations.length)
    return fail();
  const screenId = oneOf(raw.screenId, ["INT-PROVIDER-LIST", "INT-PROVIDER-DETAIL"] as const);
  if (screenId === "INT-PROVIDER-DETAIL" && integrations.length !== 1) return fail();
  return Object.freeze({
    screenId,
    queryName: oneOf(raw.queryName, ["provider_integration_admin_v1"] as const),
    queryVersion: raw.queryVersion === 1 ? 1 : fail(),
    generatedAt: instant(raw.generatedAt),
    sourceAsOf: instant(raw.sourceAsOf),
    freshness: oneOf(raw.freshness, ["Fresh", "Stale"] as const),
    completeness: oneOf(raw.completeness, ["Complete", "Partial"] as const),
    permissions: Object.freeze({
      mayEnable: bool(permissions.mayEnable),
      mayDisable: bool(permissions.mayDisable),
      mayTestSandbox: bool(permissions.mayTestSandbox),
      mayRotateCredential: bool(permissions.mayRotateCredential),
      mayReplayInbox: bool(permissions.mayReplayInbox),
      mayOpenIncident: bool(permissions.mayOpenIncident),
    }),
    filters: Object.freeze({
      providerCode: filters.providerCode === null ? null : oneOf(filters.providerCode, providers),
      capabilityCode: nullableCode(filters.capabilityCode),
      status: filters.status === null ? null : oneOf(filters.status, statuses),
      environment:
        filters.environment === null
          ? null
          : oneOf(filters.environment, ["Sandbox", "Live"] as const),
      storeReference: nullableRef(filters.storeReference),
      degradedOnly: bool(filters.degradedOnly),
    }),
    integrations,
  });
}
export const unavailableProviderIntegrationClient: ProviderIntegrationClient = {
  load: async () => {
    throw new ProviderIntegrationPageError("Unavailable");
  },
};
