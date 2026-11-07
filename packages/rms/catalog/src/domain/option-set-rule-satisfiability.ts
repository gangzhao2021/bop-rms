import { CatalogError, type ProductOptionBinding } from "./product.js";
import type { OptionSetEditorContent } from "./option-set-editor-content.js";

export interface OptionSetRuleWitness {
  readonly optionSetReference: string;
  readonly versionReference: string;
  readonly active: boolean;
  readonly options: readonly { readonly optionReference: string; readonly quantity: number }[];
}
export type OptionSetMechanicalRuleResult =
  | {
      readonly status: "Satisfiable";
      readonly witness: readonly OptionSetRuleWitness[];
      readonly searchNodes: number;
    }
  | {
      readonly status: "Unsatisfiable";
      readonly reason: "TriggerCycle" | "NoSelection";
      readonly searchNodes: number;
    }
  | {
      readonly status: "Indeterminate";
      readonly reason: "ComplexityLimit" | "SearchLimit";
      readonly searchNodes: number;
    };

/** Parsed complete candidate graph only. No current reference, policy, approval,
 * scope or publication qualification is established by this mechanical result.
 * Optional Binding fixes explicit root defaults; child witnesses are completions only. */
export function solveOptionSetRuleGraph(
  contents: readonly OptionSetEditorContent[],
  root: string,
  maximumSearchNodes: number,
  binding?: ProductOptionBinding,
): OptionSetMechanicalRuleResult {
  const nodes = [...contents].sort((a, b) =>
    a.sourceAggregate.optionSetReference.localeCompare(b.sourceAggregate.optionSetReference),
  );
  const bySet = new Map(nodes.map((n, i) => [n.sourceAggregate.optionSetReference as string, i]));
  const defaults = new Map(
    binding?.defaultSelections.map((d) => [d.optionReference as string, d.quantity]),
  );
  const variables = nodes
    .flatMap((n, setIndex) =>
      n.sourceAggregate.draft.options.map((option) => {
        const detail = n.optionDetails.find((d) => d.optionReference === option.optionReference);
        if (!detail) throw new CatalogError("CATALOG_INPUT_INVALID");
        const defaultQuantity =
          binding && n.sourceAggregate.optionSetReference === root
            ? defaults.get(option.optionReference)
            : undefined;
        return {
          option,
          setIndex,
          lower: defaultQuantity ?? Math.max(1, detail.quantityRule.minimumQuantity),
          upper: defaultQuantity ?? detail.quantityRule.maximumQuantity,
          defaultIntervalInvalid:
            defaultQuantity !== undefined &&
            (defaultQuantity < Math.max(1, detail.quantityRule.minimumQuantity) ||
              defaultQuantity > detail.quantityRule.maximumQuantity),
        };
      }),
    )
    .sort((a, b) => a.option.optionReference.localeCompare(b.option.optionReference));
  if (nodes.length > 32 || variables.length > 128)
    return Object.freeze({ status: "Indeterminate", reason: "ComplexityLimit", searchNodes: 0 });
  const byOption = new Map(variables.map((v, i) => [v.option.optionReference as string, i]));
  const index = (reference: string): number => {
    const found = byOption.get(reference);
    if (found === undefined) throw new CatalogError("CATALOG_INPUT_INVALID");
    return found;
  };
  const incoming = nodes.map((n) =>
    variables.flatMap((v, i) =>
      v.option.triggeredOptionSetReference === n.sourceAggregate.optionSetReference ? [i] : [],
    ),
  );
  const children = nodes.map((n) =>
    n.sourceAggregate.draft.options.flatMap((o) => {
      if (o.triggeredOptionSetReference === null) return [];
      const child = bySet.get(o.triggeredOptionSetReference);
      if (child === undefined) throw new CatalogError("CATALOG_INPUT_INVALID");
      return [child];
    }),
  );
  const visiting = new Set<number>(),
    visited = new Set<number>();
  const cycle = (i: number): boolean => {
    if (visiting.has(i)) return true;
    if (visited.has(i)) return false;
    visiting.add(i);
    if ((children[i] ?? []).some(cycle)) return true;
    visiting.delete(i);
    visited.add(i);
    return false;
  };
  if (nodes.some((_, i) => cycle(i)))
    return Object.freeze({ status: "Unsatisfiable", reason: "TriggerCycle", searchNodes: 0 });
  const groups = nodes.map((n, i) => ({
    node: n,
    indices: variables.flatMap((v, j) => (v.setIndex === i ? [j] : [])),
    minimum:
      (binding && n.sourceAggregate.optionSetReference === root
        ? binding.minimumSelectionOverride
        : null) ?? n.sourceAggregate.draft.minimumSelection,
    maximum: Math.min(
      (binding && n.sourceAggregate.optionSetReference === root
        ? binding.maximumSelectionOverride
        : null) ??
        n.sourceAggregate.draft.maximumSelection ??
        128 * 999,
      n.sourceAggregate.draft.maximumTotalQuantity ?? 128 * 999,
    ),
    conflicts: [
      ...n.conflictRules.map((r) => r.forbiddenTogether.map(index)),
      ...n.sourceAggregate.draft.options.flatMap((o) =>
        o.conflictOptionReferences.map((r) => [index(o.optionReference), index(r)]),
      ),
    ],
    conditions: n.conditionalRules.map((r) => ({
      when: r.whenAllSelected.map(index),
      required: r.requiredOptionReferences.map(index),
    })),
  }));
  const rootIndex = bySet.get(root);
  if (rootIndex === undefined) throw new CatalogError("CATALOG_INPUT_INVALID");
  const activity = (i: number, state: readonly number[]): boolean | null => {
    if (i === rootIndex || (incoming[i] ?? []).some((j) => state[j] === 1)) return true;
    return (incoming[i] ?? []).some((j) => state[j] === -1) ? null : false;
  };
  const propagate = (state: number[]): boolean => {
    let changed = true;
    while (changed) {
      changed = false;
      const force = (i: number, value: 0 | 1): boolean => {
        if (state[i] === value) return true;
        if (state[i] !== -1) return false;
        state[i] = value;
        changed = true;
        return true;
      };
      for (const [i, g] of groups.entries()) {
        let active = activity(i, state);
        if (g.indices.some((j) => state[j] === 1)) {
          if (active === false) return false;
          if (active === null) {
            const parents = (incoming[i] ?? []).filter((j) => state[j] === -1);
            if (parents.length === 1 && !force(parents[0] ?? -1, 1)) return false;
            active = true;
          }
        }
        if (active === false) {
          for (const j of g.indices) if (!force(j, 0)) return false;
        } else if (active === true) {
          const lower = g.indices.reduce(
            (sum, j) => sum + (state[j] === 1 ? (variables[j]?.lower ?? 0) : 0),
            0,
          );
          const possible = g.indices.reduce(
            (sum, j) => sum + (state[j] !== 0 ? (variables[j]?.upper ?? 0) : 0),
            0,
          );
          if (lower > g.maximum || possible < g.minimum) return false;
          for (const j of g.indices) {
            if (state[j] !== -1) continue;
            const v = variables[j];
            if (!v) throw new CatalogError("CATALOG_INPUT_INVALID");
            if (lower + v.lower > g.maximum && !force(j, 0)) return false;
            if (possible - v.upper < g.minimum && !force(j, 1)) return false;
          }
        }
        for (const conflict of g.conflicts) {
          if (conflict.some((j) => state[j] === 0)) continue;
          const unknown = conflict.filter((j) => state[j] === -1);
          if (unknown.length === 0) return false;
          if (unknown.length === 1 && !force(unknown[0] ?? -1, 0)) return false;
        }
        for (const rule of g.conditions) {
          if (rule.when.some((j) => state[j] === 0)) continue;
          const unknown = rule.when.filter((j) => state[j] === -1);
          if (unknown.length === 0) {
            for (const j of rule.required) if (!force(j, 1)) return false;
          } else if (unknown.length === 1 && rule.required.some((j) => state[j] === 0)) {
            if (!force(unknown[0] ?? -1, 0)) return false;
          }
        }
      }
    }
    return true;
  };
  if (variables.some((v) => v.defaultIntervalInvalid))
    return Object.freeze({ status: "Unsatisfiable", reason: "NoSelection", searchNodes: 0 });
  const initial = variables.map((v) =>
    binding && v.setIndex === rootIndex
      ? defaults.has(v.option.optionReference)
        ? 1
        : 0
      : v.option.lifecycle === "Draft" || v.option.lifecycle === "Active"
        ? -1
        : 0,
  );
  let searchNodes = 0,
    exhausted = false;
  const search = (state: number[]): number[] | null => {
    if (searchNodes >= maximumSearchNodes) {
      exhausted = true;
      return null;
    }
    searchNodes++;
    if (!propagate(state)) return null;
    const emptyRemainder = state.map((v) => (v === -1 ? 0 : v));
    if (propagate(emptyRemainder)) return emptyRemainder;
    const next = state.indexOf(-1);
    if (next < 0) return null;
    for (const value of [0, 1]) {
      const branch = [...state];
      branch[next] = value;
      const result = search(branch);
      if (result) return result;
      if (exhausted) break;
    }
    return null;
  };
  const solution = search(initial);
  if (!solution)
    return exhausted
      ? Object.freeze({ status: "Indeterminate", reason: "SearchLimit", searchNodes })
      : Object.freeze({ status: "Unsatisfiable", reason: "NoSelection", searchNodes });
  const witness = groups.map((g, i) => {
    const selected = g.indices.filter((j) => solution[j] === 1);
    let extra = Math.max(
      0,
      g.minimum - selected.reduce((sum, j) => sum + (variables[j]?.lower ?? 0), 0),
    );
    const options = selected.map((j) => {
      const v = variables[j];
      if (!v) throw new CatalogError("CATALOG_INPUT_INVALID");
      const increment = Math.min(extra, v.upper - v.lower);
      extra -= increment;
      return Object.freeze({
        optionReference: v.option.optionReference as string,
        quantity: v.lower + increment,
      });
    });
    if (extra !== 0 && activity(i, solution) === true)
      throw new CatalogError("CATALOG_INPUT_INVALID");
    return Object.freeze({
      optionSetReference: g.node.sourceAggregate.optionSetReference as string,
      versionReference: g.node.sourceAggregate.draft.versionReference as string,
      active: activity(i, solution) === true,
      options: Object.freeze(options),
    });
  });
  return Object.freeze({ status: "Satisfiable", witness: Object.freeze(witness), searchNodes });
}
