import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
} from "./product.js";
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function closed(value: unknown, keys: readonly string[]) {
  const copied = copyCategoryPersistenceValue(value);
  if (
    !copied ||
    typeof copied !== "object" ||
    Array.isArray(copied) ||
    Object.keys(copied).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(copied, key))
  )
    return fail();
  return copied as Record<string, unknown>;
}
function version(value: unknown, maximum = 2147483647): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return fail();
  return value as number;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return fail();
  return value;
}
function bounded<T>(value: T): T {
  if (new TextEncoder().encode(canonicalizeRfc8785(value)).byteLength > 4096) return fail();
  return value;
}
/** Original requested identity, with no client content, clock or authorization. */
export function parseCatalogOptionSetAuthoringResolutionCommand(value: unknown) {
  const r = closed(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "actorReference",
    "action",
    "reasonCode",
    "operationReference",
    "optionSetReference",
    "expectedAggregateVersion",
  ]);
  if (
    r.profile !== "CatalogOptionSetAuthoringResolutionCommandV1" ||
    (r.action !== "Create" && r.action !== "Edit") ||
    parseCatalogCode(r.reasonCode) !== r.reasonCode
  )
    return fail();
  if (
    r.action === "Create" &&
    (r.optionSetReference !== null || r.expectedAggregateVersion !== null)
  )
    return fail();
  return bounded(
    Object.freeze({
      profile: "CatalogOptionSetAuthoringResolutionCommandV1" as const,
      tenantReference: parseCatalogReference(r.tenantReference),
      brandReference: parseCatalogReference(r.brandReference),
      actorReference: parseCatalogReference(r.actorReference),
      action: r.action,
      reasonCode: parseCatalogCode(r.reasonCode),
      operationReference: parseCatalogReference(r.operationReference),
      optionSetReference:
        r.action === "Create" ? null : parseCatalogReference(r.optionSetReference),
      expectedAggregateVersion:
        r.action === "Create" ? null : version(r.expectedAggregateVersion, 2147483646),
    }),
  );
}
export type CatalogOptionSetAuthoringResolutionCommand = ReturnType<
  typeof parseCatalogOptionSetAuthoringResolutionCommand
>;
/** Immutable owning metadata. It is only an identity receipt, never eligibility. */
export function parseCatalogOptionSetAuthoringIdentity(value: unknown) {
  const r = closed(value, [
    "profile",
    "command",
    "sourceOperationReference",
    "optionSetReference",
    "versionReference",
    "aggregateVersion",
    "originalOccurredAt",
    "auditReference",
    "originalIntentDigest",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
    "digest",
  ]);
  if (r.profile !== "CatalogOptionSetAuthoringIdentityV1") return fail();
  const command = parseCatalogOptionSetAuthoringResolutionCommand(r.command),
    sourceOperationReference = parseCatalogReference(r.sourceOperationReference),
    optionSetReference = parseCatalogReference(r.optionSetReference),
    aggregateVersion = version(r.aggregateVersion);
  if (
    sourceOperationReference !== command.operationReference ||
    aggregateVersion !==
      (command.action === "Create" ? 1 : (command.expectedAggregateVersion ?? 0) + 1) ||
    (command.action === "Edit" && optionSetReference !== command.optionSetReference)
  )
    return fail();
  const body = {
    profile: "CatalogOptionSetAuthoringIdentityV1" as const,
    command,
    sourceOperationReference,
    optionSetReference,
    versionReference: parseCatalogReference(r.versionReference),
    aggregateVersion,
    originalOccurredAt: parseCatalogInstant(r.originalOccurredAt),
    auditReference: parseCatalogReference(r.auditReference),
    originalIntentDigest: digest(r.originalIntentDigest),
    sourceDigest: digest(r.sourceDigest),
    contentDigest: digest(r.contentDigest),
    configurationDigest: digest(r.configurationDigest),
  };
  if (r.digest !== hash(body)) return fail();
  return bounded(Object.freeze({ ...body, digest: digest(r.digest) }));
}
export type CatalogOptionSetAuthoringIdentity = ReturnType<
  typeof parseCatalogOptionSetAuthoringIdentity
>;
export function createCatalogOptionSetAuthoringIdentity(
  value: Omit<CatalogOptionSetAuthoringIdentity, "profile" | "digest">,
): CatalogOptionSetAuthoringIdentity {
  const body = { profile: "CatalogOptionSetAuthoringIdentityV1" as const, ...value };
  return parseCatalogOptionSetAuthoringIdentity({ ...body, digest: hash(body) });
}
export function parseCatalogOptionSetAuthoringResolution(value: unknown) {
  const r = closed(value, ["profile", "outcome", "command", "identity", "recordedAt", "digest"]);
  if (
    r.profile !== "CatalogOptionSetAuthoringResolutionV1" ||
    (r.outcome !== "Committed" && r.outcome !== "Abandoned")
  )
    return fail();
  const command = parseCatalogOptionSetAuthoringResolutionCommand(r.command),
    identity = r.identity === null ? null : parseCatalogOptionSetAuthoringIdentity(r.identity),
    recordedAt = parseCatalogInstant(r.recordedAt);
  if (
    r.outcome === "Abandoned"
      ? identity !== null
      : identity === null ||
        canonicalizeRfc8785(identity.command) !== canonicalizeRfc8785(command) ||
        recordedAt !== identity.originalOccurredAt
  )
    return fail();
  const body = {
    profile: "CatalogOptionSetAuthoringResolutionV1" as const,
    outcome: r.outcome,
    command,
    identity,
    recordedAt,
  };
  if (r.digest !== hash(body)) return fail();
  return bounded(Object.freeze({ ...body, digest: digest(r.digest) }));
}
export type CatalogOptionSetAuthoringResolution = ReturnType<
  typeof parseCatalogOptionSetAuthoringResolution
>;
export function createCatalogOptionSetAuthoringResolution(
  value: Omit<CatalogOptionSetAuthoringResolution, "profile" | "digest">,
): CatalogOptionSetAuthoringResolution {
  const body = { profile: "CatalogOptionSetAuthoringResolutionV1" as const, ...value };
  return parseCatalogOptionSetAuthoringResolution({ ...body, digest: hash(body) });
}
