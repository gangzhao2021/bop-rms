import { canonicalizeRfc8785 } from "@bop/audit";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  parsePublishingReference,
  type PublishingLifecycleRecord,
} from "@bop/publishing";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresCurrentFullOptionSetDraftStore,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetEditorContent,
  currentFullOptionSetDraftReviewFields,
  createPostgresOptionSetReviewContentStore,
  optionSetReviewRecordFields,
  parseCatalogOptionSetReviewRecord,
  type CatalogOptionSetReviewRecord,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type View = Awaited<
  ReturnType<
    ReturnType<typeof createPostgresCurrentFullOptionSetDraftStore>["readCurrentForReview"]
  >
>;
export type MerchantOptionSetPublicationContextAction =
  "Inspect" | "Validate" | "SubmitReview" | "Approve" | "Publish";
export interface MerchantOptionSetPublicationContextQueryOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
}
export interface MerchantOptionSetPublicationContext {
  readonly profile: "CatalogOptionSetPublicationContextV1";
  readonly action: MerchantOptionSetPublicationContextAction;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly draft: Readonly<{
    optionSetReference: string;
    versionReference: string;
    aggregateVersion: number;
    sourceOperationReference: string;
    sourceSnapshotTuple: View["sourceSnapshotTuple"];
    sourceDigest: string;
    contentDigest: string;
    configurationDigest: string;
  }>;
  readonly review:
    | Readonly<{ kind: "AbsentForCurrentDraft" }>
    | Readonly<{
        kind: "Recorded";
        operationReference: string;
        lifecycleReference: string;
        submittedActorReference: string;
        recordedAt: string;
        recordDigest: string;
        latestMutationOperationReference: string;
        publishingReviewOperationReference: string;
        binding: CatalogOptionSetReviewRecord["binding"];
        lifecycle: PublishingLifecycleRecord;
      }>;
}
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
/** Actual current Draft/Review/lifecycle observation only. Action admission is not future Command authority. */
export function createMerchantOptionSetPublicationContextQuery(
  options: MerchantOptionSetPublicationContextQueryOptions,
) {
  if (
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.authentication?.authorize !== "function"
  )
    return fail();
  const clock = options.merchant.now.bind(options.merchant),
    run = options.merchant.transactions.run.bind(options.merchant.transactions),
    authenticate = options.authentication.authorize.bind(options.authentication),
    merchant = Object.freeze({
      ...options.merchant,
      now: clock,
      transactions: { run },
      ...(options.merchant.validateAssociation
        ? { validateAssociation: options.merchant.validateAssociation.bind(options.merchant) }
        : {}),
      ...(options.merchant.currentActor
        ? { currentActor: options.merchant.currentActor.bind(options.merchant) }
        : {}),
    }),
    resolve = createMerchantBrandScope(merchant),
    host = createMerchantCategoryTransactions({ run });
  return async (request: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly command: unknown;
    readonly expectedScope: unknown;
  }): Promise<MerchantOptionSetPublicationContext> => {
    const expected = parseMerchantProductCommandScope(request.expectedScope),
      sessionCookie = request.sessionCookie,
      csrf = request.csrf;
    let action: MerchantOptionSetPublicationContextAction;
    let command: Readonly<{ optionSetReference: string; expectedAggregateVersion: number | null }>;
    try {
      const raw = readClosedRecord(copyCategoryPersistenceValue(request.command), [
        "optionSetReference",
        "expectedAggregateVersion",
        "action",
      ]);
      if (
        raw.action !== "Inspect" &&
        raw.action !== "Validate" &&
        raw.action !== "SubmitReview" &&
        raw.action !== "Approve" &&
        raw.action !== "Publish"
      )
        return fail("CATALOG_INPUT_INVALID");
      action = raw.action;
      if (
        raw.expectedAggregateVersion !== null &&
        (!Number.isSafeInteger(raw.expectedAggregateVersion) ||
          (raw.expectedAggregateVersion as number) < 1 ||
          (raw.expectedAggregateVersion as number) > 2147483647)
      )
        return fail("CATALOG_INPUT_INVALID");
      command = Object.freeze({
        optionSetReference: parseCatalogReference(raw.optionSetReference),
        expectedAggregateVersion: raw.expectedAggregateVersion as number | null,
      });
    } catch {
      return fail("CATALOG_INPUT_INVALID");
    }
    let latest = parseCatalogInstant(clock()),
      failed = false;
    const startedAt = latest,
      originalDeadline = new Date(Date.parse(latest) + 5000).toISOString();
    let deadline = originalDeadline;
    const reject = (): never => {
      failed = true;
      return fail();
    };
    const now = () => {
      try {
        const at = parseCatalogInstant(clock());
        if (failed || at < latest || at >= deadline) return reject();
        latest = at;
        return at;
      } catch {
        return reject();
      }
    };
    const session = await authenticate({ sessionCookie, csrf }).catch((error: unknown) =>
      fail(
        error instanceof BrowserSessionError
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
      ),
    );
    now();
    let calls = 0,
      finalized = false,
      completed: MerchantOptionSetPublicationContext | undefined,
      assertSources: (() => void) | undefined;
    const result = await host.transactions.run(async (tx) => {
      if (++calls !== 1) return reject();
      const query = tx.query;
      let ready = false,
        guardCalls = 0,
        guardComplete = false,
        finalCalls = 0,
        rehold: (() => Promise<void>) | undefined;
      const check = () => {
        now();
        if (tx.query !== query) return reject();
        assertSources?.();
      };
      await host.registerBeforeCommit(
        tx,
        async () => {
          if (!ready || !rehold || ++guardCalls !== 1) return reject();
          await rehold();
          check();
          guardComplete = true;
        },
        () => {
          if (!ready || !guardComplete || guardCalls !== 1 || ++finalCalls !== 1) return reject();
          check();
          finalized = true;
        },
      );
      try {
        const scope = await resolve(tx, sessionCookie, session.sessionReference);
        check();
        const bound = bindMerchantProductCommandScope(
            {
              brandReference: scope.context.brand.brandReference,
              storeReference: scope.selectedStoreReference,
            },
            expected,
          ),
          tenantReference = parseCatalogReference(scope.tenantReference),
          actorReference = parseCatalogReference(scope.actorReference),
          capabilityKey =
            action === "Inspect" ? "catalog.cat_optionset_detail" : "catalog.cat_optionset_edit",
          current = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope,
            sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now },
            originalValidUntil: originalDeadline,
            capabilityKey,
          }),
          capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            tenantReference,
            brandReference: bound.brandReference,
            storeReference: bound.storeReference,
            actorReference,
            clock: { now },
            originalValidUntil: originalDeadline,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: current,
            capabilityKey,
          });
        if (
          typeof current.leaseDeadline !== "function" ||
          typeof capability.leaseDeadline !== "function" ||
          typeof current.authorizeActionsWithDecisions !== "function"
        )
          return reject();
        const assert = current.assertCurrent.bind(current),
          currentLease = current.leaseDeadline.bind(current),
          capabilityLease = capability.leaseDeadline.bind(capability),
          authorize = current.authorizeActionsWithDecisions.bind(current),
          hold = capability.holdUntilCommit.bind(capability);
        const originalAssert = current.assertCurrent,
          originalAuthorize = current.authorizeActionsWithDecisions,
          originalCurrentLease = current.leaseDeadline,
          originalHold = capability.holdUntilCommit,
          originalCapabilityLease = capability.leaseDeadline;
        let admitted = false;
        assertSources = () => {
          if (
            current.assertCurrent !== originalAssert ||
            current.authorizeActionsWithDecisions !== originalAuthorize ||
            current.leaseDeadline !== originalCurrentLease ||
            capability.holdUntilCommit !== originalHold ||
            capability.leaseDeadline !== originalCapabilityLease
          )
            return reject();
          parseCatalogInstant(assert());
          if (admitted) {
            const a = parseCatalogInstant(currentLease()),
              b = parseCatalogInstant(capabilityLease());
            if (a < deadline) deadline = a;
            if (b < deadline) deadline = b;
            now();
          }
        };
        const actions = ["catalog.manage", "catalog.option_set.read"];
        if (action === "SubmitReview")
          actions.push("catalog.option_set.submit", "publishing.review.submit");
        if (action === "Approve") actions.push("publishing.review.approve");
        if (action === "Publish")
          actions.push("catalog.option_set.publish", "publishing.release.publish");
        Object.freeze(actions);
        let busy = false;
        const admit = async () => {
          if (busy) return reject();
          busy = true;
          try {
            check();
            if ((await hold()) !== undefined) return reject();
            admitted = true;
            check();
            const decisions = await authorize(actions);
            check();
            if (!Array.isArray(decisions) || decisions.length !== actions.length) return reject();
            for (let i = 0; i < actions.length; i++) {
              const d = readClosedRecord(decisions[i], [
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
              if (d.effect !== "Allow" || d.scopeKind !== "Brand" || d.action !== actions[i])
                return fail("CATALOG_PERMISSION_DENIED");
              if (
                (d.reason !== "EXPLICIT_ALLOW" && d.reason !== "ROLE_PERMISSION") ||
                (d.source !== "ExplicitAllow" && d.source !== "RolePermission") ||
                (d.reason === "EXPLICIT_ALLOW") !== (d.source === "ExplicitAllow") ||
                audit.effect !== d.effect ||
                audit.reason !== d.reason ||
                audit.source !== d.source
              )
                return reject();
              parseBusinessAction(d.action);
              parsePolicyReference(d.policySnapshotReference);
              parsePolicyVersion(d.policyVersion);
            }
            check();
          } finally {
            busy = false;
          }
        };
        const identity = {
          tenantReference,
          brandReference: bound.brandReference,
          actorReference,
          actorKind: "User",
          permission: "catalog.manage",
          action: "catalog.option_set.read",
        };
        const authorizeRead = async (originalTx: typeof tx, value: unknown, review: boolean) => {
          check();
          if (originalTx !== tx) return reject();
          const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
            ...Object.keys(identity),
            "purposeCode",
            "requiredFields",
            "optionSetReference",
            "observedAt",
            ...(review ? ["phase", "record"] : ["content"]),
          ]);
          for (const [key, expectedValue] of Object.entries(identity))
            if (raw[key] !== expectedValue) return reject();
          const observedAt = parseCatalogInstant(raw.observedAt);
          if (
            raw.optionSetReference !== command.optionSetReference ||
            observedAt < startedAt ||
            observedAt > now() ||
            raw.purposeCode !==
              (review ? "CATALOG_OPTION_SET_REVIEW_RECORD" : "CATALOG_OPTION_SET_DRAFT") ||
            !equal(
              raw.requiredFields,
              review ? optionSetReviewRecordFields : currentFullOptionSetDraftReviewFields,
            )
          )
            return reject();
          if (review) {
            if (raw.phase !== "Read") return reject();
            if (raw.record !== null) {
              const record = parseCatalogOptionSetReviewRecord(raw.record);
              if (
                record.binding.tenantReference !== tenantReference ||
                record.binding.brandReference !== bound.brandReference ||
                record.binding.optionSetReference !== command.optionSetReference
              )
                return reject();
            }
          } else if (raw.content !== null) {
            const content = readClosedRecord(raw.content, [
                "profile",
                "sourceAggregate",
                "optionDetails",
                "conditionalRules",
                "conflictRules",
                "scopeSet",
                "effectivePeriod",
              ]),
              { sourceAggregate, ...additional } = content,
              parsed = parseCatalogOptionSetEditorContent(sourceAggregate, additional),
              root = parsed.content.sourceAggregate;
            if (
              root.optionSetReference !== command.optionSetReference ||
              root.brandReference !== bound.brandReference ||
              root.lifecycle !== "Draft" ||
              (command.expectedAggregateVersion !== null &&
                root.aggregateVersion !== command.expectedAggregateVersion)
            )
              return reject();
          }
          await admit();
          check();
          return Object.freeze({ observedAt, validUntil: deadline });
        };
        let draftRuns = 0,
          publishingRuns = 0;
        const draftAuthority = {
            holdUntilTransactionCompletes: (t: typeof tx, value: unknown) =>
              authorizeRead(t, value, false),
          },
          draftStore = createPostgresCurrentFullOptionSetDraftStore({
            tenantReference,
            brandReference: bound.brandReference,
            actorReference,
            clock: { now },
            authority: draftAuthority,
            transactions: {
              async run(work) {
                if (++draftRuns !== 1) return reject();
                check();
                const value = await work(tx);
                check();
                return value;
              },
            },
          }),
          reviewStore = createPostgresOptionSetReviewContentStore({
            tenantReference,
            brandReference: bound.brandReference,
            actorReference,
            clock: { now },
            currentDraftAuthority: draftAuthority,
            authority: {
              holdUntilTransactionCompletes: (t, value) => authorizeRead(t, value, true),
            },
            registerBeforeCommit: host.registerBeforeCommit,
            events: { generateReference: () => reject() },
          }),
          publisher = createPostgresPublishingMutationStore(
            {
              async run(work) {
                if (++publishingRuns !== 1) return reject();
                check();
                const value = await work(tx);
                check();
                return value;
              },
            },
            tenantReference,
            createPublishingScope({
              kind: "Brand",
              brandReference: bound.brandReference,
              storeReference: null,
            }),
          );
        const readCurrent = draftStore.readCurrentForReview.bind(draftStore),
          discover = reviewStore.readCurrentReviewForDraft.bind(reviewStore),
          resolveLifecycle = publisher.resolveCurrentLifecycleMutation.bind(publisher),
          originalReviewPort = publisher.resolveRecordedOptionSetReviewForLifecycle,
          resolveOriginalReview = originalReviewPort.bind(publisher);
        let reading = false;
        const read = async () => {
          if (reading) return reject();
          reading = true;
          draftRuns = 0;
          publishingRuns = 0;
          try {
            await admit();
            const view = await readCurrent(command);
            check();
            const raw = readClosedRecord(copyCategoryPersistenceValue(view), [
                "content",
                "sourceDigest",
                "contentDigest",
                "configurationDigest",
                "observedAt",
                "validUntil",
                "referenceEligibility",
                "sourceOperationReference",
                "sourceSnapshotTuple",
              ]),
              content = readClosedRecord(raw.content, [
                "profile",
                "sourceAggregate",
                "optionDetails",
                "conditionalRules",
                "conflictRules",
                "scopeSet",
                "effectivePeriod",
              ]),
              { sourceAggregate, ...additional } = content,
              parsed = parseCatalogOptionSetEditorContent(sourceAggregate, additional),
              root = parsed.content.sourceAggregate,
              sourceOperationReference = parseCatalogReference(raw.sourceOperationReference),
              sourceSnapshotTuple = readClosedRecord(raw.sourceSnapshotTuple, [
                "tenantReference",
                "brandReference",
                "optionSetReference",
                "versionReference",
                "aggregateVersion",
                "sourceDigest",
                "contentDigest",
                "configurationDigest",
              ]),
              observedAt = parseCatalogInstant(raw.observedAt),
              validUntil = parseCatalogInstant(raw.validUntil);
            const tuple = Object.freeze({
              tenantReference,
              brandReference: parseCatalogReference(bound.brandReference),
              optionSetReference: parseCatalogReference(command.optionSetReference),
              versionReference: root.draft.versionReference,
              aggregateVersion: root.aggregateVersion,
              sourceDigest: parsed.sourceDigest,
              contentDigest: parsed.contentDigest,
              configurationDigest: parsed.configurationDigest,
            });
            if (
              root.brandReference !== bound.brandReference ||
              root.optionSetReference !== command.optionSetReference ||
              root.lifecycle !== "Draft" ||
              (command.expectedAggregateVersion !== null &&
                root.aggregateVersion !== command.expectedAggregateVersion) ||
              !equal(tuple, sourceSnapshotTuple) ||
              raw.sourceDigest !== parsed.sourceDigest ||
              raw.contentDigest !== parsed.contentDigest ||
              raw.configurationDigest !== parsed.configurationDigest ||
              raw.referenceEligibility !== "NotEvaluated" ||
              observedAt < startedAt ||
              observedAt > now() ||
              validUntil <= observedAt ||
              validUntil > deadline ||
              root.updatedAt > observedAt
            )
              return reject();
            if (validUntil < deadline) deadline = validUntil;
            const selected = await discover(tx, command);
            check();
            let review: MerchantOptionSetPublicationContext["review"] = Object.freeze({
              kind: "AbsentForCurrentDraft",
            });
            if (selected !== null) {
              const record = parseCatalogOptionSetReviewRecord(selected),
                binding = record.binding;
              if (
                binding.tenantReference !== tenantReference ||
                binding.brandReference !== bound.brandReference ||
                binding.optionSetReference !== command.optionSetReference ||
                binding.versionReference !== root.draft.versionReference ||
                binding.expectedAggregateVersion !== root.aggregateVersion ||
                binding.sourceDigest !== parsed.sourceDigest ||
                binding.contentDigest !== parsed.contentDigest ||
                binding.configurationDigest !== parsed.configurationDigest ||
                record.sourceOperationReference !== sourceOperationReference ||
                !equal(record.content, parsed.content) ||
                record.recordedAt > now()
              )
                return reject();
              const mutation = await resolveLifecycle({
                familyReference: command.optionSetReference,
                lifecycleReference: record.lifecycleReference,
                configurationType: "CATALOG_OPTION_SET",
                purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
                observedAt: now(),
              });
              check();
              if (!mutation) return reject();
              const lifecycle = createPublishingLifecycleRecord(mutation.next),
                latestMutationOperationReference = parsePublishingReference(
                  mutation.idempotencyKey,
                );
              if (
                String(lifecycle.lifecycleId) !== String(record.lifecycleReference) ||
                lifecycle.familyReference !== command.optionSetReference ||
                lifecycle.configurationType !== "CATALOG_OPTION_SET" ||
                lifecycle.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
                String(lifecycle.snapshotReference) !== String(root.draft.versionReference) ||
                lifecycle.snapshotDigest !== binding.digest ||
                lifecycle.scope.kind !== "Brand" ||
                lifecycle.scope.brandReference !== bound.brandReference ||
                lifecycle.scope.storeReference !== null ||
                lifecycle.state === "Draft" ||
                parseCatalogInstant(lifecycle.changedAt) > now()
              )
                return reject();
              publishingRuns = 0;
              const originalReview = await resolveOriginalReview({
                familyReference: command.optionSetReference,
                lifecycleReference: record.lifecycleReference,
                observedAt: now(),
              });
              check();
              if (
                !originalReview ||
                publisher.resolveRecordedOptionSetReviewForLifecycle !== originalReviewPort
              )
                return reject();
              const originalLifecycle = createPublishingLifecycleRecord(
                  originalReview.reviewLifecycle,
                ),
                originalValidation = createPublishingValidationEvidence(
                  originalReview.originalValidationEvidence,
                ),
                publishingReviewOperationReference = parsePublishingReference(
                  originalReview.reviewOperationReference,
                ),
                submittedAt = parseCatalogInstant(originalReview.submittedAt);
              if (
                !equal(originalReview.latestLifecycle, lifecycle) ||
                originalReview.latestMutationOperationReference !==
                  latestMutationOperationReference ||
                String(originalReview.submittedActorReference) !== String(record.actorReference) ||
                submittedAt > record.recordedAt ||
                String(originalLifecycle.lifecycleId) !== String(record.lifecycleReference) ||
                originalLifecycle.state !== "InReview" ||
                originalLifecycle.snapshotDigest !== binding.digest ||
                String(originalLifecycle.snapshotReference) !== String(binding.versionReference) ||
                originalLifecycle.familyReference !== command.optionSetReference ||
                originalLifecycle.configurationType !== "CATALOG_OPTION_SET" ||
                originalLifecycle.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
                !equal(originalLifecycle.scope, lifecycle.scope) ||
                originalValidation.evidenceReference !==
                  originalLifecycle.validationEvidenceReference ||
                originalValidation.snapshotDigest !== binding.digest ||
                originalValidation.snapshotReference !== originalLifecycle.snapshotReference ||
                !equal(originalValidation.scope, originalLifecycle.scope) ||
                parseCatalogInstant(originalValidation.checkedAt) > submittedAt ||
                parseCatalogInstant(originalValidation.validUntil) <= submittedAt
              )
                return reject();
              review = Object.freeze({
                kind: "Recorded",
                operationReference: record.operationReference,
                lifecycleReference: record.lifecycleReference,
                submittedActorReference: record.actorReference,
                recordedAt: record.recordedAt,
                recordDigest: record.digest,
                latestMutationOperationReference,
                publishingReviewOperationReference,
                binding,
                lifecycle,
              });
            }
            return Object.freeze({
              draft: Object.freeze({
                optionSetReference: command.optionSetReference,
                versionReference: root.draft.versionReference,
                aggregateVersion: root.aggregateVersion,
                sourceOperationReference,
                sourceSnapshotTuple: tuple,
                sourceDigest: parsed.sourceDigest,
                contentDigest: parsed.contentDigest,
                configurationDigest: parsed.configurationDigest,
              }),
              review,
            });
          } finally {
            reading = false;
          }
        };
        const snapshot = await read();
        rehold = async () => {
          const retained = await read();
          if (!equal(retained, snapshot)) return reject();
        };
        ready = true;
        check();
        completed = Object.freeze({
          profile: "CatalogOptionSetPublicationContextV1",
          action,
          tenantReference,
          brandReference: bound.brandReference,
          storeReference: bound.storeReference,
          actorReference,
          observedAt: startedAt,
          validUntil: deadline,
          ...snapshot,
        });
        return completed;
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID") return fail();
        throw error;
      }
    });
    if (calls !== 1 || !finalized || !completed || result !== completed) return reject();
    now();
    if (!assertSources) return reject();
    assertSources();
    now();
    return Object.freeze({ ...result, validUntil: deadline });
  };
}
