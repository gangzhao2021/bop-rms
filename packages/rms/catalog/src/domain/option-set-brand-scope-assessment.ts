import type { OptionSetEditorContent } from "./option-set-editor-content.js";

/** Business assessment of represented facts. Acquisition and current authority
 * belong to the held owning sources, never to this pure rule function. */
export function assessOptionSetBrandScopeRules(
  contents: readonly OptionSetEditorContent[],
  brand: {
    readonly supportedLocales: readonly string[];
    readonly effectiveFrom: string;
    readonly effectiveUntil: string | null;
  },
  topology: {
    readonly brandLifecycle: string;
    readonly references: readonly { readonly storeReference: string; readonly lifecycle: string }[];
  },
  activationAt: string,
) {
  const supported = new Set(brand.supportedLocales);
  const localeKeys = (names: Readonly<Record<string, string>>) =>
    Object.keys(names).every((locale) => supported.has(locale));
  const locales = contents.every((content) => {
    const draft = content.sourceAggregate.draft;
    return (
      supported.has(draft.defaultLocale) &&
      localeKeys(draft.localizedNames) &&
      localeKeys(draft.localizedDescriptions) &&
      draft.options.every(
        (option) => localeKeys(option.localizedNames) && localeKeys(option.localizedDescriptions),
      ) &&
      content.optionDetails.every(
        (detail) => detail.media === null || localeKeys(detail.media.altText),
      )
    );
  });
  const period =
    brand.effectiveFrom <= activationAt &&
    (brand.effectiveUntil === null || activationAt < brand.effectiveUntil);
  const selectors = contents.flatMap((content) => content.scopeSet);
  const unavailableStore = selectors.some(
    (selector) =>
      selector.level === "Store" &&
      !topology.references.some(
        (store) => store.storeReference === selector.reference && store.lifecycle === "Active",
      ),
  );
  const incomplete = selectors.some(
    (selector) =>
      !["Brand", "Store"].includes(selector.level) ||
      selector.channelCodes.length !== 0 ||
      selector.orderTypeCodes.length !== 0,
  );
  const checks = Object.freeze([
    Object.freeze({
      code: "SupportedLocales" as const,
      outcome: locales ? ("Pass" as const) : ("HardError" as const),
    }),
    Object.freeze({
      code: "BrandEffectiveAtActivation" as const,
      outcome: period ? ("Pass" as const) : ("HardError" as const),
    }),
    Object.freeze({
      code: "ScopeTopology" as const,
      outcome:
        topology.brandLifecycle !== "Active" || unavailableStore
          ? ("HardError" as const)
          : incomplete
            ? ("Indeterminate" as const)
            : ("Pass" as const),
    }),
  ]);
  return Object.freeze({
    checks,
    decision: checks.some((check) => check.outcome === "HardError")
      ? ("HardError" as const)
      : incomplete
        ? ("Indeterminate" as const)
        : ("PassForAssessedBrandStoreRules" as const),
    missingSources: Object.freeze(
      [
        ...new Set(
          selectors.flatMap((selector) => [
            ...(["Region", "StoreGroup"].includes(selector.level)
              ? [selector.level + "Membership"]
              : []),
            ...(selector.level === "Channel" || selector.channelCodes.length !== 0
              ? ["ChannelRegistration"]
              : []),
            ...(selector.level === "OrderType" || selector.orderTypeCodes.length !== 0
              ? ["OrderTypeStoreConfiguration"]
              : []),
          ]),
        ),
      ].sort(),
    ),
  });
}
