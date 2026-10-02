import { CatalogError, parseCatalogInstant } from "../contracts/product.js";
import { copyCategoryPersistenceValue } from "../contracts/category-persistence.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationValidation,
} from "../contracts/product-publication.js";
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
    // The existing owning binder validates the entire closed scope packet,
    // full12 receipt, original intent/root/digests/policy and exclusive lease.
    const validation = applyCatalogProductUniqueScopeValidation(
      command,
      validationValue,
      scope,
      now,
    );
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
    return parseProductPublicationValidation({
      ...validation,
      checks: [
        ...individual,
        {
          code: "HardErrorsCleared",
          outcome: individual.some((check) => check.outcome === "HardError") ? "HardError" : "Pass",
        },
      ],
    });
  } catch {
    // Preserve Actor/Reason. An acknowledgement made inconsistent by a newly
    // found HardError is unavailable; never rewrite it into an override.
    return fail();
  }
}
