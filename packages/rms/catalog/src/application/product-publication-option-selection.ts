import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "../contracts/category-persistence.js";
import {
  CatalogError,
  parseCatalogReference,
  parseProductAggregate,
} from "../contracts/product.js";

type RuleCode = "OPTION_TRIGGER_CYCLE" | "OPTION_RULES_UNSATISFIABLE";
export interface CatalogProductPinnedOptionSelectionAssessment {
  readonly check: { readonly code: "OptionSelection"; readonly outcome: "Pass" | "HardError" };
  readonly findings: readonly {
    readonly checkCode: "OptionSelection";
    readonly outcome: "HardError";
    readonly ruleCode: RuleCode;
    readonly subjectReference: string;
    readonly reasonCode: RuleCode;
    readonly references: readonly {
      readonly sourceCode: "PINNED_OPTION_RULES";
      readonly resourceReference: string;
      readonly versionReference: string;
    }[];
  }[];
}
export interface CatalogProductOptionSelectionAssessment {
  readonly check: CatalogProductPinnedOptionSelectionAssessment["check"];
  readonly findings: readonly (Omit<
    CatalogProductPinnedOptionSelectionAssessment["findings"][number],
    "references"
  > & {
    readonly references: readonly {
      readonly sourceCode: "PINNED_OPTION_RULES" | "CURRENT_PUBLISHED_OPTION_RULES";
      readonly resourceReference: string;
      readonly versionReference: string;
    }[];
  })[];
}
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(result, key))
  )
    return unavailable();
  return result;
}
function contradiction(status: unknown, reason: unknown): RuleCode | null {
  if (status === "Satisfiable" && reason === null) return null;
  if (status === "Unsatisfiable") {
    if (reason === "TriggerCycle") return "OPTION_TRIGGER_CYCLE";
    if (reason === "NoSelection") return "OPTION_RULES_UNSATISFIABLE";
  }
  // Indeterminate (including incomplete/ambiguous graph and search limits) and
  // unknown or mismatched result tuples never establish a business outcome.
  return unavailable();
}

/** Pure OptionSelection only. Callers retain actual Product and full pinned graph
 * authority and original leases. These summaries do not prove their acquisition,
 * current Published resolution, another check, or overall publication readiness. */
export function assessCatalogProductPinnedOptionSelection(
  value: unknown,
): CatalogProductPinnedOptionSelectionAssessment {
  return assessSelection(value, false);
}
/** Pure per-Binding business assessment. Mode/provenance summaries must come
 * from the matching owning source inside its held callback. Parsing them does
 * not acquire current Published authority or complete publication eligibility. */
export function assessCatalogProductOptionSelection(
  value: unknown,
): CatalogProductOptionSelectionAssessment {
  return assessSelection(value, true);
}
function assessSelection(
  value: unknown,
  mixed: false,
): CatalogProductPinnedOptionSelectionAssessment;
function assessSelection(value: unknown, mixed: true): CatalogProductOptionSelectionAssessment;
function assessSelection(value: unknown, mixed: boolean): CatalogProductOptionSelectionAssessment {
  const input = record(copyCategoryPersistenceValue(value), ["aggregate", "assessments"]),
    aggregate = parseProductAggregate(input.aggregate),
    content = aggregate.draft.editorContent,
    bindings = aggregate.draft.optionBindings;
  if (
    !content ||
    content.optionRules.some(
      (rule) =>
        (!mixed && rule.versionResolution !== "Pinned") ||
        rule.conditionalRule !== null ||
        rule.conflictRule !== null,
    ) ||
    !Array.isArray(input.assessments) ||
    input.assessments.length !== bindings.length
  )
    return unavailable();
  const seen = new Set<string>(),
    findings: CatalogProductOptionSelectionAssessment["findings"][number][] = [];
  for (const value of input.assessments) {
    const assessment = record(value, [
        "bindingReference",
        "bindingDigest",
        "rootOptionSetReference",
        "rootVersionReference",
        "status",
        "reason",
        ...(mixed ? ["versionResolution", "sourceAuthority"] : []),
      ]),
      bindingReference = parseCatalogReference(assessment.bindingReference),
      set = parseCatalogReference(assessment.rootOptionSetReference),
      version = parseCatalogReference(assessment.rootVersionReference),
      binding = bindings.find((item) => item.bindingReference === bindingReference),
      rule = content.optionRules.find((item) => item.bindingReference === bindingReference);
    if (
      !binding ||
      seen.has(bindingReference) ||
      assessment.bindingDigest !== hash(binding) ||
      set !== binding.optionSetReference ||
      version !== binding.optionSetVersionReference
    )
      return unavailable();
    if (
      mixed &&
      (!rule ||
        (assessment.versionResolution !== "Pinned" &&
          assessment.versionResolution !== "CurrentPublished") ||
        assessment.versionResolution !== rule.versionResolution ||
        assessment.sourceAuthority !==
          (rule.versionResolution === "Pinned"
            ? "RecordedFrozen"
            : "CurrentPublishingReleaseAndFrozenContent"))
    )
      return unavailable();
    seen.add(bindingReference);
    const ruleCode = contradiction(assessment.status, assessment.reason);
    if (ruleCode !== null)
      findings.push(
        Object.freeze({
          checkCode: "OptionSelection" as const,
          outcome: "HardError" as const,
          ruleCode,
          subjectReference: bindingReference,
          reasonCode: ruleCode,
          references: Object.freeze([
            Object.freeze({
              sourceCode:
                mixed && rule?.versionResolution === "CurrentPublished"
                  ? ("CURRENT_PUBLISHED_OPTION_RULES" as const)
                  : ("PINNED_OPTION_RULES" as const),
              resourceReference: set,
              versionReference: version,
            }),
          ]),
        }),
      );
  }
  // Sorting makes the output independent of acquisition order, while preserving
  // distinct Binding identities even when they pin the same Option Set/version.
  findings.sort((left, right) => left.subjectReference.localeCompare(right.subjectReference, "en"));
  return Object.freeze({
    check: Object.freeze({
      code: "OptionSelection" as const,
      outcome: findings.length === 0 ? ("Pass" as const) : ("HardError" as const),
    }),
    findings: Object.freeze(findings),
  });
}
