import { createTenantContext } from "@bop/tenant";
import {
  createCurrentStoreCapabilityService,
  createPostgresFeatureControlAdministrationQueryStore,
  parseStoreCapabilityKey,
  StoreCapabilityUnavailableError,
  createProductStoreCapabilityBindings,
  createEmptyStoreCapabilityDependencySource,
  type CurrentStoreCapabilityPorts,
  type StoreCapabilityDecision,
  type FeatureControlAdministrationQueryAuthorization,
} from "@bop/feature-control";
import { readClosedRecord } from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

export interface MerchantStoreCapabilityOptions {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly bindings?: CurrentStoreCapabilityPorts["bindings"];
  readonly dependencies?: CurrentStoreCapabilityPorts["dependencies"];
  /** Actual field/purpose/source authority, held through outer COMMIT. */
  readonly definitionsAuthority: FeatureControlAdministrationQueryAuthorization;
}
const fail = (): never => {
  throw new StoreCapabilityUnavailableError();
};
/** Current observations and backend guards share the owning resolver. Trusted
 * consumers choose their own action/key. HTTP bodies cannot choose an action,
 * Tenant, Store, Actor, control mapping, dependency receipt or an allow. */
export function createMerchantStoreCapability(options: MerchantStoreCapabilityOptions) {
  const resolve = createMerchantStoreScope(options.persistence),
    host = createMerchantCategoryTransactions(options.persistence.transactions);
  async function withCapability<T>(
    input: { sessionCookie: unknown; csrf: unknown },
    capabilityKey: string,
    action: string,
    work: (decision: StoreCapabilityDecision) => Promise<T>,
  ): Promise<T> {
    try {
      const key = parseStoreCapabilityKey(capabilityKey),
        session = await options.authentication.authorize(input);
      return await host.transactions.run(async (tx) => {
        const scope = await resolve(tx, input.sessionCookie, action, session.sessionReference);
        if (!(await scope.allowed())) return fail();
        await host.registerBeforeCommit(tx, async () => {
          if (!(await scope.allowed())) return fail();
        });
        const brandReference = scope.context.brand.brandReference,
          storeReference = scope.store.storeReference;
        const definitions = createPostgresFeatureControlAdministrationQueryStore(
          { run: (callback) => callback(tx) },
          { brandReference, storeReference },
          options.definitionsAuthority,
        );
        const service = createCurrentStoreCapabilityService(
          {
            clock: { now: options.persistence.now },
            bindings: options.bindings ?? createProductStoreCapabilityBindings(),
            dependencies: options.dependencies ?? createEmptyStoreCapabilityDependencySource(),
            definitions,
            authority: {
              async withCurrentStoreScope(request, callback) {
                if (
                  request.brandReference !== brandReference ||
                  request.storeReference !== storeReference ||
                  request.capabilityKey !== key ||
                  !(await scope.allowed())
                )
                  return fail();
                const context = createTenantContext(
                  scope.context.actor,
                  scope.context.brand,
                  scope.store,
                  request.observedAt,
                );
                const result = await callback(context);
                if (!(await scope.allowed())) return fail();
                return result;
              },
            },
          },
          { brandReference, storeReference },
        );
        return service.withCurrentCapability(key, work);
      });
    } catch {
      return fail();
    }
  }
  return Object.freeze({
    withCapability,
    async observe(input: { sessionCookie: unknown; csrf: unknown; query: unknown }) {
      let key: string;
      try {
        key = parseStoreCapabilityKey(
          readClosedRecord(input.query, ["capabilityKey"]).capabilityKey,
        );
      } catch {
        return fail();
      }
      return withCapability(input, key, "organization.manage", async (decision) => decision);
    },
    async guard<T>(
      input: { sessionCookie: unknown; csrf: unknown },
      capabilityKey: string,
      action: string,
      work: () => Promise<T>,
    ): Promise<T> {
      return withCapability(input, capabilityKey, action, async (decision) => {
        if (decision.backendExecution !== "Allow") return fail();
        return work();
      });
    },
  });
}
