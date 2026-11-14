import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "./product.js";

/** Original-operation identity only: no Draft content or current qualification. */
export interface CatalogProductAuthoringResolutionCommand {
  readonly profile: "CatalogProductAuthoringResolutionCommandV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly action: "Create" | "ReplaceDraft";
  readonly operationReference: string;
  readonly productReference: string | null;
  readonly expectedAggregateVersion: number | null;
}
export interface CatalogProductAuthoringResolution {
  readonly profile: "CatalogProductAuthoringResolutionV1";
  readonly outcome: "Committed" | "Abandoned";
  readonly command: CatalogProductAuthoringResolutionCommand;
  readonly productReference: string | null;
  readonly versionReference: string | null;
  readonly aggregateVersion: number | null;
  readonly originalIntentDigest: string | null;
  readonly recordedAt: string;
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const raw = copyCategoryPersistenceValue(value);
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(raw, key))
  )
    return fail();
  return raw as Record<string, unknown>;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2147483647)
    return fail();
  return value as number;
}
export function parseCatalogProductAuthoringResolutionCommand(
  value: unknown,
): CatalogProductAuthoringResolutionCommand {
  const r = closed(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "actorReference",
    "action",
    "operationReference",
    "productReference",
    "expectedAggregateVersion",
  ]);
  if (
    r.profile !== "CatalogProductAuthoringResolutionCommandV1" ||
    (r.action !== "Create" && r.action !== "ReplaceDraft")
  )
    return fail();
  if (r.action === "Create" && (r.productReference !== null || r.expectedAggregateVersion !== null))
    return fail();
  return Object.freeze({
    profile: r.profile,
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    actorReference: parseCatalogReference(r.actorReference),
    action: r.action,
    operationReference: parseCatalogReference(r.operationReference),
    productReference: r.action === "Create" ? null : parseCatalogReference(r.productReference),
    expectedAggregateVersion: r.action === "Create" ? null : version(r.expectedAggregateVersion),
  });
}
export function parseCatalogProductAuthoringResolution(
  value: unknown,
): CatalogProductAuthoringResolution {
  const r = closed(value, [
    "profile",
    "outcome",
    "command",
    "productReference",
    "versionReference",
    "aggregateVersion",
    "originalIntentDigest",
    "recordedAt",
    "digest",
  ]);
  if (
    r.profile !== "CatalogProductAuthoringResolutionV1" ||
    (r.outcome !== "Committed" && r.outcome !== "Abandoned")
  )
    return fail();
  const command = parseCatalogProductAuthoringResolutionCommand(r.command);
  const productReference =
      r.productReference === null ? null : parseCatalogReference(r.productReference),
    versionReference =
      r.versionReference === null ? null : parseCatalogReference(r.versionReference),
    aggregateVersion = r.aggregateVersion === null ? null : version(r.aggregateVersion),
    recordedAt = parseCatalogInstant(r.recordedAt),
    originalIntentDigest = r.originalIntentDigest;
  if (r.outcome === "Abandoned") {
    if (
      productReference !== command.productReference ||
      versionReference !== null ||
      aggregateVersion !== null ||
      originalIntentDigest !== null
    )
      return fail();
  } else if (
    productReference === null ||
    versionReference === null ||
    aggregateVersion !==
      (command.action === "Create" ? 1 : (command.expectedAggregateVersion ?? 0) + 1) ||
    (command.action === "ReplaceDraft" && productReference !== command.productReference) ||
    typeof originalIntentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(originalIntentDigest)
  )
    return fail();
  const body = {
    profile: r.profile,
    outcome: r.outcome,
    command,
    productReference,
    versionReference,
    aggregateVersion,
    originalIntentDigest,
    recordedAt,
  };
  if (r.digest !== hash(body)) return fail();
  return Object.freeze({
    ...body,
    digest: r.digest as string,
  }) as CatalogProductAuthoringResolution;
}
export function buildCatalogProductAuthoringResolution(
  input: Omit<CatalogProductAuthoringResolution, "profile" | "digest">,
): CatalogProductAuthoringResolution {
  const body = { profile: "CatalogProductAuthoringResolutionV1" as const, ...input };
  return parseCatalogProductAuthoringResolution({ ...body, digest: hash(body) });
}
