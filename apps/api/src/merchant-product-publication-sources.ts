import { canonicalizeRfc8785 } from "@bop/audit";
import {
  CatalogError,
  bindCatalogProductPublicationQualificationContext,
  bindCatalogProductWarningAcknowledgementQualificationContext,
  bindCatalogProductPublicationValidationContextV2,
  buildCatalogProductPublicationReferenceRequestV2,
  buildCatalogProductWarningAcknowledgementReferenceRequest,
  buildCatalogProductPublicationWarningAcknowledgementObservation,
  composeCatalogProductPublicationValidation,
  parseCatalogInstant,
  parseCatalogReference,
  type CatalogProductQualificationContext,
  type CatalogProductPublicationQualificationInput,
  type CatalogProductWarningAcknowledgementQualificationInput,
  type CatalogProductPublicationValidationFinding,
  type CatalogProductPublicationValidationSourceEvidence,
} from "@rms/catalog";
import {
  createCurrentProductPublicationContentPolicySource,
  type CurrentProductPublicationContentPolicy,
} from "./current-product-publication-content-policy.js";
import {
  createCurrentProductPublicationScopeSource,
  type CurrentProductPublicationScope,
} from "./current-product-publication-scope.js";
import { createCurrentProductPublicationVariantMappingSource } from "./current-product-publication-variant-mapping.js";
import { createCurrentProductPublicationOptionSelectionSource } from "./current-product-publication-option-selection.js";
import { createCurrentProductPublicationTaxResolutionSource } from "./current-product-publication-tax-resolution.js";
import { createMerchantProductPublicationMediaSource } from "./merchant-product-publication-media.js";
import { createCurrentProductPublicationRegisteredContentSource } from "./current-product-publication-registered-content.js";
import {
  createMerchantProductPublicationReferenceSourceV2,
  createMerchantProductWarningAcknowledgementReferenceSource,
  type MerchantProductPublicationImpactReferencesV2,
  type MerchantProductWarningAcknowledgementImpactReferences,
} from "./merchant-product-publication-reference-source-v2.js";
import type {
  MerchantProductPublicationSourceFactoryV2,
  MerchantProductPublicationSourceFactoryV2Input,
} from "./merchant-product-publication-command-v2.js";
import type {
  MerchantProductWarningAcknowledgementSourceFactory,
  MerchantProductWarningAcknowledgementSourceFactoryInput,
} from "./merchant-product-publication-warning-acknowledgement-command.js";

type Host =
  | MerchantProductPublicationSourceFactoryV2Input
  | MerchantProductWarningAcknowledgementSourceFactoryInput;
type Transaction = Host["transaction"];
type Common = "transaction" | "clock" | "registerBeforeCommit";
type Configuration<F extends (options: never) => unknown> = Omit<Parameters<F>[0], Common>;
type References =
  | MerchantProductPublicationImpactReferencesV2
  | MerchantProductWarningAcknowledgementImpactReferences;
type Qualification =
  | { readonly kind: "Publication"; readonly input: CatalogProductPublicationQualificationInput }
  | {
      readonly kind: "WarningAcknowledgement";
      readonly input: CatalogProductWarningAcknowledgementQualificationInput;
    };
interface ActionSource<Value> {
  withPublication<T>(
    input: CatalogProductPublicationQualificationInput,
    validUntil: string,
    work: (value: Value) => Promise<T>,
  ): Promise<T>;
  withAcknowledgement<T>(
    input: CatalogProductWarningAcknowledgementQualificationInput,
    work: (value: Value) => Promise<T>,
  ): Promise<T>;
}
/** Explicit server policy output. It cannot be replaced by a blanket Pass or
 * inferred from warningOverrideAllowed. The configuring owner supplies and
 * retains the backdate and SKU applicability/severity rules through commit. */
