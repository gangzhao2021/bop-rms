import { createTenantContext } from "@bop/tenant";
import {
  createCurrentStoreCapabilityService,
  createPostgresFeatureControlAdministrationQueryStore,
  parseStoreCapabilityKey,
  StoreCapabilityUnavailableError,
  createProductStoreCapabilityBindings,
  createOptionSetStoreCapabilityBindings,
  createPricingStoreCapabilityBindings,
  createEmptyStoreCapabilityDependencySource,
  productStoreCapabilityBindings,
  optionSetStoreCapabilityBindings,
  pricingStoreCapabilityBindings,
  type CurrentStoreCapabilityPorts,
  type StoreCapabilityDecision,
  type FeatureControlAdministrationQueryAuthorization,
} from "@bop/feature-control";
import { readClosedRecord } from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { parseCatalogInstant } from "@rms/catalog";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

export interface MerchantStoreCapabilityOptions {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly bindings?: CurrentStoreCapabilityPorts["bindings"];
  readonly dependencies?: CurrentStoreCapabilityPorts["dependencies"];
  /** Actual field/purpose/source authority, held through outer COMMIT. */
  readonly definitionsAuthority?: FeatureControlAdministrationQueryAuthorization;
  /** Fixed Catalog/Pricing navigation uses current Brand IAM and owning definitions. */
  readonly currentProductRuntime?: true;
}
const fail = (): never => {
  throw new StoreCapabilityUnavailableError();
};
/** Current observations and backend guards share the owning resolver. Trusted
 * consumers choose their own action/key. HTTP bodies cannot choose an action,
 * Tenant, Store, Actor, control mapping, dependency receipt or an allow. */
