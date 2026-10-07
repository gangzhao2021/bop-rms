import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import {
  createPostgresTenantStoreReferenceSource,
  parseTenantStoreReferenceRequest,
  parseTenantStoreReferenceSnapshot,
  type TenantStoreReferenceRequest,
  type TenantStoreReferenceSnapshot,
} from "@bop/tenant";
import {
  assessCatalogProductPublicationScope,
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductPublicationSourceStoreV2,
  parseCatalogInstant,
  parseCatalogProductRetirementCoverage,
  parseCatalogReference,
  productPublicationSourceFieldsV2,
  type CatalogProductPublicationScopeAssessment,
  type CatalogProductPublicationValidationFinding,
  type CatalogProductPublicationValidationSourceEvidence,
  type CatalogProductRetirementCoverage,
} from "@rms/catalog";
import {
  bindPublicationQualificationInput,
  bindWarningAcknowledgementQualificationInput,
  type ProductPublicationQualificationContext,
} from "./product-publication-qualification-context.js";

type Context = ProductPublicationQualificationContext;
type HistoryOptions = Parameters<typeof createPostgresProductPublicationSourceStoreV2>[0];
type HistoryInput = Parameters<HistoryOptions["authority"]["holdUntilTransactionCompletes"]>[1];
type Transaction = Parameters<HistoryOptions["authority"]["holdUntilTransactionCompletes"]>[0];
interface IntentAuthority {
  readonly command: Context["command"];
  readonly actorKind: Context["actorKind"];
  readonly commandPurposeCode: Context["command"]["purposeCode"];
  readonly originalIntentDigest: string;
  readonly replacementIntentDigest: string;
  readonly requestObservedAt: string;
  readonly requestValidUntil: string;
}
export interface ProductPublicationScopeHistoryAuthority {
  holdUntilTransactionCompletes(
    transaction: Transaction,
    input: HistoryInput & IntentAuthority,
  ): Promise<void>;
}
export interface ProductPublicationScopeTenantAuthority {
  withCurrentBrandReferenceRead<T>(
    transaction: Transaction,
    input: IntentAuthority & { readonly request: TenantStoreReferenceRequest },
    work: () => Promise<T>,
  ): Promise<T>;
  isCurrent(
    transaction: Transaction,
    input: IntentAuthority & { readonly request: TenantStoreReferenceRequest },
  ): Promise<boolean>;
}
function capturePolicy(value: unknown) {
  const r = readClosedRecord(copyCategoryPersistenceValue(value), [
    "content",
    "currentPublicationReference",
    "observedAt",
    "validUntil",
  ]);
  return Object.freeze({
    content: parsePublishingProductPublicationPolicy(r.content),
    currentPublicationReference: parseCatalogReference(r.currentPublicationReference),
    observedAt: parseCatalogInstant(r.observedAt),
    validUntil: parseCatalogInstant(r.validUntil),
  });
}
export interface CurrentProductPublicationScope {
  readonly assessment: CatalogProductPublicationScopeAssessment;
  readonly coverage: CatalogProductRetirementCoverage;
  readonly stores: TenantStoreReferenceSnapshot;
  readonly policy: ReturnType<typeof capturePolicy>;
  readonly check: CatalogProductPublicationScopeAssessment["check"];
  readonly publishableSkuCheck: CatalogProductPublicationScopeAssessment["publishableSkuCheck"];
  readonly findings: readonly CatalogProductPublicationValidationFinding[];
  readonly sources: readonly CatalogProductPublicationValidationSourceEvidence[];
  readonly observedAt: string;
  readonly validUntil: string;
}
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Acquire one complete Catalog history and Tenant roster in the writer's
 * transaction. The supplied policy must remain inside its actual outer owner
 * callback/commit guard. This holder does not reread or establish policy authority.
 */
