import {
  CatalogError,
  parseCatalogInstant,
  parseProductPublicationCommand,
  parseProductPublicationVersion,
  copyCategoryPersistenceValue,
  type ProductPublicationStoreOptions,
} from "@rms/catalog";
import {
  createCurrentProductPublicationPolicySource,
  currentProductPolicyFields,
} from "./current-product-publication-policy.js";

type SourceOptions = Parameters<typeof createCurrentProductPublicationPolicySource>[0];
type ScopePort = NonNullable<ProductPublicationStoreOptions["sources"]["withHeldScopePolicy"]>;
export interface MerchantProductScopePolicyConfiguration {
  readonly authority: SourceOptions["authority"];
}
export function captureMerchantProductScopePolicyConfiguration(
  value: MerchantProductScopePolicyConfiguration,
): MerchantProductScopePolicyConfiguration {
  if (typeof value?.authority?.holdUntilTransactionCompletes !== "function") return fail();
  return Object.freeze({
    authority: Object.freeze({
      holdUntilTransactionCompletes: value.authority.holdUntilTransactionCompletes.bind(
        value.authority,
      ),
    }),
  });
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Actual policy/order/current release only. Full validation, approval and
 * operational topology remain mandatory independent sources. */
export function createMerchantProductScopePolicy(options: {
  readonly configuration: MerchantProductScopePolicyConfiguration;
  readonly transaction: Parameters<ScopePort>[0];
  readonly command: Parameters<
    ProductPublicationStoreOptions["sources"]["withHeldCurrentFacts"]
  >[1]["command"];
  readonly clock: { now(): string };
  readonly assertAdmission: () => Promise<void>;
}) {
  const configuration = captureMerchantProductScopePolicyConfiguration(options.configuration);
  if (
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.assertAdmission !== "function"
  )
    return fail();
  const tx = options.transaction,
    query = tx.query,
    command = parseProductPublicationCommand(copyCategoryPersistenceValue(options.command)),
    now = options.clock.now.bind(options.clock),
    admission = options.assertAdmission,
    observedAt = parseCatalogInstant(now()),
    validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
  if (command.action !== "Publish" || command.actorKind !== "User") return fail();
  let latest = observedAt,
    failed = false,
    active = false;
  let policyValidUntil: string | undefined;
  let heldPolicy:
    Parameters<SourceOptions["authority"]["holdUntilTransactionCompletes"]>[1] | undefined;
  const check = () => {
    const at = parseCatalogInstant(now());
    if (
      failed ||
      tx.query !== query ||
      at < latest ||
      at >= validUntil ||
      (policyValidUntil !== undefined && at >= policyValidUntil)
    )
      return fail();
    latest = at;
    return at;
  };
  const assertNative = async () => {
    try {
      check();
      await admission();
      check();
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
  const assertCurrent = async () => {
    try {
      await assertNative();
      if (heldPolicy !== undefined) {
        if (
          (await configuration.authority.holdUntilTransactionCompletes(tx, {
            ...heldPolicy,
            observedAt: check(),
          })) !== undefined
        )
          return fail();
        await assertNative();
      }
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
  const source = createCurrentProductPublicationPolicySource({
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    actorReference: command.actorReference,
    actorKind: "User",
    clock: { now: check },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        if (
          actual !== tx ||
          input.tenantReference !== command.tenantReference ||
          input.brandReference !== command.brandReference ||
          input.actorReference !== command.actorReference ||
          input.actorKind !== "User" ||
          input.purposeCode !== "CATALOG_PRODUCT_VERSION_PUBLICATION" ||
          JSON.stringify(input.requiredFields) !== JSON.stringify(currentProductPolicyFields)
        )
          return fail();
        await assertNative();
        const captured = Object.freeze({ ...input, requiredFields: currentProductPolicyFields });
        if ((await configuration.authority.holdUntilTransactionCompletes(tx, input)) !== undefined)
          return fail();
        heldPolicy = captured;
        await assertNative();
      },
    },
  });
  const withHeldScopePolicy: ScopePort = async (actual, input, work) => {
    try {
      if (actual !== tx || active) return fail();
      active = true;
      const publication = parseProductPublicationVersion(
        copyCategoryPersistenceValue(input.publication),
      );
      if (
        publication.state !== "Published" ||
        publication.actorKind !== "User" ||
        publication.tenantReference !== command.tenantReference ||
        publication.brandReference !== command.brandReference ||
        publication.actorReference !== command.actorReference ||
        publication.productReference !== command.productReference ||
        publication.versionReference !== command.versionReference ||
        publication.operationReference !== command.operationReference
      )
        return fail();
      parseCatalogInstant(input.observedAt);
      await assertCurrent();
      let calls = 0,
        completed: { value: Awaited<ReturnType<typeof work>> } | undefined;
      const result = await source.withHeldScopePolicy(
        tx,
        { publication, observedAt: input.observedAt },
        async (policy) => {
          if (++calls !== 1) return fail();
          const captured = copyCategoryPersistenceValue(policy);
          if (!captured || typeof captured !== "object" || Array.isArray(captured)) return fail();
          const lease = captured as Record<string, unknown>;
          policyValidUntil = parseCatalogInstant(lease.validUntil);
          if (
            lease.policyReference !== publication.policyReference ||
            lease.policyVersion !== publication.policyVersion ||
            lease.observedAt !== input.observedAt
          )
            return fail();
          await assertNative();
          completed = { value: await work(captured) };
          await assertNative();
          return completed;
        },
      );
      await assertCurrent();
      if (calls !== 1 || !completed || result !== completed) return fail();
      return completed.value;
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    } finally {
      active = false;
    }
  };
  return Object.freeze({ withHeldScopePolicy, assertCurrent });
}
