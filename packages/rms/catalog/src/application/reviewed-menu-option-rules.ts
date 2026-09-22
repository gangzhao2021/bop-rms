import {
  CatalogError,
  parseCatalogCode,
  parseLocalizedNames,
  type ProductOptionBinding,
} from "../contracts/product.js";
import type { OptionSetAggregate } from "../contracts/option-set.js";
import type { PublishedOptionRule } from "../contracts/published-menu-projection.js";
import type { CatalogResolvedSelectionRule } from "./ports/selection-validation-ports.js";

/** Project current resolved quantity semantics into the versioned display
 * contract. Full source metadata remains in the review source digest.
 * Complete content parsing subsequently validates per-channel graph integrity.
 */
export function buildReviewedMenuOptionRules(
  channels: readonly {
    channelCode: string;
    bindings: readonly { binding: ProductOptionBinding; optionSet: OptionSetAggregate }[];
    rules: readonly CatalogResolvedSelectionRule[];
  }[],
  defaultLocale: string,
): readonly PublishedOptionRule[] {
  return Object.freeze(
    channels.flatMap((channel) =>
      channel.rules.map((rule) => {
        const pairs = channel.bindings.filter(
          (pair) => pair.binding.bindingReference === rule.bindingReference,
        );
        const pair = pairs[0];
        if (
          pairs.length !== 1 ||
          !pair ||
          pair.optionSet.draft.versionReference !== rule.optionSetVersionReference
        )
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        const options = rule.options.map((option) => {
          const source = pair.optionSet.draft.options.find(
            (item) => item.optionReference === option.optionReference,
          );
          if (!source) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          const defaultQuantity =
            pair.binding.defaultSelections.find(
              (item) => item.optionReference === option.optionReference,
            )?.quantity ?? 0;
          if (defaultQuantity > option.maximumQuantity)
            throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
          return Object.freeze({
            optionReference: option.optionReference,
            localizedNames: parseLocalizedNames(source.localizedNames, defaultLocale),
            maximumQuantity: option.maximumQuantity,
            conflictOptionReferences: option.conflictOptionReferences,
            selectedByDefault: defaultQuantity > 0,
            defaultQuantity,
          });
        });
        return Object.freeze({
          semanticsVersion: 2 as const,
          channelCodes: Object.freeze([parseCatalogCode(channel.channelCode)]),
          activationOptionReferences: rule.activationOptionReferences,
          bindingReference: rule.bindingReference,
          optionSetVersionReference: rule.optionSetVersionReference,
          minimumSelections: rule.minimumQuantity,
          maximumSelections: rule.maximumQuantity,
          enabledOptionReferences: Object.freeze(options.map((option) => option.optionReference)),
          defaultOptionReferences: Object.freeze(
            options
              .filter((option) => option.selectedByDefault)
              .map((option) => option.optionReference),
          ),
          options: Object.freeze(options),
        });
      }),
    ),
  );
}
