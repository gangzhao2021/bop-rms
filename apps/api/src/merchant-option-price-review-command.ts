import { canonicalizeRfc8785 } from "@bop/audit";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import {
  createPostgresTransactionCurrentPermissionPolicySource,
  parsePolicyReference,
  parsePolicyVersion,
} from "@bop/permission";
import { createTenantContext } from "@bop/tenant";
import {
  createPostgresPublishingMutationStore,
  createPostgresOptionPriceReviewOperationStore,
  OptionPriceReviewOriginalDeniedError,
  parsePublishingOptionPriceReviewOperation,
  optionPriceReviewOperationFields,
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  parsePublishingReference,
  parsePublishingVersion,
  parsePublishingInstant,
  parsePublishingCode,
  executePublishingMutation,
  parseRecordedPublishingMutation,
  parsePublishingOptionPricePublicationPolicy,
  publishingOptionPricePublicationPolicyDigest,
  optionPricePolicyConfigurationType,
  optionPriceRuleConfigurationType,
  optionPriceRulePublicationPurpose,
  type OptionPriceReviewOriginalOperation,
  type OptionPriceRuleReviewHeldSource,
  type ExecutePublishingMutationInput,
} from "@bop/publishing";
import { CatalogError, copyCategoryPersistenceValue, parseCatalogInstant } from "@rms/catalog";
import {
  createCurrencyMetadataSnapshot,
  createPostgresOptionPriceAuthoringStore,
  OptionPriceAuthoringError,
  OptionPriceError,
  parseOptionPriceAuthoringCommand,
  optionPriceAuthoringFields,
  materializeOptionPriceVersion,
  assertOptionPricePublicationUnambiguous,
  optionPriceWireState,
  type CurrencyMetadataSnapshot,
} from "@rms/pricing";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import {
  createMerchantOptionPriceContextSource,
  type MerchantOptionPriceContextRequest,
} from "./merchant-option-price-context.js";
import { optionPricePublicationReviewCheckCodes } from "./merchant-option-price-publication-authority.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
export interface MerchantOptionPriceReviewCommandOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  readonly publicationPolicyFamilyReference: string;
  readonly references: {
    generate(
      kind:
        | "PublishingLifecycle"
        | "PublishingOperation"
        | "PublishingEvidence"
        | "OptionPriceVersion"
        | "Audit",
    ): string;
  };
}
export interface MerchantOptionPriceReviewRequest {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
  readonly expectedScope: unknown;
  readonly command: unknown;
}
export interface MerchantOptionPriceReviewExecuteRequest extends MerchantOptionPriceReviewRequest {
  readonly context: MerchantOptionPriceContextRequest;
}
export interface MerchantOptionPriceReviewResult {
  readonly profile: "MerchantOptionPriceReviewResultV1";
  readonly action: "SubmitReview" | "Approve";
  readonly operationReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly outcome: "Committed" | "Abandoned";
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface MerchantOptionPriceReviewQueryRequest extends Omit<
  MerchantOptionPriceReviewRequest,
  "command"
> {
  readonly context: MerchantOptionPriceContextRequest;
  readonly ruleReference: string;
}
export interface MerchantOptionPriceReviewCurrent {
  readonly profile: "MerchantOptionPriceReviewCurrentV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly ruleReference: string;
  readonly aggregateVersion: number;
  readonly draftVersionReference: string;
  readonly draftSnapshotDigest: string;
  readonly draftAuthorActorReference: string;
  readonly policy: Readonly<{
    familyReference: string;
    policyReference: string;
    policyVersion: number;
    approvalPolicy: "Required" | "NotRequired";
    effectiveFrom: string;
    effectiveUntil: string | null;
    currentPublicationReference: string;
  }>;
  readonly review:
    | Readonly<{ outcome: "Absent" }>
    | Readonly<{
        outcome: "Recorded";
        lifecycle: Readonly<{
          lifecycleReference: string;
          version: number;
          state: ReturnType<typeof createPublishingLifecycleRecord>["state"];
          latestMutationOperationReference: string;
        }>;
        validationValidUntil: string | null;
        approvalValidUntil: string | null;
        submittedActorReference: string | null;
        approvedActorReference: string | null;
        sourceAuthority: "RecordedHistory";
        qualification: "NotEvaluated";
      }>;
  readonly observedAt: string;
  readonly validUntil: string;
}
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const fail = (
  code: ConstructorParameters<
    typeof OptionPriceAuthoringError
  >[0] = "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new OptionPriceAuthoringError(code);
};
const bounded = (error: unknown): never => {
  if (
    error instanceof OptionPriceAuthoringError ||
    error instanceof MerchantProductWriteFeatureDisabled
  )
    throw error;
  if (error instanceof OptionPriceError && error.code === "OPTION_PRICE_CONFLICT")
    return fail("OPTION_PRICE_CONFLICT");
  if (
    error instanceof BrowserSessionError ||
    (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
  )
    return fail("OPTION_PRICE_PERMISSION_DENIED");
  return fail();
};
/** Genuine ordinary review composition. Original arbitration precedes current
 * sources; fresh work retains Catalog→Publishing→Pricing through outer COMMIT. */
export function createMerchantOptionPriceReviewCommand(
  options: MerchantOptionPriceReviewCommandOptions,
) {
  const clockPort = options.merchant.now,
    runPort = options.merchant.transactions.run,
    authPort = options.authentication.authorize,
    generatorPort = options.references.generate;
  if (
    typeof clockPort !== "function" ||
    typeof runPort !== "function" ||
    typeof authPort !== "function" ||
    typeof generatorPort !== "function"
  )
    return fail();
  const clock = clockPort.bind(options.merchant),
    run = runPort.bind(options.merchant.transactions),
    authenticate = authPort.bind(options.authentication),
    generate = (kind: Parameters<typeof generatorPort>[0]) =>
      parsePublishingReference(generatorPort.call(options.references, kind)),
    currency = createCurrencyMetadataSnapshot(options.currencyMetadata),
    family = parsePublishingReference(options.publicationPolicyFamilyReference),
    merchant = Object.freeze({
      ...options.merchant,
      now: clock,
      transactions: { run },
      currentActor: options.merchant.currentActor.bind(options.merchant),
      validateAssociation: options.merchant.validateAssociation.bind(options.merchant),
    }),
    host = createMerchantCategoryTransactions({ run });
  async function perform(
    mode: "Execute" | "Resolve" | "Query",
    request: MerchantOptionPriceReviewRequest,
    contextRequest?: MerchantOptionPriceContextRequest,
    queryRule?: string,
  ): Promise<MerchantOptionPriceReviewResult | MerchantOptionPriceReviewCurrent> {
    try {
      const raw =
          mode === "Query"
            ? null
            : (() => {
                try {
                  return readClosedRecord(copyCategoryPersistenceValue(request.command), [
                    "action",
                    "operationReference",
                    "ruleReference",
                    "draftVersionReference",
                    "draftSnapshotDigest",
                    "expectedAggregateVersion",
                    "validationValidUntil",
                    "approvalValidUntil",
                    "expectedLifecycle",
                  ]);
                } catch {
                  return fail("OPTION_PRICE_INPUT_INVALID");
                }
              })(),
        expected = parseMerchantProductCommandScope(request.expectedScope),
        started = parseCatalogInstant(clock()),
        originalUntil = parseCatalogInstant(new Date(Date.parse(started) + 5000).toISOString());
      let deadline: string = originalUntil,
        latest: string = started,
        failed = false,
        hostDone = false,
        guardDone = false,
        ready = false,
        guardRunning = false,
        finalDone = false;
      const finals: (() => string)[] = [];
      const reject = (error?: unknown): never => {
        failed = true;
        return bounded(error);
      };
      const now = () => {
        if (
          failed ||
          options.merchant.now !== clockPort ||
          options.merchant.transactions.run !== runPort ||
          options.authentication.authorize !== authPort ||
          options.references.generate !== generatorPort
        )
          return reject();
        const at = parseCatalogInstant(clock());
        if (at < latest || at >= deadline) return reject();
        latest = at;
        return at;
      };
      const tighten = (until: string) => {
        const value = parseCatalogInstant(until);
        if (value < deadline) deadline = value;
        now();
      };
      const session = await authenticate({
        sessionCookie: request.sessionCookie,
        csrf: request.csrf,
      });
      now();
      const result = await host.transactions.run(async (tx) => {
        const capturedQuery = tx.query,
          permissionPolicy = createPostgresTransactionCurrentPermissionPolicySource(tx),
          check = () => {
            if (tx.query !== capturedQuery) return reject();
            return now();
          };
        const withPublishingReview = async <T>(
          publisher: ReturnType<typeof createPostgresPublishingMutationStore>,
          input: Parameters<typeof publisher.withOptionPriceReview>[0],
          work: (review: OptionPriceRuleReviewHeldSource) => Promise<T>,
        ): Promise<T> => {
          const port = publisher.withOptionPriceReview;
          let callbackCalls = 0;
          const trustedFailure: { error?: OptionPriceAuthoringError } = {};
          try {
            return await publisher.withOptionPriceReview<T>(input, async (review) => {
              if (++callbackCalls !== 1 || publisher.withOptionPriceReview !== port)
                return reject();
              try {
                return await work(review);
              } catch (error) {
                // Preserve only a real API error raised inside this request's
                // actual owner callback. The public owner normalizes failures;
                // untrusted payloads and owner/source failures stay unavailable.
                if (
                  error instanceof OptionPriceAuthoringError &&
                  tx.query === capturedQuery &&
                  publisher.withOptionPriceReview === port
                )
                  trustedFailure.error = error;
                throw error;
              }
            });
          } catch (error) {
            if (trustedFailure.error) throw trustedFailure.error;
            throw error;
          }
        };
        const scope = await createMerchantBrandScope(merchant, permissionPolicy)(
            tx,
            request.sessionCookie,
            session.sessionReference,
          ),
          storeScope = await createMerchantStoreScope(merchant, permissionPolicy)(
            tx,
            request.sessionCookie,
            "merchant.access",
            session.sessionReference,
          ),
          bound = bindMerchantProductCommandScope(
            {
              brandReference: scope.context.brand.brandReference,
              storeReference: scope.selectedStoreReference,
            },
            expected,
          ),
          tenant = parsePublishingReference(scope.tenantReference),
          brand = parsePublishingReference(bound.brandReference),
          store = parsePublishingReference(bound.storeReference),
          actor = parsePublishingReference(scope.actorReference);
        if (
          String(storeScope.selected.tenantReference) !== tenant ||
          String(storeScope.actorReference) !== actor ||
          String(storeScope.context.brand.brandReference) !== brand ||
          String(storeScope.store.storeReference) !== store ||
          storeScope.sessionReference !== session.sessionReference
        )
          return reject();
        const command =
          raw === null
            ? null
            : (() => {
                try {
                  return parsePublishingOptionPriceReviewOperation({
                    ...raw,
                    profile: "PublishingOptionPriceReviewOperationV1",
                    tenantReference: tenant,
                    brandReference: brand,
                    selectedStoreReference: store,
                    actorReference: actor,
                    reasonCode: "AUTHORIZED_OPERATION",
                  });
                } catch {
                  return fail("OPTION_PRICE_INPUT_INVALID");
                }
              })();
        const current = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope,
            sessionCookie: request.sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now: check },
            originalValidUntil: originalUntil,
            permissionPolicy,
            capabilityKey: "pricing.price_book_editor",
          }),
          capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            tenantReference: tenant,
            brandReference: brand,
            storeReference: store,
            actorReference: actor,
            clock: { now: check },
            originalValidUntil: originalUntil,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: current,
            capabilityKey: "pricing.price_book_editor",
          }),
          combined = capability.holdUntilCommitWithDecisions,
          assert = current.assertCurrent,
          authLease = current.leaseDeadline,
          capLease = capability.leaseDeadline;
        if (
          typeof combined !== "function" ||
          typeof authLease !== "function" ||
          typeof capLease !== "function"
        )
          return reject();
        const actions = Object.freeze(
          [
            "pricing.price-book.manage",
            ...(mode === "Execute" && command !== null
              ? [
                  command.action === "SubmitReview"
                    ? "publishing.review.submit"
                    : "publishing.review.approve",
                  ...(command.action === "SubmitReview" && command.expectedLifecycle === null
                    ? ["publishing.draft.create"]
                    : []),
                ]
              : []),
          ].sort(),
        );
        const usedActions = new Set<string>(["pricing.price-book.manage"]);
        const hold = async (
          selected: readonly string[] = Object.freeze([...usedActions].sort()),
        ) => {
          check();
          if (
            capability.holdUntilCommitWithDecisions !== combined ||
            current.assertCurrent !== assert ||
            current.leaseDeadline !== authLease ||
            capability.leaseDeadline !== capLease
          )
            return reject();
          assert.call(current);
          const decisions = await combined.call(capability, Object.freeze([...selected]));
          check();
          if (
            !Array.isArray(decisions) ||
            !Object.isFrozen(decisions) ||
            decisions.length !== selected.length ||
            Reflect.ownKeys(decisions).length !== decisions.length + 1
          )
            return reject();
          for (let i = 0; i < decisions.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(decisions, String(i));
            if (
              !descriptor ||
              !("value" in descriptor) ||
              !descriptor.enumerable ||
              !Object.isFrozen(descriptor.value)
            )
              return reject();
            const d = readClosedRecord(copyCategoryPersistenceValue(descriptor.value), [
                "effect",
                "reason",
                "source",
                "action",
                "scopeKind",
                "policySnapshotReference",
                "policyVersion",
                "audit",
              ]),
              audit = readClosedRecord(d.audit, ["effect", "reason", "source"]);
            if (
              d.action !== selected[i] ||
              d.effect !== "Allow" ||
              d.scopeKind !== "Brand" ||
              !(
                (d.reason === "ROLE_PERMISSION" && d.source === "RolePermission") ||
                (d.reason === "EXPLICIT_ALLOW" && d.source === "ExplicitAllow")
              ) ||
              audit.effect !== d.effect ||
              audit.reason !== d.reason ||
              audit.source !== d.source
            )
              return fail("OPTION_PRICE_PERMISSION_DENIED");
            parsePolicyReference(d.policySnapshotReference);
            parsePolicyVersion(d.policyVersion);
          }
          tighten(authLease.call(current));
          tighten(capLease.call(capability));
          for (const action of selected) usedActions.add(action);
          return decisions;
        };
        await host.registerBeforeCommit(
          tx,
          async () => {
            try {
              if (!ready || guardRunning || guardDone) return reject();
              guardRunning = true;
              await hold();
              guardDone = true;
            } catch (error) {
              return reject(error);
            }
          },
          () => {
            if (!ready || !guardDone || finalDone) return reject();
            assert.call(current);
            check();
            finalDone = true;
            hostDone = true;
          },
        );
        await hold(["pricing.price-book.manage"]);
        if (mode === "Query") {
          if (!contextRequest || queryRule === undefined) return fail("OPTION_PRICE_INPUT_INVALID");
          const rule = parsePublishingReference(queryRule),
            common = {
              transaction: tx,
              tenantReference: tenant,
              brandReference: brand,
              storeReference: store,
              actorReference: actor,
              sessionReference: String(session.sessionReference),
              clock: { now: check },
              originalValidUntil: originalUntil,
              currentAuthorization: current,
              capability,
              registerBeforeCommit: host.registerBeforeCommit,
            };
          const contextSource = createMerchantOptionPriceContextSource({
              ...common,
              brandScope: scope,
              storeScope,
              currencyMetadata: currency,
              events: { generateReference: () => reject() },
            }),
            context = await contextSource.withCurrentContext(
              tx,
              contextRequest,
              async (value) => value,
            );
          finals.push(() => contextSource.assertFinalized(tx));
          tighten(context.validUntil);
          if (
            context.tenantReference !== tenant ||
            context.brandReference !== brand ||
            context.storeReference !== store ||
            context.actorReference !== actor ||
            context.productReference !== contextRequest.productReference ||
            context.productAggregateVersion !== contextRequest.expectedProductAggregateVersion ||
            String(context.binding.bindingReference) !== contextRequest.bindingReference ||
            context.optionReference !== contextRequest.optionReference
          )
            return reject();
          const borrowed = Object.freeze({
              async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
                const at = check(),
                  remaining = Math.floor(Date.parse(deadline) - Date.parse(at));
                if (remaining < 1) return reject();
                await tx.query(
                  "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
                  [String(remaining)],
                );
                check();
                const result = await tx.query<Row>(sql, values);
                check();
                return result;
              },
            }),
            publisher = createPostgresPublishingMutationStore(
              { run: (work) => work(borrowed) },
              tenant,
              createPublishingScope({ kind: "Brand", brandReference: brand, storeReference: null }),
            );
          return withPublishingReview(
            publisher,
            { familyReference: rule, mode: "Read" },
            async (review) => {
              const prices = createPostgresOptionPriceAuthoringStore({
                transaction: tx,
                tenantReference: tenant,
                brandReference: brand,
                selectedStoreReference: store,
                actorReference: actor,
                currencyMetadata: currency,
                originalObservedAt: started,
                originalValidUntil: originalUntil,
                clock: { now: check },
                registerBeforeCommit: host.registerBeforeCommit,
                references: { generate: () => reject() },
                audit: { create: () => reject() },
                authority: {
                  async holdUntilTransactionCompletes(actual, input) {
                    if (
                      actual !== tx ||
                      input.mode !== "Read" ||
                      input.command !== null ||
                      input.permission !== "pricing.price-book.manage" ||
                      input.purposeCode !== "PRICING_OPTION_PRICE_AUTHORING" ||
                      !equal(input.requiredFields, optionPriceAuthoringFields) ||
                      input.tenantReference !== tenant ||
                      input.brandReference !== brand ||
                      input.selectedStoreReference !== store ||
                      input.actorReference !== actor ||
                      input.originalObservedAt !== started ||
                      input.originalValidUntil !== originalUntil
                    )
                      return reject();
                    await hold();
                    return deadline;
                  },
                },
              });
              let sourceGuardDone = false,
                sourceFinalDone = false;
              // Register before the first owning Pricing read registers its
              // final guard. This fresh read must precede owner finalization.
              await host.registerBeforeCommit(
                tx,
                async () => {
                  if (sourceGuardDone) return reject();
                  const currentState = await prices.readCurrent(rule);
                  if (
                    currentState === null ||
                    !equal(stableState, optionPriceWireState(currentState))
                  )
                    return fail("OPTION_PRICE_VERSION_CONFLICT");
                  const currentView = await withPublishingReview(
                    publisher,
                    { familyReference: rule, mode: "Read" },
                    (currentReview) => acquire(currentReview),
                  );
                  if (!equal(view.stable, currentView.stable)) return reject();
                  sourceGuardDone = true;
                },
                () => {
                  if (!sourceGuardDone || sourceFinalDone) return reject();
                  check();
                  sourceFinalDone = true;
                },
              );
              const state = await prices.readCurrent(rule);
              finals.push(prices.assertFinalized.bind(prices));
              if (!state || !state.draft || !state.draftAuthorActorReference)
                return fail("OPTION_PRICE_LIFECYCLE_CONFLICT");
              const draft = state.draft;
              if (
                String(state.brandReference) !== brand ||
                String(state.ruleReference) !== rule ||
                String(state.bindingReference) !== String(context.binding.bindingReference) ||
                String(state.optionReference) !== context.optionReference
              )
                return fail("OPTION_PRICE_VERSION_CONFLICT");
              const acquire = async (activeReview: OptionPriceRuleReviewHeldSource) => {
                await hold();
                const source = await publisher.resolveCurrentOptionPricePublicationPolicy({
                  familyReference: family,
                  observedAt: check(),
                });
                readClosedRecord(copyCategoryPersistenceValue(source), [
                  "content",
                  "current",
                  "observedAt",
                ]);
                readClosedRecord(copyCategoryPersistenceValue(source.current), [
                  "release",
                  "lifecycle",
                  "validationEvidence",
                  "approvalEvidence",
                  "auditReference",
                  "observedAt",
                ]);
                const policy = parsePublishingOptionPricePublicationPolicy(source.content),
                  digest = publishingOptionPricePublicationPolicyDigest(policy);
                if (
                  String(policy.tenantReference) !== tenant ||
                  String(policy.brandReference) !== brand ||
                  String(policy.familyReference) !== family ||
                  String(source.observedAt) < started ||
                  String(source.observedAt) > check() ||
                  source.current.observedAt !== source.observedAt ||
                  String(policy.effectiveFrom) > check() ||
                  (policy.effectiveUntil !== null && String(policy.effectiveUntil) <= check())
                )
                  return reject();
                for (const item of [
                  source.current.release,
                  source.current.lifecycle,
                  source.current.validationEvidence,
                  source.current.approvalEvidence,
                ])
                  if (
                    item.scope.kind !== "Brand" ||
                    String(item.scope.brandReference) !== brand ||
                    item.scope.storeReference !== null ||
                    String(item.snapshotReference) !== String(policy.policyReference) ||
                    String(item.snapshotDigest) !== digest
                  )
                    return reject();
                if (
                  source.current.release.configurationType !== optionPricePolicyConfigurationType ||
                  source.current.release.purposeCode !== optionPricePolicyConfigurationType ||
                  source.current.release.familyReference !== family ||
                  source.current.lifecycle.state !== "Published" ||
                  source.current.release.sourceLifecycleId !== source.current.lifecycle.lifecycleId
                )
                  return reject();
                if (policy.effectiveUntil !== null) tighten(policy.effectiveUntil);
                const history = await activeReview.readForDraft({
                  snapshotReference: draft.versionReference,
                  snapshotDigest: draft.snapshotDigest,
                  observedAt: check(),
                });
                if (
                  String(history.observedAt) < started ||
                  String(history.observedAt) > check() ||
                  String(history.familyReference) !== rule ||
                  String(history.snapshotReference) !== String(draft.versionReference) ||
                  String(history.snapshotDigest) !== String(draft.snapshotDigest)
                )
                  return reject();
                const view: MerchantOptionPriceReviewCurrent["review"] =
                  history.outcome === "Absent"
                    ? Object.freeze({ outcome: "Absent" })
                    : Object.freeze({
                        outcome: "Recorded",
                        lifecycle: Object.freeze({
                          lifecycleReference: String(history.latest.next.lifecycleId),
                          version: history.latest.next.version,
                          state: history.latest.next.state,
                          latestMutationOperationReference: String(history.latest.idempotencyKey),
                        }),
                        validationValidUntil:
                          history.review?.validationEvidence?.validUntil ?? null,
                        approvalValidUntil: history.approval?.approvalEvidence?.validUntil ?? null,
                        submittedActorReference:
                          history.review?.audit.actor.type === "User"
                            ? String(history.review.audit.actor.reference)
                            : null,
                        approvedActorReference:
                          history.approval?.audit.actor.type === "User"
                            ? String(history.approval.audit.actor.reference)
                            : null,
                        sourceAuthority: "RecordedHistory",
                        qualification: "NotEvaluated",
                      });
                return {
                  policy: Object.freeze({
                    familyReference: String(policy.familyReference),
                    policyReference: String(policy.policyReference),
                    policyVersion: policy.policyVersion,
                    approvalPolicy: policy.approvalPolicy,
                    effectiveFrom: String(policy.effectiveFrom),
                    effectiveUntil:
                      policy.effectiveUntil === null ? null : String(policy.effectiveUntil),
                    currentPublicationReference: String(source.current.release.releaseId),
                  }),
                  review: view,
                  stable: {
                    policy: source.content,
                    current: { ...source.current, observedAt: null },
                    history:
                      history.outcome === "Absent"
                        ? { outcome: "Absent" }
                        : {
                            outcome: "Recorded",
                            draft: history.draft,
                            review: history.review,
                            approval: history.approval,
                            latest: history.latest,
                          },
                  },
                };
              };
              const view = await acquire(review),
                stableState = optionPriceWireState(state);
              finals.push(() => {
                if (!sourceGuardDone || !sourceFinalDone) return reject();
                return deadline;
              });
              await hold();
              ready = true;
              return Object.freeze({
                profile: "MerchantOptionPriceReviewCurrentV1" as const,
                tenantReference: tenant,
                brandReference: brand,
                storeReference: store,
                actorReference: actor,
                ruleReference: String(rule),
                aggregateVersion: state.aggregateVersion,
                draftVersionReference: String(draft.versionReference),
                draftSnapshotDigest: String(draft.snapshotDigest),
                draftAuthorActorReference: String(state.draftAuthorActorReference),
                policy: view.policy,
                review: view.review,
                observedAt: check(),
                validUntil: deadline,
              });
            },
          );
        }
        if (command === null) return reject();
        const original = createPostgresOptionPriceReviewOperationStore({
          tenantReference: tenant,
          brandReference: brand,
          selectedStoreReference: store,
          actorReference: actor,
          clock: { now: check },
          originalValidUntil: originalUntil,
          registerBeforeCommit(actual, guard, final) {
            if (actual !== tx) return reject();
            return host.registerBeforeCommit(tx, guard, final);
          },
          audit: {
            create(input) {
              return {
                auditId: generate("Audit"),
                brandId: brand,
                actor: { type: "User", reference: actor },
                actionCode: "PUBLISHING_OPTION_PRICE_REVIEW_ABANDONED",
                targetType: "PublishingOptionPriceReviewOperation",
                targetId: input.command.operationReference,
                reasonCode: "AUTHORIZED_OPERATION",
                correlationId: input.command.operationReference,
                occurredAt: input.observedAt,
                sourceChannel: "API",
                dataClassification: "Confidential",
                retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
                retentionPolicyVersion: 1,
              };
            },
          },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              readClosedRecord(input, [
                "command",
                "mode",
                "permission",
                "requiredPermissions",
                "requiredFields",
                "purposeCode",
                "actorKind",
                "observedAt",
                "validUntil",
              ]);
              if (
                actual !== tx ||
                !equal(input.command, command) ||
                input.permission !== "pricing.price-book.manage" ||
                input.purposeCode !== "PRICING_OPTION_PRICE_REVIEW_OPERATION" ||
                input.actorKind !== "User" ||
                !equal(input.requiredFields, optionPriceReviewOperationFields) ||
                String(input.observedAt) > check() ||
                String(input.observedAt) < started ||
                String(input.validUntil) > originalUntil
              )
                return reject();
              const required = input.mode === "Write" ? actions : ["pricing.price-book.manage"];
              if (!equal(input.requiredPermissions, required)) return reject();
              await hold(required);
              check();
              return Object.freeze({ validUntil: deadline });
            },
          },
        });
        finals.push(() => original.assertFinalized(tx));
        const readOriginal = async () => {
          try {
            return mode === "Resolve"
              ? await original.resolveOperation(tx, command)
              : await original.inspectOriginalOperation(tx, command);
          } catch (error) {
            if (error instanceof OptionPriceReviewOriginalDeniedError)
              return fail("OPTION_PRICE_PERMISSION_DENIED");
            throw error;
          }
        };
        let terminal: Exclude<OptionPriceReviewOriginalOperation, { outcome: "Absent" }>;
        if (mode === "Resolve") {
          const resolved = await readOriginal();
          if (resolved.outcome === "Absent") return reject();
          terminal = resolved;
        } else {
          const inspected = await readOriginal();
          if (inspected.outcome !== "Absent") terminal = inspected;
          else {
            if (!contextRequest) return fail("OPTION_PRICE_INPUT_INVALID");
            const common = {
              transaction: tx,
              tenantReference: tenant,
              brandReference: brand,
              storeReference: store,
              actorReference: actor,
              sessionReference: String(session.sessionReference),
              clock: { now: check },
              originalValidUntil: originalUntil,
              currentAuthorization: current,
              capability,
              registerBeforeCommit: host.registerBeforeCommit,
            };
            await hold(actions);
            const contextSource = createMerchantOptionPriceContextSource({
                ...common,
                publicationReviewWriteFamilyReference: String(command.ruleReference),
                brandScope: scope,
                storeScope,
                currencyMetadata: currency,
                events: { generateReference: () => reject() },
              }),
              context = await contextSource.withCurrentContext(
                tx,
                contextRequest,
                async (value) => value,
              );
            if (
              context.tenantReference !== tenant ||
              context.brandReference !== brand ||
              context.storeReference !== store ||
              context.actorReference !== actor ||
              context.productReference !== contextRequest.productReference ||
              context.productAggregateVersion !== contextRequest.expectedProductAggregateVersion ||
              String(context.binding.bindingReference) !== contextRequest.bindingReference ||
              context.optionReference !== contextRequest.optionReference
            )
              return reject();
            finals.push(() => contextSource.assertFinalized(tx));
            tighten(context.validUntil);
            terminal = await original.withOriginalOperation(tx, command, async (held) => {
              if (held.outcome !== "Absent") return held;
              await hold(actions);
              const publisher = createPostgresPublishingMutationStore(
                {
                  run: (work) =>
                    work(
                      Object.freeze({
                        async query<Row = Record<string, unknown>>(
                          sql: string,
                          values: readonly unknown[],
                        ) {
                          const at = check(),
                            remaining = Math.floor(Date.parse(deadline) - Date.parse(at));
                          if (remaining < 1) return reject();
                          await tx.query(
                            "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
                            [String(remaining)],
                          );
                          check();
                          const result = await tx.query<Row>(sql, values);
                          check();
                          return result;
                        },
                      }),
                    ),
                },
                tenant,
                createPublishingScope({
                  kind: "Brand",
                  brandReference: brand,
                  storeReference: null,
                }),
              );
              return withPublishingReview(
                publisher,
                { familyReference: command.ruleReference, mode: "Write" },
                async (review) => {
                  const prices = createPostgresOptionPriceAuthoringStore({
                    transaction: tx,
                    tenantReference: tenant,
                    brandReference: brand,
                    selectedStoreReference: store,
                    actorReference: actor,
                    currencyMetadata: currency,
                    originalObservedAt: started,
                    originalValidUntil: originalUntil,
                    clock: { now: check },
                    registerBeforeCommit: host.registerBeforeCommit,
                    references: { generate: () => reject() },
                    audit: { create: () => reject() },
                    authority: {
                      async holdUntilTransactionCompletes(actual, input) {
                        if (
                          actual !== tx ||
                          input.mode !== "Read" ||
                          input.command !== null ||
                          input.permission !== "pricing.price-book.manage" ||
                          input.purposeCode !== "PRICING_OPTION_PRICE_AUTHORING" ||
                          !equal(input.requiredFields, optionPriceAuthoringFields) ||
                          input.tenantReference !== tenant ||
                          input.brandReference !== brand ||
                          input.selectedStoreReference !== store ||
                          input.actorReference !== actor ||
                          input.originalObservedAt !== started ||
                          input.originalValidUntil !== originalUntil
                        )
                          return reject();
                        await hold();
                        return deadline;
                      },
                    },
                  });
                  const state = await prices.readCurrent(command.ruleReference);
                  finals.push(prices.assertFinalized.bind(prices));
                  if (
                    !state ||
                    String(state.brandReference) !== brand ||
                    String(state.ruleReference) !== String(command.ruleReference) ||
                    !state.draft ||
                    !state.draftAuthorActorReference ||
                    state.aggregateVersion !== command.expectedAggregateVersion ||
                    String(state.draft.versionReference) !==
                      String(command.draftVersionReference) ||
                    String(state.draft.snapshotDigest) !== String(command.draftSnapshotDigest) ||
                    String(state.bindingReference) !== String(context.binding.bindingReference) ||
                    String(state.optionReference) !== context.optionReference
                  )
                    return fail("OPTION_PRICE_VERSION_CONFLICT");
                  const draft = state.draft;
                  if (
                    !equal(draft.currencyMetadata, currency) ||
                    !equal(context.currencyMetadata, currency) ||
                    (draft.scopeKind === "Brand" && draft.scopeReference !== null) ||
                    (draft.scopeKind === "Store" && String(draft.scopeReference) !== store) ||
                    (draft.scopeKind !== "Brand" && draft.scopeKind !== "Store") ||
                    !context.choices.some(
                      (choice) =>
                        choice.optionReference === String(state.optionReference) &&
                        choice.lifecycle === "Active",
                    ) ||
                    (draft.skuReference !== null &&
                      !context.skus.some(
                        (sku) =>
                          sku.skuReference === String(draft.skuReference) &&
                          sku.lifecycle === "Active",
                      ))
                  )
                    return fail("OPTION_PRICE_LIFECYCLE_CONFLICT");
                  const policySource = await publisher.resolveCurrentOptionPricePublicationPolicy({
                      familyReference: family,
                      observedAt: check(),
                    }),
                    policy = parsePublishingOptionPricePublicationPolicy(policySource.content);
                  readClosedRecord(copyCategoryPersistenceValue(policySource), [
                    "content",
                    "current",
                    "observedAt",
                  ]);
                  readClosedRecord(copyCategoryPersistenceValue(policySource.current), [
                    "release",
                    "lifecycle",
                    "validationEvidence",
                    "approvalEvidence",
                    "auditReference",
                    "observedAt",
                  ]);
                  if (
                    String(policySource.observedAt) < started ||
                    String(policySource.observedAt) > check() ||
                    policySource.current.observedAt !== policySource.observedAt ||
                    policySource.current.release.configurationType !==
                      optionPricePolicyConfigurationType ||
                    policySource.current.release.purposeCode !==
                      optionPricePolicyConfigurationType ||
                    policySource.current.release.familyReference !== family ||
                    policySource.current.lifecycle.state !== "Published" ||
                    policySource.current.release.sourceLifecycleId !==
                      policySource.current.lifecycle.lifecycleId ||
                    String(policy.tenantReference) !== tenant ||
                    String(policy.brandReference) !== brand ||
                    String(policy.familyReference) !== family ||
                    String(policy.effectiveFrom) > check() ||
                    (policy.effectiveUntil !== null && String(policy.effectiveUntil) <= check())
                  )
                    return reject();
                  const policyDigest = publishingOptionPricePublicationPolicyDigest(policy);
                  for (const source of [
                    policySource.current.release,
                    policySource.current.lifecycle,
                    policySource.current.validationEvidence,
                    policySource.current.approvalEvidence,
                  ])
                    if (
                      source.scope.kind !== "Brand" ||
                      String(source.scope.brandReference) !== brand ||
                      source.scope.storeReference !== null ||
                      String(source.snapshotReference) !== String(policy.policyReference) ||
                      String(source.snapshotDigest) !== policyDigest
                    )
                      return reject();
                  if (
                    policySource.current.lifecycle.familyReference !== family ||
                    policySource.current.lifecycle.configurationType !==
                      optionPricePolicyConfigurationType ||
                    policySource.current.lifecycle.purposeCode !==
                      optionPricePolicyConfigurationType ||
                    policySource.current.lifecycle.validationEvidenceReference !==
                      policySource.current.validationEvidence.evidenceReference ||
                    policySource.current.lifecycle.approvalEvidenceReference !==
                      policySource.current.approvalEvidence.evidenceReference
                  )
                    return reject();
                  if (policy.effectiveUntil !== null) tighten(policy.effectiveUntil);
                  const stablePolicy = {
                    content: policySource.content,
                    current: { ...policySource.current, observedAt: null },
                  };
                  let policyGuardDone = false,
                    policyFinalDone = false;
                  await host.registerBeforeCommit(
                    tx,
                    async () => {
                      if (policyGuardDone) return reject();
                      await hold();
                      const currentPolicy =
                        await publisher.resolveCurrentOptionPricePublicationPolicy({
                          familyReference: family,
                          observedAt: check(),
                        });
                      if (
                        !equal(stablePolicy, {
                          content: currentPolicy.content,
                          current: { ...currentPolicy.current, observedAt: null },
                        })
                      )
                        return reject();
                      if (currentPolicy.content.effectiveUntil !== null)
                        tighten(currentPolicy.content.effectiveUntil);
                      policyGuardDone = true;
                    },
                    () => {
                      if (!policyGuardDone || policyFinalDone) return reject();
                      check();
                      policyFinalDone = true;
                    },
                  );
                  finals.push(() => {
                    if (!policyGuardDone || !policyFinalDone) return reject();
                    return deadline;
                  });
                  if (
                    String(command.validationValidUntil) <= check() ||
                    (policy.effectiveUntil !== null &&
                      String(command.validationValidUntil) > String(policy.effectiveUntil)) ||
                    (command.approvalValidUntil !== null &&
                      (String(command.approvalValidUntil) <= check() ||
                        String(command.approvalValidUntil) > String(command.validationValidUntil)))
                  )
                    return fail("OPTION_PRICE_APPROVAL_REQUIRED");
                  tighten(command.validationValidUntil);
                  if (command.approvalValidUntil !== null) tighten(command.approvalValidUntil);
                  const history = await review.readForDraft({
                      snapshotReference: command.draftVersionReference,
                      snapshotDigest: command.draftSnapshotDigest,
                      observedAt: check(),
                    }),
                    ownerScope = createPublishingScope({
                      kind: "Brand",
                      brandReference: brand,
                      storeReference: null,
                    });
                  let lifecycle: ReturnType<typeof createPublishingLifecycleRecord>;
                  if (command.expectedLifecycle === null) {
                    if (command.action !== "SubmitReview" || history.outcome !== "Absent")
                      return fail("OPTION_PRICE_VERSION_CONFLICT");
                    const time = parsePublishingInstant(check());
                    lifecycle = createPublishingLifecycleRecord({
                      lifecycleId: generate("PublishingLifecycle"),
                      familyReference: command.ruleReference,
                      configurationType: parsePublishingCode(optionPriceRuleConfigurationType),
                      purposeCode: parsePublishingCode(optionPriceRulePublicationPurpose),
                      snapshotReference: command.draftVersionReference,
                      snapshotDigest: command.draftSnapshotDigest,
                      scope: ownerScope,
                      version: parsePublishingVersion(1),
                      state: "Draft",
                      validationEvidenceReference: null,
                      approvalEvidenceReference: null,
                      createdAt: time,
                      changedAt: time,
                    });
                  } else {
                    if (
                      history.outcome !== "Recorded" ||
                      history.latest.next.lifecycleId !==
                        command.expectedLifecycle.lifecycleReference ||
                      history.latest.next.version !== command.expectedLifecycle.version ||
                      history.latest.next.state !== command.expectedLifecycle.state ||
                      history.latest.idempotencyKey !==
                        command.expectedLifecycle.latestMutationOperationReference
                    )
                      return fail("OPTION_PRICE_VERSION_CONFLICT");
                    lifecycle = history.latest.next;
                  }
                  const committed: { value?: ReturnType<typeof parseRecordedPublishingMutation> } =
                    {};
                  const service = async (
                    input: ExecutePublishingMutationInput,
                    createDraft = false,
                  ) =>
                    executePublishingMutation(input, {
                      authorization: {
                        async authorize(value) {
                          readClosedRecord(value, [
                            "tenantContext",
                            "action",
                            "resourceScope",
                            "familyReference",
                            "purposeCode",
                            "expectedVersion",
                          ]);
                          if (
                            !equal(value.tenantContext, input.tenantContext) ||
                            !equal(value.resourceScope, {
                              kind: "Brand",
                              brandReference: brand,
                              storeReference: null,
                            }) ||
                            value.familyReference !== command.ruleReference ||
                            value.purposeCode !== optionPriceRulePublicationPurpose ||
                            value.expectedVersion !== input.expectedVersion
                          )
                            return reject();
                          const expectedAction =
                            input.operation === "CreateDraft"
                              ? "publishing.draft.create"
                              : input.operation === "SubmitReview"
                                ? "publishing.review.submit"
                                : "publishing.review.approve";
                          if (value.action !== expectedAction) return reject();
                          const decisions = await hold(actions);
                          const d = decisions.find(
                            (decision) => decision.action === expectedAction,
                          );
                          if (!d) return reject();
                          return d;
                        },
                      },
                      unitOfWork: {
                        async commit(input) {
                          const parsed = parseRecordedPublishingMutation(input);
                          const receipt = createDraft
                            ? await held.createDraft(parsed)
                            : await held.commit(parsed);
                          if (receipt.auditReference !== parsed.audit.auditId) return reject();
                          if (!createDraft) committed.value = parsed;
                          return receipt;
                        },
                      },
                    });
                  const mutation = (
                    operation: "CreateDraft" | "SubmitReview" | "Approve",
                    currentLifecycle: typeof lifecycle | null,
                    next: typeof lifecycle,
                    operationReference: string,
                  ) => ({
                    tenantContext: createTenantContext(
                      scope.context.actor,
                      scope.context.brand,
                      null,
                      check(),
                    ),
                    operation,
                    current: currentLifecycle,
                    next,
                    expectedVersion: currentLifecycle?.version ?? next.version,
                    idempotencyKey: parsePublishingReference(operationReference),
                    auditId: generate("Audit"),
                    correlationId: command.operationReference,
                    occurredAt: check(),
                    sourceChannel: parsePublishingCode("API"),
                  });
                  if (command.action === "SubmitReview") {
                    const states = await prices.listForBinding({
                        bindingReference: state.bindingReference,
                        optionReference: state.optionReference,
                      }),
                      candidate = materializeOptionPriceVersion({
                        command: parseOptionPriceAuthoringCommand({
                          action: "Publish",
                          operationReference: command.operationReference,
                          ruleReference: command.ruleReference,
                          expectedAggregateVersion: state.aggregateVersion,
                          bindingReference: null,
                          optionReference: null,
                          content: null,
                        }),
                        current: state,
                        brandReference: brand,
                        versionReference: generate("OptionPriceVersion"),
                        occurredAt: check(),
                        currencyMetadata: currency,
                      });
                    assertOptionPricePublicationUnambiguous(
                      candidate,
                      states.flatMap((value) =>
                        value.currentPublished ? [value.currentPublished] : [],
                      ),
                    );
                    if (command.expectedLifecycle === null)
                      await service(
                        mutation("CreateDraft", null, lifecycle, generate("PublishingOperation")),
                        true,
                      );
                    const evidence = createPublishingValidationEvidence({
                        evidenceReference: generate("PublishingEvidence"),
                        snapshotReference: lifecycle.snapshotReference,
                        snapshotDigest: lifecycle.snapshotDigest,
                        scope: ownerScope,
                        result: "Pass",
                        checkedAt: parsePublishingInstant(check()),
                        validUntil: command.validationValidUntil,
                        checkCodes: optionPricePublicationReviewCheckCodes.map(parsePublishingCode),
                      }),
                      next = createPublishingLifecycleRecord({
                        ...lifecycle,
                        version: parsePublishingVersion(lifecycle.version + 1),
                        state: "InReview",
                        validationEvidenceReference: evidence.evidenceReference,
                        changedAt: parsePublishingInstant(check()),
                      });
                    await service({
                      ...mutation("SubmitReview", lifecycle, next, command.operationReference),
                      validationEvidence: evidence,
                    });
                  } else {
                    if (
                      history.outcome !== "Recorded" ||
                      !history.review?.validationEvidence ||
                      history.review.validationEvidence.validUntil !==
                        command.validationValidUntil ||
                      String(history.review.validationEvidence.validUntil) <= check() ||
                      history.review.audit.actor.type !== "User" ||
                      String(history.review.audit.actor.reference) === actor ||
                      String(state.draftAuthorActorReference) === actor ||
                      command.approvalValidUntil === null ||
                      !equal(
                        [...history.review.validationEvidence.checkCodes].sort(),
                        [...optionPricePublicationReviewCheckCodes].sort(),
                      )
                    )
                      return fail("OPTION_PRICE_APPROVAL_REQUIRED");
                    const approval = createPublishingApprovalEvidence({
                        evidenceReference: generate("PublishingEvidence"),
                        reviewLifecycleId: lifecycle.lifecycleId,
                        reviewVersion: lifecycle.version,
                        snapshotReference: lifecycle.snapshotReference,
                        snapshotDigest: lifecycle.snapshotDigest,
                        scope: ownerScope,
                        decision: "Accepted",
                        approvedActorReference: actor,
                        approvedAt: parsePublishingInstant(check()),
                        validUntil: command.approvalValidUntil,
                      }),
                      next = createPublishingLifecycleRecord({
                        ...lifecycle,
                        version: parsePublishingVersion(lifecycle.version + 1),
                        state: "Approved",
                        approvalEvidenceReference: approval.evidenceReference,
                        changedAt: parsePublishingInstant(check()),
                      });
                    await service({
                      ...mutation("Approve", lifecycle, next, command.operationReference),
                      approvalEvidence: approval,
                    });
                  }
                  if (!committed.value) return reject();
                  return Object.freeze({
                    outcome: "Committed" as const,
                    command,
                    originalOccurredAt: parsePublishingInstant(committed.value.audit.occurredAt),
                    auditReference: parsePublishingReference(committed.value.audit.auditId),
                    mutation: committed.value,
                  });
                },
              );
            });
          }
        }
        if (!equal(terminal.command, command)) return reject();
        await hold(["pricing.price-book.manage"]);
        ready = true;
        return Object.freeze({
          profile: "MerchantOptionPriceReviewResultV1" as const,
          action: command.action,
          operationReference: String(command.operationReference),
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          actorReference: actor,
          outcome: terminal.outcome,
          occurredAt:
            terminal.outcome === "Committed" ? terminal.originalOccurredAt : terminal.recordedAt,
          observedAt: check(),
          validUntil: deadline,
        });
      });
      if (!hostDone || failed) return reject();
      for (const final of finals) tighten(final());
      now();
      return Object.freeze({ ...result, validUntil: deadline });
    } catch (error) {
      return bounded(error);
    }
  }
  return Object.freeze({
    async execute(
      request: MerchantOptionPriceReviewExecuteRequest,
    ): Promise<MerchantOptionPriceReviewResult> {
      const result = await perform("Execute", request, request.context);
      if (result.profile !== "MerchantOptionPriceReviewResultV1") return fail();
      return result;
    },
    async resolve(
      request: MerchantOptionPriceReviewRequest,
    ): Promise<MerchantOptionPriceReviewResult> {
      const result = await perform("Resolve", request);
      if (result.profile !== "MerchantOptionPriceReviewResultV1") return fail();
      return result;
    },
    async query(
      request: MerchantOptionPriceReviewQueryRequest,
    ): Promise<MerchantOptionPriceReviewCurrent> {
      const result = await perform(
        "Query",
        {
          sessionCookie: request.sessionCookie,
          csrf: request.csrf,
          expectedScope: request.expectedScope,
          command: undefined,
        },
        request.context,
        request.ruleReference,
      );
      if (result.profile !== "MerchantOptionPriceReviewCurrentV1") return fail();
      return result;
    },
  });
}
