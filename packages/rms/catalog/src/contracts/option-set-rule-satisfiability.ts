import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { parseCatalogOptionSetEditorContent } from "./option-set-editor-content.js";
import {
  CatalogError,
  parseCatalogReference,
  parseProductOptionBinding,
  type ProductOptionBinding,
} from "./product.js";
import {
  validateProductOptionBinding,
  assessProductOptionBindingDefaultQuantity,
} from "../domain/option-set.js";
import { solveOptionSetRuleGraph } from "../domain/option-set-rule-satisfiability.js";

const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some((k) => !Object.hasOwn(r, k)))
    return invalid();
  return r;
}
/** Mechanical candidate evaluation only. A held owning producer must separately
 * prove current graph/references, permissions, scope/policy and approval. */
function evaluateGraph(
  value: unknown,
  limitsValue: unknown,
  binding?: ProductOptionBinding,
  assessDefaultQuantity = false,
) {
  const input = record(copyCategoryPersistenceValue(value), [
    "brandReference",
    "rootOptionSetReference",
    "rootVersionReference",
    "contents",
  ]);
  const limits = record(copyCategoryPersistenceValue(limitsValue), ["maximumSearchNodes"]);
  if (
    !Number.isSafeInteger(limits.maximumSearchNodes) ||
    (limits.maximumSearchNodes as number) < 1 ||
    (limits.maximumSearchNodes as number) > 65536
  )
    return invalid();
  const brandReference = parseCatalogReference(input.brandReference),
    rootOptionSetReference = parseCatalogReference(input.rootOptionSetReference),
    rootVersionReference = parseCatalogReference(input.rootVersionReference);
  if (!Array.isArray(input.contents) || input.contents.length > 32) return invalid();
  const prepared = input.contents
    .map((v) => {
      const body = record(v, [
        "profile",
        "sourceAggregate",
        "optionDetails",
        "conditionalRules",
        "conflictRules",
        "scopeSet",
        "effectivePeriod",
      ]);
      const { sourceAggregate, ...additional } = body;
      return parseCatalogOptionSetEditorContent(sourceAggregate, additional);
    })
    .sort(
      (a, b) =>
        a.content.sourceAggregate.optionSetReference.localeCompare(
          b.content.sourceAggregate.optionSetReference,
        ) ||
        a.content.sourceAggregate.draft.versionReference.localeCompare(
          b.content.sourceAggregate.draft.versionReference,
        ),
    );
  if (
    prepared.some((p) => p.content.sourceAggregate.brandReference !== brandReference) ||
    new Set(
      prepared.map(
        (p) =>
          p.content.sourceAggregate.optionSetReference +
          ":" +
          p.content.sourceAggregate.draft.versionReference,
      ),
    ).size !== prepared.length
  )
    return invalid();
  const identities = Object.freeze(
    prepared.map((p) =>
      Object.freeze({
        optionSetReference: p.content.sourceAggregate.optionSetReference as string,
        versionReference: p.content.sourceAggregate.draft.versionReference as string,
        aggregateVersion: p.content.sourceAggregate.aggregateVersion,
        sourceDigest: p.sourceDigest,
        contentDigest: p.contentDigest,
        configurationDigest: p.configurationDigest,
      }),
    ),
  );
  const base = Object.freeze({
    brandReference: brandReference as string,
    rootOptionSetReference: rootOptionSetReference as string,
    rootVersionReference: rootVersionReference as string,
    identities,
    graphDigest:
      "sha256:" +
      sha256Hex(
        canonicalizeRfc8785({
          brandReference,
          rootOptionSetReference,
          rootVersionReference,
          identities,
        }),
      ),
    eligibility: "NotEvaluated" as const,
  });
  const incomplete = (reason: "IncompleteTriggerGraph" | "AmbiguousTriggerVersion") =>
    Object.freeze({ ...base, status: "Indeterminate" as const, reason, searchNodes: 0 });
  const nodes = prepared.map((p) => p.content);
  if (new Set(nodes.map((n) => n.sourceAggregate.optionSetReference)).size !== nodes.length)
    return incomplete("AmbiguousTriggerVersion");
  const options = nodes.flatMap((n) => n.sourceAggregate.draft.options);
  if (new Set(options.map((o) => o.optionReference)).size !== options.length) return invalid();
  const bySet = new Map(nodes.map((n) => [n.sourceAggregate.optionSetReference as string, n]));
  if (
    bySet.get(rootOptionSetReference)?.sourceAggregate.draft.versionReference !==
    rootVersionReference
  )
    return incomplete("IncompleteTriggerGraph");
  const root = bySet.get(rootOptionSetReference);
  let defaultQuantityViolation = false;
  if (binding && root) {
    if (assessDefaultQuantity)
      defaultQuantityViolation =
        assessProductOptionBindingDefaultQuantity(binding, root.sourceAggregate) ===
        "DefaultQuantityViolation";
    else validateProductOptionBinding(binding, root.sourceAggregate);
  }
  for (const n of nodes)
    for (const o of n.sourceAggregate.draft.options) {
      if (o.triggeredOptionSetReference === null) continue;
      const detail = n.optionDetails.find((d) => d.optionReference === o.optionReference);
      if (
        bySet.get(o.triggeredOptionSetReference)?.sourceAggregate.draft.versionReference !==
        detail?.triggeredOptionSetVersionReference
      )
        return incomplete("IncompleteTriggerGraph");
    }
  const reached = new Set<string>();
  const visit = (reference: string): void => {
    if (reached.has(reference)) return;
    reached.add(reference);
    for (const o of bySet.get(reference)?.sourceAggregate.draft.options ?? [])
      if (o.triggeredOptionSetReference !== null) visit(o.triggeredOptionSetReference);
  };
  visit(rootOptionSetReference);
  if (reached.size !== nodes.length) return invalid();
  return Object.freeze({
    ...base,
    ...(defaultQuantityViolation
      ? { status: "Unsatisfiable" as const, reason: "NoSelection" as const, searchNodes: 0 }
      : solveOptionSetRuleGraph(
          nodes,
          rootOptionSetReference,
          limits.maximumSearchNodes as number,
          binding,
        )),
  });
}

