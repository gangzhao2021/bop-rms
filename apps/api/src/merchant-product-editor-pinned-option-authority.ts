import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  productEditorContentFields,
  type ProductOptionBinding,
} from "@rms/catalog";
import {
  createFrozenFullOptionBindingRuleSource,
  type FrozenFullOptionBindingRuleAssessment,
} from "./frozen-full-option-binding-rule-source.js";
import {
  remainingProductEditorVariantReferenceChecks,
  type MerchantProductEditorVariantRemainingAuthority,
} from "./merchant-product-editor-variant-content-authority.js";
type OptionOptions = Parameters<typeof createFrozenFullOptionBindingRuleSource>[0];
export interface CurrentPublishedProductOptionBindingAssessment extends Omit<
  FrozenFullOptionBindingRuleAssessment,
  "profile"
> {
  readonly profile: "CurrentPublishedProductOptionBindingAssessmentV1";
  readonly sourceAuthority: "CurrentPublishingReleaseAndFrozenContent";
}
export interface CurrentPublishedProductOptionBindingPort {
  withBindingAssessment<T>(
    tx: Parameters<OptionOptions["authority"]["holdUntilTransactionCompletes"]>[0],
    binding: ProductOptionBinding,
    work: (assessment: CurrentPublishedProductOptionBindingAssessment) => Promise<T>,
  ): Promise<T>;
}
/** Resolve each original binding through its selected owning source. Pinned
 * history and actual Current Published retain distinct provenance; complete
 * fields and remaining reference checks stay independently mandatory. */
export function createMerchantProductEditorPinnedOptionAuthority(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly optionAuthority: OptionOptions["authority"];
  readonly remainingAuthority: MerchantProductEditorVariantRemainingAuthority;
  readonly currentPublished?: CurrentPublishedProductOptionBindingPort;
  readonly clock: { now(): string };
}): MerchantProductEditorVariantRemainingAuthority {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  if (
    typeof options.optionAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.remainingAuthority !== "function" ||
    typeof options.clock?.now !== "function" ||
    (options.currentPublished !== undefined &&
      typeof options.currentPublished?.withBindingAssessment !== "function")
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
    currentPublishedPort = options.currentPublished?.withBindingAssessment,
    currentPublished = currentPublishedPort?.bind(options.currentPublished),
    active = new WeakSet<object>(),
    queries = new WeakMap<object, unknown>(),
    failed = new WeakSet<object>();
  return async (tx, value) => {
    try {
      if (
        !tx ||
        typeof tx !== "object" ||
        typeof tx.query !== "function" ||
        failed.has(tx) ||
        active.has(tx)
      )
        return fail();
      const query = tx.query;
      if (queries.has(tx) && queries.get(tx) !== query) return fail();
      queries.set(tx, query);
      active.add(tx);
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
        (raw.purposeCode !== "CATALOG_PRODUCT_DRAFT_REPLACE" &&
          raw.purposeCode !== "CATALOG_PRODUCT_CREATE") ||
        (raw.purposeCode === "CATALOG_PRODUCT_CREATE" &&
          (raw.mode !== "DraftWrite" ||
            aggregate.aggregateVersion !== 1 ||
            aggregate.lifecycle !== "Draft" ||
            aggregate.draft.status !== "Draft")) ||
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
        purposeCode: raw.purposeCode as "CATALOG_PRODUCT_DRAFT_REPLACE" | "CATALOG_PRODUCT_CREATE",
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
        if (
          failed.has(tx) ||
          tx.query !== query ||
          options.currentPublished?.withBindingAssessment !== currentPublishedPort ||
          at < latest ||
          at >= deadline
        )
          return fail();
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
            ) === undefined,
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
        const rule = aggregate.draft.editorContent?.optionRules.find(
          (candidate) => candidate.bindingReference === binding.bindingReference,
        );
        if (!rule) return fail();
        const current = rule.versionResolution === "CurrentPublished";
        if (current && currentPublished === undefined) return fail();
        const work = async (
          assessment:
            FrozenFullOptionBindingRuleAssessment | CurrentPublishedProductOptionBindingAssessment,
        ) => {
          if (current) {
            try {
              const packet = readClosedRecord(copyCategoryPersistenceValue(assessment), [
                "profile",
                "tenantReference",
                "brandReference",
                "bindingReference",
                "bindingDigest",
                "rootOptionSetReference",
                "rootVersionReference",
                "graphDigest",
                "sourceRecords",
                "rules",
                "observedAt",
                "validUntil",
                "publishValidation",
                "referenceEligibility",
                "eligibility",
                "digest",
                "sourceAuthority",
              ]);
              const rules = readClosedRecord(packet.rules, ["status", "reason", "searchNodes"]);
              if (
                !Array.isArray(packet.sourceRecords) ||
                packet.sourceRecords.length > 32 ||
                [packet.bindingDigest, packet.graphDigest, packet.digest].some(
                  (digest) => typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest),
                ) ||
                typeof rules.searchNodes !== "number" ||
                !Number.isSafeInteger(rules.searchNodes) ||
                rules.searchNodes < 0 ||
                rules.searchNodes > 65536 ||
                (rules.reason !== null &&
                  (typeof rules.reason !== "string" || rules.reason.length > 4096))
              )
                return fail();
            } catch {
              return fail();
            }
          }
          calls[index] = (calls[index] ?? 0) + 1;
          const sourceAt = parseCatalogInstant(assessment.observedAt),
            sourceUntil = parseCatalogInstant(assessment.validUntil);
          check();
          if (sourceAt < latest || sourceAt > parseCatalogInstant(now())) return fail();
          if (
            calls[index] !== 1 ||
            assessment.profile !==
              (current
                ? "CurrentPublishedProductOptionBindingAssessmentV1"
                : "FrozenFullOptionBindingRuleAssessmentV1") ||
            (current &&
              (!("sourceAuthority" in assessment) ||
                assessment.sourceAuthority !== "CurrentPublishingReleaseAndFrozenContent")) ||
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
        };
        const result = current
          ? currentPublished === undefined
            ? fail()
            : await currentPublished(tx, binding, work)
          : await source.withPinnedAssessment(tx, binding, work);
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
    } finally {
      if (tx && typeof tx === "object") active.delete(tx);
    }
  };
}
