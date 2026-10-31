import { readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  assertProductVariantCreationAbsence,
  assertProductVariantIdentityHistory,
  copyCategoryPersistenceValue,
  createPostgresProductVariantIdentityHistorySource,
  createPostgresProductVariantCreationSource,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  productEditorContentFields,
  type ProductVariantCreationAbsence,
  type ProductVariantIdentityHistorySnapshot,
  type ProductVariantIdentityHistoryRequest,
  productVariantHistoryFields,
} from "@rms/catalog";
import {
  remainingProductEditorReferenceChecks,
  type MerchantProductEditorRemainingContentAuthority,
} from "./merchant-product-editor-registered-content-authority.js";

type VariantOptions = Parameters<typeof createPostgresProductVariantIdentityHistorySource>[0];
type CreationOptions = Parameters<typeof createPostgresProductVariantCreationSource>[0];
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
  readonly creation?: Pick<CreationOptions, "authority" | "registerBeforeCommit">;
  readonly remainingAuthority: MerchantProductEditorVariantRemainingAuthority;
  readonly clock: { now(): string };
}): MerchantProductEditorRemainingContentAuthority {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  if (
    typeof options.variantAuthority?.holdUntilTransactionCompletes !== "function" ||
    (options.creation !== undefined &&
      (typeof options.creation.authority?.holdUntilTransactionCompletes !== "function" ||
        typeof options.creation.registerBeforeCommit !== "function")) ||
    typeof options.remainingAuthority !== "function" ||
    typeof options.clock?.now !== "function"
  )
    return fail();
  const variantHold = options.variantAuthority.holdUntilTransactionCompletes.bind(
      options.variantAuthority,
    ),
    remainingHold = options.remainingAuthority,
    now = options.clock.now.bind(options.clock);
  const creationHold = options.creation?.authority.holdUntilTransactionCompletes.bind(
      options.creation.authority,
    ),
    creationRegister = options.creation?.registerBeforeCommit.bind(options.creation);
  type CreationRequest = Parameters<
    ReturnType<typeof createPostgresProductVariantCreationSource>["withCreationAbsence"]
  >[0];
  const states = new WeakMap<
    object,
    {
      failed: boolean;
      active: boolean;
      query: Parameters<MerchantProductEditorRemainingContentAuthority>[0]["query"];
      latest: string;
      selectors: Map<string, number>;
      histories: Map<
        string,
        {
          fingerprint: string;
          request: ProductVariantIdentityHistoryRequest;
          snapshot: ProductVariantIdentityHistorySnapshot;
        }
      >;
      creations: Map<
        string,
        {
          fingerprint: string;
          request: CreationRequest;
          source: ReturnType<typeof createPostgresProductVariantCreationSource>;
        }
      >;
    }
  >();
  return async (tx, value) => {
    if (!tx || typeof tx !== "object" || typeof tx.query !== "function") return fail();
    const state = states.get(tx) ?? {
      failed: false,
      active: false,
      query: tx.query,
      latest: "",
      selectors: new Map<string, number>(),
      histories: new Map(),
      creations: new Map(),
    };
    states.set(tx, state);
    try {
      if (
        state.failed ||
        state.active ||
        typeof tx.query !== "function" ||
        tx.query !== state.query
      )
        return fail();
      state.active = true;
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
        purposeCode: raw.purposeCode as "CATALOG_PRODUCT_DRAFT_REPLACE" | "CATALOG_PRODUCT_CREATE",
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
        if (
          state.failed ||
          tx.query !== state.query ||
          at < observedAt ||
          at < state.latest ||
          at >= validUntil
        )
          return fail();
        state.latest = at;
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
      if (tuple.purposeCode === "CATALOG_PRODUCT_CREATE") {
        if (!creationHold || !creationRegister) return fail();
        const { observedAt: originalAt, validUntil: originalUntil, ...creationIdentity } = tuple;
        void originalAt;
        void originalUntil;
        const creationKey = sha256Hex(canonicalizeRfc8785(creationIdentity)),
          fingerprint = canonicalizeRfc8785(input);
        let admitted = state.creations.get(creationKey);
        if (admitted && admitted.fingerprint !== fingerprint) return fail();
        if (!admitted) {
          if (state.creations.size >= 16) return fail();
          const sourceAt = parseCatalogInstant(now()),
            request = Object.freeze({
              profile: "CatalogProductVariantCreationRequestV1" as const,
              operationReference: tuple.operationReference,
              aggregate,
              originalIntentDigest: "sha256:" + sha256Hex(fingerprint),
              observedAt: sourceAt,
              validUntil,
            }),
            source = createPostgresProductVariantCreationSource({
              tenantReference: tuple.tenantReference,
              brandReference: tuple.brandReference,
              actorReference: tuple.actorReference,
              clock: { now },
              transactions: { run: (work) => work(tx) },
              registerBeforeCommit: creationRegister,
              authority: {
                async holdUntilTransactionCompletes(actualTx, request) {
                  check();
                  if (actualTx !== tx || (await creationHold(actualTx, request)) !== undefined)
                    return fail();
                  check();
                },
              },
            });
          admitted = { fingerprint, request, source };
          state.creations.set(creationKey, admitted);
        }
        const original = admitted;
        let calls = 0,
          finished = false,
          lifecycleConflict = false;
        const result = await original.source.withCreationAbsence(
          original.request,
          async (
            proof: ProductVariantCreationAbsence,
            actualTx: Parameters<MerchantProductEditorRemainingContentAuthority>[0],
          ) => {
            if (++calls !== 1 || actualTx !== tx) return fail();
            check();
            assertProductVariantCreationAbsence(original.request, proof);
            try {
              await holdRemaining();
            } catch (error) {
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
        return;
      }
      if (raw.mode === "Read") {
        await holdRemaining();
        state.selectors.set(
          key,
          Math.max(state.selectors.get(key) ?? 0, aggregate.aggregateVersion),
        );
        return;
      }
      const { observedAt: originalAt, validUntil: originalUntil, ...historyIdentity } = tuple;
      void originalAt;
      void originalUntil;
      const historyKey = sha256Hex(canonicalizeRfc8785(historyIdentity)),
        fingerprint = canonicalizeRfc8785(input),
        retained = state.histories.get(historyKey);
      if (retained) {
        if (retained.fingerprint !== fingerprint) return fail();
        const authorize = async () => {
          check();
          if (
            (await variantHold(
              tx,
              Object.freeze({
                tenantReference: tuple.tenantReference,
                brandReference: tuple.brandReference,
                actorReference: tuple.actorReference,
                purposeCode: "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY",
                permission: "catalog.product.history.read",
                request: retained.request,
                requiredFields: productVariantHistoryFields,
                observedAt: parseCatalogInstant(now()),
              }),
            )) !== undefined
          )
            return fail();
          check();
        };
        await authorize();
        assertProductVariantIdentityHistory(aggregate, retained.snapshot);
        await holdRemaining();
        await authorize();
        return;
      }
      if (state.histories.size >= 16) return fail();
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
      const request = Object.freeze({
        productReference: tuple.productReference,
        expectedAggregateVersion: root,
        originalIntentDigest,
      });
      const result = await source.withCurrentSnapshot(request, async (snapshot) => {
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
        if (!lifecycleConflict) state.histories.set(historyKey, { fingerprint, request, snapshot });
      });
      if (calls !== 1 || !finished || result !== undefined) return fail();
      check();
      if (lifecycleConflict) throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
    } catch (error) {
      state.failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    } finally {
      state.active = false;
    }
  };
}
