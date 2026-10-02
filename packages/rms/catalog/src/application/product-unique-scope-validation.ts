import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogInstant } from "../contracts/product.js";
import { copyCategoryPersistenceValue } from "../contracts/category-persistence.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationValidation,
} from "../contracts/product-publication.js";
import type { CatalogProductUniqueScopeAssessment } from "../contracts/product-unique-scope.js";

/** Minimal held-owner binding, not a source or authorization receipt. */
export type ProductUniqueScopeValidationBinding = Pick<
  CatalogProductUniqueScopeAssessment,
  | "tenantReference"
  | "brandReference"
  | "productReference"
  | "versionReference"
  | "aggregateVersion"
  | "originalIntentDigest"
  | "policyReference"
  | "policyVersion"
  | "observedAt"
  | "validUntil"
  | "check"
> & {
  readonly contentDigest: string;
  readonly configurationDigest: string;
};
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Catalog owns the one-check replacement and consistent hard-error summary.
 * Actual current acquisition/permission stays mandatory in the source consumer.
 * No other check, warning acknowledgment or evidence can be inferred here. */
export function applyCatalogProductUniqueScopeValidation(
  commandValue: unknown,
  validationValue: unknown,
  scopeValue: ProductUniqueScopeValidationBinding,
  nowValue: unknown,
) {
  try {
    const c = parseProductPublicationCommand(copyCategoryPersistenceValue(commandValue)),
      v = parseProductPublicationValidation(copyCategoryPersistenceValue(validationValue)),
      scope = copyCategoryPersistenceValue(scopeValue) as ProductUniqueScopeValidationBinding,
      now = parseCatalogInstant(nowValue);
    const keys = [
      "tenantReference",
      "brandReference",
      "productReference",
      "versionReference",
      "aggregateVersion",
      "contentDigest",
      "configurationDigest",
      "originalIntentDigest",
      "policyReference",
      "policyVersion",
      "observedAt",
      "validUntil",
      "check",
    ];
    if (
      !scope ||
      typeof scope !== "object" ||
      Array.isArray(scope) ||
      Object.keys(scope).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(scope, k))
    )
      return fail();
    const observed = parseCatalogInstant(scope.observedAt),
      until = parseCatalogInstant(scope.validUntil),
      check = scope.check;
    if (
      c.action !== "Validate" ||
      c.actorKind !== "User" ||
      scope.tenantReference !== c.tenantReference ||
      scope.brandReference !== c.brandReference ||
      scope.productReference !== c.productReference ||
      scope.versionReference !== c.versionReference ||
      scope.aggregateVersion !== c.expectedProductAggregateVersion ||
      scope.contentDigest !== c.contentDigest ||
      scope.configurationDigest !== c.configurationDigest ||
      scope.originalIntentDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(c)) ||
      scope.policyReference !== v.policyReference ||
      scope.policyVersion !== v.policyVersion ||
      v.productAggregateVersion !== c.expectedProductAggregateVersion ||
      v.contentDigest !== c.contentDigest ||
      v.configurationDigest !== c.configurationDigest ||
      v.scopeDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(c.scopeSet)) ||
      v.periodDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(c.effectivePeriod)) ||
      c.occurredAt > observed ||
      observed > now ||
      until <= now ||
      Date.parse(until) - Date.parse(observed) > 5000 ||
      v.checkedAt > now ||
      v.validUntil <= now ||
      !check ||
      Object.keys(check).length !== 2 ||
      check.code !== "UniqueScope" ||
      !["Pass", "HardError"].includes(check.outcome) ||
      v.checks.find((x) => x.code === "UniqueScope")?.outcome !== "Pass"
    )
      return fail();
    const individual = v.checks
        .filter((x) => x.code !== "HardErrorsCleared")
        .map((x) => (x.code === "UniqueScope" ? check : x)),
      hard = individual.some((x) => x.outcome === "HardError");
    return parseProductPublicationValidation({
      ...v,
      checks: [...individual, { code: "HardErrorsCleared", outcome: hard ? "HardError" : "Pass" }],
      validUntil: until < v.validUntil ? until : v.validUntil,
    });
  } catch {
    return fail();
  }
}
