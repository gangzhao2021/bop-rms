import type { OptionSetAggregate } from "../domain/option-set.js";

/**
 * WP-2423 sold-out-and-allergen-safety (M22, M24): a dish's option sets as sold here now — each
 * choice the Store cannot sell now (`listOptionsOffNow`) is off for now (`Inactive`). Used only with
 * the Sale rules, which keep a group's limits and offer what is left: picking an off choice is
 * `OPTION_NOT_ENABLED`, and a required group with nothing left makes the dish unavailable now.
 * Nothing is stored: the Brand's option sets are unchanged.
 */
export function withOptionsOffNow<
  T extends { readonly optionSet: OptionSetAggregate; readonly binding: unknown },
>(bindings: readonly T[], offNow: ReadonlyMap<string, unknown>): readonly T[] {
  if (offNow.size === 0) return bindings;
  return Object.freeze(
    bindings.map((pair) =>
      pair.optionSet.draft.options.some(
        (option) => option.lifecycle === "Active" && offNow.has(String(option.optionReference)),
      )
        ? Object.freeze({
            ...pair,
            optionSet: Object.freeze({
              ...pair.optionSet,
              draft: Object.freeze({
                ...pair.optionSet.draft,
                options: Object.freeze(
                  pair.optionSet.draft.options.map((option) =>
                    option.lifecycle === "Active" && offNow.has(String(option.optionReference))
                      ? Object.freeze({ ...option, lifecycle: "Inactive" as const })
                      : option,
                  ),
                ),
              }),
            }),
          })
        : pair,
    ),
  );
}
