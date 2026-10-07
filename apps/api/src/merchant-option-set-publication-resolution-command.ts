import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
} from "@rms/catalog";
import {
  createPostgresOptionSetPublicationOperationStore,
  parsePublishingOptionSetPublicationOperation,
  parseRecordedPublishingMutation,
  parsePublishingReference,
  parsePublishingDigest,
  parsePublishingVersion,
  optionSetPublicationOperationFields,
  type OptionSetPublicationOriginalOperation,
} from "@bop/publishing";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
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

const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
export interface MerchantOptionSetPublicationResolutionOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly auditReference: (operationReference: string) => string;
  readonly optionSetPolicyFamilyReference: string;
}
export interface MerchantOptionSetPublicationResolutionResult {
  readonly profile: "CatalogOptionSetPublicationResolutionResultV1";
  readonly storeReference: string;
  readonly resolution: Exclude<OptionSetPublicationOriginalOperation, { outcome: "Absent" }>;
}
/** Actual current Session/Brand/Store admission. No original content requalification
 * and no new execution. The Publishing owner resolves or permanently fences absence. */
export function createMerchantOptionSetPublicationResolutionCommand(
  options: MerchantOptionSetPublicationResolutionOptions,
) {
  if (
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.authentication?.authorize !== "function" ||
    typeof options.auditReference !== "function"
  )
    return fail();
  const family = parsePublishingReference(options.optionSetPolicyFamilyReference);
  const clock = options.merchant.now.bind(options.merchant),
    run = options.merchant.transactions.run.bind(options.merchant.transactions),
    authenticate = options.authentication.authorize.bind(options.authentication),
    auditReference = options.auditReference.bind(options),
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
  }): Promise<MerchantOptionSetPublicationResolutionResult> => {
    const expected = parseMerchantProductCommandScope(request.expectedScope),
      sessionCookie = request.sessionCookie,
      csrf = request.csrf;
    let raw: Record<string, unknown>;
    try {
      raw = readClosedRecord(copyCategoryPersistenceValue(request.command), [
        "profile",
        "action",
        "operationReference",
        "optionSetReference",
        "versionReference",
        "expectedAggregateVersion",
        "sourceDigest",
        "contentDigest",
        "configurationDigest",
        "expectedReview",
        "expectedLifecycle",
      ]);
      if (
        raw.profile !== "CatalogOptionSetPublicationResolutionRequestV1" ||
        !["SubmitReview", "Approve", "Publish"].includes(String(raw.action))
      )
        return fail("CATALOG_INPUT_INVALID");
      for (const key of ["operationReference", "optionSetReference", "versionReference"])
        parsePublishingReference(raw[key]);
      parsePublishingVersion(raw.expectedAggregateVersion);
      for (const key of ["sourceDigest", "contentDigest", "configurationDigest"])
        parsePublishingDigest(raw[key]);
      if (raw.expectedReview !== null) {
        const r = readClosedRecord(raw.expectedReview, [
          "reviewOperationReference",
          "publishingReviewOperationReference",
          "recordDigest",
          "bindingDigest",
        ]);
        parsePublishingReference(r.reviewOperationReference);
        parsePublishingReference(r.publishingReviewOperationReference);
        parsePublishingDigest(r.recordDigest);
        parsePublishingDigest(r.bindingDigest);
      }
      if (raw.expectedLifecycle !== null) {
        const r = readClosedRecord(raw.expectedLifecycle, [
          "lifecycleReference",
          "version",
          "state",
          "latestMutationOperationReference",
        ]);
        parsePublishingReference(r.lifecycleReference);
        parsePublishingReference(r.latestMutationOperationReference);
        parsePublishingVersion(r.version);
        if (!["Draft", "InReview", "Approved"].includes(String(r.state)))
          return fail("CATALOG_INPUT_INVALID");
        if (
          (raw.action === "SubmitReview" && r.state !== "Draft") ||
          (raw.action === "Approve" && r.state !== "InReview") ||
          (raw.action === "Publish" && r.state === "Draft")
        )
          return fail("CATALOG_INPUT_INVALID");
      }
      if (
        raw.action === "SubmitReview"
          ? raw.expectedReview !== null
          : raw.expectedReview === null || raw.expectedLifecycle === null
      )
        return fail("CATALOG_INPUT_INVALID");
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
      completed: MerchantOptionSetPublicationResolutionResult | undefined;
    const result = await host.transactions.run(async (tx) => {
      if (++calls !== 1) return reject();
      const query = tx.query;
      let guardCalls = 0,
        finalCalls = 0,
        guardComplete = false;
      let ready = false,
        holdAgain: (() => Promise<void>) | undefined,
        assertCurrent: (() => void) | undefined;
      const check = () => {
        now();
        if (tx.query !== query) return reject();
        assertCurrent?.();
      };
      await host.registerBeforeCommit(
        tx,
        async () => {
          if (!ready || !holdAgain || ++guardCalls !== 1) return reject();
          await holdAgain();
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
        );
        const { profile: requestProfile, ...original } = raw;
        void requestProfile;
        const command = parsePublishingOptionSetPublicationOperation({
          ...original,
          profile: "PublishingOptionSetPublicationOperationV1",
          tenantReference: scope.tenantReference,
          brandReference: bound.brandReference,
          selectedStoreReference: bound.storeReference,
          actorReference: scope.actorReference,
          reasonCode:
            raw.action === "SubmitReview"
              ? "PUBLISHING_REVIEW_SUBMITTED"
              : raw.action === "Approve"
                ? "PUBLISHING_REVIEW_APPROVED"
                : "PUBLISHING_RELEASE_PUBLISHED",
        });
        const capabilityKey = "catalog.cat_optionset_edit",
          permissions = Object.freeze(["catalog.manage", "catalog.option_set.read"] as const),
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
            tenantReference: command.tenantReference,
            brandReference: command.brandReference,
            storeReference: bound.storeReference,
            actorReference: command.actorReference,
            clock: { now },
            originalValidUntil: originalDeadline,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: current,
            capabilityKey,
          });
        if (
          typeof current.leaseDeadline !== "function" ||
          typeof capability.leaseDeadline !== "function"
        )
          return reject();
        const assertPort = current.assertCurrent,
          holdPort = capability.holdUntilCommit,
          currentLeasePort = current.leaseDeadline,
          capabilityLeasePort = capability.leaseDeadline,
          assert = assertPort.bind(current),
          decisionPort = current.authorizeActionsWithDecisions,
          authorize = typeof decisionPort === "function" ? decisionPort.bind(current) : reject(),
          hold = holdPort.bind(capability),
          currentLease = current.leaseDeadline.bind(current),
          capabilityLease = capability.leaseDeadline.bind(capability);
        const shorten = () => {
          const a = parseCatalogInstant(currentLease()),
            b = parseCatalogInstant(capabilityLease());
          if (a < deadline) deadline = a;
          if (b < deadline) deadline = b;
          now();
        };
        let holding = false,
          admitted = false;
        assertCurrent = () => {
          if (
            current.assertCurrent !== assertPort ||
            current.authorizeActionsWithDecisions !== decisionPort ||
            capability.holdUntilCommit !== holdPort ||
            current.leaseDeadline !== currentLeasePort ||
            capability.leaseDeadline !== capabilityLeasePort
          )
            return reject();
          const at = parseCatalogInstant(assert());
          if (at !== latest) return reject();
          if (admitted) shorten();
        };
        holdAgain = async () => {
          if (holding) return reject();
          holding = true;
          try {
            check();
            if ((await hold()) !== undefined) return reject();
            check();
            const decisions = await authorize(permissions);
            if (!Array.isArray(decisions) || decisions.length !== permissions.length)
              return reject();
            for (let i = 0; i < permissions.length; i++) {
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
                a = readClosedRecord(d.audit, ["effect", "reason", "source"]);
              if (d.effect !== "Allow" || d.scopeKind !== "Brand" || d.action !== permissions[i])
                return fail("CATALOG_PERMISSION_DENIED");
              if (
                (d.reason !== "EXPLICIT_ALLOW" && d.reason !== "ROLE_PERMISSION") ||
                (d.source !== "ExplicitAllow" && d.source !== "RolePermission") ||
                (d.reason === "EXPLICIT_ALLOW") !== (d.source === "ExplicitAllow") ||
                a.effect !== d.effect ||
                a.reason !== d.reason ||
                a.source !== d.source
              )
                return reject();
              parseBusinessAction(d.action);
              parsePolicyReference(d.policySnapshotReference);
              parsePolicyVersion(d.policyVersion);
            }
            admitted = true;
            check();
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            holding = false;
          }
        };
        const store = createPostgresOptionSetPublicationOperationStore({
          tenantReference: command.tenantReference,
          brandReference: command.brandReference,
          actorReference: command.actorReference,
          selectedStoreReference: bound.storeReference,
          optionSetPolicyFamilyReference: family,
          clock: { now },
          originalValidUntil: originalDeadline,
          async registerBeforeCommit(actual, guard, finalAssert) {
            if (actual !== tx) return reject();
            await host.registerBeforeCommit(tx, guard, finalAssert);
            check();
          },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              try {
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
                const observedAt = parseCatalogInstant(input.observedAt);
                if (
                  actual !== tx ||
                  input.mode !== "Resolve" ||
                  canonicalizeRfc8785(input.command) !== canonicalizeRfc8785(command) ||
                  input.actorKind !== "User" ||
                  input.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION_OPERATION" ||
                  input.permission !== "catalog.manage" ||
                  canonicalizeRfc8785(input.requiredPermissions) !==
                    canonicalizeRfc8785(["catalog.option_set.read"]) ||
                  canonicalizeRfc8785(input.requiredFields) !==
                    canonicalizeRfc8785(optionSetPublicationOperationFields) ||
                  input.validUntil > deadline ||
                  input.validUntil <= observedAt ||
                  observedAt < startedAt ||
                  observedAt > now()
                )
                  return reject();
                if (!holdAgain) return reject();
                await holdAgain();
                return Object.freeze({
                  validUntil: input.validUntil < deadline ? input.validUntil : deadline,
                });
              } catch (error) {
                failed = true;
                throw error;
              }
            },
          },
          audit: {
            create({ command: originalCommand, observedAt }) {
              if (canonicalizeRfc8785(originalCommand) !== canonicalizeRfc8785(command))
                return reject();
              return {
                auditId: parseCatalogReference(auditReference(command.operationReference)),
                brandId: command.brandReference,
                actor: { type: "User", reference: command.actorReference },
                actionCode: "PUBLISHING_OPTION_SET_OPERATION_ABANDONED",
                targetType: "PublishingOptionSetOperation",
                targetId: command.operationReference,
                reasonCode: command.reasonCode,
                correlationId: command.operationReference,
                occurredAt: observedAt,
                sourceChannel: "API",
                dataClassification: "Confidential",
                retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
                retentionPolicyVersion: 1,
              };
            },
          },
        });
        const resolution = await store.resolveOperation(tx, command);
        check();
        readClosedRecord(
          resolution,
          resolution.outcome === "Committed"
            ? ["outcome", "command", "originalOccurredAt", "auditReference", "mutation"]
            : ["outcome", "command", "recordedAt", "auditReference"],
        );
        parsePublishingReference(resolution.auditReference);
        if (resolution.outcome === "Committed") {
          const originalMutation = parseRecordedPublishingMutation(resolution.mutation);
          if (
            originalMutation.idempotencyKey !== command.operationReference ||
            originalMutation.operation !== command.action ||
            originalMutation.audit.auditId !== resolution.auditReference ||
            originalMutation.audit.occurredAt !== resolution.originalOccurredAt
          )
            return reject();
        } else if (resolution.outcome !== "Abandoned") return reject();
        if (
          canonicalizeRfc8785(resolution.command) !== canonicalizeRfc8785(command) ||
          parseCatalogInstant(
            resolution.outcome === "Committed"
              ? resolution.originalOccurredAt
              : resolution.recordedAt,
          ) > now()
        )
          return reject();
        ready = true;
        completed = Object.freeze({
          profile: "CatalogOptionSetPublicationResolutionResultV1",
          storeReference: bound.storeReference,
          resolution,
        });
        return completed;
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    if (calls !== 1 || !finalized || !completed || result !== completed) return reject();
    now();
    return result;
  };
}
