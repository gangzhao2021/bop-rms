import { createHash } from "node:crypto";
import { parseCanonicalInstant } from "@bop/tenant";

export const systemMediaImagePromotionRequiredFields = Object.freeze([
  "sourceVersion",
  "scanAdmission",
  "processingIntent",
  "processingResult",
  "asset",
  "renditions",
  "audit",
] as const);

export class SystemMediaImagePromotionAuthorizationError extends Error {
  constructor(
    readonly code:
      | "SYSTEM_MEDIA_IMAGE_PROMOTION_REQUEST_INVALID"
      | "SYSTEM_MEDIA_IMAGE_PROMOTION_SOURCE_UNAVAILABLE",
  ) {
    super(
      code === "SYSTEM_MEDIA_IMAGE_PROMOTION_REQUEST_INVALID"
        ? "system image promotion authorization request is invalid"
        : "system image promotion authorization is unavailable",
    );
    this.name = "SystemMediaImagePromotionAuthorizationError";
  }
}

export interface SystemMediaImagePromotionWorkloadIdentity {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string | null;
  /** Named configured workload, not Identity System.actorReference (which is null). */
  readonly workloadReference: string;
  readonly deploymentConfigurationDigest: string;
}

export interface SystemMediaImagePromotionAuthorizationDecision extends SystemMediaImagePromotionWorkloadIdentity {
  readonly profile: "MEDIA_IMAGE_PROMOTION_V1";
  readonly decisionReference: string;
  readonly version: number;
  readonly action: "media.asset.promote";
  readonly purposeCode: "MEDIA_IMAGE_PROMOTION";
  readonly requiredFields: typeof systemMediaImagePromotionRequiredFields;
  readonly enabled: boolean;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly recordedAt: string;
  readonly auditReference: string;
  readonly digest: string;
}

export interface SystemMediaImagePromotionAuthorizationRequest {
  readonly actorKind: "System";
  readonly action: "media.asset.promote";
  readonly purposeCode: "MEDIA_IMAGE_PROMOTION";
  readonly requiredFields: typeof systemMediaImagePromotionRequiredFields;
  readonly observedAt: string;
  readonly validUntil: string;
}

export type SystemMediaImagePromotionAuthorizationReason =
  | "CURRENT_WORKLOAD_AUTHORIZATION"
  | "MISSING_WORKLOAD_AUTHORIZATION"
  | "WORKLOAD_DISABLED"
  | "DEPLOYMENT_CONFIGURATION_MISMATCH"
  | "OUTSIDE_EFFECTIVE_PERIOD";

export interface SystemMediaImagePromotionAuthorization extends SystemMediaImagePromotionWorkloadIdentity {
  readonly profile: "SystemMediaImagePromotionAuthorizationV1";
  readonly effect: "Allow" | "Deny";
  readonly reason: SystemMediaImagePromotionAuthorizationReason;
  readonly decisionReference: string | null;
  readonly policyVersion: number | null;
  readonly decisionDigest: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
}

const invalid = (): never => {
  throw new SystemMediaImagePromotionAuthorizationError(
    "SYSTEM_MEDIA_IMAGE_PROMOTION_REQUEST_INVALID",
  );
};
const uuid = (value: unknown): string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    ? value
    : invalid();
const hash = (value: unknown): string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : invalid();
function instant(value: unknown): string {
  try {
    return parseCanonicalInstant(value);
  } catch {
    return invalid();
  }
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return invalid();
    result[key] = d.value;
  }
  return result;
}
function fields(value: unknown): typeof systemMediaImagePromotionRequiredFields {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== systemMediaImagePromotionRequiredFields.length + 1 ||
    value.length !== systemMediaImagePromotionRequiredFields.length
  )
    return invalid();
  for (const [index, field] of systemMediaImagePromotionRequiredFields.entries()) {
    const d = Object.getOwnPropertyDescriptor(value, String(index));
    if (!d?.enumerable || !("value" in d) || d.value !== field) return invalid();
  }
  return systemMediaImagePromotionRequiredFields;
}
const identityKeys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "workloadReference",
  "deploymentConfigurationDigest",
] as const;
function identity(r: Record<string, unknown>): SystemMediaImagePromotionWorkloadIdentity {
  return Object.freeze({
    tenantReference: uuid(r.tenantReference),
    brandReference: uuid(r.brandReference),
    storeReference: r.storeReference === null ? null : uuid(r.storeReference),
    workloadReference: uuid(r.workloadReference),
    deploymentConfigurationDigest: hash(r.deploymentConfigurationDigest),
  });
}
export function parseSystemMediaImagePromotionWorkloadIdentity(
  value: unknown,
): SystemMediaImagePromotionWorkloadIdentity {
  return identity(closed(value, identityKeys));
}

