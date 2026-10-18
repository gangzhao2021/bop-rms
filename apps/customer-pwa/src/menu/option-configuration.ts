import type { MenuOptionRule } from "./types.js";

/** A conditional group's defaults cannot activate another group until its own
 * parent is active. Keep inactive selections out of validation and the command.
 */
export function activeMenuOptionRules(
  rules: readonly MenuOptionRule[],
  selected: ReadonlyMap<string, number>,
): readonly MenuOptionRule[] {
  const active = new Set(rules.filter((rule) => !rule.activationOptionReferences?.length));
  let changed = true;
  while (changed) {
    changed = false;
    const selectedActive = new Set(
      [...active].flatMap((rule) =>
        rule.options
          .filter((option) => (selected.get(option.optionReference) ?? 0) > 0)
          .map((option) => option.optionReference),
      ),
    );
    for (const rule of rules) {
      if (
        !active.has(rule) &&
        rule.activationOptionReferences?.some((ref) => selectedActive.has(ref))
      ) {
        active.add(rule);
        changed = true;
      }
    }
  }
  return rules.filter((rule) => active.has(rule));
}

export function defaultMenuOptionSelections(
  rules: readonly MenuOptionRule[],
): ReadonlyMap<string, number> {
  return new Map(
    rules.flatMap((rule) =>
      rule.options
        .filter((option) => option.selectedByDefault)
        .map((option) => [option.optionReference, option.defaultQuantity ?? 1] as const),
    ),
  );
}

export function selectedMenuOptions(
  rules: readonly MenuOptionRule[],
  selected: ReadonlyMap<string, number>,
) {
  return Object.freeze(
    activeMenuOptionRules(rules, selected).flatMap((rule) =>
      rule.options
        .filter((option) => selected.has(option.optionReference))
        .map((option) =>
          Object.freeze({
            optionReference: option.optionReference,
            quantity: selected.get(option.optionReference) ?? 0,
          }),
        ),
    ),
  );
}
