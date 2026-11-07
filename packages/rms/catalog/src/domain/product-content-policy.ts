import type { ProductAggregate } from "./product.js";
export interface ProductContentPolicyConstraints {
  readonly supportedLocales: readonly string[];
  readonly requiredLocales: readonly string[];
  readonly mediaRequirement: "Optional" | "Required";
}
/** Candidate rules only. Presence never certifies a Media rendition or reference. */
export function assessProductContentPolicyRules(
  aggregate: ProductAggregate,
  constraints: ProductContentPolicyConstraints,
) {
  const draft = aggregate.draft,
    content = draft.editorContent;
  const enabled = new Set(constraints.supportedLocales);
  const localeMaps = [
    draft.localizedNames,
    ...draft.skus.map((sku) => sku.localizedNames),
    ...(content === undefined
      ? []
      : [
          content.localizedShortDescriptions,
          content.localizedDescriptions,
          content.preparationNotes,
          ...content.media.map((m) => m.altText),
          ...content.variantDimensions.flatMap((dimension) => [
            dimension.localizedNames,
            ...dimension.values.map((value) => value.localizedNames),
          ]),
        ]),
  ];
  const checks = Object.freeze([
    Object.freeze({
      code: "SupportedLocales" as const,
      outcome:
        enabled.has(draft.defaultLocale) &&
        localeMaps.every((map) => Object.keys(map).every((locale) => enabled.has(locale)))
          ? ("Pass" as const)
          : ("HardError" as const),
    }),
    Object.freeze({
      code: "RequiredProductNames" as const,
      outcome: constraints.requiredLocales.every(
        (locale) => enabled.has(locale) && Boolean(draft.localizedNames[locale]),
      )
        ? ("Pass" as const)
        : ("HardError" as const),
    }),
    Object.freeze({
      code: "CompleteContent" as const,
      outcome: content === undefined ? ("HardError" as const) : ("Pass" as const),
    }),
    Object.freeze({
      code: "RequiredMediaPresence" as const,
      outcome:
        constraints.mediaRequirement === "Optional" ||
        (content !== undefined && content.media.length > 0)
          ? ("Pass" as const)
          : ("HardError" as const),
    }),
  ]);
  return Object.freeze({
    checks,
    decision: checks.some((c) => c.outcome === "HardError")
      ? ("HardError" as const)
      : ("PassForAssessedRules" as const),
  });
}

/** Draft configuration may be incomplete. Its warnings never stand in for the
 * separate publication threshold, and reference/readiness checks stay external. */
export function assessProductDraftContentPolicyRules(
  aggregate: ProductAggregate,
  constraints: ProductContentPolicyConstraints,
) {
  const draft = aggregate.draft,
    content = draft.editorContent,
    enabled = new Set(constraints.supportedLocales),
    localeMaps = [
      draft.localizedNames,
      ...draft.skus.map((sku) => sku.localizedNames),
      ...(content === undefined
        ? []
        : [
            content.localizedShortDescriptions,
            content.localizedDescriptions,
            content.preparationNotes,
            ...content.media.map((media) => media.altText),
            ...content.variantDimensions.flatMap((dimension) => [
              dimension.localizedNames,
              ...dimension.values.map((value) => value.localizedNames),
            ]),
          ]),
    ];
  const checks = Object.freeze([
    Object.freeze({
      code: "SupportedLocales" as const,
      outcome:
        enabled.has(draft.defaultLocale) &&
        localeMaps.every((map) => Object.keys(map).every((locale) => enabled.has(locale)))
          ? ("Pass" as const)
          : ("HardError" as const),
    }),
    Object.freeze({
      code: "RequiredProductNames" as const,
      outcome: constraints.requiredLocales.every(
        (locale) => enabled.has(locale) && Boolean(draft.localizedNames[locale]),
      )
        ? ("Pass" as const)
        : ("Warning" as const),
    }),
    Object.freeze({
      code: "CompleteContent" as const,
      outcome: content === undefined ? ("HardError" as const) : ("Pass" as const),
    }),
    Object.freeze({
      code: "RequiredMediaPresence" as const,
      outcome:
        constraints.mediaRequirement === "Optional" ||
        (content !== undefined && content.media.length > 0)
          ? ("Pass" as const)
          : ("Warning" as const),
    }),
  ]);
  return Object.freeze({
    checks,
    decision: checks.some((check) => check.outcome === "HardError")
      ? ("HardError" as const)
      : ("PassForAssessedDraftRules" as const),
  });
}