export function parseSystemMediaImagePromotionAuthorizationRequest(
  value: unknown,
): SystemMediaImagePromotionAuthorizationRequest {
  const r = closed(value, [
    "actorKind",
    "action",
    "purposeCode",
    "requiredFields",
    "observedAt",
    "validUntil",
  ]);
  if (
    r.actorKind !== "System" ||
    r.action !== "media.asset.promote" ||
    r.purposeCode !== "MEDIA_IMAGE_PROMOTION"
  )
    return invalid();
  const observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
    return invalid();
  return Object.freeze({
    actorKind: "System",
    action: "media.asset.promote",
    purposeCode: "MEDIA_IMAGE_PROMOTION",
    requiredFields: fields(r.requiredFields),
    observedAt,
    validUntil,
  });
}

const decisionKeys = [
  "profile",
  "decisionReference",
  ...identityKeys,
  "version",
  "action",
  "purposeCode",
  "requiredFields",
  "enabled",
  "effectiveFrom",
  "effectiveUntil",
  "recordedAt",
  "auditReference",
] as const;
function body(value: unknown): Omit<SystemMediaImagePromotionAuthorizationDecision, "digest"> {
  const r = closed(value, decisionKeys);
  if (
    r.profile !== "MEDIA_IMAGE_PROMOTION_V1" ||
    r.action !== "media.asset.promote" ||
    r.purposeCode !== "MEDIA_IMAGE_PROMOTION" ||
    typeof r.enabled !== "boolean" ||
    !Number.isSafeInteger(r.version) ||
    (r.version as number) < 1
  )
    return invalid();
  const effectiveFrom = instant(r.effectiveFrom),
    effectiveUntil = r.effectiveUntil === null ? null : instant(r.effectiveUntil);
  if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) return invalid();
  return Object.freeze({
    profile: "MEDIA_IMAGE_PROMOTION_V1",
    decisionReference: uuid(r.decisionReference),
    ...identity(r),
    version: r.version as number,
    action: "media.asset.promote",
    purposeCode: "MEDIA_IMAGE_PROMOTION",
    requiredFields: fields(r.requiredFields),
    enabled: r.enabled,
    effectiveFrom,
    effectiveUntil,
    recordedAt: instant(r.recordedAt),
    auditReference: uuid(r.auditReference),
  });
}
// The closed body has only ASCII keys, canonical scalar values and one string
// array, so sorted JSON keys give a stable digest without a general JSON protocol.
function bodyDigest(value: Omit<SystemMediaImagePromotionAuthorizationDecision, "digest">): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value, [...decisionKeys].sort()))
    .digest("hex")}`;
}
export function buildSystemMediaImagePromotionAuthorizationDecision(
  value: Omit<SystemMediaImagePromotionAuthorizationDecision, "digest">,
): SystemMediaImagePromotionAuthorizationDecision {
  const parsed = body(value);
  return Object.freeze({ ...parsed, digest: bodyDigest(parsed) });
}
export function parseSystemMediaImagePromotionAuthorizationDecision(
  value: unknown,
): SystemMediaImagePromotionAuthorizationDecision {
  const r = closed(value, [...decisionKeys, "digest"]),
    digest = hash(r.digest);
  delete r.digest;
  const parsed = body(r);
  if (digest !== bodyDigest(parsed)) return invalid();
  return Object.freeze({ ...parsed, digest });
}
