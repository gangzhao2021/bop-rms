import { CatalogError, parseCatalogInstant } from "../contracts/product.js";
import { copyCategoryPersistenceValue } from "../contracts/category-persistence.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationValidation,
  type ProductPublicationCommand,
  type ProductPublicationValidation,
} from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  type ProductPublicationValidationV2,
} from "../contracts/product-publication-v2.js";
import {
  parseCatalogProductUniqueScopeAssessmentV2,
  type CatalogProductUniqueScopeAssessmentV2,
} from "../contracts/product-unique-scope-v2.js";
import { applyCatalogProductUniqueScopeValidationV2 } from "./product-unique-scope-validation-v2.js";
import type { CatalogCurrentProductValidationCandidate } from "../contracts/product-validation-candidate.js";
import {
  applyCatalogProductUniqueScopeValidation,
  type ProductUniqueScopeValidationBinding,
} from "./product-unique-scope-validation.js";

export type ProductCandidateValidationBinding = ProductUniqueScopeValidationBinding & {
  readonly skuPrerequisite: CatalogCurrentProductValidationCandidate["skuPrerequisite"];
  readonly variantMappingPrerequisite: CatalogCurrentProductValidationCandidate["variantMappingPrerequisite"];
  readonly optionSelectionPrerequisite: CatalogCurrentProductValidationCandidate["optionSelectionPrerequisite"];
  readonly optionRulePrerequisite: "Unsatisfiable" | "NoMechanicalContradiction";
  readonly internalCodeCheck: CatalogCurrentProductValidationCandidate["internalCodeCheck"];
};
type CandidatePrerequisites = Pick<
  ProductCandidateValidationBinding,
  | "skuPrerequisite"
  | "variantMappingPrerequisite"
  | "optionSelectionPrerequisite"
  | "optionRulePrerequisite"
  | "internalCodeCheck"
