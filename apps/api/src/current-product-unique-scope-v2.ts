import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresTenantStoreReferenceSource,
  type TenantStoreReferenceSourceOptions,
} from "@bop/tenant";
import {
  assessCatalogProductUniqueScopeV2,
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductPublicationSourceStoreV2,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductPublicationCommandV2,
  productPublicationWriteFieldsV2,
  type CatalogProductUniqueScopeAssessmentV2,
  type ProductPublicationStoreOptionsV2,
} from "@rms/catalog";
import type { createCurrentProductPublicationPolicySource } from "./current-product-publication-policy.js";

type HistoryOptions = Parameters<typeof createPostgresProductPublicationSourceStoreV2>[0];
type PolicySource = ReturnType<typeof createCurrentProductPublicationPolicySource>;
export interface CurrentProductUniqueScopeSourceOptionsV2 {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly validationAuthority: ProductPublicationStoreOptionsV2["authority"];
  readonly historyAuthority: HistoryOptions["authority"];
  readonly tenantAuthority: TenantStoreReferenceSourceOptions["authority"];
  readonly policySource: Pick<PolicySource, "context" | "withCurrentPolicy">;
  readonly clock: { now(): string };
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
/** Actual complete retirement coverage, registered Store references and current
 * Published policy in the caller transaction. A passing check establishes no
 * operational Store/SKU qualification or other publication validation. */
export function createCurrentProductUniqueScopeSourceV2(
  options: CurrentProductUniqueScopeSourceOptionsV2,
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.validationAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.historyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.tenantAuthority?.withCurrentBrandReferenceRead !== "function" ||
    typeof options.tenantAuthority?.isCurrent !== "function" ||
    typeof options.policySource?.withCurrentPolicy !== "function"
  )
    return fail();
  const policyContext = copyCategoryPersistenceValue(
    options.policySource.context,
  ) as PolicySource["context"];
  if (
    !policyContext ||
    policyContext.tenantReference !== tenant ||
    policyContext.brandReference !== brand ||
    policyContext.actorReference !== actor ||
    policyContext.actorKind !== "User"
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    validate = options.validationAuthority.holdUntilTransactionCompletes.bind(
      options.validationAuthority,
    ),
    historyAuthority = Object.freeze({
      holdUntilTransactionCompletes: options.historyAuthority.holdUntilTransactionCompletes.bind(
        options.historyAuthority,
      ),
    }),
    tenantAuthority = Object.freeze({
      withCurrentBrandReferenceRead: options.tenantAuthority.withCurrentBrandReferenceRead.bind(
        options.tenantAuthority,
      ),
      isCurrent: options.tenantAuthority.isCurrent.bind(options.tenantAuthority),
    }),
    policy = options.policySource.withCurrentPolicy.bind(options.policySource),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Parameters<PolicySource["withCurrentPolicy"]>[0],
      value: unknown,
      work: (assessment: CatalogProductUniqueScopeAssessmentV2) => Promise<T>,
    ): Promise<T> {
      let entered = false;
      try {
        if (
          !tx ||
          typeof tx !== "object" ||
          typeof tx.query !== "function" ||
          typeof work !== "function" ||
          active.has(tx) ||
          failed.has(tx)
        )
          return fail();
        active.add(tx);
        entered = true;
        const raw = copyCategoryPersistenceValue(value);
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.keys(raw).length !== 3 ||
          ["command", "policyReference", "policyVersion"].some((key) => !Object.hasOwn(raw, key))
        )
          return fail();
        const input = raw as Record<string, unknown>,
          c = parseProductPublicationCommandV2(input.command),
          policyReference = parseCatalogReference(input.policyReference),
          policyVersion = input.policyVersion;
        if (
          c.action !== "Validate" ||
          c.actorKind !== "User" ||
          c.tenantReference !== tenant ||
          c.brandReference !== brand ||
          c.actorReference !== actor ||
          !Number.isSafeInteger(policyVersion) ||
          (policyVersion as number) < 1 ||
          (policyVersion as number) > 2147483647
        )
          return fail();
        const observedAt = parseCatalogInstant(now()),
          query = tx.query;
        let latest = observedAt,
          deadline = new Date(Date.parse(observedAt) + 5000).toISOString();
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || at >= deadline) return fail();
          latest = at;
          return at;
        };
        const authorize = async () => {
          const observedAt = check();
          if (
            (await validate(
              tx,
              Object.freeze({
                command: c,
                requiredPermissions: Object.freeze([
                  "catalog.product.read",
                  "catalog.product.validate",
                ]),
                requiredFields: productPublicationWriteFieldsV2,
                requiredScope: "FullBrandScope",
                observedAt,
              }),
            )) !== undefined
          )
            return fail();
          check();
        };
        const transactions = {
          async run<R>(callback: (actual: typeof tx) => Promise<R>) {
            check();
            const result = await callback(tx);
            check();
            return result;
          },
        };
        await authorize();
        const history = createPostgresProductPublicationSourceStoreV2({
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            actorKind: "User",
            transactions,
            authority: historyAuthority,
            clock: { now: check },
          }),
          stores = createPostgresTenantStoreReferenceSource({
            brandReference: brand,
            transactions,
            authority: tenantAuthority,
          });
        let historyCalls = 0,
          storeCalls = 0,
          policyCalls = 0,
          consumerCalls = 0,
          completed: { value: T } | undefined;
        const result = await history.withCurrentCoverage(
          {
            productReference: c.productReference,
            expectedAggregateVersion: c.expectedProductAggregateVersion,
          },
          async (coverage, actual) => {
            if (actual !== tx || ++historyCalls !== 1) return fail();
            check();
            return stores.withCurrentSnapshot(
              {
                brandReference: brand,
                actorReference: actor,
                purposeCode: c.purposeCode,
                originalIntentDigest: hash(c),
                observedAt: coverage.observedAt,
              },
              async (registered) => {
                if (++storeCalls !== 1) return fail();
                check();
                return policy(
                  tx,
                  {
                    policyReference,
                    policyVersion: policyVersion as number,
                    observedAt: coverage.observedAt,
                  },
                  async (currentPolicy) => {
                    if (++policyCalls !== 1) return fail();
                    const assessment = assessCatalogProductUniqueScopeV2(
                      c,
                      coverage,
                      registered,
                      currentPolicy,
                      check(),
                    );
                    if (
                      assessment.policyReference !== policyReference ||
                      assessment.policyVersion !== policyVersion
                    )
                      return fail();
                    deadline = [deadline, assessment.validUntil].sort()[0] ?? fail();
                    check();
                    // Keep the assessment's complete bindings while exposing the
                    // earliest original acquisition deadline of this composition.
                    const body = Object.fromEntries(
                        Object.entries(assessment).filter(([key]) => key !== "digest"),
                      ),
                      bounded = { ...body, validUntil: parseCatalogInstant(deadline) },
                      proof = Object.freeze({
                        ...assessment,
                        validUntil: bounded.validUntil,
                        digest: hash(bounded),
                      });
                    if (++consumerCalls !== 1) return fail();
                    const value = await work(proof);
                    check();
                    completed = Object.freeze({ value });
                    return completed;
                  },
                );
              },
            );
          },
        );
        if (
          historyCalls !== 1 ||
          storeCalls !== 1 ||
          policyCalls !== 1 ||
          consumerCalls !== 1 ||
          !completed ||
          result !== completed
        )
          return fail();
        await authorize();
        check();
        return completed.value;
      } catch (error) {
        if (tx && typeof tx === "object") failed.add(tx);
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      } finally {
        if (entered) active.delete(tx);
      }
    },
  });
}
