import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  assertProductVariantIdentityHistory,
  copyCategoryPersistenceValue,
  createPostgresProductPublicationQualificationHistorySource,
  createPostgresProductWarningAcknowledgementQualificationHistorySource,
  buildCatalogProductPublicationReferenceRequestV2,
  buildCatalogProductWarningAcknowledgementReferenceRequest,
  bindCatalogProductPublicationValidationContextV2,
  parseCatalogProductPublicationReferenceProvenance,
  productPublicationQualificationHistoryFields,
  productWarningAcknowledgementQualificationHistoryFields,
  type CatalogProductPublicationReferenceProvenance,
  parseCatalogInstant,
  parseProductVariantIdentityHistorySnapshot,
  type CatalogProductPublicationValidationFinding,
  type CatalogProductPublicationValidationSourceEvidence,
} from "@rms/catalog";
import {
  bindPublicationQualificationInput,
  bindWarningAcknowledgementQualificationInput,
  type ProductPublicationQualificationContext,
} from "./product-publication-qualification-context.js";

type OwnerOptions = Parameters<
  typeof createPostgresProductPublicationQualificationHistorySource
>[0];
type AckOptions = Parameters<
  typeof createPostgresProductWarningAcknowledgementQualificationHistorySource
>[0];
type OwnerInput =
  | Parameters<OwnerOptions["authority"]["holdUntilTransactionCompletes"]>[1]
  | Parameters<AckOptions["authority"]["holdUntilTransactionCompletes"]>[1];
type Transaction = Parameters<OwnerOptions["authority"]["holdUntilTransactionCompletes"]>[0];
export interface ProductPublicationVariantHistoryAuthority {
  holdUntilTransactionCompletes(
    transaction: Transaction,
    input: OwnerInput & {
      readonly command: ProductPublicationQualificationContext["command"];
      readonly actorKind: "User" | "System";
      readonly commandPurposeCode: ProductPublicationQualificationContext["command"]["purposeCode"];
      readonly originalIntentDigest: string;
      readonly replacementIntentDigest: string;
      readonly requestObservedAt: string;
      readonly requestValidUntil: string;
    },
  ): Promise<void>;
}
export interface CurrentProductPublicationVariantMapping {
  readonly originalIntentDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly historyDigest: string;
  readonly referenceProvenance: CatalogProductPublicationReferenceProvenance;
  readonly check: { readonly code: "VariantMapping"; readonly outcome: "Pass" | "HardError" };
  readonly findings: readonly CatalogProductPublicationValidationFinding[];
  readonly sources: readonly CatalogProductPublicationValidationSourceEvidence[];
  readonly observedAt: string;
  readonly validUntil: string;
}
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Complete explicit Variant mapping and permanently used identities only.
 * The writer already holds the actual Draft; its structural context alone is
 * not authority. One owner-verified operation read supplies permanent identities and precise
 * reference provenance under its same-transaction barrier.
 */
