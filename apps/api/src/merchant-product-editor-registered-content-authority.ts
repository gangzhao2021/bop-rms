import { readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  contentRegistryFields,
  copyCategoryPersistenceValue,
  createPostgresProductContentRegistryStore,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogProductContentRegistry,
  parseProductAggregate,
  productEditorContentFields,
  productEditorContentReferenceChecks,
  validateCatalogProductRegisteredContent,
} from "@rms/catalog";
import type {
  MerchantProductEditorContentAuthority,
  MerchantProductEditorContentAuthorityInput,
} from "./merchant-product-editor-content-authority.js";

type RegistryOptions = Parameters<typeof createPostgresProductContentRegistryStore>[0];
export const remainingProductEditorReferenceChecks = Object.freeze(
  productEditorContentReferenceChecks.filter(
    (check) => check !== "TagRegistry" && check !== "AttributeRegistry",
  ),
);
export type MerchantProductEditorRemainingContentAuthority = (
  tx: Parameters<MerchantProductEditorContentAuthority>[0],
  input: Omit<MerchantProductEditorContentAuthorityInput, "requiredReferenceChecks"> & {
    readonly requiredReferenceChecks: typeof remainingProductEditorReferenceChecks;
  },
) => Promise<void>;

/** Server composition for two actual owning reference checks. All other fields
 * and references still require an independent current holder; no partial source
 * or stored registry is full publication/sale qualification.
 */
