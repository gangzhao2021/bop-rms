import type { OptionSetEditorContent } from "./option-set-editor-content.js";

/** Parsed candidate rules. Media presence and text are not asset qualification;
 * every graph node is checked even when a feasible witness leaves it inactive. */
export function assessOptionSetContentPolicyRules(
  contents: readonly OptionSetEditorContent[],
  constraints: {
    readonly requiredLocales: readonly string[];
    readonly mediaRequirement: "Optional" | "Required";
    readonly effectiveFrom: string;
    readonly effectiveUntil: string | null;
  },
  activationAt: string,
) {
  const at = Date.parse(activationAt);
  const checks = Object.freeze([
    [
      "RequiredSetNames",
      contents.every((n) =>
        constraints.requiredLocales.every((l) =>
          Boolean(n.sourceAggregate.draft.localizedNames[l]),
        ),
      ),
    ],
    [
      "RequiredOptionNames",
      contents.every((n) =>
        n.sourceAggregate.draft.options.every((o) =>
          constraints.requiredLocales.every((l) => Boolean(o.localizedNames[l])),
        ),
      ),
    ],
    [
      "RequiredMediaPresence",
      constraints.mediaRequirement === "Optional" ||
        contents.every((n) =>
          n.sourceAggregate.draft.options.every(
            (o) =>
              o.lifecycle === "Archived" ||
              n.optionDetails.some(
                (d) => d.optionReference === o.optionReference && d.media !== null,
              ),
          ),
        ),
    ],
    [
      "RequiredMediaAltText",
      contents.every((n) =>
        n.optionDetails.every(
          (d) =>
            d.media === null ||
            constraints.requiredLocales.every((l) => Boolean(d.media?.altText[l])),
        ),
      ),
    ],
    [
      "CandidateEffectiveAtActivation",
      contents.every(
        (n) =>
          Date.parse(n.effectivePeriod.effectiveFrom.instant) <= at &&
          (n.effectivePeriod.effectiveUntil === null ||
            at < Date.parse(n.effectivePeriod.effectiveUntil.instant)),
      ),
    ],
    [
      "PolicyEffectiveAtActivation",
      Date.parse(constraints.effectiveFrom) <= at &&
        (constraints.effectiveUntil === null || at < Date.parse(constraints.effectiveUntil)),
    ],
  ] as const).map(([code, pass]) =>
    Object.freeze({ code, outcome: pass ? ("Pass" as const) : ("HardError" as const) }),
  );
  return Object.freeze(checks);
}