export function createCurrentProductPublicationVariantMappingSource(options: {
  readonly transaction: Transaction;
  readonly clock: { now(): string };
  readonly authority: ProductPublicationVariantHistoryAuthority;
  readonly registerBeforeCommit: (
    transaction: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}) {
  if (
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return unavailable();
  const tx = options.transaction,
    query = tx.query,
    now = options.clock.now.bind(options.clock),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options);
  let active = false,
    failed = false;
  const fail = (): never => {
    failed = true;
    return unavailable();
  };
  const protect = (error: unknown): never => {
    failed = true;
    if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
    return unavailable();
  };
  async function run<T>(
    bind: () => ProductPublicationQualificationContext,
    work: (assessment: CurrentProductPublicationVariantMapping) => Promise<T>,
  ): Promise<T> {
    if (active || failed) return fail();
    active = true;
    let ready = false,
      guardCalls = 0,
      guardComplete = false,
      assertLease: (() => string) | undefined,
      refreshAuthority: (() => Promise<void>) | undefined;
    try {
      let captured: ProductPublicationQualificationContext | undefined, captureError: unknown;
      try {
        captured = bind();
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
      if (!captured) throw captureError;
      const context = captured;
      if (typeof work !== "function") return fail();
      let latest = context.observedAt;
      const deadline = context.validUntil;
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
      const request =
        context.kind === "Publication"
          ? buildCatalogProductPublicationReferenceRequestV2(
              bindCatalogProductPublicationValidationContextV2({
                command: context.command,
                aggregate: context.aggregate,
                current: context.current,
                content: null,
                observedAt: context.observedAt,
              }),
              context.validUntil,
            )
          : buildCatalogProductWarningAcknowledgementReferenceRequest({
              command: context.command,
              aggregate: context.aggregate,
              current: context.current,
              report: context.report,
              observedAt: context.observedAt,
              validUntil: context.validUntil,
            });
      const ownerPacket = (observedAt: string): OwnerInput =>
        request.profile === "CatalogProductPublicationReferenceRequestV2"
          ? {
              tenantReference: context.tenantReference,
              brandReference: context.brandReference,
              actorReference: context.actorReference,
              actorKind: context.actorKind,
              purposeCode: "CATALOG_PRODUCT_PUBLICATION_QUALIFICATION_HISTORY_READ",
              permission: "catalog.manage",
              owningAction: "catalog.product.history.read",
              requiredScope: "FullBrandScope",
              request,
              requiredFields: productPublicationQualificationHistoryFields,
              observedAt,
            }
          : {
              tenantReference: context.tenantReference,
              brandReference: context.brandReference,
              actorReference: context.actorReference,
              actorKind: "User",
              purposeCode: "CATALOG_PRODUCT_WARNING_ACKNOWLEDGEMENT_QUALIFICATION_HISTORY_READ",
              permission: "catalog.manage",
              owningAction: "catalog.product.history.read",
              requiredScope: "FullBrandScope",
              request,
              requiredFields: productWarningAcknowledgementQualificationHistoryFields,
              observedAt,
            };
      const authorize = async (value: OwnerInput) => {
        try {
          check();
          const raw = copyCategoryPersistenceValue(value) as OwnerInput;
          const ownerAt = parseCatalogInstant(raw.observedAt);
          if (
            ownerAt < context.observedAt ||
            ownerAt > check() ||
            !equal(raw, ownerPacket(ownerAt))
          )
            return fail();
          if (
            (await hold(
              tx,
              Object.freeze({
                ...raw,
                command: context.command,
                commandPurposeCode: context.command.purposeCode,
                originalIntentDigest: context.originalIntentDigest,
                replacementIntentDigest: context.replacementIntentDigest,
                requestObservedAt: context.observedAt,
                requestValidUntil: context.validUntil,
              }),
            )) !== undefined
          )
            return fail();
          check();
        } catch (error) {
          return protect(error);
        }
      };
      refreshAuthority = () => authorize(ownerPacket(check()));
      let transactionCalls = 0,
        historyCalls = 0,
        authorityCalls = 0;
      const sourceOptions = {
        tenantReference: context.tenantReference,
        brandReference: context.brandReference,
        actorReference: context.actorReference,
        clock: { now: check },
        transactions: {
          async run<T>(callback: (actual: Transaction) => Promise<T>) {
            try {
              if (++transactionCalls !== 1) return fail();
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
          async holdUntilTransactionCompletes(actual: Transaction, value: OwnerInput) {
            try {
              if (actual !== tx || transactionCalls !== 1) return fail();
              await authorize(value);
              authorityCalls++;
            } catch (error) {
              return protect(error);
            }
          },
        },
        registerBeforeCommit: async (
          actual: Transaction,
          guard: () => Promise<void>,
          final: () => void,
        ) => {
          if (actual !== tx) return fail();
          if ((await register(actual, guard, final)) !== undefined) return fail();
        },
      };
      let completed: { value: T } | undefined;
      const consume = async (
        value: CatalogProductPublicationReferenceProvenance,
        actual: Transaction,
      ) => {
        try {
          if (
            actual !== tx ||
            ++historyCalls !== 1 ||
            transactionCalls !== 1 ||
            authorityCalls === 0
          )
            return fail();
          const referenceProvenance = parseCatalogProductPublicationReferenceProvenance(value),
            history = parseProductVariantIdentityHistorySnapshot(
              referenceProvenance.variantHistory,
            );
          if (!equal(referenceProvenance.request, request)) return fail();
          if (
            history.brandReference !== context.brandReference ||
            history.productReference !== context.productReference ||
            history.aggregateVersion !== context.aggregateVersion ||
            history.originalIntentDigest !== context.originalIntentDigest ||
            history.observedAt < context.observedAt ||
            history.observedAt > check()
          )
            return fail();
          const content = context.aggregate.draft.editorContent;
          if (!content) return fail();
          // Both inputs are already parsed and their full identities/root match.
          // The owning assertion can now reject only a proved used-ID change.
          let compatible = true;
          try {
            assertProductVariantIdentityHistory(context.aggregate, history);
          } catch (error) {
            if (!(error instanceof CatalogError) || error.code !== "CATALOG_DEPENDENCY_UNAVAILABLE")
              return fail();
            compatible = false;
          }
          const relevantReferenceDigest = hash({
            brandReference: history.brandReference,
            productReference: history.productReference,
            used: history.used,
          });
          const findings: CatalogProductPublicationValidationFinding[] = [];
          if (!compatible)
            findings.push(
              Object.freeze({
                checkCode: "VariantMapping",
                outcome: "HardError",
                ruleCode: "VARIANT_IDENTITY_HISTORY_CONFLICT",
                reasonCode: "VARIANT_IDENTITY_HISTORY_CONFLICT",
                subjectReference: context.productReference,
                references: Object.freeze([
                  Object.freeze({
                    sourceCode: "VARIANT_IDENTITY_HISTORY",
                    resourceReference: context.productReference,
                    versionReference: null,
                    referenceDigest: relevantReferenceDigest,
                  }),
                ]),
              }),
            );
          if (
            content.variantCombinations.some(
              (combination) => combination.disposition === "NotGenerated",
            )
          )
            findings.push(
              Object.freeze({
                checkCode: "VariantMapping",
                outcome: "HardError",
                ruleCode: "VARIANT_COMBINATION_NOT_GENERATED",
                reasonCode: "VARIANT_COMBINATION_NOT_GENERATED",
                subjectReference: context.versionReference,
                references: Object.freeze([]),
              }),
            );
          const evidence: CatalogProductPublicationValidationSourceEvidence = Object.freeze({
            sourceCode: "VARIANT_IDENTITY_HISTORY",
            sourceDigest: history.digest,
            generation: null,
            relevantReferenceDigest,
            observedAt: history.observedAt,
            validUntil: deadline,
          });
          const assessment: CurrentProductPublicationVariantMapping = Object.freeze({
            originalIntentDigest: context.originalIntentDigest,
            contentDigest: context.contentDigest,
            configurationDigest: context.configurationDigest,
            historyDigest: history.digest,
            referenceProvenance,
            check: Object.freeze({
              code: "VariantMapping",
              outcome: findings.length ? "HardError" : "Pass",
            }),
            findings: Object.freeze(findings),
            sources: Object.freeze([evidence]),
            observedAt: history.observedAt,
            validUntil: deadline,
          });
          check();
          const answer = await work(assessment);
          check();
          completed = { value: answer };
          return completed;
        } catch (error) {
          return protect(error);
        }
      };
      const returned =
        request.profile === "CatalogProductPublicationReferenceRequestV2"
          ? await createPostgresProductPublicationQualificationHistorySource({
              ...sourceOptions,
              actorKind: request.command.actorKind,
            }).withCurrentQualificationHistory(request, consume)
          : await createPostgresProductWarningAcknowledgementQualificationHistorySource({
              ...sourceOptions,
              actorKind: "User",
            }).withCurrentQualificationHistory(request, consume);
      if (historyCalls !== 1 || transactionCalls !== 1 || !completed || returned !== completed)
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
      work: (assessment: CurrentProductPublicationVariantMapping) => Promise<T>,
    ) {
      return run(() => bindPublicationQualificationInput(input, originalValidUntil), work);
    },
    withAcknowledgement<T>(
      input: Parameters<typeof bindWarningAcknowledgementQualificationInput>[0],
      work: (assessment: CurrentProductPublicationVariantMapping) => Promise<T>,
    ) {
      return run(() => bindWarningAcknowledgementQualificationInput(input), work);
    },
  });
}
