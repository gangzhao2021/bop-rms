import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  createCatalogOptionSetContentReviewBinding,
  optionContentReviewValidationCodes,
  parseCatalogInstant,
  parseCatalogOptionSetContentPolicyBinding,
  parseCatalogReference,
  createPostgresOptionSetReviewContentStore,
  parseCatalogOptionSetReviewRecord,
  optionSetReviewRecordFields,
  currentFullOptionSetDraftReviewFields,
  frozenFullOptionSetContentFields,
  parseFullOptionSetPublicationSealIdentity,
  type FullOptionSetPublicationSealIdentity,
  type OptionSetEditorContent,
  prepareCatalogOptionSetRecordedReviewQualification,
  assertCatalogOptionSetRecordedReviewQualification,
} from "@rms/catalog";
import { createCurrentOptionSetPublicationDraftGraphSource } from "./current-option-set-publication-draft-graph.js";
import { createCurrentOptionSetPublicationBrandPolicySource } from "./current-option-set-publication-brand-policy.js";
import { createCurrentOptionSetPublicationPriceInventorySource } from "./current-option-set-publication-price-inventory.js";
import { createCurrentOptionSetPublicationRecipeSource } from "./current-option-set-publication-recipe.js";
import { createCurrentOptionSetPublicationMediaSource } from "./current-option-set-publication-media.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

type BrandOptions = Parameters<typeof createCurrentOptionSetPublicationBrandPolicySource>[0];
type MediaOptions = Parameters<typeof createCurrentOptionSetPublicationMediaSource>[0];
type GraphPacket = Parameters<
  Parameters<
    ReturnType<typeof createCurrentOptionSetPublicationDraftGraphSource>["withCurrentGraph"]
  >[1]
>[0];
type BrandPacket = Parameters<
  Parameters<
    ReturnType<typeof createCurrentOptionSetPublicationBrandPolicySource>["withCurrentAssessment"]
  >[1]
>[0];
type ReferencePacket = Parameters<
  Parameters<
    ReturnType<
      typeof createCurrentOptionSetPublicationPriceInventorySource
    >["withCurrentAssessment"]
  >[1]
>[0];
type RecipePacket = Parameters<
  Parameters<
    ReturnType<typeof createCurrentOptionSetPublicationRecipeSource>["withCurrentAssessment"]
  >[1]
>[0];
type MediaPacket = Parameters<
  Parameters<
    ReturnType<typeof createCurrentOptionSetPublicationMediaSource>["withCurrentAssessment"]
  >[1]
>[0];
export type CurrentOptionSetPublicationValidationOptions = BrandOptions &
  Pick<MediaOptions, "mediaScope"> & {
    readonly originalObservedAt: string;
    readonly publicationSeal?: FullOptionSetPublicationSealIdentity;
  };
type CheckCode = (typeof optionContentReviewValidationCodes)[number];
type Outcome = "Pass" | "HardError" | "Indeterminate";
interface Finding {
  readonly checkCode: CheckCode;
  readonly ruleCode: string;
  readonly outcome: Outcome;
  readonly optionSetReference: string | null;
  readonly optionReference: string | null;
  readonly reference: string | null;
}
export interface CurrentOptionSetPublicationValidationPacket {
  readonly profile: "CurrentOptionSetPublicationValidationV1";
  readonly operationReference: string;
  readonly sourceOperationReference: string;
  readonly reviewBinding: ReturnType<typeof createCatalogOptionSetContentReviewBinding>;
  readonly content: OptionSetEditorContent;
  readonly recordedReview: ReturnType<typeof parseCatalogOptionSetReviewRecord> | null;
  readonly qualifiedActivationAt: string;
  readonly qualificationBinding: ReturnType<typeof parseCatalogOptionSetContentPolicyBinding>;
  readonly checks: readonly { readonly code: CheckCode; readonly outcome: Outcome }[];
  readonly findings: readonly Finding[];
  readonly sourceAssessmentDigests: Readonly<{
    brandPolicy: string;
    priceInventory: string;
    recipe: string;
    media: string;
  }>;
  readonly decision: Outcome;
  readonly originalObservedAt: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly independentApproval: "NotEvaluated";
  readonly saleEligibility: "NotEvaluated";
  readonly digest: string;
}
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}
function outcome(values: readonly Outcome[]): Outcome {
  return values.includes("HardError")
    ? "HardError"
    : values.includes("Indeterminate")
      ? "Indeterminate"
      : "Pass";
}

