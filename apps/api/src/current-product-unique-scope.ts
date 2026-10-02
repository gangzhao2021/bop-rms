import {
  createPostgresProductPublicationSourceStore,
  assessCatalogProductUniqueScope,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductPublicationCommand,
  CatalogError,
  productPublicationWriteFields,
  type ProductPublicationStoreOptions,
  type CatalogProductUniqueScopeAssessment,
} from "@rms/catalog";
import {
  createPostgresTenantStoreReferenceSource,
  type TenantStoreReferenceSourceOptions,
} from "@bop/tenant";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { createCurrentProductPublicationPolicySource } from "./current-product-publication-policy.js";
type HistoryOptions = Parameters<typeof createPostgresProductPublicationSourceStore>[0];
type PolicySource = ReturnType<typeof createCurrentProductPublicationPolicySource>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Three public owners, one caller transaction. Registry identities are not
 * operational topology or capability/module/sale qualification. */
export function createCurrentProductUniqueScopeSource(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly validationAuthority: ProductPublicationStoreOptions["authority"];
  readonly historyAuthority: HistoryOptions["authority"];
  readonly tenantAuthority: TenantStoreReferenceSourceOptions["authority"];
  readonly policySource: PolicySource;
  readonly clock: { now(): string };
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    now = options.clock.now.bind(options.clock);
  if (typeof options.validationAuthority?.holdUntilTransactionCompletes !== "function")
    return fail();
  const validate = options.validationAuthority.holdUntilTransactionCompletes.bind(
    options.validationAuthority,
  );
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Parameters<PolicySource["withCurrentPolicy"]>[0],
      value: unknown,
      work: (assessment: CatalogProductUniqueScopeAssessment) => Promise<T>,
    ): Promise<T> {
      try {
        const raw = copyCategoryPersistenceValue(value);
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.keys(raw).length !== 3 ||
          ["command", "policyReference", "policyVersion"].some((k) => !Object.hasOwn(raw, k))
        )
          return fail();
        const input = raw as Record<string, unknown>,
          c = parseProductPublicationCommand(input.command),
          context = options.policySource.context;
        if (
          c.action !== "Validate" ||
          c.actorKind !== "User" ||
          c.tenantReference !== tenant ||
          c.brandReference !== brand ||
          c.actorReference !== actor ||
          context.tenantReference !== tenant ||
          context.brandReference !== brand ||
          context.actorReference !== actor ||
          context.actorKind !== "User"
        )
          return fail();
        const authorize = () =>
          validate(tx, {
            command: c,
            requiredPermissions: ["catalog.product.read", "catalog.product.validate"],
            requiredFields: productPublicationWriteFields,
            requiredScope: "FullBrandScope",
            observedAt: parseCatalogInstant(now()),
          });
        await authorize();
        const history = createPostgresProductPublicationSourceStore({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          actorKind: "User",
          clock: { now },
          transactions: { run: (work) => work(tx) },
          authority: options.historyAuthority,
        });
        const stores = createPostgresTenantStoreReferenceSource({
          brandReference: brand,
          transactions: { run: (work) => work(tx) },
          authority: options.tenantAuthority,
        });
        let calls = 0,
          assessmentCalls = 0,
          finished = false,
          completed: T | undefined,
          finalLease: { observedAt: string; validUntil: string } | undefined;
        const result = await history.withCurrentSnapshot(
          {
            productReference: c.productReference,
            expectedAggregateVersion: c.expectedProductAggregateVersion,
          },
          async (current) => {
            if (++calls !== 1) return fail();
            const observedAt = current.observedAt,
              validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
            const check = () => {
              const at = parseCatalogInstant(now());
              if (at < observedAt || at >= validUntil) return fail();
            };
            check();
            return stores.withCurrentSnapshot(
              {
                brandReference: brand,
                actorReference: actor,
                purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
                originalIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(c)),
                observedAt,
              },
              async (registered) =>
                options.policySource.withCurrentPolicy(
                  tx,
                  {
                    policyReference: input.policyReference as string,
                    policyVersion: input.policyVersion as number,
                    observedAt,
                  },
                  async (policy) => {
                    if (++assessmentCalls !== 1) return fail();
                    const assessment = assessCatalogProductUniqueScope(
                      c,
                      current,
                      registered,
                      policy,
                      now(),
                    );
                    check();
                    finalLease = assessment;
                    const result = await work(assessment);
                    check();
                    finished = true;
                    completed = result;
                    return result;
                  },
                ),
            );
          },
        );
        if (calls !== 1 || assessmentCalls !== 1 || !finished || !Object.is(result, completed))
          return fail();
        await authorize();
        const currentAt = parseCatalogInstant(now());
        if (!finalLease || currentAt < finalLease.observedAt || currentAt >= finalLease.validUntil)
          return fail();
        return result;
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
  });
}
