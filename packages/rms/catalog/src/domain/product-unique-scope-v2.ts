import { assessProductUniqueScopeRules } from "./product-unique-scope.js";

interface SelectorTarget {
  readonly previousVersionReference: string;
  readonly previousPublicationOperationReference: string;
  readonly previousSelectorIndex: number;
}

/** Internal rule step after the public V2 contract has bound complete coverage,
 * the current target and each recorded retirement. No caller exemption list is
 * accepted by the public assessment contract. All original heads stay intact. */
export function assessProductUniqueScopeRulesV2(
  input: Parameters<typeof assessProductUniqueScopeRules>[0] & {
    readonly replacementIntent:
      | { readonly mode: "None" }
      | (SelectorTarget & { readonly mode: "PermanentSelectorRetirement" });
    readonly retirementHeaders: readonly {
      readonly retirements: readonly {
        readonly replacementIntent: SelectorTarget;
        readonly retiredAt: string;
      }[];
    }[];
  },
) {
  const original = assessProductUniqueScopeRules(input),
    proposed = input.replacementIntent,
    findings = original.findings.filter((finding) => {
      if (finding.reason !== "EQUAL_RANK_REQUIRES_DISPOSITION") return true;
      if (
        proposed.mode === "PermanentSelectorRetirement" &&
        finding.selectorIndex === 0 &&
        finding.versionReference === proposed.previousVersionReference &&
        finding.counterpartIndex === proposed.previousSelectorIndex
      )
        return false;
      return !input.retirementHeaders.some((header) =>
        header.retirements.some(
          (row) =>
            row.retiredAt <= input.observedAt &&
            finding.versionReference === row.replacementIntent.previousVersionReference &&
            finding.counterpartIndex === row.replacementIntent.previousSelectorIndex,
        ),
      );
    });
  // In particular, an inactive retired Store still retains its non-equal
  // registration finding. Retirement does not supply operational qualification.
  return Object.freeze({
    ...original,
    check: Object.freeze({
      code: "UniqueScope" as const,
      outcome: findings.length === 0 ? ("Pass" as const) : ("HardError" as const),
    }),
    findings: Object.freeze(findings),
    equalRankResolution:
      proposed.mode === "None"
        ? ("NoReplacementRequested" as const)
        : ("ExactStoreSelectorRetirementBound" as const),
  });
}