>;
export interface ProductCandidateValidationBindingV2 extends CandidatePrerequisites {
  readonly profile: "CatalogProductCandidateValidationBindingV2";
  readonly scopeAssessment: CatalogProductUniqueScopeAssessmentV2;
  readonly candidateObservedAt: string;
  readonly candidateValidUntil: string;
  readonly validUntil: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Bind the owning current code check and content necessary conditions.
 * Empty SKUs, pending Variants and explicit default bound violations fail Section68.9.
 * An ended half-open EffectivePeriod also fails the owning publication time rule.
 * Presence or absence never replaces independent validation with Pass. */
export function applyCatalogProductCandidateValidation(
  commandValue: unknown,
  validationValue: unknown,
  candidateValue: ProductCandidateValidationBinding,
  nowValue: unknown,
) {
  try {
    const command = parseProductPublicationCommand(copyCategoryPersistenceValue(commandValue)),
      now = parseCatalogInstant(nowValue),
      candidate = copyCategoryPersistenceValue(candidateValue) as ProductCandidateValidationBinding;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return fail();
    const {
      skuPrerequisite,
      variantMappingPrerequisite,
      optionSelectionPrerequisite,
      optionRulePrerequisite,
      internalCodeCheck,
      ...scope
    } = candidate;
    const prerequisites = {
      skuPrerequisite,
      variantMappingPrerequisite,
      optionSelectionPrerequisite,
      optionRulePrerequisite,
      internalCodeCheck,
    };
    validatePrerequisites(prerequisites);
    // The existing owning binder validates the entire closed scope packet,
    // full12 receipt, original intent/root/digests/policy and exclusive lease.
    const validation = applyCatalogProductUniqueScopeValidation(
      command,
      validationValue,
      scope,
      now,
    );
    return mergeCandidateChecks(
      command,
      validation,
      prerequisites,
      now,
      parseProductPublicationValidation,
    );
  } catch {
    // Preserve Actor/Reason. An acknowledgement made inconsistent by a newly
    // found HardError is unavailable; never rewrite it into an override.
    return fail();
  }
}
/** Explicit complete V2 scope proof plus held candidate/Option necessary facts.
 * validUntil is the original joined deadline, not a newly started subsource lease. */
export function applyCatalogProductCandidateValidationV2(
  commandValue: unknown,
  validationValue: unknown,
  candidateValue: ProductCandidateValidationBindingV2,
  nowValue: unknown,
) {
  try {
    const c = parseProductPublicationCommandV2(commandValue),
      now = parseCatalogInstant(nowValue),
      candidate = copyCategoryPersistenceValue(
        candidateValue,
      ) as ProductCandidateValidationBindingV2,
      keys = [
        "profile",
        "scopeAssessment",
        "candidateObservedAt",
        "candidateValidUntil",
        "validUntil",
        "skuPrerequisite",
        "variantMappingPrerequisite",
        "optionSelectionPrerequisite",
        "optionRulePrerequisite",
        "internalCodeCheck",
      ];
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.keys(candidate).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(candidate, key)) ||
      candidate.profile !== "CatalogProductCandidateValidationBindingV2"
    )
      return fail();
    validatePrerequisites(candidate);
    const scope = parseCatalogProductUniqueScopeAssessmentV2(candidate.scopeAssessment),
      observedAt = parseCatalogInstant(candidate.candidateObservedAt),
      until = parseCatalogInstant(candidate.candidateValidUntil),
      joinedUntil = parseCatalogInstant(candidate.validUntil);
    if (
      c.occurredAt > observedAt ||
      observedAt > scope.observedAt ||
      observedAt > now ||
      until <= now ||
      until <= observedAt ||
      Date.parse(until) - Date.parse(observedAt) > 30000 ||
      joinedUntil <= now ||
      joinedUntil > until ||
      joinedUntil > scope.validUntil ||
      Date.parse(joinedUntil) - Date.parse(observedAt) > 5000
    )
      return fail();
    const validation = applyCatalogProductUniqueScopeValidationV2(c, validationValue, scope, now);
    return mergeCandidateChecks(
      c,
      parseProductPublicationValidationV2({
        ...validation,
        validUntil: joinedUntil < validation.validUntil ? joinedUntil : validation.validUntil,
      }),
      candidate,
      now,
      parseProductPublicationValidationV2,
    );
  } catch {
    return fail();
  }
}
function validatePrerequisites({
  skuPrerequisite,
  variantMappingPrerequisite,
  optionSelectionPrerequisite,
  optionRulePrerequisite,
  internalCodeCheck,
}: CandidatePrerequisites) {
  if (
    optionRulePrerequisite !== "Unsatisfiable" &&
    optionRulePrerequisite !== "NoMechanicalContradiction"
  )
    return fail();
  if (skuPrerequisite !== "NoActiveMember" && skuPrerequisite !== "ActiveMemberPresent")
    return fail();
  if (
    optionSelectionPrerequisite !== "ExplicitDefaultBoundsViolated" &&
    optionSelectionPrerequisite !== "NoExplicitDefaultBoundsViolation"
  )
    return fail();
  if (
    variantMappingPrerequisite !== "UnmappedCombinationPresent" &&
    variantMappingPrerequisite !== "NoExplicitUnmappedCombination"
  )
    return fail();
  if (
    !internalCodeCheck ||
    typeof internalCodeCheck !== "object" ||
    Array.isArray(internalCodeCheck) ||
    Object.keys(internalCodeCheck).length !== 2 ||
    internalCodeCheck.code !== "InternalCode" ||
    !["Pass", "HardError"].includes(internalCodeCheck.outcome)
  )
    return fail();
}
function mergeCandidateChecks<
  V extends ProductPublicationValidation | ProductPublicationValidationV2,
>(
  command: ProductPublicationCommand,
  validation: V,
  {
    skuPrerequisite,
    variantMappingPrerequisite,
    optionSelectionPrerequisite,
    optionRulePrerequisite,
    internalCodeCheck,
  }: CandidatePrerequisites,
  now: string,
  parseValidation: (value: unknown) => V,
): V {
  if (validation.checks.find((check) => check.code === "InternalCode")?.outcome !== "Pass")
    return fail();
  const individual = validation.checks
    .filter((check) => check.code !== "HardErrorsCleared")
    .map((check) =>
      check.code === "InternalCode"
        ? internalCodeCheck
        : (check.code === "PublishableSku" && skuPrerequisite === "NoActiveMember") ||
            (check.code === "EffectivePeriod" &&
              command.effectivePeriod.effectiveUntil !== null &&
              command.effectivePeriod.effectiveUntil.instant <= now) ||
            (check.code === "VariantMapping" &&
              variantMappingPrerequisite === "UnmappedCombinationPresent") ||
            (check.code === "OptionSelection" &&
              (optionSelectionPrerequisite === "ExplicitDefaultBoundsViolated" ||
                optionRulePrerequisite === "Unsatisfiable"))
          ? { code: check.code, outcome: "HardError" as const }
          : check,
    );
  // An outstanding V2 approval is retained; only an actual HardError affects this summary.
  return parseValidation({
    ...validation,
    checks: [
      ...individual,
      {
        code: "HardErrorsCleared",
        outcome: individual.some((check) => check.outcome === "HardError") ? "HardError" : "Pass",
      },
    ],
  });
}