export function createMerchantProductEditorRegisteredContentAuthority(options: {
  readonly registryAuthority: RegistryOptions["authority"];
  readonly remainingAuthority: MerchantProductEditorRemainingContentAuthority;
  readonly clock: { now(): string };
}): MerchantProductEditorContentAuthority {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  if (
    typeof options.registryAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.remainingAuthority !== "function" ||
    typeof options.clock?.now !== "function"
  )
    return fail();
  const registryHold = options.registryAuthority.holdUntilTransactionCompletes.bind(
      options.registryAuthority,
    ),
    remainingHold = options.remainingAuthority,
    now = options.clock.now.bind(options.clock);
  interface HeldRegistry {
    readonly fingerprint: string;
    readonly query: Parameters<MerchantProductEditorContentAuthority>[0]["query"];
    readonly registry: ReturnType<typeof parseCatalogProductContentRegistry>;
    readonly snapshotDigest: string;
    readonly originalIntentDigest: string;
    readonly observedAt: string;
    readonly validUntil: string;
  }
  // The owning shared transaction lock retains this immutable source to COMMIT.
  // Permissions and the remaining source chain are always held again.
  const held = new WeakMap<object, HeldRegistry>();
  return async (tx, value) => {
    try {
      if (!tx || typeof tx !== "object" || typeof tx.query !== "function") return fail();
      const query = tx.query;
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
        !["Read", "DraftWrite"].includes(String(raw.mode)) ||
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
          JSON.stringify(raw.mode === "Read" ? [] : productEditorContentReferenceChecks) ||
        aggregate.draft.editorContent === undefined ||
        Buffer.byteLength(JSON.stringify(aggregate), "utf8") > 8 * 1024 * 1024
      )
        return fail();
      const input: MerchantProductEditorContentAuthorityInput = Object.freeze({
        tenantReference: parseCatalogReference(raw.tenantReference),
        brandReference: parseCatalogReference(raw.brandReference),
        storeReference: parseCatalogReference(raw.storeReference),
        actorReference: parseCatalogReference(raw.actorReference),
        sessionReference: parseCatalogReference(raw.sessionReference),
        productReference: parseCatalogReference(raw.productReference),
        operationReference: parseCatalogReference(raw.operationReference),
        permission: "catalog.manage",
        owningAction: "catalog.product.manage",
        purposeCode: raw.purposeCode as "CATALOG_PRODUCT_DRAFT_REPLACE" | "CATALOG_PRODUCT_CREATE",
        observedAt,
        validUntil,
        mode: raw.mode as "Read" | "DraftWrite",
        aggregate,
        requiredFields: productEditorContentFields,
        requiredReferenceChecks:
          raw.mode === "Read" ? Object.freeze([]) : productEditorContentReferenceChecks,
      });
      if (
        aggregate.brandReference !== input.brandReference ||
        aggregate.productReference !== input.productReference
      )
        return fail();
      const check = () => {
        const at = parseCatalogInstant(now());
        if (tx.query !== query || at < observedAt || at >= validUntil) return fail();
      };
      const holdRemaining = async () => {
        check();
        if (
          (await remainingHold(
            tx,
            Object.freeze({
              ...input,
              requiredReferenceChecks:
                input.mode === "Read" ? Object.freeze([]) : remainingProductEditorReferenceChecks,
            }),
          )) !== undefined
        )
          return fail();
        check();
      };
      check();
      if (input.mode === "Read") return await holdRemaining();
      const fingerprint = canonicalizeRfc8785(input),
        retained = held.get(tx);
      if (retained) {
        if (
          retained.fingerprint !== fingerprint ||
          retained.query !== tx.query ||
          retained.observedAt !== observedAt ||
          retained.validUntil !== validUntil
        )
          return fail();
        const digest =
          "sha256:" +
          sha256Hex(
            canonicalizeRfc8785({
              ...input,
              aggregate: deriveCatalogProductPublicationContentIdentity(aggregate),
            }),
          );
        if (
          retained.originalIntentDigest !== digest ||
          retained.registry.tenantReference !== input.tenantReference ||
          retained.registry.brandReference !== input.brandReference ||
          validateCatalogProductRegisteredContent(aggregate, retained.registry).snapshotDigest !==
            retained.snapshotDigest
        )
          return fail();
        const holdRegistry = async () => {
          check();
          if (
            (await registryHold(
              tx,
              Object.freeze({
                tenantReference: input.tenantReference,
                brandReference: input.brandReference,
                actorReference: input.actorReference,
                actorKind: "User",
                purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY",
                permission: "catalog.manage",
                action: "catalog.content-registry.read",
                registry: retained.registry,
                requiredFields: contentRegistryFields,
                observedAt: parseCatalogInstant(now()),
              }),
            )) !== undefined
          )
            return fail();
          check();
        };
        await holdRegistry();
        await holdRemaining();
        await holdRegistry();
        return;
      }
      const originalIntentDigest =
          "sha256:" +
          sha256Hex(
            canonicalizeRfc8785({
              ...input,
              aggregate: deriveCatalogProductPublicationContentIdentity(aggregate),
            }),
          ),
        source = createPostgresProductContentRegistryStore({
          tenantReference: input.tenantReference,
          brandReference: input.brandReference,
          actorReference: input.actorReference,
          actorKind: "User",
          clock: { now },
          transactions: { run: (work) => work(tx) },
          authority: {
            async holdUntilTransactionCompletes(actualTx, request) {
              check();
              if ((await registryHold(actualTx, request)) !== undefined) return fail();
              check();
            },
          },
        });
      let calls = 0,
        finished = false,
        proof: HeldRegistry | undefined;
      const result = await source.withCurrentRegistry(
        { originalIntentDigest, observedAt, validUntil },
        async (current, actualTx) => {
          if (
            ++calls !== 1 ||
            actualTx !== tx ||
            current.eligibility !== "NotEvaluated" ||
            current.registry.tenantReference !== input.tenantReference ||
            current.registry.brandReference !== input.brandReference ||
            current.observation.originalIntentDigest !== originalIntentDigest ||
            current.observation.observedAt !== observedAt ||
            current.observation.validUntil !== validUntil
          )
            return fail();
          check();
          const registry = parseCatalogProductContentRegistry(
            copyCategoryPersistenceValue(current.registry),
          );
          const assessment = validateCatalogProductRegisteredContent(aggregate, registry);
          if (assessment.snapshotDigest !== current.snapshotDigest) return fail();
          proof = Object.freeze({
            fingerprint,
            query,
            registry,
            snapshotDigest: current.snapshotDigest,
            originalIntentDigest,
            observedAt,
            validUntil,
          });
          await holdRemaining();
          finished = true;
        },
      );
      if (calls !== 1 || !finished || result !== undefined || !proof) return fail();
      check();
      held.set(tx, proof);
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
}
