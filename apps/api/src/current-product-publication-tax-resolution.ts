import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  createPostgresProductTaxClassificationRegistryStore,
  resolveCatalogProductTaxClassification,
  parseCatalogInstant,
  type CatalogTaxClassificationRegistryAuthority,
  type CatalogProductPublicationValidationFinding,
  type CatalogProductPublicationValidationSourceEvidence,
} from "@rms/catalog";
import {
  bindPublicationQualificationInput,
  bindWarningAcknowledgementQualificationInput,
  type ProductPublicationQualificationContext,
} from "./product-publication-qualification-context.js";

type RegistryOptions = Parameters<typeof createPostgresProductTaxClassificationRegistryStore>[0];
type Transaction = Parameters<
  CatalogTaxClassificationRegistryAuthority["holdUntilTransactionCompletes"]
>[0];
type RegistryAuthorityInput = Parameters<
  CatalogTaxClassificationRegistryAuthority["holdUntilTransactionCompletes"]
>[1];
export interface ProductPublicationTaxResolutionAuthority {
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: RegistryAuthorityInput & {
      readonly command: ProductPublicationQualificationContext["command"];
      readonly commandPurposeCode: ProductPublicationQualificationContext["command"]["purposeCode"];
      readonly originalIntentDigest: string;
      readonly requestObservedAt: string;
      readonly requestValidUntil: string;
    },
  ): Promise<void>;
}
export interface CurrentProductPublicationTaxResolution {
  readonly originalIntentDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly check: { readonly code: "TaxResolution"; readonly outcome: "Pass" | "HardError" };
  readonly findings: readonly CatalogProductPublicationValidationFinding[];
  readonly sources: readonly CatalogProductPublicationValidationSourceEvidence[];
  readonly observedAt: string;
  readonly validUntil: string;
}
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Use the owning current classification registry, including its actual Brand
 * default. This resolves identity only; it neither quotes tax nor authorizes a
 * sale. Publication and Ack retain their full, distinct original intents. */
