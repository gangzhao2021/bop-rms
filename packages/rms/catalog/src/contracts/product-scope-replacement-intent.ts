import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError, parseCatalogHash, parseCatalogReference } from "./product.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationVersion,
} from "./product-publication.js";

export interface CatalogProductScopeReplacementIntent {
  readonly profile: "CatalogProductExactStoreSelectorReplacementV1";
  readonly mode: "PermanentSelectorRetirement";
  readonly previousVersionReference: string;
  readonly previousPublicationOperationReference: string;
  readonly expectedPreviousPublicationVersion: number;
  readonly previousIntentDigest: string;
  readonly previousScopeDigest: string;
  readonly previousPeriodDigest: string;
  readonly previousSelectorIndex: number;
  readonly previousSelectorDigest: string;
  readonly digest: string;
}

/** Explicit absence of a requested disposition, never absence of current scope checks. */
export interface CatalogProductNoReplacementIntent {
  readonly profile: "CatalogProductNoReplacementIntentV1";
  readonly mode: "None";
  readonly digest: string;
}
export type CatalogProductPublicationReplacementIntent =
  CatalogProductScopeReplacementIntent | CatalogProductNoReplacementIntent;

const fields = [
  "profile",
  "mode",
  "previousVersionReference",
  "previousPublicationOperationReference",
  "expectedPreviousPublicationVersion",
  "previousIntentDigest",
  "previousScopeDigest",
  "previousPeriodDigest",
  "previousSelectorIndex",
  "previousSelectorDigest",
  "digest",
] as const;
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const hash = (value: unknown): string => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function digest(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(value.slice(7));
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    return fail();
  return value as number;
}

/** Immutable proposed target only. Parsing supplies no current owner, permission,
 * coverage, approval or retirement evidence. Existing V1 commands remain closed. */
export function parseCatalogProductScopeReplacementIntent(
  value: unknown,
): CatalogProductScopeReplacementIntent {
  try {
    const captured = copyCategoryPersistenceValue(value);
    if (!captured || typeof captured !== "object" || Array.isArray(captured)) return fail();
    const r = captured as Record<string, unknown>;
    if (
      Object.keys(r).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(r, field)) ||
      r.profile !== "CatalogProductExactStoreSelectorReplacementV1" ||
      r.mode !== "PermanentSelectorRetirement"
    )
      return fail();
    const body = {
      profile: "CatalogProductExactStoreSelectorReplacementV1" as const,
      mode: "PermanentSelectorRetirement" as const,
      previousVersionReference: parseCatalogReference(r.previousVersionReference),
      previousPublicationOperationReference: parseCatalogReference(
        r.previousPublicationOperationReference,
      ),
      expectedPreviousPublicationVersion: integer(
        r.expectedPreviousPublicationVersion,
        1,
        2147483647,
      ),
      previousIntentDigest: digest(r.previousIntentDigest),
      previousScopeDigest: digest(r.previousScopeDigest),
      previousPeriodDigest: digest(r.previousPeriodDigest),
      previousSelectorIndex: integer(r.previousSelectorIndex, 0, 999),
      previousSelectorDigest: digest(r.previousSelectorDigest),
    };
    const intentDigest = digest(r.digest);
    if (intentDigest !== hash(body)) return fail();
    return Object.freeze({ ...body, digest: intentDigest });
  } catch {
    return fail();
  }
}

/** The existing exact shape stays byte-compatible. None is closed and hashed too;
 * neither branch supplies current ownership, uniqueness or retirement evidence. */
export function parseCatalogProductPublicationReplacementIntent(
  value: unknown,
): CatalogProductPublicationReplacementIntent {
  const captured = copyCategoryPersistenceValue(value);
  if (!captured || typeof captured !== "object" || Array.isArray(captured)) return fail();
  const r = captured as Record<string, unknown>;
  if (r.profile === "CatalogProductExactStoreSelectorReplacementV1")
    return parseCatalogProductScopeReplacementIntent(captured);
  if (
    Object.keys(r).length !== 3 ||
    ["profile", "mode", "digest"].some((key) => !Object.hasOwn(r, key)) ||
    r.profile !== "CatalogProductNoReplacementIntentV1" ||
    r.mode !== "None"
  )
    return fail();
  const body = { profile: "CatalogProductNoReplacementIntentV1" as const, mode: "None" as const };
  if (digest(r.digest) !== hash(body)) return fail();
  return Object.freeze({ ...body, digest: hash(body) });
}

/** Bind only the supplied original V1 Published tuple and exact Store selector.
 * A held owning source must separately prove that this is the current head and
 * has not already been retired. This function performs no lifecycle transition. */
export function bindCatalogProductScopeReplacementIntent(
  intentValue: unknown,
  previousPublicationValue: unknown,
  incomingCommandValue: unknown,
): CatalogProductScopeReplacementIntent {
  const intent = parseCatalogProductScopeReplacementIntent(intentValue),
    previousValue = copyCategoryPersistenceValue(previousPublicationValue),
    previous = parseProductPublicationVersion(previousValue),
    incoming = parseProductPublicationCommand(incomingCommandValue);
  // The ordinal addresses the original persisted array. Do not normalize a
  // reordered source and silently make its supplied ordinal mean another Store.
  if (canonicalizeRfc8785(previousValue) !== canonicalizeRfc8785(previous)) return fail();
  if (
    previous.state !== "Published" ||
    previous.tenantReference !== incoming.tenantReference ||
    previous.brandReference !== incoming.brandReference ||
    previous.productReference !== incoming.productReference ||
    previous.versionReference === incoming.versionReference ||
    // Replacement is a new operation after the original publication advanced
    // the Product root; reusing that operation or its source root is not a new intent.
    previous.operationReference === incoming.operationReference ||
    previous.productAggregateVersion >= incoming.expectedProductAggregateVersion ||
    // A target cannot come from later history than the proposed replacement.
    previous.occurredAt > incoming.occurredAt ||
    // Whole-version Supersede would also remove the retained Store selectors.
    incoming.action === "Supersede" ||
    previous.versionReference !== intent.previousVersionReference ||
    previous.operationReference !== intent.previousPublicationOperationReference ||
    previous.publicationVersion !== intent.expectedPreviousPublicationVersion ||
    previous.intentDigest !== intent.previousIntentDigest ||
    previous.scopeDigest !== intent.previousScopeDigest ||
    previous.periodDigest !== intent.previousPeriodDigest ||
    previous.scopeSet.length < 2 ||
    previous.scopeSet.some((scope) => scope.level !== "Store") ||
    new Set(previous.scopeSet.map((scope) => scope.reference)).size !== previous.scopeSet.length ||
    incoming.scopeSet.length !== 1
  )
    return fail();
  const targeted = previous.scopeSet[intent.previousSelectorIndex],
    proposed = incoming.scopeSet[0];
  if (
    !targeted ||
    !proposed ||
    proposed.level !== "Store" ||
    hash(targeted) !== intent.previousSelectorDigest ||
    canonicalizeRfc8785(targeted) !== canonicalizeRfc8785(proposed)
  )
    return fail();
  return intent;
}
