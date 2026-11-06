import {
  CatalogError,
  parseProductOptionBinding,
  type CatalogReference,
} from "../domain/product.js";
import {
  parseOptionSetAggregate,
  validateProductOptionBinding,
  type OptionBindingRuleMode,
} from "../domain/option-set.js";
import type { CatalogResolvedSelectionRule } from "./ports/selection-validation-ports.js";
const unavailable = (): never => {
  throw new CatalogError("CATALOG_UNAVAILABLE");
};

/**
 * Current owner rule facts only; publication, scope and availability are separate prerequisites.
 *
 * WP-2423 (cart-unsellable-dishes): `rules: "Sale"` (the cart, the quote, the order) checks the
 * limits, never the defaults guests start with, and a group whose every enabled choice is off for
 * now is returned with no options and its minimum kept, so validation refuses that one dish
 * (RULE_UNSATISFIED) instead of failing the whole read. The limits themselves must still fit the
 * enabled, not archived, choices (counted as if all were offered); limits that do not fit even then
 * are a setup error and still throw. The default (`Listing`) keeps every rule.
 */
export function resolveCurrentCatalogSelectionRules(
  value: unknown,
  scope?: Readonly<{
    brandReference: string;
    sellableReference: string;
    channelCode: string;
    observedAt: string;
  }>,
  checked: Readonly<{ rules: Extract<OptionBindingRuleMode, "Listing" | "Sale"> }> = {
    rules: "Listing",
  },
): readonly CatalogResolvedSelectionRule[] {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 100 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      return unavailable();
    const pairs = Array.from({ length: value.length }, (_, i) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
      const pair: unknown = descriptor.value;
      if (
        pair === null ||
        typeof pair !== "object" ||
        Object.getPrototypeOf(pair) !== Object.prototype ||
        Reflect.ownKeys(pair).length !== 2
      )
        return unavailable();
      const b = Object.getOwnPropertyDescriptor(pair, "binding"),
        s = Object.getOwnPropertyDescriptor(pair, "optionSet");
      if (!b?.enumerable || !("value" in b) || !s?.enumerable || !("value" in s))
        return unavailable();
      const binding = parseProductOptionBinding(b.value),
        optionSet = parseOptionSetAggregate(s.value);
      validateProductOptionBinding(binding, optionSet, checked.rules);
      if (
        scope &&
        (optionSet.brandReference !== scope.brandReference ||
          optionSet.updatedAt > scope.observedAt ||
          optionSet.draft.updatedAt > scope.observedAt ||
          optionSet.draft.options.some((o) => o.createdAt > scope.observedAt) ||
          (binding.channelCodes.length > 0 &&
            !binding.channelCodes.some((c) => c === scope.channelCode)) ||
          (binding.includedSkuReferences.length > 0 &&
            !binding.includedSkuReferences.some((r) => r === scope.sellableReference)) ||
          binding.excludedSkuReferences.some((r) => r === scope.sellableReference))
      )
        return unavailable();

      if (optionSet.lifecycle === "Archived") return unavailable();
      const enabled = optionSet.draft.options.filter((o) =>
        binding.enabledOptionReferences.includes(o.optionReference),
      );
      const active = enabled.filter((o) => o.lifecycle === "Active");
      const perOption = optionSet.draft.perOptionMaximumQuantity;
      if (perOption > 999) return unavailable();
      const minimum = binding.minimumSelectionOverride ?? optionSet.draft.minimumSelection;
      const limit = (count: number) =>
        Math.min(
          binding.maximumSelectionOverride ?? optionSet.draft.maximumSelection ?? count * perOption,
          optionSet.draft.maximumTotalQuantity ?? count * perOption,
          count * perOption,
        );
      let maximum = limit(active.length);
      if (maximum > 99900 || active.length > 100) return unavailable();
      // Sale: limits that fit the enabled choices but not those offered now. Only the choices off
      // for now are missing, so the group keeps its limits and offers what is left (maybe none).
      const offNow =
        checked.rules === "Sale" &&
        minimum > maximum &&
        minimum <= limit(enabled.filter((o) => o.lifecycle !== "Archived").length);
      if (offNow) maximum = Math.max(minimum, 1);
      return {
        binding,
        optionSet,
        enabled,
        active: maximum === 0 ? [] : active,
        minimum,
        maximum,
        perOption: Math.min(perOption, maximum),
      };
    });
    if (
      new Set(pairs.map((p) => p.binding.bindingReference)).size !== pairs.length ||
      new Set(pairs.map((p) => p.optionSet.optionSetReference)).size !== pairs.length ||
      new Set(pairs.map((p) => p.optionSet.brandReference)).size > 1
    )
      return unavailable();
    const options = pairs.flatMap((p) => p.enabled);
    if (new Set(options.map((o) => o.optionReference)).size !== options.length)
      return unavailable();
    const bySet = new Map(pairs.map((p) => [p.optionSet.optionSetReference, p]));
    const incoming = new Set<CatalogReference>();
    const graph = new Map<CatalogReference, Set<CatalogReference>>();
    for (const p of pairs) {
      const edges = new Set<CatalogReference>();
      for (const o of p.enabled) {
        const target = o.triggeredOptionSetReference;
        if (target !== null) {
          if (!bySet.has(target)) return unavailable();
          edges.add(target);
          incoming.add(target);
        }
      }
      graph.set(p.optionSet.optionSetReference, edges);
    }
    const visiting = new Set<CatalogReference>(),
      visited = new Set<CatalogReference>();
    const visit = (ref: CatalogReference): void => {
      if (visiting.has(ref)) return unavailable();
      if (visited.has(ref)) return;
      visiting.add(ref);
      for (const next of graph.get(ref) ?? []) visit(next);
      visiting.delete(ref);
      visited.add(ref);
    };
    for (const ref of bySet.keys()) visit(ref);
    const reachable = new Set<CatalogReference>();
    const activate = (ref: CatalogReference): void => {
      if (reachable.has(ref)) return;
      reachable.add(ref);
      for (const o of bySet.get(ref)?.active ?? [])
        if (o.triggeredOptionSetReference !== null) activate(o.triggeredOptionSetReference);
    };
    for (const ref of bySet.keys()) if (!incoming.has(ref)) activate(ref);
    const current = pairs.filter((p) => reachable.has(p.optionSet.optionSetReference));
    // Unreachable conditional branches cannot constrain the current selection.
    if (current.some((p) => p.minimum > p.maximum)) return unavailable();
    const activeOptions = current.flatMap((p) => p.active);
    const activeRefs = new Set(activeOptions.map((o) => o.optionReference));
    return Object.freeze(
      current.map((p) =>
        Object.freeze({
          bindingReference: p.binding.bindingReference,
          optionSetVersionReference: p.binding.optionSetVersionReference,
          activationOptionReferences: Object.freeze(
            activeOptions
              .filter((o) => o.triggeredOptionSetReference === p.optionSet.optionSetReference)
              .map((o) => o.optionReference),
          ),
          minimumQuantity: p.minimum,
          maximumQuantity: p.maximum,
          options: Object.freeze(
            p.active.map((o) =>
              Object.freeze({
                optionReference: o.optionReference,
                maximumQuantity: p.perOption,
                conflictOptionReferences: Object.freeze(
                  o.conflictOptionReferences.filter((ref) => activeRefs.has(ref)),
                ),
              }),
            ),
          ),
        }),
      ),
    );
  } catch {
    return unavailable();
  }
}
