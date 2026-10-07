import {
  createCurrentStoreCapabilityService,
  createEmptyStoreCapabilityDependencySource,
  createPostgresFeatureControlAdministrationQueryStore,
  createProductStoreCapabilityBindings,
  createOptionSetStoreCapabilityBindings,
  productStoreCapabilityBindings,
  optionSetStoreCapabilityBindings,
  createPricingStoreCapabilityBindings,
  pricingStoreCapabilityBindings,
  type FeatureControlAdministrationSource,
} from "@bop/feature-control";
import { revalidateTenantContext, type PermissionDecision } from "@bop/permission";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
} from "@rms/catalog";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { MerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

type Host = ReturnType<typeof createMerchantCategoryTransactions>;
export interface MerchantProductStoreCapabilityGuardOptions {
  readonly transaction: Parameters<Host["registerBeforeCommit"]>[0];
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: Host["registerBeforeCommit"];
  readonly currentAuthorization: MerchantProductCurrentAuthorization;
  readonly capabilityKey?:
    | "catalog.cat_product_list"
    | "catalog.cat_product_create"
    | "catalog.cat_product_detail"
    | "catalog.cat_product_edit"
    | "catalog.cat_optionset_list"
    | "catalog.cat_optionset_create"
    | "catalog.cat_optionset_detail"
    | "catalog.cat_optionset_edit"
    | "catalog.cat_sku_detail"
    | "pricing.price_book_list"
    | "pricing.price_book_editor";
}
export interface MerchantProductStoreCapabilityGuard {
  holdUntilCommit(): Promise<void>;
  holdUntilCommitWithDecisions?(actions: readonly string[]): Promise<readonly PermissionDecision[]>;
  /** Real held deadline observation, not reusable capability authority. */
  leaseDeadline?(): string;
}
const purposeCode = "STORE_CAPABILITY_EVALUATION";
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Fixed Product authoring evaluation, not an administration read or a reusable Allow.
 * The owning resolver selects the actual definition. Its shared Brand lock and
 * current Merchant authority remain on the caller's transaction through COMMIT. */
export function createMerchantProductStoreCapabilityGuard(
  options: MerchantProductStoreCapabilityGuardOptions,
): MerchantProductStoreCapabilityGuard {
  const tx = options.transaction,
    query = tx?.query,
    now = options.clock?.now?.bind(options.clock),
    register = options.registerBeforeCommit?.bind(options),
    authorize = options.currentAuthorization?.authorizeActions?.bind(options.currentAuthorization),
    decisionsPort = options.currentAuthorization?.authorizeActionsWithDecisions,
    authorizeDecisions =
      typeof decisionsPort === "function"
        ? decisionsPort.bind(options.currentAuthorization)
        : undefined,
    withScope = options.currentAuthorization?.withCurrentStoreScope?.bind(
      options.currentAuthorization,
    ),
    tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    storeReference = parseCatalogReference(options.storeReference),
    actorReference = parseCatalogReference(options.actorReference),
    capabilityKey = options.capabilityKey ?? "catalog.cat_product_edit",
    optionBinding = optionSetStoreCapabilityBindings.find(
      (entry) => entry.capabilityKey === capabilityKey,
    ),
    pricingBinding = pricingStoreCapabilityBindings.find(
      (entry) => entry.capabilityKey === capabilityKey,
    ),
    permissionAction = pricingBinding ? "pricing.price-book.manage" : "catalog.manage",
    binding =
      pricingBinding ??
      optionBinding ??
      productStoreCapabilityBindings.find((entry) => entry.capabilityKey === capabilityKey),
    controlKey = binding?.controlKey;
  void tenantReference; // Bound by the request-owned current authorization bridge and RLS.
  if (
    typeof query !== "function" ||
    typeof now !== "function" ||
    typeof register !== "function" ||
    typeof authorize !== "function" ||
    typeof withScope !== "function" ||
    ![
      "catalog.cat_product_list",
      "catalog.cat_product_create",
      "catalog.cat_product_detail",
      "catalog.cat_product_edit",
      "catalog.cat_optionset_list",
      "catalog.cat_optionset_create",
      "catalog.cat_optionset_detail",
      "catalog.cat_optionset_edit",
      "catalog.cat_sku_detail",
      "pricing.price_book_list",
      "pricing.price_book_editor",
    ].includes(capabilityKey) ||
    !controlKey
  )
    return fail();
  let failed = false,
    registered = false,
    active = false,
    ready = false,
    committing = false,
    committedGuard = false,
    finalCalls = 0,
    featureDisabled = false,
    latest = "",
    deadline = "";
  let authorityFailure: CatalogError | undefined;
  try {
    latest = parseCatalogInstant(now());
    const original = parseCatalogInstant(options.originalValidUntil),
      local = new Date(Date.parse(latest) + 5000).toISOString();
    deadline = original < local ? original : local;
    if (deadline <= latest) failed = true;
  } catch {
    failed = true;
  }
  const poison = (): never => {
    failed = true;
    return fail();
  };
  const check = () => {
    try {
      const at = parseCatalogInstant(now());
      if (failed || tx.query !== query || at < latest || at >= deadline) return poison();
      latest = at;
      return at;
    } catch {
      return poison();
    }
  };
  const current = async (
    actions?: readonly string[],
  ): Promise<readonly PermissionDecision[] | undefined> => {
    try {
      check();
      let decisions: readonly PermissionDecision[] | undefined;
      if (actions === undefined) {
        if ((await authorize([permissionAction])) !== undefined) return poison();
      }
      check();
      let calls = 0,
        completed: object | undefined;
      const observedAt = check(),
        result = await withScope(
          { brandReference, storeReference, capabilityKey, observedAt },
          async (value) => {
            if (++calls !== 1) return poison();
            const context = revalidateTenantContext(value);
            if (
              String(context.brand.brandReference) !== brandReference ||
              String(context.store?.storeReference) !== storeReference ||
              String(context.actor.actorReference) !== actorReference ||
              context.actor.actorType !== "User" ||
              String(context.resolvedAt) !== observedAt
            )
              return poison();
            check();
            completed = Object.freeze({});
            return completed;
          },
        );
      if (calls !== 1 || completed === undefined || result !== completed) return poison();
      check();
      // The actual Store reader leaves Store RLS selected. Full Brand policy
      // admission restores its owning Brand context after the scope checkpoint,
      // matching the original capability-then-authorize consumer sequence.
      if (actions !== undefined) {
        if (
          !authorizeDecisions ||
          options.currentAuthorization.authorizeActionsWithDecisions !== decisionsPort
        )
          return poison();
        decisions = await authorizeDecisions(actions);
        check();
      }
      return decisions;
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) {
        authorityFailure = error;
        throw error;
      }
      return fail();
    }
  };
  const beforeCommit = async () => {
    if (committing || active || !ready) return poison();
    committing = true;
    try {
      await current();
      check();
      committedGuard = true;
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const finalAssert = () => {
    if (!committedGuard || ++finalCalls !== 1 || active || !ready) return poison();
    check();
  };
  const hold = async (
    actions?: readonly string[],
  ): Promise<readonly PermissionDecision[] | undefined> => {
    // Later owning writer guards recheck authority after this guard resolves.
    // They may reuse the held evaluation until the final synchronous phase.
    if (active || (committing && !committedGuard) || finalCalls > 0) return poison();
    active = true;
    try {
      if (!registered) {
        registered = true;
        await register(tx, beforeCommit, finalAssert);
      }
      check();
      if (ready) return await current(actions);
      await current();
      let source: FeatureControlAdministrationSource | undefined;
      const definitions = createPostgresFeatureControlAdministrationQueryStore(
          {
            async run(work) {
              check();
              const value = await work(tx);
              check();
              return value;
            },
          },
          { brandReference, storeReference },
          {
            async withAuthorizedDefinitionsScope(input, work) {
              if (
                input.actorReference !== actorReference ||
                input.brandReference !== brandReference ||
                input.storeReference !== storeReference ||
                input.key !== controlKey ||
                input.purposeCode !== purposeCode ||
                input.access !== "AdministrationDefinitions"
              )
                return poison();
              await current();
              const value = await work();
              await current();
              return value;
            },
          },
        ),
        service = createCurrentStoreCapabilityService(
          {
            clock: { now: check },
            bindings: pricingBinding
              ? createPricingStoreCapabilityBindings()
              : optionBinding
                ? createOptionSetStoreCapabilityBindings()
                : createProductStoreCapabilityBindings(),
            dependencies: createEmptyStoreCapabilityDependencySource(),
            definitions: {
              withCurrentDefinitions(input, work) {
                return definitions.withCurrentDefinitions(input, async (value) => {
                  source = value;
                  return work(value);
                });
              },
            },
            authority: {
              async withCurrentStoreScope(input, work) {
                try {
                  return await withScope(input, work);
                } catch (error) {
                  if (error instanceof CatalogError) authorityFailure = error;
                  throw error;
                }
              },
            },
          },
          { brandReference, storeReference },
        );
      await service.withCurrentCapability(capabilityKey, async (decision) => {
        check();
        if (
          decision.capabilityKey !== capabilityKey ||
          decision.controlKey !== controlKey ||
          decision.brandReference !== brandReference ||
          decision.storeReference !== storeReference ||
          decision.backendExecution !== "Allow"
        ) {
          featureDisabled = true;
          throw new MerchantProductWriteFeatureDisabled();
        }
        const selected = source?.definitions.find(
          (d) => d.controlId === decision.controlReference && d.version === decision.controlVersion,
        );
        if (!selected || !source) return poison();
        for (const boundary of [selected.effectiveUntil, selected.expiresAt]) {
          if (boundary !== null && boundary < deadline) deadline = boundary;
        }
        // A persisted future definition can become effective without a write.
        // Stop at that boundary and require a new owning evaluation rather than
        // retaining the earlier selection through a future override.
        for (const definition of source.definitions) {
          if (
            (definition.lifecycle === "Published" || definition.lifecycle === "Disabled") &&
            definition.effectiveFrom > decision.observedAt &&
            definition.effectiveFrom < deadline
          )
            deadline = definition.effectiveFrom;
        }
        check();
      });
      const decisions = await current(actions);
      ready = true;
      return decisions;
    } catch (error) {
      failed = true;
      if (authorityFailure?.code === "CATALOG_PERMISSION_DENIED") throw authorityFailure;
      if (featureDisabled) throw new MerchantProductWriteFeatureDisabled();
      if (authorityFailure) throw authorityFailure;
      if (error instanceof CatalogError) throw error;
      return fail();
    } finally {
      active = false;
    }
  };
  return Object.freeze({
    leaseDeadline() {
      if (!ready || active) return poison();
      check();
      return parseCatalogInstant(deadline);
    },
    async holdUntilCommit(): Promise<void> {
      await hold();
    },
    async holdUntilCommitWithDecisions(
      actions: readonly string[],
    ): Promise<readonly PermissionDecision[]> {
      let copied: unknown;
      try {
        copied = copyCategoryPersistenceValue(actions);
      } catch {
        return poison();
      }
      if (!Array.isArray(copied)) return poison();
      const selected: string[] = [];
      for (const action of copied) {
        if (typeof action !== "string") return poison();
        selected.push(action);
      }
      if (!selected.includes(permissionAction)) return poison();
      const result = await hold(Object.freeze(selected));
      if (result === undefined) return poison();
      return result;
    },
  });
}
