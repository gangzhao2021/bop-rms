export const providerIntegrationProjectionName = "provider_integration_admin_v1" as const;
export const providerIntegrationProjectionVersion = 1 as const;
export type AcceptedProviderCode = "STRIPE_CANADA" | "AWS_COGNITO_CA" | "AWS_S3_CA" | "AWS_SES_CA";
export type ProviderOwnerModule =
  "@rms/payment" | "@bop/identity" | "@bop/media" | "@bop/notification";
export interface ProviderIntegrationSource {
  readonly integrationReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string | null;
  readonly providerCode: AcceptedProviderCode;
  readonly adapterCode: string;
  readonly ownerModule: ProviderOwnerModule;
  readonly capabilityCodes: readonly string[];
  readonly environment: "Sandbox" | "Live";
  readonly status: "Draft" | "Disabled" | "Enabled" | "Degraded" | "KillSwitched";
  readonly aggregateVersion: number;
  readonly contractVersionCode: string;
  readonly regionCode: string;
  readonly lastSuccessAt: string | null;
  readonly lastSafeErrorCode: string | null;
  readonly credentialIssuedAt: string | null;
  readonly credentialExpiresAt: string | null;
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
  readonly sourceAsOf: string;
}
export interface ProviderIntegrationRow extends ProviderIntegrationSource {
  readonly effectiveEnablement: "Allowed" | "Blocked";
  readonly credentialAgeDays: number | null;
  readonly credentialExpiryDisposition: "NotApplicable" | "Current" | "Expiring" | "Expired";
}
export interface ProviderIntegrationProjection {
  readonly projectionName: typeof providerIntegrationProjectionName;
  readonly projectionVersion: 1;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string | null;
  readonly checkpointReference: string;
  readonly projectedAt: string;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly initializedEmpty: boolean;
  readonly rows: readonly ProviderIntegrationRow[];
}
export class ProviderIntegrationProjectionError extends Error {
  constructor(
    readonly code:
      | "INPUT_INVALID"
      | "SCOPE_MISMATCH"
      | "PROVIDER_OWNER_MISMATCH"
      | "PERMISSION_DENIED"
      | "ACTION_BLOCKED",
  ) {
    super("Provider integration administration is unavailable");
    this.name = "ProviderIntegrationProjectionError";
  }
}
const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (code: ProviderIntegrationProjectionError["code"]): never => {
  throw new ProviderIntegrationProjectionError(code);
};
function exact(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail("INPUT_INVALID");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("INPUT_INVALID");
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail("INPUT_INVALID");
const ref = (value: unknown) =>
  typeof value === "string" && REF.test(value) ? value : fail("INPUT_INVALID");
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const code = (value: unknown) =>
  typeof value === "string" && CODE.test(value) ? value : fail("INPUT_INVALID");
const nullableCode = (value: unknown) => (value === null ? null : code(value));
const instant = (value: unknown) =>
  typeof value === "string" &&
  INSTANT.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail("INPUT_INVALID");
const nullableInstant = (value: unknown) => (value === null ? null : instant(value));
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fail("INPUT_INVALID");
const nullableCount = (value: unknown) => (value === null ? null : count(value));
const ownerByProvider: Record<AcceptedProviderCode, ProviderOwnerModule> = {
  STRIPE_CANADA: "@rms/payment",
  AWS_COGNITO_CA: "@bop/identity",
  AWS_S3_CA: "@bop/media",
  AWS_SES_CA: "@bop/notification",
};
export function parseProviderIntegrationSource(value: unknown): ProviderIntegrationSource {
  const raw = exact(value, [
    "integrationReference",
    "tenantReference",
    "brandReference",
    "storeReference",
    "providerCode",
    "adapterCode",
    "ownerModule",
    "capabilityCodes",
    "environment",
    "status",
    "aggregateVersion",
    "contractVersionCode",
    "regionCode",
    "lastSuccessAt",
    "lastSafeErrorCode",
    "credentialIssuedAt",
    "credentialExpiresAt",
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
    "sourceAsOf",
  ]);
  if (
    !Array.isArray(raw.capabilityCodes) ||
    raw.capabilityCodes.length === 0 ||
    raw.capabilityCodes.length > 20 ||
    !Array.isArray(raw.evidenceReferences) ||
    raw.evidenceReferences.length > 20
  )
    return fail("INPUT_INVALID");
  const capabilityCodes = Object.freeze(raw.capabilityCodes.map(code));
  const evidenceReferences = Object.freeze(raw.evidenceReferences.map(ref));
  if (
    new Set(capabilityCodes).size !== capabilityCodes.length ||
    new Set(evidenceReferences).size !== evidenceReferences.length
  )
    return fail("INPUT_INVALID");
  const providerCode = oneOf(raw.providerCode, [
    "STRIPE_CANADA",
    "AWS_COGNITO_CA",
    "AWS_S3_CA",
    "AWS_SES_CA",
  ] as const);
  const ownerModule = oneOf(raw.ownerModule, [
    "@rms/payment",
    "@bop/identity",
    "@bop/media",
    "@bop/notification",
  ] as const);
  if (ownerByProvider[providerCode] !== ownerModule) return fail("PROVIDER_OWNER_MISMATCH");
  const environment = oneOf(raw.environment, ["Sandbox", "Live"] as const);
  const status = oneOf(raw.status, [
    "Draft",
    "Disabled",
    "Enabled",
    "Degraded",
    "KillSwitched",
  ] as const);
  const killSwitchState = oneOf(raw.killSwitchState, ["Open", "Closed"] as const);
  const requiredEvidenceSatisfied =
    typeof raw.requiredEvidenceSatisfied === "boolean"
      ? raw.requiredEvidenceSatisfied
      : fail("INPUT_INVALID");
  if (
    (status === "KillSwitched") !== (killSwitchState === "Closed") ||
    (environment === "Live" && status === "Enabled" && !requiredEvidenceSatisfied)
  )
    return fail("INPUT_INVALID");
  const credentialIssuedAt = nullableInstant(raw.credentialIssuedAt);
  const credentialExpiresAt = nullableInstant(raw.credentialExpiresAt);
  if (
    (credentialIssuedAt === null) !== (credentialExpiresAt === null) ||
    (credentialIssuedAt !== null &&
      credentialExpiresAt !== null &&
      Date.parse(credentialExpiresAt) <= Date.parse(credentialIssuedAt))
  )
    return fail("INPUT_INVALID");
  return Object.freeze({
    integrationReference: ref(raw.integrationReference),
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    storeReference: nullableRef(raw.storeReference),
    providerCode,
    adapterCode: code(raw.adapterCode),
    ownerModule,
    capabilityCodes,
    environment,
    status,
    aggregateVersion:
      count(raw.aggregateVersion) > 0 ? (raw.aggregateVersion as number) : fail("INPUT_INVALID"),
    contractVersionCode: code(raw.contractVersionCode),
    regionCode: code(raw.regionCode),
    lastSuccessAt: nullableInstant(raw.lastSuccessAt),
    lastSafeErrorCode: nullableCode(raw.lastSafeErrorCode),
    credentialIssuedAt,
    credentialExpiresAt,
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
    sourceAsOf: instant(raw.sourceAsOf),
  });
}
export function buildProviderIntegrationProjection(input: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string | null;
  readonly checkpointReference: string;
  readonly projectedAt: string;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly sources: readonly unknown[];
}): ProviderIntegrationProjection {
  const tenantReference = ref(input.tenantReference);
  const brandReference = ref(input.brandReference);
  const storeReference = nullableRef(input.storeReference);
  const projectedAt = instant(input.projectedAt);
  if (!Array.isArray(input.sources) || input.sources.length > 100) return fail("INPUT_INVALID");
  const sources = input.sources.map(parseProviderIntegrationSource);
  if (new Set(sources.map((item) => item.integrationReference)).size !== sources.length)
    return fail("INPUT_INVALID");
  const rows = Object.freeze(
    sources.map((source) => {
      if (
        source.tenantReference !== tenantReference ||
        source.brandReference !== brandReference ||
        (storeReference !== null &&
          source.storeReference !== null &&
          source.storeReference !== storeReference)
      )
        return fail("SCOPE_MISMATCH");
      const credentialAgeDays =
        source.credentialIssuedAt === null
          ? null
          : Math.floor(
              (Date.parse(projectedAt) - Date.parse(source.credentialIssuedAt)) / 86_400_000,
            );
      const credentialExpiryDisposition =
        source.credentialExpiresAt === null
          ? ("NotApplicable" as const)
          : Date.parse(source.credentialExpiresAt) <= Date.parse(projectedAt)
            ? ("Expired" as const)
            : Date.parse(source.credentialExpiresAt) - Date.parse(projectedAt) <= 30 * 86_400_000
              ? ("Expiring" as const)
              : ("Current" as const);
      return Object.freeze({
        ...source,
        effectiveEnablement:
          source.requiredEvidenceSatisfied &&
          source.killSwitchState === "Open" &&
          (source.status === "Enabled" || source.status === "Degraded")
            ? ("Allowed" as const)
            : ("Blocked" as const),
        credentialAgeDays,
        credentialExpiryDisposition,
      });
    }),
  );
  return Object.freeze({
    projectionName: providerIntegrationProjectionName,
    projectionVersion: 1,
    tenantReference,
    brandReference,
    storeReference,
    checkpointReference: ref(input.checkpointReference),
    projectedAt,
    freshnessStatus: oneOf(input.freshnessStatus, ["Fresh", "Stale"] as const),
    completeness: oneOf(input.completeness, ["Complete", "Partial"] as const),
    initializedEmpty: rows.length === 0,
    rows,
  });
}
export type ProviderAdminAction =
  "Enable" | "Disable" | "TestSandbox" | "RotateCredential" | "ReplayInbox" | "OpenIncident";