export function createCurrentProductPublicationTaxResolutionSource(options: {
  readonly transaction: Transaction;
  readonly clock: { now(): string };
  readonly authority: ProductPublicationTaxResolutionAuthority;
  readonly registerBeforeCommit: RegistryOptions["registerBeforeCommit"];
}) {
  if (
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return fail();
  const tx = options.transaction,
    query = tx.query,
    now = options.clock.now.bind(options.clock),
    authorize = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options);
  let active = false,
    failed = false;
  async function run<T>(
    bind: () => ProductPublicationQualificationContext,
    work: (assessment: CurrentProductPublicationTaxResolution) => Promise<T>,
  ): Promise<T> {
    if (active || failed) {
      failed = true;
      return fail();
    }
    active = true;
    let ready = false,
      committing = false,
      guardCalls = 0,
      assertLease: (() => string) | undefined,
      child: { guard: () => Promise<void>; finalAssert: () => void } | undefined;
    try {
      let context: ProductPublicationQualificationContext | undefined;
      try {
        context = bind();
      } catch {
        failed = true;
      }
      const checkOuter = () => {
        if (failed || !ready || !assertLease || !child) {
          failed = true;
          return fail();
        }
        return assertLease();
      };
      if (
        (await register(
          tx,
          async () => {
            try {
              if (++guardCalls !== 1) return fail();
              committing = true;
              checkOuter();
              if ((await child?.guard()) !== undefined) return fail();
              checkOuter();
            } catch (error) {
              failed = true;
              throw error;
            }
          },
          () => {
            try {
              if (guardCalls !== 1) return fail();
              checkOuter();
              if (child?.finalAssert() !== undefined) return fail();
              checkOuter();
            } catch (error) {
              failed = true;
              throw error;
            }
          },
        )) !== undefined
      )
        return fail();
      if (!context || typeof work !== "function") return fail();
      const bound = context;
      let latest = bound.observedAt;
      const check = () => {
        try {
          const at = parseCatalogInstant(now());
          if (failed || tx.query !== query || at < latest || at >= bound.validUntil) return fail();
          latest = at;
          return at;
        } catch {
          failed = true;
          return fail();
        }
      };
      assertLease = check;
      check();
      const source = createPostgresProductTaxClassificationRegistryStore({
        tenantReference: bound.tenantReference,
        brandReference: bound.brandReference,
        actorReference: bound.actorReference,
        actorKind: bound.actorKind,
        clock: { now: check },
        transactions: { run: (work) => work(tx) },
        authority: {
          async holdUntilTransactionCompletes(actual, input) {
            try {
              check();
              if (
                actual !== tx ||
                input.tenantReference !== bound.tenantReference ||
                input.brandReference !== bound.brandReference ||
                input.actorReference !== bound.actorReference ||
                input.actorKind !== bound.actorKind ||
                input.purposeCode !== "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY" ||
                input.permission !== "catalog.manage" ||
                input.action !== "catalog.tax-classification.read" ||
                input.mode !== "Read"
              )
                return fail();
              if (
                (await authorize(
                  tx,
                  Object.freeze({
                    ...input,
                    command: bound.command,
                    commandPurposeCode: bound.command.purposeCode,
                    originalIntentDigest: bound.originalIntentDigest,
                    requestObservedAt: bound.observedAt,
                    requestValidUntil: bound.validUntil,
                  }),
                )) !== undefined
              )
                return fail();
              check();
            } catch (error) {
              failed = true;
              throw error;
            }
          },
        },
        async registerBeforeCommit(actual, guard, finalAssert) {
          try {
            check();
            if (
              actual !== tx ||
              ready ||
              committing ||
              child ||
              typeof guard !== "function" ||
              typeof finalAssert !== "function"
            )
              return fail();
            child = { guard, finalAssert };
          } catch (error) {
            failed = true;
            throw error;
          }
        },
      });
      let calls = 0,
        completed: { value: T } | undefined;
      const result = await source.withCurrentRegistry(
        {
          originalIntentDigest: bound.originalIntentDigest,
          observedAt: bound.observedAt,
          validUntil: bound.validUntil,
        },
        async (current, actual) => {
          try {
            if (
              ++calls !== 1 ||
              actual !== tx ||
              current.sourceAuthority !== "CurrentTransactionHeld" ||
              current.registry.tenantReference !== bound.tenantReference ||
              current.registry.brandReference !== bound.brandReference ||
              canonicalizeRfc8785(current.observation) !==
                canonicalizeRfc8785({
                  originalIntentDigest: bound.originalIntentDigest,
                  observedAt: bound.observedAt,
                  validUntil: bound.validUntil,
                }) ||
              current.snapshotDigest !== hash(current.registry)
            )
              return fail();
            check();
            const resolution = resolveCatalogProductTaxClassification(current.registry, {
              classificationReference: bound.aggregate.draft.taxClassificationReference,
              originalIntentDigest: bound.originalIntentDigest,
              observedAt: bound.observedAt,
              validUntil: bound.validUntil,
            });
            const definition = current.registry.definitions.find(
              (d) => d.classificationReference === resolution.classificationReference,
            );
            // Relevant facts exclude unrelated registry changes, names and request
            // timing. A changed selection, permanent code or lifecycle is material.
            const relevantReferenceDigest = hash({
              selection: resolution.selection,
              classificationReference: resolution.classificationReference,
              reason: resolution.reason,
              definition: definition
                ? {
                    classificationReference: definition.classificationReference,
                    code: definition.code,
                    lifecycle: definition.lifecycle,
                  }
                : null,
            });
            const reasonCodes = {
              DefaultMissing: "TAX_DEFAULT_MISSING",
              Unknown: "TAX_CLASSIFICATION_UNKNOWN",
              Inactive: "TAX_CLASSIFICATION_INACTIVE",
              Retired: "TAX_CLASSIFICATION_RETIRED",
            } as const;
            const findings: readonly CatalogProductPublicationValidationFinding[] =
              resolution.reason === "Resolved"
                ? []
                : [
                    {
                      checkCode: "TaxResolution",
                      ruleCode: reasonCodes[resolution.reason],
                      outcome: "HardError",
                      subjectReference: bound.productReference,
                      reasonCode: reasonCodes[resolution.reason],
                      references: [
                        {
                          sourceCode: "TAX_CLASSIFICATION",
                          resourceReference:
                            resolution.classificationReference ??
                            current.registry.registryReference,
                          versionReference: null,
                          referenceDigest: relevantReferenceDigest,
                        },
                      ],
                    },
                  ];
            const assessment: CurrentProductPublicationTaxResolution = Object.freeze({
              originalIntentDigest: bound.originalIntentDigest,
              contentDigest: bound.contentDigest,
              configurationDigest: bound.configurationDigest,
              check: resolution.check,
              findings: Object.freeze(
                findings.map((finding) =>
                  Object.freeze({
                    ...finding,
                    references: Object.freeze(
                      finding.references.map((reference) => Object.freeze(reference)),
                    ),
                  }),
                ),
              ),
              sources: Object.freeze([
                Object.freeze({
                  sourceCode: "TAX_CLASSIFICATION",
                  sourceDigest: resolution.digest,
                  generation: String(current.registry.registryVersion),
                  relevantReferenceDigest,
                  observedAt: bound.observedAt,
                  validUntil: bound.validUntil,
                }),
              ]),
              observedAt: bound.observedAt,
              validUntil: bound.validUntil,
            });
            const value = await work(assessment);
            check();
            completed = { value };
            return completed;
          } catch (error) {
            failed = true;
            throw error;
          }
        },
      );
      if (calls !== 1 || !completed || result !== completed || !child) return fail();
      check();
      ready = true;
      return completed.value;
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    } finally {
      active = false;
    }
  }
  return Object.freeze({
    withPublication<T>(
      input: Parameters<typeof bindPublicationQualificationInput>[0],
      originalValidUntil: string,
      work: (assessment: CurrentProductPublicationTaxResolution) => Promise<T>,
    ) {
      return run(() => bindPublicationQualificationInput(input, originalValidUntil), work);
    },
    withAcknowledgement<T>(
      input: Parameters<typeof bindWarningAcknowledgementQualificationInput>[0],
      work: (assessment: CurrentProductPublicationTaxResolution) => Promise<T>,
    ) {
      return run(() => bindWarningAcknowledgementQualificationInput(input), work);
    },
  });
}