/** Complete candidate graph only; this result does not establish current eligibility. */
export function evaluateCatalogOptionSetRuleSatisfiability(
  value: unknown,
  limitsValue: unknown = { maximumSearchNodes: 65536 },
) {
  return evaluateGraph(value, limitsValue);
}

/** Explicit Product defaults must satisfy full root rules and admit a triggered
 * child completion. A completion is not an automatically inserted default. */
function evaluateFullBinding(value: unknown, limitsValue: unknown, assessDefaultQuantity: boolean) {
  const input = record(copyCategoryPersistenceValue(value), ["graph", "binding"]);
  const binding = parseProductOptionBinding(input.binding);
  const graph = record(input.graph, [
    "brandReference",
    "rootOptionSetReference",
    "rootVersionReference",
    "contents",
  ]);
  if (
    binding.optionSetReference !== graph.rootOptionSetReference ||
    binding.optionSetVersionReference !== graph.rootVersionReference
  )
    return invalid();
  return Object.freeze({
    ...evaluateGraph(graph, limitsValue, binding, assessDefaultQuantity),
    bindingReference: binding.bindingReference as string,
    bindingDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(binding)),
  });
}

/** Legacy strict binding validation remains a refusal for invalid defaults. */
export function evaluateCatalogFullProductOptionBindingRules(
  value: unknown,
  limitsValue: unknown = { maximumSearchNodes: 65536 },
) {
  return evaluateFullBinding(value, limitsValue, false);
}
/** Complete owning graph only. Proven default quantity contradictions are
 * Unsatisfiable; malformed references and unavailable graph still refuse. */
export function assessCatalogFullProductOptionBindingPrerequisites(
  value: unknown,
  limitsValue: unknown = { maximumSearchNodes: 65536 },
) {
  return evaluateFullBinding(value, limitsValue, true);
}
