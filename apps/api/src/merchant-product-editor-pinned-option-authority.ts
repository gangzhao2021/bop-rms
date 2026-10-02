import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  productEditorContentFields,
} from "@rms/catalog";
import { createFrozenFullOptionBindingRuleSource } from "./frozen-full-option-binding-rule-source.js";
import {
  remainingProductEditorVariantReferenceChecks,
  type MerchantProductEditorVariantRemainingAuthority,
} from "./merchant-product-editor-variant-content-authority.js";
type OptionOptions = Parameters<typeof createFrozenFullOptionBindingRuleSource>[0];
/** Pinned historical mechanical rules only; current Published and the remaining
 * complete field/reference checks remain independent mandatory owning holders. */
export function createMerchantProductEditorPinnedOptionAuthority(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly optionAuthority: OptionOptions["authority"];
  readonly remainingAuthority: MerchantProductEditorVariantRemainingAuthority;
  readonly clock: { now(): string };
}): MerchantProductEditorVariantRemainingAuthority {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  if (
    typeof options.optionAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.remainingAuthority !== "function" ||
    typeof options.clock?.now !== "function"
  )
    return fail();
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    now = options.clock.now.bind(options.clock),
    optionHold = options.optionAuthority.holdUntilTransactionCompletes.bind(
      options.optionAuthority,
    ),
    remainingHold = options.remainingAuthority,
    failed = new WeakSet<object>();
  return async (tx, value) => {
    try {
      if (!tx || typeof tx !== "object" || typeof tx.query !== "function" || failed.has(tx))
        return fail();
      const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
          "sessionReference",
          "productReference",
          "operationReference",
          "permission",
          "owningAction",
          "purposeCode",
          "observedAt",
          "validUntil",
          "mode",
          "aggregate",
          "requiredFields",
          "requiredReferenceChecks",
        ]),
        aggregate = parseProductAggregate(raw.aggregate),
        observedAt = parseCatalogInstant(raw.observedAt),
        validUntil = parseCatalogInstant(raw.validUntil);
      if (
        (raw.mode !== "Read" && raw.mode !== "DraftWrite") ||
        raw.tenantReference !== tenantReference ||
        raw.brandReference !== brandReference ||
        raw.actorReference !== actorReference ||
        raw.permission !== "catalog.manage" ||
        raw.owningAction !== "catalog.product.manage" ||
        raw.purposeCode !== "CATALOG_PRODUCT_DRAFT_REPLACE" ||
        Date.parse(validUntil) - Date.parse(observedAt) !== 5000 ||
        JSON.stringify(raw.requiredFields) !== JSON.stringify(productEditorContentFields) ||
        JSON.stringify(raw.requiredReferenceChecks) !==
          JSON.stringify(raw.mode === "Read" ? [] : remainingProductEditorVariantReferenceChecks) ||
        aggregate.brandReference !== brandReference ||
        aggregate.productReference !== raw.productReference ||
        aggregate.draft.editorContent === undefined ||
        Buffer.byteLength(JSON.stringify(aggregate), "utf8") > 8 * 1024 * 1024
      )
        return fail();
      const input = Object.freeze({
        tenantReference,
        brandReference,
        actorReference,
        storeReference: parseCatalogReference(raw.storeReference),
        sessionReference: parseCatalogReference(raw.sessionReference),
        productReference: parseCatalogReference(raw.productReference),
        operationReference: parseCatalogReference(raw.operationReference),
        permission: "catalog.manage" as const,
        owningAction: "catalog.product.manage" as const,
        purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE" as const,
        observedAt,
        validUntil,
        mode: raw.mode,
        aggregate,
        requiredFields: productEditorContentFields,
        requiredReferenceChecks:
          raw.mode === "Read" ? Object.freeze([]) : remainingProductEditorVariantReferenceChecks,
      });
      let deadline = validUntil,
        latest = observedAt;
      const check = () => {
        const at = parseCatalogInstant(now());
        if (failed.has(tx) || at < latest || at >= deadline) return fail();
      };
      const holdRemaining = async () => {
        check();
        if ((await remainingHold(tx, input)) !== undefined) return fail();
        check();
      };
      check();
      if (raw.mode === "Read") return await holdRemaining();
      const bindings = [...aggregate.draft.optionBindings].sort((a, b) =>
        a.bindingReference.localeCompare(b.bindingReference),
      );
      if (
        bindings.length > 32 ||
        bindings.some(
          (binding) =>
            aggregate.draft.editorContent?.optionRules.find(
              (rule) => rule.bindingReference === binding.bindingReference,
            )?.versionResolution !== "Pinned",
        )
      )
        return fail();
      const source = createFrozenFullOptionBindingRuleSource({
        tenantReference,
        brandReference,
        actorReference,
        clock: { now },
        authority: {
          async holdUntilTransactionCompletes(actualTx, request) {
            check();
            if (
              actualTx !== tx ||
              request.tenantReference !== tenantReference ||
              request.brandReference !== brandReference ||
              request.actorReference !== actorReference ||
              request.actorKind !== "User" ||
              request.permission !== "catalog.manage" ||
              request.action !== "catalog.option_set.read" ||
              request.purposeCode !== "CATALOG_OPTION_SET_FROZEN_CONTENT"
            )
              return fail();
            const held = readClosedRecord(
                copyCategoryPersistenceValue(await optionHold(actualTx, request)),
                ["observedAt", "validUntil"],
              ),
              at = parseCatalogInstant(held.observedAt),
              until = parseCatalogInstant(held.validUntil);
            if (
              at !== request.observedAt ||
              at < observedAt ||
              until <= at ||
              Date.parse(until) - Date.parse(at) > 30000
            )
              return fail();
            check();
            return { observedAt: at, validUntil: until < deadline ? until : deadline };
          },
        },
      });
      let hardError = false,
        indeterminate = false,
        completed = false;
      const calls: number[] = [];
      const acquire = async (index: number): Promise<void> => {
        check();
        const binding = bindings[index];
        if (!binding) {
          if (index !== bindings.length) return fail();
          await holdRemaining();
          completed = true;
          return;
        }
        const result = await source.withPinnedAssessment(tx, binding, async (assessment) => {
          calls[index] = (calls[index] ?? 0) + 1;
          const sourceAt = parseCatalogInstant(assessment.observedAt),
            sourceUntil = parseCatalogInstant(assessment.validUntil);
          check();
          if (sourceAt < latest || sourceAt > parseCatalogInstant(now())) return fail();
          if (
            calls[index] !== 1 ||
            assessment.profile !== "FrozenFullOptionBindingRuleAssessmentV1" ||
            assessment.tenantReference !== tenantReference ||
            assessment.brandReference !== brandReference ||
            assessment.bindingReference !== binding.bindingReference ||
            assessment.bindingDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(binding)) ||
            assessment.rootOptionSetReference !== binding.optionSetReference ||
            assessment.rootVersionReference !== binding.optionSetVersionReference ||
            assessment.observedAt < observedAt ||
            assessment.observedAt >= validUntil ||
            assessment.validUntil > validUntil ||
            assessment.validUntil <= assessment.observedAt ||
            assessment.publishValidation !== "Incomplete" ||
            assessment.referenceEligibility !== "NotEvaluated" ||
            assessment.eligibility !== "NotEvaluated"
          )
            return fail();
          latest = sourceAt;
          deadline = sourceUntil < deadline ? sourceUntil : deadline;
          check();
          if (assessment.rules.status === "Unsatisfiable") {
            hardError = true;
            completed = true;
            return;
          }
          if (assessment.rules.status === "Indeterminate") {
            indeterminate = true;
            completed = true;
            return;
          }
          if (assessment.rules.status !== "Satisfiable") return fail();
          await acquire(index + 1);
          check();
        });
        if (calls[index] !== 1 || result !== undefined) return fail();
        check();
      };
      await acquire(0);
      if (
        !completed ||
        calls.some((n) => n !== 1) ||
        (!hardError && !indeterminate && calls.length !== bindings.length)
      )
        return fail();
      check();
      if (indeterminate) return fail();
      if (hardError) throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
    } catch (error) {
      if (tx && typeof tx === "object") failed.add(tx);
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
}