export function createMerchantStoreCapability(options: MerchantStoreCapabilityOptions) {
  const source = options.persistence,
    persistence = Object.freeze({
      ...source,
      now: source.now.bind(source),
      currentActor: source.currentActor.bind(source),
      validateAssociation: source.validateAssociation.bind(source),
      transactions: Object.freeze({ run: source.transactions.run.bind(source.transactions) }),
    }),
    authenticate = options.authentication.authorize.bind(options.authentication),
    currentProductRuntime = options.currentProductRuntime === true,
    definitionsAuthority = options.definitionsAuthority,
    bindings = options.bindings,
    dependencies = options.dependencies,
    resolve = createMerchantStoreScope(persistence),
    resolveBrand = createMerchantBrandScope(persistence),
    host = createMerchantCategoryTransactions(persistence.transactions);
  if (
    (options.currentProductRuntime !== undefined && options.currentProductRuntime !== true) ||
    (currentProductRuntime &&
      (definitionsAuthority !== undefined ||
        bindings !== undefined ||
        dependencies !== undefined)) ||
    (!currentProductRuntime && !definitionsAuthority)
  )
    return fail();

  async function withCurrentProductCapability<T>(
    input: { sessionCookie: unknown; csrf: unknown },
    capabilityKey: string,
    action: string,
    work: (decision: StoreCapabilityDecision) => Promise<T>,
  ): Promise<T> {
    const key = parseStoreCapabilityKey(capabilityKey),
      optionBinding = optionSetStoreCapabilityBindings.find((entry) => entry.capabilityKey === key),
      pricingBinding = pricingStoreCapabilityBindings.find((entry) => entry.capabilityKey === key),
      binding =
        pricingBinding ??
        optionBinding ??
        productStoreCapabilityBindings.find((entry) => entry.capabilityKey === key);
    if (
      ![
        "catalog.cat_product_list",
        "catalog.cat_product_create",
        "catalog.cat_product_detail",
        "catalog.cat_product_edit",
        "catalog.cat_sku_detail",
        "catalog.cat_optionset_list",
        "catalog.cat_optionset_create",
        "catalog.cat_optionset_detail",
        "catalog.cat_optionset_edit",
        "pricing.price_book_list",
        "pricing.price_book_editor",
      ].includes(key) ||
      !binding ||
      action !==
        (pricingBinding
          ? "pricing.price-book.manage"
          : optionBinding
            ? "catalog.option_set.read"
            : "catalog.product.manage")
    )
      return fail();
    const sessionCookie = input.sessionCookie,
      observedAt = parseCatalogInstant(persistence.now());
    let deadline = new Date(Date.parse(observedAt) + 5000).toISOString(),
      latest: string = observedAt,
      failed = false;
    const session = await authenticate({ sessionCookie, csrf: input.csrf });
    return host.transactions.run(async (tx) => {
      const query = tx.query;
      let ready = false,
        current: (() => Promise<void>) | undefined;
      const check = () => {
        try {
          const at = parseCatalogInstant(persistence.now());
          if (failed || tx.query !== query || at < latest || at >= deadline) return fail();
          latest = at;
          return at;
        } catch (error) {
          failed = true;
          throw error;
        }
      };
      await host.registerBeforeCommit(
        tx,
        async () => {
          check();
          if (!ready || !current) return fail();
          await current();
          check();
        },
        () => {
          check();
        },
      );
      try {
        check();
        const scope = await resolve(tx, sessionCookie, "merchant.access", session.sessionReference),
          brand = await resolveBrand(tx, sessionCookie, session.sessionReference),
          brandReference = String(scope.context.brand.brandReference),
          storeReference = String(scope.store.storeReference),
          actorReference = String(scope.actorReference),
          authorize = brand.authorizeActionsWithValidity.bind(brand);
        if (
          brand.tenantReference !== scope.selected.tenantReference ||
          String(brand.context.brand.brandReference) !== brandReference ||
          String(brand.selectedStoreReference) !== storeReference ||
          String(brand.actorReference) !== actorReference ||
          scope.sessionReference !== session.sessionReference
        )
          return fail();
        current = async () => {
          check();
          const actions = pricingBinding
              ? (["pricing.price-book.manage"] as const)
              : (["catalog.manage", action] as const),
            held = readClosedRecord(await authorize(actions), ["decisions", "validUntil"]),
            decisions = held.decisions;
          const retain = (value: unknown) => {
            if (value !== null) {
              const boundary = parseCatalogInstant(value);
              if (boundary < deadline) deadline = boundary;
            }
            check();
          };
          retain(held.validUntil);
          check();
          if (
            !Array.isArray(decisions) ||
            decisions.length !== actions.length ||
            actions.some(
              (action, index) =>
                decisions[index]?.effect !== "Allow" ||
                decisions[index]?.scopeKind !== "Brand" ||
                decisions[index]?.action !== action,
            )
          )
            return fail();
          if (!(await scope.allowed())) return fail();
          retain(scope.authorizationValidUntil());
          check();
        };
        await current();
        const definitions = createPostgresFeatureControlAdministrationQueryStore(
          { run: (callback) => callback(tx) },
          { brandReference, storeReference },
          {
            async withAuthorizedDefinitionsScope(value, callback) {
              const packet = readClosedRecord(value, [
                "actorReference",
                "purposeCode",
                "key",
                "observedAt",
                "brandReference",
                "storeReference",
                "access",
              ]);
              const at = parseCatalogInstant(packet.observedAt);
              if (
                packet.actorReference !== actorReference ||
                packet.brandReference !== brandReference ||
                packet.storeReference !== storeReference ||
                packet.key !== binding.controlKey ||
                packet.purposeCode !== "STORE_CAPABILITY_EVALUATION" ||
                packet.access !== "AdministrationDefinitions" ||
                at < observedAt ||
                at > check() ||
                !current
              )
                return fail();
              await current();
              const result = await callback();
              await current();
              return result;
            },
          },
        );
        const service = createCurrentStoreCapabilityService(
          {
            clock: { now: check },
            bindings: pricingBinding
              ? createPricingStoreCapabilityBindings()
              : optionBinding
                ? createOptionSetStoreCapabilityBindings()
                : createProductStoreCapabilityBindings(),
            dependencies: createEmptyStoreCapabilityDependencySource(),
            definitions: {
              withCurrentDefinitions(request, callback) {
                return definitions.withCurrentDefinitions(request, async (source) => {
                  // The held definition lock prevents writes; clock boundaries
                  // still apply during the final authority reads.
                  for (const definition of source.definitions) {
                    for (const boundary of [
                      definition.effectiveFrom,
                      definition.effectiveUntil,
                      definition.expiresAt,
                    ]) {
                      if (boundary !== null && boundary > source.observedAt && boundary < deadline)
                        deadline = boundary;
                    }
                  }
                  return callback(source);
                });
              },
            },
            authority: {
              async withCurrentStoreScope(request, callback) {
                if (
                  request.brandReference !== brandReference ||
                  request.storeReference !== storeReference ||
                  request.capabilityKey !== key ||
                  request.observedAt < observedAt ||
                  request.observedAt > check() ||
                  !current
                )
                  return fail();
                await current();
                const result = await callback(
                  createTenantContext(
                    scope.context.actor,
                    scope.context.brand,
                    scope.store,
                    request.observedAt,
                  ),
                );
                await current();
                return result;
              },
            },
          },
          { brandReference, storeReference },
        );
        const result = await service.withCurrentCapability(key, async (decision) => {
          if (
            decision.capabilityKey !== key ||
            decision.controlKey !== binding.controlKey ||
            decision.brandReference !== brandReference ||
            decision.storeReference !== storeReference ||
            !current
          )
            return fail();
          await current();
          const value = await work(decision);
          await current();
          return value;
        });
        check();
        ready = true;
        return result;
      } catch (error) {
        failed = true;
        throw error;
      }
    });
  }
  async function withCapability<T>(
    input: { sessionCookie: unknown; csrf: unknown },
    capabilityKey: string,
    action: string,
    work: (decision: StoreCapabilityDecision) => Promise<T>,
  ): Promise<T> {
    try {
      if (currentProductRuntime)
        return await withCurrentProductCapability(input, capabilityKey, action, work);
      const key = parseStoreCapabilityKey(capabilityKey),
        session = await authenticate(input);
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
          definitionsAuthority ?? fail(),
        );
        const service = createCurrentStoreCapabilityService(
          {
            clock: { now: persistence.now },
            bindings: bindings ?? createProductStoreCapabilityBindings(),
            dependencies: dependencies ?? createEmptyStoreCapabilityDependencySource(),
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
      return withCapability(
        input,
        key,
        currentProductRuntime
          ? pricingStoreCapabilityBindings.some((binding) => binding.capabilityKey === key)
            ? "pricing.price-book.manage"
            : optionSetStoreCapabilityBindings.some((binding) => binding.capabilityKey === key)
              ? "catalog.option_set.read"
              : "catalog.product.manage"
          : "organization.manage",
        async (decision) => decision,
      );
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