export function createCurrentProductPublicationScopeSource(options: {
  readonly transaction: Transaction;
  readonly clock: { now(): string };
  readonly historyAuthority: ProductPublicationScopeHistoryAuthority;
  readonly tenantAuthority: ProductPublicationScopeTenantAuthority;
  readonly registerBeforeCommit: (
    transaction: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}) {
  if (
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.historyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.tenantAuthority?.withCurrentBrandReferenceRead !== "function" ||
    typeof options.tenantAuthority?.isCurrent !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return unavailable();
  const tx = options.transaction,
    query = tx.query,
    now = options.clock.now.bind(options.clock),
    holdHistory = options.historyAuthority.holdUntilTransactionCompletes.bind(
      options.historyAuthority,
    ),
    holdTenant = options.tenantAuthority.withCurrentBrandReferenceRead.bind(
      options.tenantAuthority,
    ),
    tenantCurrent = options.tenantAuthority.isCurrent.bind(options.tenantAuthority),
    register = options.registerBeforeCommit.bind(options);
  let active = false,
    failed = false,
    permissionError: CatalogError | undefined,
    dependencyError: CatalogError | undefined;
  const fail = (): never => {
    failed = true;
    return unavailable();
  };
  const protect = (error: unknown, captureDependency = false): never => {
    failed = true;
    if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
      permissionError = error;
    if (
      captureDependency &&
      error instanceof CatalogError &&
      error.code === "CATALOG_DEPENDENCY_UNAVAILABLE" &&
      !dependencyError
    )
      dependencyError = error;
    // The Tenant owner intentionally hides its unrestricted errors. Preserve
    // only classified failures captured inside our own held callback.
    if (permissionError) throw permissionError;
    if (dependencyError) throw dependencyError;
    return unavailable();
  };
  async function run<T>(
    bind: () => Context,
    policyValue: unknown,
    work: (value: CurrentProductPublicationScope) => Promise<T>,
  ): Promise<T> {
    if (active || failed) return fail();
    active = true;
    let ready = false,
      guardCalls = 0,
      guardComplete = false,
      assertLease: (() => string) | undefined,
      refreshAuthority: (() => Promise<void>) | undefined;
    try {
      let captured: Context | undefined,
        policy: ReturnType<typeof capturePolicy> | undefined,
        captureError: unknown;
      try {
        captured = bind();
        policy = capturePolicy(policyValue);
      } catch (error) {
        failed = true;
        captureError = error;
      }
      const outerCheck = () => {
        if (failed || !ready || !assertLease || !refreshAuthority) return fail();
        return assertLease();
      };
      if (
        (await register(
          tx,
          async () => {
            try {
              if (++guardCalls !== 1) return fail();
              outerCheck();
              if (!refreshAuthority) return fail();
              await refreshAuthority();
              outerCheck();
              guardComplete = true;
            } catch (error) {
              return protect(error);
            }
          },
          () => {
            try {
              if (guardCalls !== 1 || !guardComplete) return fail();
              outerCheck();
            } catch (error) {
              return protect(error);
            }
          },
        )) !== undefined
      )
        return fail();
      if (!captured || !policy) throw captureError;
      const context = captured,
        capturedPolicy = policy;
      if (typeof work !== "function") return fail();
      let latest = context.observedAt,
        deadline: string = context.validUntil;
      const check = () => {
        try {
          const time = parseCatalogInstant(now());
          if (failed || tx.query !== query || time < latest || time >= deadline) return fail();
          latest = time;
          return time;
        } catch {
          return fail();
        }
      };
      assertLease = check;
      check();
      const intent: IntentAuthority = Object.freeze({
        command: context.command,
        actorKind: context.actorKind,
        commandPurposeCode: context.command.purposeCode,
        originalIntentDigest: context.originalIntentDigest,
        replacementIntentDigest: context.replacementIntentDigest,
        requestObservedAt: context.observedAt,
        requestValidUntil: context.validUntil,
      });
      const historyInput = (observedAt: string): HistoryInput => ({
        tenantReference: context.tenantReference,
        brandReference: context.brandReference,
        actorReference: context.actorReference,
        actorKind: context.actorKind,
        productReference: context.productReference,
        purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE",
        permission: "catalog.manage",
        owningActions: ["catalog.product.history.read"],
        requiredFields: productPublicationSourceFieldsV2,
        observedAt,
      });
      const authorizeHistory = async (value: HistoryInput) => {
        try {
          const raw = copyCategoryPersistenceValue(value) as HistoryInput,
            ownerAt = parseCatalogInstant(raw.observedAt);
          if (
            ownerAt < context.observedAt ||
            ownerAt > check() ||
            !equal(raw, historyInput(ownerAt))
          )
            return fail();
          if ((await holdHistory(tx, Object.freeze({ ...raw, ...intent }))) !== undefined)
            return fail();
          check();
        } catch (error) {
          return protect(error);
        }
      };
      let storeRequest: TenantStoreReferenceRequest | undefined;
      const tenantPacket = (value: TenantStoreReferenceRequest) => {
        check();
        const request = parseTenantStoreReferenceRequest(value);
        if (!storeRequest || !equal(request, storeRequest)) return fail();
        return Object.freeze({ ...intent, request });
      };
      const authorizeTenantCurrent = async (request: TenantStoreReferenceRequest) => {
        try {
          if ((await tenantCurrent(tx, tenantPacket(request))) !== true) return fail();
          check();
        } catch (error) {
          return protect(error);
        }
      };
      const withTenantAuthority = async <R>(
        request: TenantStoreReferenceRequest,
        callback: () => Promise<R>,
      ): Promise<R> => {
        try {
          const packet = tenantPacket(request);
          let calls = 0,
            completed: { value: R } | undefined;
          const answer = await holdTenant(tx, packet, async () => {
            try {
              if (++calls !== 1) return fail();
              await authorizeTenantCurrent(request);
              const value = await callback();
              await authorizeTenantCurrent(request);
              completed = { value };
              return completed;
            } catch (error) {
              return protect(error);
            }
          });
          if (calls !== 1 || !completed || answer !== completed) return fail();
          check();
          return completed.value;
        } catch (error) {
          return protect(error);
        }
      };
      refreshAuthority = async () => {
        await authorizeHistory(historyInput(check()));
        if (!storeRequest) return fail();
        await withTenantAuthority(storeRequest, async () => undefined);
      };
      let historyTransactions = 0,
        historyCallbacks = 0,
        historyAuthorities = 0,
        storeTransactions = 0,
        storeCallbacks = 0,
        storeAuthorities = 0;
      const historySource = createPostgresProductPublicationSourceStoreV2({
        tenantReference: context.tenantReference,
        brandReference: context.brandReference,
        actorReference: context.actorReference,
        actorKind: context.actorKind,
        clock: { now: check },
        transactions: {
          async run(callback) {
            try {
              if (++historyTransactions !== 1) return fail();
              check();
              const result = await callback(tx);
              check();
              return result;
            } catch (error) {
              return protect(error);
            }
          },
        },
        authority: {
          async holdUntilTransactionCompletes(actual, value) {
            try {
              if (actual !== tx || historyTransactions !== 1) return fail();
              await authorizeHistory(value);
              historyAuthorities++;
            } catch (error) {
              return protect(error);
            }
          },
        },
      });
      let completed: { value: T } | undefined;
      const returned = await historySource.withCurrentCoverage(
        {
          productReference: context.productReference,
          expectedAggregateVersion: context.aggregateVersion,
        },
        async (value, actual) => {
          try {
            if (
              actual !== tx ||
              ++historyCallbacks !== 1 ||
              historyTransactions !== 1 ||
              historyAuthorities === 0
            )
              return fail();
            const coverage = parseCatalogProductRetirementCoverage(value);
            if (
              coverage.tenantReference !== context.tenantReference ||
              coverage.brandReference !== context.brandReference ||
              coverage.productReference !== context.productReference ||
              coverage.aggregateVersion !== context.aggregateVersion ||
              coverage.observedAt < context.observedAt ||
              coverage.observedAt > check()
            )
              return fail();
            storeRequest = parseTenantStoreReferenceRequest({
              brandReference: context.brandReference,
              actorReference: context.actorReference,
              purposeCode: context.command.purposeCode,
              originalIntentDigest: context.originalIntentDigest,
              observedAt: coverage.observedAt,
            });
            const storeSource = createPostgresTenantStoreReferenceSource({
              brandReference: context.brandReference,
              transactions: {
                async run(callback) {
                  try {
                    if (++storeTransactions !== 1 || storeAuthorities !== 1) return fail();
                    check();
                    const result = await callback(tx);
                    check();
                    return result;
                  } catch (error) {
                    return protect(error);
                  }
                },
              },
              authority: {
                async withCurrentBrandReferenceRead(request, callback) {
                  if (++storeAuthorities !== 1) return fail();
                  return withTenantAuthority(request, callback);
                },
                async isCurrent(actual, request) {
                  try {
                    if (actual !== tx || storeTransactions !== 1 || storeAuthorities !== 1)
                      return fail();
                    await authorizeTenantCurrent(request);
                    return true;
                  } catch (error) {
                    return protect(error);
                  }
                },
              },
            });
            const answer = await storeSource.withCurrentSnapshot(storeRequest, async (value) => {
              try {
                if (++storeCallbacks !== 1 || storeTransactions !== 1 || storeAuthorities !== 1)
                  return fail();
                const stores = parseTenantStoreReferenceSnapshot(value),
                  assessment = assessCatalogProductPublicationScope(
                    {
                      command: context.command,
                      aggregate: context.aggregate,
                      current: context.current,
                      report: context.report,
                      observedAt: context.observedAt,
                      validUntil: context.validUntil,
                    },
                    coverage,
                    stores,
                    capturedPolicy,
                    check(),
                  );
                deadline = assessment.validUntil;
                check();
                const findings: CatalogProductPublicationValidationFinding[] =
                  assessment.findings.map((finding) =>
                    Object.freeze({
                      checkCode: "UniqueScope",
                      outcome: "HardError",
                      ruleCode: finding.reason,
                      reasonCode: finding.reason,
                      subjectReference: context.versionReference,
                      references: Object.freeze([
                        Object.freeze({
                          sourceCode: "PRODUCT_SCOPE",
                          resourceReference: context.productReference,
                          versionReference: finding.versionReference,
                          referenceDigest: hash({
                            finding,
                            relevantReferenceDigest: assessment.relevantReferenceDigest,
                          }),
                        }),
                      ]),
                    }),
                  );
                if (assessment.publishableSkuCheck.outcome === "HardError")
                  findings.push(
                    Object.freeze({
                      checkCode: "PublishableSku",
                      outcome: "HardError",
                      ruleCode:
                        assessment.skuQualification === "NoActiveMember"
                          ? "NO_ACTIVE_SKU"
                          : "SKU_SCOPE_NOT_QUALIFIED",
                      reasonCode:
                        assessment.skuQualification === "NoActiveMember"
                          ? "NO_ACTIVE_SKU"
                          : "SKU_SCOPE_NOT_QUALIFIED",
                      subjectReference: context.versionReference,
                      references: Object.freeze([]),
                    }),
                  );
                const sources: readonly CatalogProductPublicationValidationSourceEvidence[] =
                  Object.freeze([
                    Object.freeze({
                      sourceCode: "PRODUCT_SCOPE",
                      sourceDigest: assessment.digest,
                      generation: null,
                      relevantReferenceDigest: assessment.relevantReferenceDigest,
                      observedAt: coverage.observedAt,
                      validUntil: deadline,
                    }),
                  ]);
                const result: CurrentProductPublicationScope = Object.freeze({
                  assessment,
                  coverage,
                  stores,
                  policy: capturedPolicy,
                  check: assessment.check,
                  publishableSkuCheck: assessment.publishableSkuCheck,
                  findings: Object.freeze(findings),
                  sources,
                  observedAt: context.observedAt,
                  validUntil: deadline,
                });
                const answer = await work(result);
                check();
                completed = { value: answer };
                return completed;
              } catch (error) {
                return protect(error, true);
              }
            });
            if (
              storeCallbacks !== 1 ||
              storeTransactions !== 1 ||
              storeAuthorities !== 1 ||
              !completed ||
              answer !== completed
            )
              return fail();
            check();
            return completed;
          } catch (error) {
            return protect(error);
          }
        },
      );
      if (
        historyCallbacks !== 1 ||
        historyTransactions !== 1 ||
        !completed ||
        returned !== completed
      )
        return fail();
      check();
      ready = true;
      return completed.value;
    } catch (error) {
      return protect(error);
    } finally {
      active = false;
    }
  }
  return Object.freeze({
    withPublication<T>(
      input: Parameters<typeof bindPublicationQualificationInput>[0],
      originalValidUntil: string,
      policy: unknown,
      work: (value: CurrentProductPublicationScope) => Promise<T>,
    ) {
      return run(() => bindPublicationQualificationInput(input, originalValidUntil), policy, work);
    },
    withAcknowledgement<T>(
      input: Parameters<typeof bindWarningAcknowledgementQualificationInput>[0],
      policy: unknown,
      work: (value: CurrentProductPublicationScope) => Promise<T>,
    ) {
      return run(() => bindWarningAcknowledgementQualificationInput(input), policy, work);
    },
  });
}
