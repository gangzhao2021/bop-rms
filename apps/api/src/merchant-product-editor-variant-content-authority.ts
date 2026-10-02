import { readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  assertProductVariantIdentityHistory,
  copyCategoryPersistenceValue,
  createPostgresProductVariantIdentityHistorySource,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  productEditorContentFields,
} from "@rms/catalog";
import {
  remainingProductEditorReferenceChecks,
  type MerchantProductEditorRemainingContentAuthority,
} from "./merchant-product-editor-registered-content-authority.js";

type VariantOptions = Parameters<typeof createPostgresProductVariantIdentityHistorySource>[0];
export const remainingProductEditorVariantReferenceChecks = Object.freeze(
  remainingProductEditorReferenceChecks.filter((check) => check !== "VariantIdentityHistory"),
);
type Input = Parameters<MerchantProductEditorRemainingContentAuthority>[1];
export type MerchantProductEditorVariantRemainingAuthority = (
  tx: Parameters<MerchantProductEditorRemainingContentAuthority>[0],
  input: Omit<Input, "requiredReferenceChecks"> & {
    readonly requiredReferenceChecks: typeof remainingProductEditorVariantReferenceChecks;
  },
) => Promise<void>;

/** Composes inside the registered-content holder and outer complete Draft guard.
 * Admitted owning Read roots select an actual current history query; the selector
 * is never history, authority or eligibility. No nested transaction or SQL here.
 */
export function createMerchantProductEditorVariantContentAuthority(options: {
  readonly variantAuthority: VariantOptions["authority"];
  readonly remainingAuthority: MerchantProductEditorVariantRemainingAuthority;
  readonly clock: { now(): string };
}): MerchantProductEditorRemainingContentAuthority {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  if (
    typeof options.variantAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.remainingAuthority !== "function" ||
    typeof options.clock?.now !== "function"
  )
    return fail();
  const variantHold = options.variantAuthority.holdUntilTransactionCompletes.bind(
      options.variantAuthority,
    ),
    remainingHold = options.remainingAuthority,
    now = options.clock.now.bind(options.clock);
  const states = new WeakMap<object, { failed: boolean; selectors: Map<string, number> }>();
  return async (tx, value) => {
    const state = states.get(tx) ?? { failed: false, selectors: new Map<string, number>() };
    states.set(tx, state);
    try {
      if (state.failed || typeof tx.query !== "function") return fail();
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
        raw.permission !== "catalog.manage" ||
        raw.owningAction !== "catalog.product.manage" ||
        raw.purposeCode !== "CATALOG_PRODUCT_DRAFT_REPLACE" ||
        Date.parse(validUntil) - Date.parse(observedAt) !== 5000 ||
        JSON.stringify(raw.requiredFields) !== JSON.stringify(productEditorContentFields) ||
        JSON.stringify(raw.requiredReferenceChecks) !==
          JSON.stringify(raw.mode === "Read" ? [] : remainingProductEditorReferenceChecks) ||
        aggregate.draft.editorContent === undefined ||
        Buffer.byteLength(JSON.stringify(aggregate), "utf8") > 8 * 1024 * 1024
      )
        return fail();
      const tuple = Object.freeze({
        tenantReference: parseCatalogReference(raw.tenantReference),
        brandReference: parseCatalogReference(raw.brandReference),
        storeReference: parseCatalogReference(raw.storeReference),
        actorReference: parseCatalogReference(raw.actorReference),
        sessionReference: parseCatalogReference(raw.sessionReference),
        productReference: parseCatalogReference(raw.productReference),
        operationReference: parseCatalogReference(raw.operationReference),
        permission: "catalog.manage" as const,
        owningAction: "catalog.product.manage" as const,
        purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE" as const,
        observedAt,
        validUntil,
      });
      if (
        aggregate.brandReference !== tuple.brandReference ||
        aggregate.productReference !== tuple.productReference
      )
        return fail();
      const check = () => {
        const at = parseCatalogInstant(now());
        if (state.failed || at < observedAt || at >= validUntil) return fail();
      };
      const key = sha256Hex(canonicalizeRfc8785(tuple));
      if (!state.selectors.has(key) && state.selectors.size >= 16) return fail();
      const input = Object.freeze({
        ...tuple,
        mode: raw.mode,
        aggregate,
        requiredFields: productEditorContentFields,
        requiredReferenceChecks:
          raw.mode === "Read" ? Object.freeze([]) : remainingProductEditorVariantReferenceChecks,
      });
      const holdRemaining = async () => {
        check();
        if ((await remainingHold(tx, input)) !== undefined) return fail();
        check();
      };
      check();
      if (raw.mode === "Read") {
        await holdRemaining();
        state.selectors.set(
          key,
          Math.max(state.selectors.get(key) ?? 0, aggregate.aggregateVersion),
        );
        return;
      }
      const root = state.selectors.get(key);
      if (
        root === undefined ||
        (aggregate.aggregateVersion !== root && aggregate.aggregateVersion !== root + 1)
      )
        return fail();
      const originalIntentDigest =
          "sha256:" +
          sha256Hex(
            canonicalizeRfc8785({
              ...tuple,
              selector: root,
              identity: deriveCatalogProductPublicationContentIdentity(aggregate),
            }),
          ),
        source = createPostgresProductVariantIdentityHistorySource({
          tenantReference: tuple.tenantReference,
          brandReference: tuple.brandReference,
          actorReference: tuple.actorReference,
          clock: { now },
          transactions: { run: (work) => work(tx) },
          authority: {
            async holdUntilTransactionCompletes(actualTx, request) {
              check();
              if ((await variantHold(actualTx, request)) !== undefined) return fail();
              check();
            },
          },
        });
      let calls = 0,
        finished = false,
        lifecycleConflict = false;
      const result = await source.withCurrentSnapshot(
        {
          productReference: tuple.productReference,
          expectedAggregateVersion: root,
          originalIntentDigest,
        },
        async (snapshot) => {
          if (
            ++calls !== 1 ||
            snapshot.brandReference !== tuple.brandReference ||
            snapshot.productReference !== tuple.productReference ||
            snapshot.aggregateVersion !== root ||
            snapshot.originalIntentDigest !== originalIntentDigest ||
            snapshot.observedAt < observedAt ||
            snapshot.observedAt >= validUntil
          )
            return fail();
          check();
          assertProductVariantIdentityHistory(aggregate, snapshot);
          try {
            await holdRemaining();
          } catch (error) {
            // The owning source sanitizes callback failures. Defer only a known
            // business conflict until its final authority/freshness checks pass.
            if (!(error instanceof CatalogError) || error.code !== "CATALOG_LIFECYCLE_CONFLICT")
              throw error;
            lifecycleConflict = true;
          }
          finished = true;
        },
      );
      if (calls !== 1 || !finished || result !== undefined) return fail();
      check();
      if (lifecycleConflict) throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
    } catch (error) {
      state.failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
}