export function authorizeProviderAdminAction(input: {
  readonly row: ProviderIntegrationRow;
  readonly action: ProviderAdminAction;
  readonly actorReference: string;
  readonly actorPermissions: readonly string[];
  readonly purposeCode: string;
  readonly expectedVersion: number;
  readonly idempotencyReference: string;
  readonly auditReference: string;
}) {
  const permission = `integration.provider.${input.action.replace(/([a-z])([A-Z])/gu, "$1-$2").toLowerCase()}`;
  if (!input.actorPermissions.includes(permission)) return fail("PERMISSION_DENIED");
  if (input.expectedVersion !== input.row.aggregateVersion) return fail("ACTION_BLOCKED");
  if (
    input.action === "Enable" &&
    (!input.row.requiredEvidenceSatisfied ||
      input.row.killSwitchState !== "Open" ||
      !["Draft", "Disabled"].includes(input.row.status))
  )
    return fail("ACTION_BLOCKED");
  if (input.action === "TestSandbox" && input.row.environment !== "Sandbox")
    return fail("ACTION_BLOCKED");
  if (input.action === "ReplayInbox" && input.row.eligibleInboxReference === null)
    return fail("ACTION_BLOCKED");
  if (input.action === "RotateCredential" && input.row.credentialIssuedAt === null)
    return fail("ACTION_BLOCKED");
  return Object.freeze({
    owningModule: input.row.ownerModule,
    commandName: `${input.action}ProviderIntegration`,
    integrationReference: input.row.integrationReference,
    eligibleInboxReference:
      input.action === "ReplayInbox" ? input.row.eligibleInboxReference : null,
    actorReference: ref(input.actorReference),
    purposeCode: code(input.purposeCode),
    expectedVersion: input.expectedVersion,
    idempotencyReference: ref(input.idempotencyReference),
    auditReference: ref(input.auditReference),
  });
}