export interface MerchantProductPublicationBusinessAssessment {
  readonly originalIntentDigest: string;
  readonly aggregateSnapshotDigest: string;
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly checks: readonly {
    readonly code: "EffectivePeriod" | "ChangeImpact";
    readonly outcome: "Pass" | "Warning" | "HardError";
  }[];
  readonly findings: readonly CatalogProductPublicationValidationFinding[];
  readonly sources: readonly CatalogProductPublicationValidationSourceEvidence[];
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface MerchantProductPublicationSourcesConfiguration {
  readonly contentPolicy: Configuration<typeof createCurrentProductPublicationContentPolicySource>;
  readonly scope: Configuration<typeof createCurrentProductPublicationScopeSource>;
  readonly variant: Configuration<typeof createCurrentProductPublicationVariantMappingSource>;
  readonly options: Configuration<typeof createCurrentProductPublicationOptionSelectionSource>;
  readonly tax: Configuration<typeof createCurrentProductPublicationTaxResolutionSource>;
  readonly registeredContent: Configuration<
    typeof createCurrentProductPublicationRegisteredContentSource
  >;
  readonly publicationReferences: Omit<
    Parameters<typeof createMerchantProductPublicationReferenceSourceV2>[0],
    Common | "request" | "context"
  >;
  readonly acknowledgementReferences: Omit<
    Parameters<typeof createMerchantProductWarningAcknowledgementReferenceSource>[0],
    Common | "request" | "context"
  >;
  readonly evidenceReference: (operationReference: string) => string;
  readonly reviewReference: (operationReference: string) => string;
  readonly businessPolicy: {
    withAssessment<T>(
      transaction: Transaction,
      input: {
        readonly context: CatalogProductQualificationContext;
        readonly policy: CurrentProductPublicationContentPolicy["policy"];
        readonly references: References;
        readonly registerBeforeCommit: Host["registerBeforeCommit"];
      },
      work: (assessment: MerchantProductPublicationBusinessAssessment) => Promise<T>,
    ): Promise<T>;
  };
}
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

function captureHolder<T extends { holdUntilTransactionCompletes: (...args: never[]) => unknown }>(
  holder: T,
): T {
  if (typeof holder?.holdUntilTransactionCompletes !== "function") return unavailable();
  return Object.freeze({
    ...holder,
    holdUntilTransactionCompletes: holder.holdUntilTransactionCompletes.bind(holder),
  });
}
function captureReferences<
  T extends
    | MerchantProductPublicationSourcesConfiguration["publicationReferences"]
    | MerchantProductPublicationSourcesConfiguration["acknowledgementReferences"],
>(value: T): T {
  return Object.freeze({
    ...value,
    historyAuthority: captureHolder(value.historyAuthority),
    availabilityAuthority: captureHolder(value.availabilityAuthority),
    bundleAuthority: captureHolder(value.bundleAuthority),
    menuAuthority: captureHolder(value.menuAuthority),
    recipeAuthority: captureHolder(value.recipeAuthority),
    recipeInventoryAuthority: captureHolder(value.recipeInventoryAuthority),
    inventoryAuthority: captureHolder(value.inventoryAuthority),
    pricingAuthority: captureHolder(value.pricingAuthority),
    priceBookAuthority: captureHolder(value.priceBookAuthority),
    optionPriceAuthority: captureHolder(value.optionPriceAuthority),
    promotionAuthority: captureHolder(value.promotionAuthority),
  }) as T;
}

/** Shared actual-source assembly for the two distinct ordinary User commands.
 * Construction does no reads. The owning writer invokes it after replay, with
 * its locked aggregate; every source callback encloses the eventual write. */
export function createMerchantProductPublicationSources(
  configuration: MerchantProductPublicationSourcesConfiguration,
): {
  readonly publication: MerchantProductPublicationSourceFactoryV2;
  readonly acknowledgement: MerchantProductWarningAcknowledgementSourceFactory;
} {
  if (
    typeof configuration.businessPolicy?.withAssessment !== "function" ||
    typeof configuration.evidenceReference !== "function" ||
    typeof configuration.reviewReference !== "function"
  )
    return unavailable();
  const config = Object.freeze({
    ...configuration,
    contentPolicy: Object.freeze({ ...configuration.contentPolicy }),
    scope: Object.freeze({ ...configuration.scope }),
    variant: Object.freeze({ ...configuration.variant }),
    options: Object.freeze({ ...configuration.options }),
    tax: Object.freeze({ ...configuration.tax }),
    registeredContent: Object.freeze({ ...configuration.registeredContent }),
    publicationReferences: captureReferences(configuration.publicationReferences),
    acknowledgementReferences: captureReferences(configuration.acknowledgementReferences),
  });
  const assess = configuration.businessPolicy.withAssessment.bind(configuration.businessPolicy),
    evidenceReference = configuration.evidenceReference.bind(configuration),
    reviewReference = configuration.reviewReference.bind(configuration);
  function create(host: Host) {
    const tx = host.transaction,
      query = tx.query,
      command = canonicalizeRfc8785(host.command),
      now = host.clock.now.bind(host.clock),
      register = host.registerBeforeCommit.bind(host),
      deadline = parseCatalogInstant(host.originalValidUntil),
      common = { transaction: tx, clock: { now }, registerBeforeCommit: register },
      policySource = createCurrentProductPublicationContentPolicySource({
        ...config.contentPolicy,
        ...common,
        registerBeforeCommit: async (actual, guard, finalAssert) => {
          if (actual !== tx) return unavailable();
          await register(tx, guard, finalAssert);
        },
      }),
      scopeSource = createCurrentProductPublicationScopeSource({ ...config.scope, ...common }),
      variantSource = createCurrentProductPublicationVariantMappingSource({
        ...config.variant,
        ...common,
      }),
      optionSource = createCurrentProductPublicationOptionSelectionSource({
        ...config.options,
        ...common,
      }),
      mediaSource = createMerchantProductPublicationMediaSource(host),
      taxSource = createCurrentProductPublicationTaxResolutionSource({ ...config.tax, ...common }),
      registeredSource = createCurrentProductPublicationRegisteredContentSource({
        ...config.registeredContent,
        ...common,
      });
    let failed = false,
      active = false,
      started = false,
      complete = false,
      latest: string | undefined,
      validUntil: string = deadline,
      heldPolicy: CurrentProductPublicationContentPolicy["policy"] | undefined;
    const fail = (): never => {
      failed = true;
      return unavailable();
    };
    const check = () => {
      const at = parseCatalogInstant(now());
      if (failed || tx.query !== query || (latest !== undefined && at < latest) || at >= validUntil)
        return fail();
      latest = at;
      return at;
    };
    async function run<T>(
      actual: Transaction,
      qualification: Qualification,
      work: (
        result: ReturnType<typeof composeCatalogProductPublicationValidation>,
        context: CatalogProductQualificationContext,
        policy: CurrentProductPublicationContentPolicy["policy"],
        assessedAt: string,
      ) => Promise<T>,
    ): Promise<T> {
      if (started) return fail();
      started = true;
      let guardComplete = false,
        consumerCalls = 0;
      let consumerResult: { value: T } | undefined;
      let consumerError: CatalogError | undefined, sourceError: CatalogError | undefined;
      try {
        await register(
          tx,
          async () => {
            check();
            if (active || !complete || guardComplete) return fail();
            guardComplete = true;
          },
          () => {
            check();
            if (active || !complete || !guardComplete) return fail();
          },
        );
        if (actual !== tx || canonicalizeRfc8785(qualification.input.command) !== command)
          return fail();
        let context =
          qualification.kind === "Publication"
            ? bindCatalogProductPublicationQualificationContext(qualification.input, deadline)
            : bindCatalogProductWarningAcknowledgementQualificationContext(qualification.input);
        // The owning Ack writer begins after the authenticated host. Its local
        // lease may therefore end later, but acquisition must retain the first
        // outer deadline. Rebind validated values; never extend a leaf lease.
        if (context.kind === "WarningAcknowledgement" && context.validUntil > deadline) {
          const input = Object.freeze({
            command: context.command,
            aggregate: context.aggregate,
            current: context.current,
            report: context.report,
            observedAt: context.observedAt,
            validUntil: deadline,
          });
          qualification = { kind: "WarningAcknowledgement", input };
          context = bindCatalogProductWarningAcknowledgementQualificationContext(input);
        }
        if (
          context.validUntil > deadline ||
          context.tenantReference !== host.tenantReference ||
          context.brandReference !== host.brandReference ||
          context.actorReference !== host.actorReference ||
          context.actorKind !== "User"
        )
          return fail();
        latest = context.observedAt;
        validUntil = context.validUntil;
        active = true;
        check();
        const read = async <Value, Result>(
          source: ActionSource<Value>,
          consume: (value: Value) => Promise<Result>,
        ) => {
          try {
            return await (qualification.kind === "Publication"
              ? source.withPublication(qualification.input, validUntil, consume)
              : source.withAcknowledgement(qualification.input, consume));
          } catch (error) {
            if (
              !sourceError &&
              error instanceof CatalogError &&
              (error.code === "CATALOG_DEPENDENCY_UNAVAILABLE" ||
                error.code === "CATALOG_VERSION_CONFLICT")
            )
              sourceError = error;
            throw error;
          }
        };
        const retain = (value: { readonly observedAt: string; readonly validUntil: string }) => {
          if (
            value.observedAt < context.observedAt ||
            value.observedAt > check() ||
            value.validUntil > context.validUntil ||
            value.validUntil <= context.observedAt
          )
            return fail();
          validUntil = [validUntil, parseCatalogInstant(value.validUntil)].sort()[0] ?? fail();
          check();
        };
        const result = await read(policySource, async (policy) => {
          retain(policy);
          heldPolicy = policy.policy;
          try {
            const consumeScope = async (scope: CurrentProductPublicationScope) => {
              retain(scope);
              return read(variantSource, async (variant) => {
                retain(variant);
                return read(optionSource, async (options) => {
                  retain(options);
                  return read(mediaSource, async (media) => {
                    retain(media);
                    return read(taxSource, async (tax) => {
                      retain(tax);
                      const consumeRegistered = async (registered: {
                        readonly sources: readonly CatalogProductPublicationValidationSourceEvidence[];
                        readonly observedAt: string;
                        readonly validUntil: string;
                      }) => {
                        retain(registered);
                        const consumeReferences = async (
                          references: References,
                          ownerTx: Transaction,
                        ) => {
                          if (ownerTx !== tx) return fail();
                          retain(references);
                          let calls = 0,
                            returned: { value: T } | undefined;
                          const value = await assess(
                            tx,
                            {
                              context,
                              policy: policy.policy,
                              references,
                              registerBeforeCommit: register,
                            },
                            async (business) => {
                              if (
                                ++calls !== 1 ||
                                business.originalIntentDigest !== context.originalIntentDigest ||
                                business.aggregateSnapshotDigest !==
                                  context.aggregateSnapshotDigest ||
                                business.policyReference !==
                                  policy.policy.content.policyReference ||
                                business.policyVersion !== policy.policy.content.policyVersion ||
                                business.checks.length !== 2 ||
                                new Set(business.checks.map((item) => item.code)).size !== 2 ||
                                business.checks.some(
                                  (item) =>
                                    !["EffectivePeriod", "ChangeImpact"].includes(item.code),
                                ) ||
                                business.sources.length === 0
                              )
                                return fail();
                              retain(business);
                              const requiredMediaFindings: CatalogProductPublicationValidationFinding[] =
                                [];
                              if (policy.requiredMediaPresence.outcome === "HardError") {
                                const policyEvidence =
                                  policy.sources.find(
                                    (source) => source.sourceCode === "PRODUCT_PUBLICATION_POLICY",
                                  ) ?? fail();
                                requiredMediaFindings.push({
                                  checkCode: "MediaReady",
                                  ruleCode: "REQUIRED_PRODUCT_MEDIA",
                                  outcome: "HardError",
                                  subjectReference: context.productReference,
                                  reasonCode: "REQUIRED_PRODUCT_MEDIA_MISSING",
                                  references: [
                                    {
                                      sourceCode: policyEvidence.sourceCode,
                                      resourceReference: policy.policy.content.policyReference,
                                      versionReference: policy.policy.currentPublicationReference,
                                      referenceDigest: policyEvidence.sourceDigest,
                                    },
                                  ],
                                });
                              }
                              const assessedAt = parseCatalogInstant(check());
                              const combined = composeCatalogProductPublicationValidation({
                                context: {
                                  ...context,
                                  validUntil: parseCatalogInstant(validUntil),
                                },
                                policy: policy.policy,
                                evidenceReference: parseCatalogReference(
                                  evidenceReference(context.command.operationReference),
                                ),
                                checks: [
                                  policy.check,
                                  scope.publishableSkuCheck,
                                  scope.check,
                                  variant.check,
                                  options.check,
                                  {
                                    code: "MediaReady",
                                    outcome:
                                      policy.requiredMediaPresence.outcome === "HardError"
                                        ? "HardError"
                                        : media.check.outcome,
                                  },
                                  tax.check,
                                  ...business.checks,
                                ],
                                details: {
                                  coverage: "Complete",
                                  impact: "Recorded",
                                  findings: [
                                    ...policy.findings,
                                    ...scope.findings,
                                    ...variant.findings,
                                    ...options.findings,
                                    ...media.findings,
                                    ...requiredMediaFindings,
                                    ...tax.findings,
                                    ...business.findings,
                                  ],
                                  sources: [
                                    ...policy.sources,
                                    ...scope.sources,
                                    ...variant.sources,
                                    ...options.sources,
                                    ...media.sources,
                                    ...tax.sources,
                                    ...registered.sources,
                                    ...references.referenceEvidence,
                                    ...business.sources,
                                  ],
                                },
                                assessedAt,
                              });
                              validUntil =
                                [validUntil, combined.validation.validUntil].sort()[0] ?? fail();
                              if (++consumerCalls !== 1) return fail();
                              let outcome: T;
                              try {
                                outcome = await work(combined, context, policy.policy, assessedAt);
                              } catch (error) {
                                if (error instanceof CatalogError) consumerError = error;
                                throw error;
                              }
                              check();
                              returned = { value: outcome };
                              consumerResult = { value: outcome };
                              return outcome;
                            },
                          );
                          if (
                            calls !== 1 ||
                            returned === undefined ||
                            !Object.is(value, returned.value)
                          )
                            return fail();
                          return value;
                        };
                        if (qualification.kind === "Publication") {
                          const referenceContext = bindCatalogProductPublicationValidationContextV2(
                            qualification.input,
                          );
                          return createMerchantProductPublicationReferenceSourceV2({
                            ...config.publicationReferences,
                            ...common,
                            context: referenceContext,
                            request: buildCatalogProductPublicationReferenceRequestV2(
                              referenceContext,
                              context.validUntil,
                            ),
                          }).withCurrentImpactReferences(
                            variant.referenceProvenance,
                            scope.coverage,
                            consumeReferences,
                          );
                        }
                        return createMerchantProductWarningAcknowledgementReferenceSource({
                          ...config.acknowledgementReferences,
                          ...common,
                          context: qualification.input,
                          request: buildCatalogProductWarningAcknowledgementReferenceRequest(
                            qualification.input,
                          ),
                        }).withCurrentImpactReferences(
                          variant.referenceProvenance,
                          scope.coverage,
                          consumeReferences,
                        );
                      };
                      const proof = { policy, media, options, variant };
                      return qualification.kind === "Publication"
                        ? registeredSource.withPublication(
                            qualification.input,
                            context.validUntil,
                            proof,
                            consumeRegistered,
                          )
                        : registeredSource.withAcknowledgement(
                            qualification.input,
                            proof,
                            consumeRegistered,
                          );
                    });
                  });
                });
              });
            };
            return await (qualification.kind === "Publication"
              ? scopeSource.withPublication(
                  qualification.input,
                  context.validUntil,
                  policy.policy,
                  consumeScope,
                )
              : scopeSource.withAcknowledgement(qualification.input, policy.policy, consumeScope));
          } finally {
            heldPolicy = undefined;
          }
        });
        if (
          consumerCalls !== 1 ||
          consumerResult === undefined ||
          !Object.is(result, consumerResult.value)
        )
          return fail();
        active = false;
        complete = true;
        check();
        return result;
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        if (consumerError) throw consumerError;
        if (sourceError) throw sourceError;
        if (error instanceof CatalogError && error.code === "CATALOG_DEPENDENCY_UNAVAILABLE")
          throw error;
        return unavailable();
      }
    }
    return {
      run,
      registeredSource,
      async currentPolicy<T>(
        actual: Transaction,
        input: {
          readonly policyReference: string;
          readonly policyVersion: number;
          readonly observedAt: string;
        },
        work: (policy: unknown) => Promise<T>,
      ): Promise<T> {
        try {
          check();
          if (
            actual !== tx ||
            !active ||
            !heldPolicy ||
            input.policyReference !== heldPolicy.content.policyReference ||
            input.policyVersion !== heldPolicy.content.policyVersion ||
            input.observedAt !== heldPolicy.observedAt
          )
            return fail();
          const value = await work(heldPolicy);
          check();
          return value;
        } catch (error) {
          failed = true;
          throw error;
        }
      },
    };
  }
  return Object.freeze({
    publication(host) {
      const source = create(host);
      return {
        editorContentAuthority: source.registeredSource.editorContentAuthority,
        sources: {
          withCurrentPolicy: source.currentPolicy,
          withHeldCurrentFacts: (tx, input, work) =>
            source.run(tx, { kind: "Publication", input }, async (result, context) =>
              work(
                {
                  now: context.observedAt,
                  productAggregateVersion: context.aggregateVersion,
                  contentDigest: context.contentDigest,
                  configurationDigest: context.configurationDigest,
                  scopeDigest: context.scopeDigest,
                  periodDigest: context.periodDigest,
                  validation: result.validation,
                  approval: null,
                  replacement: null,
                  reviewReference:
                    input.command.action === "SubmitReview"
                      ? parseCatalogReference(reviewReference(input.command.operationReference))
                      : null,
                },
                result.details,
              ),
            ),
        },
      };
    },
    acknowledgement(host) {
      const source = create(host);
      return {
        sources: {
          withHeldCurrentObservation: (tx, input, work) =>
            source.run(
              tx,
              { kind: "WarningAcknowledgement", input },
              async (result, _context, policy, assessedAt) =>
                work(
                  buildCatalogProductPublicationWarningAcknowledgementObservation({
                    command: input.command,
                    binding: result.binding,
                    validation: result.validation,
                    details: result.details,
                    policy: policy.content,
                    observedAt: assessedAt,
                    validUntil: result.validation.validUntil,
                  }),
                ),
            ),
        },
      };
    },
  });
}