/** One held ordinary-review validation. The factories acquire their actual
 * owners internally; none of the packets is accepted from an HTTP caller.
 * Independent approval, atomic publication and sale eligibility are separate.
 */
export function createCurrentOptionSetPublicationValidationSource(
  options: CurrentOptionSetPublicationValidationOptions,
) {
  const tx = options.transaction,
    query = tx?.query,
    nowPort = options.clock?.now,
    registerPort = options.registerBeforeCommit;
  if (
    typeof query !== "function" ||
    typeof nowPort !== "function" ||
    typeof registerPort !== "function"
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  const now = nowPort.bind(options.clock),
    register = registerPort.bind(options),
    tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    operation = parseCatalogReference(options.operationReference),
    currentStartedAt = parseCatalogInstant(now()),
    originalObservedAt = parseCatalogInstant(options.originalObservedAt),
    originalValidUntil = parseCatalogInstant(options.originalValidUntil);
  if (
    currentStartedAt < originalObservedAt ||
    currentStartedAt >= originalValidUntil ||
    originalValidUntil <= originalObservedAt ||
    Date.parse(originalValidUntil) - Date.parse(originalObservedAt) > 5000
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  let latest = currentStartedAt,
    deadline = originalValidUntil,
    entered = false,
    active = false,
    failed = false,
    ready = false,
    guarded = false;
  const combinedPort = options.capability.holdUntilCommitWithDecisions;
  if (combinedPort !== undefined && typeof combinedPort !== "function")
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  const combined = combinedPort?.bind(options.capability);
  const fail = (): never => {
    failed = true;
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const check = () => {
    const at = parseCatalogInstant(now());
    if (
      failed ||
      tx.query !== query ||
      options.clock.now !== nowPort ||
      options.registerBeforeCommit !== registerPort ||
      options.capability.holdUntilCommitWithDecisions !== combinedPort ||
      at < latest ||
      at >= deadline
    )
      return fail();
    latest = at;
    return at;
  };
  const tighten = (until: string) => {
    const value = parseCatalogInstant(until);
    if (value < deadline) deadline = value;
    check();
  };
  const authorizePort = options.currentAuthorization.authorizeActions,
    assertPort = options.currentAuthorization.assertCurrent,
    authorizationLeasePort = options.currentAuthorization.leaseDeadline,
    capabilityPort = options.capability.holdUntilCommit,
    capabilityLeasePort = options.capability.leaseDeadline;
  if (typeof authorizationLeasePort !== "function" || typeof capabilityLeasePort !== "function")
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  const holdReview = async () => {
    check();
    if (
      options.currentAuthorization.authorizeActions !== authorizePort ||
      options.currentAuthorization.assertCurrent !== assertPort ||
      options.currentAuthorization.leaseDeadline !== authorizationLeasePort ||
      options.capability.holdUntilCommit !== capabilityPort ||
      options.capability.leaseDeadline !== capabilityLeasePort
    )
      return fail();
    assertPort.call(options.currentAuthorization);
    const actions = Object.freeze(["catalog.manage", "catalog.option_set.read"]);
    if (combined) {
      const decisions = await combined(actions);
      check();
      if (
        !Array.isArray(decisions) ||
        Object.getPrototypeOf(decisions) !== Array.prototype ||
        decisions.length !== actions.length ||
        Reflect.ownKeys(decisions).length !== actions.length + 1
      )
        return fail();
      for (let i = 0; i < actions.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(decisions, String(i));
        if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
        const decision = readClosedRecord(descriptor.value, [
            "effect",
            "reason",
            "source",
            "action",
            "scopeKind",
            "policySnapshotReference",
            "policyVersion",
            "audit",
          ]),
          audit = readClosedRecord(decision.audit, ["effect", "reason", "source"]);
        if (decision.effect !== "Allow" || decision.scopeKind !== "Brand") {
          failed = true;
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        }
        if (
          parseBusinessAction(decision.action) !== actions[i] ||
          (decision.reason !== "EXPLICIT_ALLOW" && decision.reason !== "ROLE_PERMISSION") ||
          (decision.source !== "ExplicitAllow" && decision.source !== "RolePermission") ||
          (decision.reason === "EXPLICIT_ALLOW") !== (decision.source === "ExplicitAllow") ||
          audit.effect !== decision.effect ||
          audit.reason !== decision.reason ||
          audit.source !== decision.source
        )
          return fail();
        parsePolicyReference(decision.policySnapshotReference);
        parsePolicyVersion(decision.policyVersion);
      }
    } else {
      if ((await capabilityPort.call(options.capability)) !== undefined) return fail();
      check();
      if ((await authorizePort.call(options.currentAuthorization, actions)) !== undefined)
        return fail();
    }
    tighten(authorizationLeasePort.call(options.currentAuthorization));
    tighten(capabilityLeasePort.call(options.capability));
    assertPort.call(options.currentAuthorization);
    check();
  };
  const publicationSeal =
    options.publicationSeal === undefined
      ? undefined
      : parseFullOptionSetPublicationSealIdentity(options.publicationSeal);
  let reviewOwner: ReturnType<typeof createPostgresOptionSetReviewContentStore> | undefined,
    ownSealAdmitted = false;
  const captured = {
    ...options,
    ...(publicationSeal ? { publicationSeal } : {}),
    clock: { now: check },
    originalValidUntil,
  };
  const graphSource = createCurrentOptionSetPublicationDraftGraphSource(captured);
  async function held<P, T>(
    acquire: (consume: (packet: P) => Promise<T>) => Promise<T>,
    consume: (packet: P) => Promise<T>,
  ): Promise<T> {
    let calls = 0,
      complete = false;
    let answer: T | undefined;
    const result = await acquire(async (packet) => {
      if (++calls !== 1) return fail();
      check();
      answer = await consume(packet);
      check();
      complete = true;
      return answer;
    });
    if (calls !== 1 || !complete || !Object.is(result, answer)) return fail();
    check();
    return result;
  }
  async function execute<T>(
    value: unknown,
    work: (packet: CurrentOptionSetPublicationValidationPacket) => Promise<T>,
    recordedReviewMode = false,
  ): Promise<T> {
    if (entered || active || typeof work !== "function") return fail();
    entered = active = true;
    try {
      if (
        (await register(
          tx,
          async () => {
            if (!ready || active || guarded) return fail();
            check();
            if (recordedReviewMode) await holdReview();
            guarded = true;
          },
          () => {
            if (!guarded || active) return fail();
            check();
          },
        )) !== undefined
      )
        return fail();
      const input = readClosedRecord(
        copyCategoryPersistenceValue(value),
        recordedReviewMode
          ? [
              "graphRequest",
              "originalIntentDigest",
              "expectedReviewOperationReference",
              "expectedReviewRecordDigest",
              "expectedReviewBindingDigest",
            ]
          : ["graphRequest", "originalIntentDigest", "activationAt"],
      );
      let recordedReview: ReturnType<typeof parseCatalogOptionSetReviewRecord> | null = null;
      const expectedReviewOperation = recordedReviewMode
        ? parseCatalogReference(input.expectedReviewOperationReference)
        : null;
      for (const field of recordedReviewMode
        ? ["expectedReviewRecordDigest", "expectedReviewBindingDigest"]
        : [])
        if (typeof input[field] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input[field]))
          return fail();
      return await held<GraphPacket, T>(
        (consume) => graphSource.withCurrentGraph(input.graphRequest, consume),
        async (graph) => {
          tighten(graph.validUntil);
          if (
            graph.originalObservedAt !== originalObservedAt ||
            graph.sourceSnapshotTuple.tenantReference !== tenant ||
            graph.sourceSnapshotTuple.brandReference !== brand
          )
            return fail();
          if (recordedReviewMode) {
            await holdReview();
            const actor = parseCatalogReference(options.actorReference),
              set = graph.graph.rootOptionSetReference,
              root = graph.graph.contents.find((c) => c.sourceAggregate.optionSetReference === set);
            if (!root) return fail();
            const owner = createPostgresOptionSetReviewContentStore({
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              clock: { now: check },
              events: options.events,
              registerBeforeCommit(actual, guard, final) {
                if (actual !== tx) return fail();
                return register(tx, guard, final);
              },
              authority: {
                async holdUntilTransactionCompletes(actual, request) {
                  if (
                    actual !== tx ||
                    request.tenantReference !== tenant ||
                    request.brandReference !== brand ||
                    request.actorReference !== actor ||
                    request.actorKind !== "User" ||
                    request.permission !== "catalog.manage" ||
                    request.action !== "catalog.option_set.read" ||
                    request.purposeCode !== "CATALOG_OPTION_SET_REVIEW_RECORD" ||
                    request.phase !== "Read" ||
                    request.optionSetReference !== set ||
                    !equal(request.requiredFields, optionSetReviewRecordFields) ||
                    parseCatalogInstant(request.observedAt) < currentStartedAt ||
                    parseCatalogInstant(request.observedAt) > check()
                  )
                    return fail();
                  if (request.record !== null) {
                    const record = parseCatalogOptionSetReviewRecord(request.record);
                    if (
                      record.operationReference !== expectedReviewOperation ||
                      record.digest !== input.expectedReviewRecordDigest ||
                      record.binding.digest !== input.expectedReviewBindingDigest ||
                      !equal(record.content, root)
                    )
                      return fail();
                  }
                  await holdReview();
                  return Object.freeze({ observedAt: request.observedAt, validUntil: deadline });
                },
              },
              ...(publicationSeal
                ? {
                    publicationSeal: {
                      identity: publicationSeal,
                      originalObservedAt,
                      originalValidUntil,
                      currentDraftAuthority: {
                        async holdUntilTransactionCompletes(actual, request) {
                          if (
                            actual !== tx ||
                            request.tenantReference !== tenant ||
                            request.brandReference !== brand ||
                            request.actorReference !== actor ||
                            request.actorKind !== "User" ||
                            request.permission !== "catalog.manage" ||
                            request.action !== "catalog.option_set.read" ||
                            request.purposeCode !== "CATALOG_OPTION_SET_DRAFT" ||
                            request.optionSetReference !== set ||
                            !equal(request.requiredFields, currentFullOptionSetDraftReviewFields) ||
                            parseCatalogInstant(request.observedAt) < currentStartedAt ||
                            parseCatalogInstant(request.observedAt) > check()
                          )
                            return fail();
                          await holdReview();
                          return Object.freeze({
                            observedAt: request.observedAt,
                            validUntil: deadline,
                          });
                        },
                      },
                      frozenAuthority: {
                        async holdUntilTransactionCompletes(actual, request) {
                          if (
                            actual !== tx ||
                            request.tenantReference !== tenant ||
                            request.brandReference !== brand ||
                            request.actorReference !== actor ||
                            request.actorKind !== "User" ||
                            request.permission !== "catalog.manage" ||
                            request.action !== "catalog.option_set.read" ||
                            request.purposeCode !== "CATALOG_OPTION_SET_FROZEN_CONTENT" ||
                            request.optionSetReference !== set ||
                            request.versionReference !== graph.graph.rootVersionReference ||
                            !equal(request.requiredFields, frozenFullOptionSetContentFields) ||
                            parseCatalogInstant(request.observedAt) < currentStartedAt ||
                            parseCatalogInstant(request.observedAt) > check()
                          )
                            return fail();
                          await holdReview();
                          return Object.freeze({
                            observedAt: request.observedAt,
                            validUntil: deadline,
                          });
                        },
                      },
                    },
                  }
                : {}),
              currentDraftAuthority: {
                async holdUntilTransactionCompletes(actual, request) {
                  if (
                    actual !== tx ||
                    request.tenantReference !== tenant ||
                    request.brandReference !== brand ||
                    request.actorReference !== actor ||
                    request.actorKind !== "User" ||
                    request.permission !== "catalog.manage" ||
                    request.action !== "catalog.option_set.read" ||
                    request.purposeCode !== "CATALOG_OPTION_SET_DRAFT" ||
                    request.optionSetReference !== set ||
                    !equal(request.requiredFields, currentFullOptionSetDraftReviewFields) ||
                    parseCatalogInstant(request.observedAt) < currentStartedAt ||
                    parseCatalogInstant(request.observedAt) > check() ||
                    (request.content !== null && !equal(request.content, root))
                  )
                    return fail();
                  await holdReview();
                  return Object.freeze({ observedAt: request.observedAt, validUntil: deadline });
                },
              },
            });
            reviewOwner = owner;
            const selected = await owner.readCurrentReviewForDraft(tx, {
              optionSetReference: set,
              expectedAggregateVersion: graph.aggregateVersion,
            });
            if (!selected) return fail();
            const record = parseCatalogOptionSetReviewRecord(selected);
            if (
              record.operationReference !== expectedReviewOperation ||
              record.digest !== input.expectedReviewRecordDigest ||
              record.binding.digest !== input.expectedReviewBindingDigest
            )
              return fail();
            recordedReview = immutable(record);
          }
          const freshBinding = {
            tenantReference: tenant,
            brandReference: brand,
            optionSetReference: graph.graph.rootOptionSetReference,
            versionReference: graph.graph.rootVersionReference,
            expectedAggregateVersion: graph.aggregateVersion,
            sourceDigest: graph.sourceDigest,
            contentDigest: graph.contentDigest,
            configurationDigest: graph.configurationDigest,
            graphDigest: graph.graphDigest,
            originalIntentDigest: input.originalIntentDigest,
            observedAt: originalObservedAt,
            validUntil: deadline,
          };
          const preparedReview = recordedReview
            ? prepareCatalogOptionSetRecordedReviewQualification(recordedReview, freshBinding)
            : null;
          const binding =
              preparedReview?.qualificationBinding ??
              parseCatalogOptionSetContentPolicyBinding({
                ...freshBinding,
                activationAt: input.activationAt,
              }),
            qualifiedActivationAt = binding.activationAt;
          const assessmentInput = { graph, binding };
          return held<BrandPacket, T>(
            (consume) =>
              createCurrentOptionSetPublicationBrandPolicySource(captured).withCurrentAssessment(
                assessmentInput,
                consume,
              ),
            async (brandPolicy) => {
              tighten(brandPolicy.validUntil);
              if (!equal(brandPolicy.binding, binding)) return fail();
              return held<ReferencePacket, T>(
                (consume) =>
                  createCurrentOptionSetPublicationPriceInventorySource(
                    captured,
                  ).withCurrentAssessment(assessmentInput, consume),
                async (references) => {
                  tighten(references.validUntil);
                  return held<RecipePacket, T>(
                    (consume) =>
                      createCurrentOptionSetPublicationRecipeSource(captured).withCurrentAssessment(
                        assessmentInput,
                        consume,
                      ),
                    async (recipes) => {
                      tighten(recipes.validUntil);
                      return held<MediaPacket, T>(
                        (consume) =>
                          createCurrentOptionSetPublicationMediaSource(
                            captured,
                          ).withCurrentAssessment(assessmentInput, consume),
                        async (media) => {
                          tighten(media.validUntil);
                          if (
                            ![references, recipes, media].every(
                              (packet) =>
                                packet.operationReference === operation &&
                                equal(packet.binding, binding),
                            )
                          )
                            return fail();
                          const findings: Finding[] = [];
                          const add = (
                            checkCode: CheckCode,
                            ruleCode: string,
                            status: Outcome,
                            subject: {
                              optionSetReference: string | null;
                              optionReference: string | null;
                              reference: string | null;
                            } = {
                              optionSetReference: binding.optionSetReference,
                              optionReference: null,
                              reference: null,
                            },
                          ) => {
                            if (status !== "Pass")
                              findings.push({ checkCode, ruleCode, outcome: status, ...subject });
                          };
                          const policyChecks = brandPolicy.contentPolicy.checks;
                          policyChecks.forEach((rule) =>
                            add(
                              rule.code === "MechanicalRules"
                                ? "RULE_SATISFIABILITY"
                                : "PUBLISHING_POLICY",
                              rule.code,
                              rule.outcome,
                            ),
                          );
                          brandPolicy.brandScope.checks.forEach((rule) =>
                            add(
                              rule.code === "ScopeTopology"
                                ? "SCOPE_TOPOLOGY"
                                : "PUBLISHING_POLICY",
                              rule.code,
                              rule.outcome,
                            ),
                          );
                          brandPolicy.brandScope.missingSources.forEach((source) =>
                            add("SCOPE_TOPOLOGY", source, "Indeterminate"),
                          );
                          // These codes require an actual field-specific inherited
                          // requirement owner; unrecognized codes cannot be waived.
                          brandPolicy.brandConfiguration.hardRequirementFieldCodes.forEach((code) =>
                            add(
                              "PUBLISHING_POLICY",
                              "BrandHardRequirement:" + code,
                              "Indeterminate",
                            ),
                          );
                          for (const assessment of [
                            references.standaloneReferenceAssessment,
                            recipes.standaloneReferenceAssessment,
                          ]) {
                            if (assessment.phase !== "OptionSetPublication") return fail();
                            const assessedOutcomes: Outcome[] = [];
                            for (const rule of assessment.checks) {
                              const value: string = rule.outcome;
                              if (value === "NotApplicableForIndependentSet") {
                                if (rule.code !== "ProductBindingAndSaleApplicability")
                                  return fail();
                                continue;
                              }
                              const status = value === "Satisfied" ? "Pass" : value;
                              if (!["Pass", "HardError", "Indeterminate"].includes(status))
                                return fail();
                              if (status !== "Pass" && rule.reasonCode === null) return fail();
                              assessedOutcomes.push(status as Outcome);
                              add(
                                "CURRENT_REFERENCES",
                                rule.reasonCode ?? rule.code,
                                status as Outcome,
                                {
                                  optionSetReference: rule.optionSetReference,
                                  optionReference: rule.optionReference,
                                  reference: rule.reference,
                                },
                              );
                            }
                            if (assessment.decision !== outcome(assessedOutcomes)) return fail();
                          }
                          media.nodes.forEach((node) =>
                            add("CURRENT_REFERENCES", "MediaReady", node.check.outcome),
                          );
                          const checks = optionContentReviewValidationCodes.map((code) => ({
                            code,
                            outcome: outcome(
                              findings.filter((f) => f.checkCode === code).map((f) => f.outcome),
                            ),
                          }));
                          const root = graph.graph.contents.find(
                            (content) =>
                              content.sourceAggregate.optionSetReference ===
                              binding.optionSetReference,
                          );
                          if (!root) return fail();
                          const currentTarget = createCatalogOptionSetContentReviewBinding({
                            tenantReference: binding.tenantReference,
                            brandReference: binding.brandReference,
                            optionSetReference: binding.optionSetReference,
                            versionReference: binding.versionReference,
                            sourceDigest: binding.sourceDigest,
                            contentDigest: binding.contentDigest,
                            configurationDigest: binding.configurationDigest,
                            expectedAggregateVersion: binding.expectedAggregateVersion,
                            graphDigest: binding.graphDigest,
                            policyReference: brandPolicy.contentPolicy.policyReference,
                            policyVersion: brandPolicy.contentPolicy.policyVersion,
                            policyContentDigest: brandPolicy.contentPolicy.policyContentDigest,
                            currentPolicyPublicationReference:
                              brandPolicy.policy.currentPublicationReference,
                            originalIntentDigest: binding.originalIntentDigest,
                            activationAt: binding.activationAt,
                          });
                          const reviewBinding = recordedReview?.binding ?? currentTarget;
                          if (recordedReview)
                            assertCatalogOptionSetRecordedReviewQualification(
                              recordedReview,
                              binding,
                              currentTarget,
                              graph.sourceOperationReference,
                              root,
                            );
                          const body = {
                            recordedReview,
                            qualifiedActivationAt,
                            qualificationBinding: binding,
                            profile: "CurrentOptionSetPublicationValidationV1" as const,
                            operationReference: operation,
                            sourceOperationReference: graph.sourceOperationReference,
                            reviewBinding,
                            content: root,
                            checks,
                            findings,
                            sourceAssessmentDigests: {
                              brandPolicy: hash(brandPolicy),
                              priceInventory: hash(references),
                              recipe: hash(recipes),
                              media: hash(media),
                            },
                            decision: outcome(checks.map((c) => c.outcome)),
                            originalObservedAt,
                            observedAt: check(),
                            validUntil: deadline,
                            independentApproval: "NotEvaluated" as const,
                            saleEligibility: "NotEvaluated" as const,
                          };
                          const result = await work(immutable({ ...body, digest: hash(body) }));
                          check();
                          ready = true;
                          return result;
                        },
                      );
                    },
                  );
                },
              );
            },
          );
        },
      );
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError || error instanceof MerchantProductWriteFeatureDisabled)
        throw error;
      return fail();
    } finally {
      active = false;
    }
  }
  return Object.freeze({
    async admitOwnSeal(receipt: unknown) {
      if (!publicationSeal || !ready || active || guarded || ownSealAdmitted) return fail();
      active = true;
      try {
        const graphProof = await graphSource.admitOwnSeal(receipt);
        tighten(graphProof.validUntil);
        if (reviewOwner) {
          const reviewProof = await reviewOwner.admitOwnSeal(tx, receipt);
          tighten(reviewProof.validUntil);
        }
        await holdReview();
        ownSealAdmitted = true;
        return graphProof;
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError || error instanceof MerchantProductWriteFeatureDisabled)
          throw error;
        return fail();
      } finally {
        active = false;
      }
    },
    withCurrentValidation<T>(
      value: unknown,
      work: (packet: CurrentOptionSetPublicationValidationPacket) => Promise<T>,
    ) {
      return execute(value, work, false);
    },
    withCurrentRecordedReviewValidation<T>(
      value: unknown,
      work: (packet: CurrentOptionSetPublicationValidationPacket) => Promise<T>,
    ) {
      return execute(value, work, true);
    },
  });
}
