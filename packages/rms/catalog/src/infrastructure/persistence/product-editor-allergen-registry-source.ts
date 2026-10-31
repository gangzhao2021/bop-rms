import { canonicalizeRfc8785 } from "@bop/audit";
import {
  buildProductEditorAllergenRegistrySnapshot,
  parseProductEditorAllergenRegistryRequest,
  productEditorAllergenRegistryFields,
  type ProductEditorAllergenRegistryRequest,
  type ProductEditorAllergenRegistrySnapshot,
} from "../../contracts/product-editor-allergen-registry.js";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
} from "../../contracts/product.js";
import { requireCategoryCurrentReads } from "./category-repository.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";

const select = `SELECT jsonb_build_object(
 'registryVersionReference',r.registry_version_id,'brandReference',r.brand_id,
 'jurisdictionCode',r.jurisdiction_code,'policyDocumentDigest',r.policy_document_digest,
 'reviewedAt',to_char(r.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'reviewerActorReference',r.reviewer_actor_id,'status',r.status,
 'entries',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'allergenReference',a.allergen_id,'code',a.allergen_code,'localizedNames',a.localized_names_json
 ) ORDER BY a.allergen_id) FROM (SELECT allergen_id,allergen_code,localized_names_json
   FROM rms_catalog.allergen_registry_entry WHERE registry_version_id=r.registry_version_id
   AND brand_id=r.brand_id ORDER BY allergen_id LIMIT 10001) a),'[]'::jsonb)
 ) facts,(date_trunc('milliseconds',r.reviewed_at)=r.reviewed_at) coherent
 FROM rms_catalog.allergen_registry_version r
 WHERE r.brand_id=$1 AND r.registry_version_id=$2 LIMIT 2`;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
export interface ProductEditorAllergenRegistryAuthority {
  /** Actual User scope and fixed fields/purpose must remain current through
   * outer COMMIT, including shorter Session/Permission effective boundaries.
   * The caller's final authority guard is independent of dictionary locks. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly request: ProductEditorAllergenRegistryRequest;
      readonly actorKind: "User";
      readonly purposeCode: "CATALOG_PRODUCT_EDITOR_ALLERGEN_REGISTRY_READ";
      readonly permission: "catalog.manage";
      readonly owningAction: "catalog.product.manage";
      readonly requiredFields: typeof productEditorAllergenRegistryFields;
    },
  ): Promise<void>;
}
/** Uses the existing Catalog registry assets, not Menu source evidence or a new
 * registry. Its locked original dictionary and exact candidate are held until
 * outer COMMIT; sequential reholds retain the original observation and lease. */
export function createPostgresProductEditorAllergenRegistrySource(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly authority: ProductEditorAllergenRegistryAuthority;
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    now = options.clock.now.bind(options.clock),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options);
  interface State {
    readonly query: Transaction["query"];
    readonly fingerprint: string;
    readonly request: ProductEditorAllergenRegistryRequest;
    latest: string;
    failed: boolean;
    active: boolean;
    ready: boolean;
    final: boolean;
    guardRan: boolean;
    snapshot?: ProductEditorAllergenRegistrySnapshot;
  }
  const states = new WeakMap<object, State>();
  const poisoned = new WeakSet<object>();
  return Object.freeze({
    async withCurrentRegistry<T>(
      tx: Transaction,
      value: unknown,
      work: (snapshot: ProductEditorAllergenRegistrySnapshot) => Promise<T>,
    ): Promise<T> {
      let state = states.get(tx);
      const poison = (): never => {
        if (state) state.failed = true;
        return fail();
      };
      const check = () => {
        const at = parseCatalogInstant(now());
        if (
          !state ||
          poisoned.has(tx) ||
          state.failed ||
          tx.query !== state.query ||
          at < state.latest ||
          at >= state.request.validUntil
        )
          return poison();
        state.latest = at;
        return at;
      };
      const current = async () => {
        check();
        if (!state) return poison();
        if (
          (await hold(
            tx,
            Object.freeze({
              request: state.request,
              actorKind: "User",
              purposeCode: "CATALOG_PRODUCT_EDITOR_ALLERGEN_REGISTRY_READ",
              permission: "catalog.manage",
              owningAction: "catalog.product.manage",
              requiredFields: productEditorAllergenRegistryFields,
            }),
          )) !== undefined
        )
          return poison();
        check();
      };
      try {
        if (!state && !poisoned.has(tx)) {
          if (
            (await register(
              tx,
              async () => {
                check();
                if (!state || state.active || state.guardRan || !state.ready || state.final)
                  return poison();
                state.guardRan = true;
                await current();
              },
              () => {
                check();
                if (!state || state.active || !state.guardRan || state.final) return poison();
                state.final = true;
              },
            )) !== undefined
          )
            return poison();
        }
        if (poisoned.has(tx)) return poison();
        const request = parseProductEditorAllergenRegistryRequest(value),
          fingerprint = canonicalizeRfc8785(request);
        if (
          request.tenantReference !== tenant ||
          request.brandReference !== brand ||
          request.actorReference !== actor ||
          typeof work !== "function" ||
          typeof tx.query !== "function"
        )
          return poison();
        if (!state) {
          state = {
            query: tx.query,
            fingerprint,
            request,
            latest: request.observedAt,
            failed: false,
            active: false,
            ready: false,
            final: false,
            guardRan: false,
          };
          states.set(tx, state);
        }
        if (state.fingerprint !== fingerprint || state.active || state.final || state.failed)
          return poison();
        state.active = true;
        await current();
        if (!state.ready) {
          await requireCategoryCurrentReads(tx);
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          await tx.query(
            "LOCK TABLE rms_catalog.allergen_registry_version,rms_catalog.allergen_registry_entry IN SHARE MODE",
            [],
          );
          check();
          const result = await tx.query<{ readonly facts: unknown; readonly coherent: boolean }>(
            select,
            [brand, request.registryVersionReference],
          );
          check();
          const row = result.rows[0];
          if (result.rows.length !== 1 || !row || row.coherent !== true) return poison();
          state.snapshot = buildProductEditorAllergenRegistrySnapshot(request, row.facts);
          state.ready = true;
          check();
        }
        if (!state.snapshot) return poison();
        const result = await work(state.snapshot);
        check();
        await current();
        return result;
      } catch (error) {
        if (tx && typeof tx === "object") poisoned.add(tx);
        if (state) state.failed = true;
        if (
          error instanceof CatalogError &&
          ["CATALOG_PERMISSION_DENIED", "CATALOG_LIFECYCLE_CONFLICT"].includes(error.code)
        )
          throw error;
        return fail();
      } finally {
        if (state) state.active = false;
      }
    },
  });
}
