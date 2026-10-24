import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  createPostgresFullOptionSetPublicationSourceAdmissionStore,
  createPostgresOptionSetReviewContentStore,
  createCatalogOptionSetReviewRecord,
  createCatalogOptionSetReleaseRecord,
  createPostgresFullOptionSetContentSealStore,
  currentFullOptionSetDraftFields,
  currentFullOptionSetDraftReviewFields,
  frozenFullOptionSetContentFields,
  fullOptionSetPublicationSourceAdmissionFields,
  optionSetReviewRecordFields,
  optionSetReleaseRecordFields,
  fullOptionSealChecks,
  type CurrentFullOptionSetDraftAuthority,
  type FrozenFullOptionSetContentAuthority,
  type FullOptionSetSealAuthority,
} from "@rms/catalog";
import {
  createPostgresOptionSetPublicationOperationStore,
  parsePublishingOptionSetPublicationOperation,
  createPostgresPublishingMutationStore,
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  createPublishingReleaseRecord,
  executePublishingMutation,
  parsePublishingInstant,
  parsePublishingCode,
  parseReleaseSequence,
  publishingOptionSetPublicationOperationDigest,
  parsePublishingOptionSetApprovalWaiver,
  parsePublishingOptionSetCurrentQualification,
  type ExecutePublishingMutationInput,
  type CommitPublishingMutationInput,
  parseRecordedPublishingMutation,
  parsePublishingReference,
  parsePublishingDigest,
  parsePublishingVersion,
  optionSetPublicationOperationFields,
  type OptionSetPublicationOriginalOperation,
} from "@bop/publishing";
import {
  createPostgresTransactionCurrentPermissionPolicySource,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  type PermissionDecision,
} from "@bop/permission";
import {
  createCurrentOptionSetPublicationValidationSource,
  type CurrentOptionSetPublicationValidationPacket,
  type CurrentOptionSetPublicationValidationOptions,
} from "./current-option-set-publication-validation.js";
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
export interface MerchantOptionSetPublicationCommandOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly generateReference: () => string;
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly brandConfigurationVersionReference: string;
  readonly expectedBrandVersion: number;
  readonly mediaScope: CurrentOptionSetPublicationValidationOptions["mediaScope"];
  readonly optionSetPolicyFamilyReference: string;
}
export type MerchantOptionSetPublicationCommandResult =
  | Readonly<{
      profile: "CatalogOptionSetPublicationCommandResultV1";
      storeReference: string;
      outcome: "Validated";
      validation: Readonly<
        Pick<
          CurrentOptionSetPublicationValidationPacket,
          | "checks"
          | "findings"
          | "decision"
          | "observedAt"
          | "qualifiedActivationAt"
          | "independentApproval"
          | "saleEligibility"
        >
      >;
    }>
  | Readonly<{
      profile: "CatalogOptionSetPublicationCommandResultV1";
      storeReference: string;
      resolution: Exclude<OptionSetPublicationOriginalOperation, { outcome: "Absent" }>;
    }>;
/** Ordinary server-bound commands, one original host and actual owning qualification.
 * Terminal original replay bypasses current Draft CAS and new allocations. */
export function createMerchantOptionSetPublicationCommand(
  options: MerchantOptionSetPublicationCommandOptions,
) {
  if (
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.authentication?.authorize !== "function" ||
    typeof options.generateReference !== "function"
  )
    return fail();
  const family = parsePublishingReference(options.optionSetPolicyFamilyReference);
  const clock = options.merchant.now.bind(options.merchant),
    run = options.merchant.transactions.run.bind(options.merchant.transactions),
    authenticate = options.authentication.authorize.bind(options.authentication),
    generator = options.generateReference.bind(options),
    policyReference = parsePublishingReference(options.policyReference),
    policyVersion = parsePublishingVersion(options.policyVersion),
    brandConfigurationVersionReference = parseCatalogReference(
      options.brandConfigurationVersionReference,
    ),
    expectedBrandVersion = parsePublishingVersion(options.expectedBrandVersion),
    mediaScope = Object.freeze({ ...options.mediaScope }),
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
    host = createMerchantCategoryTransactions({ run });
  return async (request: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly command: unknown;
    readonly expectedScope: unknown;
  }): Promise<MerchantOptionSetPublicationCommandResult> => {
    const expected = parseMerchantProductCommandScope(request.expectedScope),
      sessionCookie = request.sessionCookie,
      csrf = request.csrf;
    let raw: Record<string, unknown>;
    try {
      const copied = copyCategoryPersistenceValue(request.command);
      if (!copied || typeof copied !== "object" || Array.isArray(copied))
        return fail("CATALOG_INPUT_INVALID");
      const action = readClosedRecord(copied, Object.keys(copied)).action;
      const inspected = readClosedRecord(
        copied,
        action === "Validate"
          ? [
              "profile",
              "action",
              "optionSetReference",
              "versionReference",
              "expectedAggregateVersion",
              "sourceDigest",
              "contentDigest",
              "configurationDigest",
            ]
          : [
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
            ],
      );
      if (
        inspected.profile !== "CatalogOptionSetPublicationCommandRequestV1" ||
        !["Validate", "SubmitReview", "Approve", "Publish"].includes(String(inspected.action))
      )
        return fail("CATALOG_INPUT_INVALID");
      raw = inspected;
      for (const key of ["optionSetReference", "versionReference"])
        parsePublishingReference(raw[key]);
      parsePublishingVersion(raw.expectedAggregateVersion);
      for (const key of ["sourceDigest", "contentDigest", "configurationDigest"])
        parsePublishingDigest(raw[key]);
      if (raw.action !== "Validate") {
        parsePublishingReference(raw.operationReference);
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
          if (
            !["Draft", "InReview", "Approved"].includes(String(r.state)) ||
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
      }
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
      completed: MerchantOptionSetPublicationCommandResult | undefined;
    const result = await host.transactions.run(async (tx) => {
      if (++calls !== 1) return reject();
      const query = tx.query,
        permissionPolicy = createPostgresTransactionCurrentPermissionPolicySource(tx);
      if (
        !permissionPolicy ||
        typeof permissionPolicy.authorize !== "function" ||
        typeof permissionPolicy.authorizeWithRoles !== "function" ||
        typeof permissionPolicy.authorizeActionsWithRoles !== "function"
      )
        return reject();
      let guardCalls = 0,
        finalCalls = 0,
        guardComplete = false;
      let verifyOwnPublished: (() => Promise<void>) | undefined;
      let ready = false,
        holdAgain: (() => Promise<readonly PermissionDecision[]>) | undefined,
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
          if (verifyOwnPublished) await verifyOwnPublished();
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
        const scope = await createMerchantBrandScope(merchant, permissionPolicy)(
          tx,
          sessionCookie,
          session.sessionReference,
        );
        check();
        const bound = bindMerchantProductCommandScope(
          {
            brandReference: scope.context.brand.brandReference,
            storeReference: scope.selectedStoreReference,
          },
          expected,
        );
        const allocated = new Set<string>();
        const generate = () => {
          check();
          const ref = parsePublishingReference(generator());
          check();
          if (allocated.has(ref) || ref === raw.operationReference) return reject();
          allocated.add(ref);
          return ref;
        };
        const graphRequest = Object.freeze({
          optionSetReference: parseCatalogReference(raw.optionSetReference),
          versionReference: parseCatalogReference(raw.versionReference),
          expectedAggregateVersion: parsePublishingVersion(raw.expectedAggregateVersion),
          sourceDigest: parsePublishingDigest(raw.sourceDigest),
          contentDigest: parsePublishingDigest(raw.contentDigest),
          configurationDigest: parsePublishingDigest(raw.configurationDigest),
        });
        const { profile: requestProfile, ...original } = raw;
        void requestProfile;
        const command =
          raw.action === "Validate"
            ? null
            : parsePublishingOptionSetPublicationOperation({
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
        const action = raw.action;
        const capabilityKey = "catalog.cat_optionset_edit",
          permissions = Object.freeze(
            [
              ...new Set([
                "catalog.manage",
                "catalog.option_set.read",
                ...(action === "SubmitReview"
                  ? [
                      "catalog.option_set.submit",
                      "publishing.review.submit",
                      ...(command?.expectedLifecycle === null ? ["publishing.draft.create"] : []),
                    ]
                  : action === "Approve"
                    ? ["publishing.review.approve"]
                    : action === "Publish"
                      ? ["catalog.option_set.publish", "publishing.release.publish"]
                      : []),
              ]),
            ].sort(),
          ),
          current = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope,
            sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now },
            originalValidUntil: originalDeadline,
            permissionPolicy,
            capabilityKey,
          }),
          capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            tenantReference: scope.tenantReference,
            brandReference: bound.brandReference,
            storeReference: bound.storeReference,
            actorReference: scope.actorReference,
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
          holdPort =
            typeof capability.holdUntilCommitWithDecisions === "function"
              ? capability.holdUntilCommitWithDecisions
              : reject(),
          currentLeasePort = current.leaseDeadline,
          capabilityLeasePort = capability.leaseDeadline,
          assert = assertPort.bind(current),
          decisionPort = current.authorizeActionsWithDecisions,
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
        let writing = false;
        const readPermissions = Object.freeze(["catalog.manage", "catalog.option_set.read"]);
        let holding = false,
          admitted = false;
        assertCurrent = () => {
          if (
            current.assertCurrent !== assertPort ||
            current.authorizeActionsWithDecisions !== decisionPort ||
            capability.holdUntilCommitWithDecisions !== holdPort ||
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
            const requested = writing ? permissions : readPermissions;
            const decisions = await hold(requested);
            check();
            if (!Array.isArray(decisions) || decisions.length !== requested.length) return reject();
            for (let i = 0; i < requested.length; i++) {
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
              if (d.effect !== "Allow" || d.scopeKind !== "Brand" || d.action !== requested[i])
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
            return decisions;
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            holding = false;
          }
        };
        const rehold = holdAgain;
        const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
        const register: typeof host.registerBeforeCommit = async (actual, guard, final) => {
          if (actual !== tx) return reject();
          await host.registerBeforeCommit(actual, guard, final);
          check();
        };
        const borrowed = {
          async run<T>(work: (actual: typeof tx) => Promise<T>) {
            check();
            const result = await work(tx);
            check();
            return result;
          },
        };
        const ownerScope = createPublishingScope({
          kind: "Brand",
          brandReference: bound.brandReference,
          storeReference: null,
        });
        const publisher = createPostgresPublishingMutationStore(
          borrowed,
          scope.tenantReference,
          ownerScope,
          { optionSetPolicyFamilyReference: family },
        );
        const identity = {
          tenantReference: scope.tenantReference,
          brandReference: bound.brandReference,
          actorReference: scope.actorReference,
          actorKind: "User",
          permission: "catalog.manage",
        };
        const proof = async (
          actual: typeof tx,
          value: unknown,
          keys: readonly string[],
          purpose: string,
          fine: string,
          fields: readonly string[],
        ) => {
          check();
          if (actual !== tx) return reject();
          const input = readClosedRecord(copyCategoryPersistenceValue(value), keys);
          for (const [key, expectedValue] of Object.entries(identity))
            if (input[key] !== expectedValue) return reject();
          const observedAt = parseCatalogInstant(input.observedAt);
          if (
            input.purposeCode !== purpose ||
            input.action !== fine ||
            !equal(input.requiredFields, fields) ||
            observedAt < startedAt ||
            observedAt > now()
          )
            return reject();
          await rehold();
          check();
          return Object.freeze({ observedAt, validUntil: deadline });
        };
        const commonKeys = [
          ...Object.keys(identity),
          "action",
          "purposeCode",
          "requiredFields",
          "observedAt",
        ];
        const readAuthority: CurrentFullOptionSetDraftAuthority = {
          async holdUntilTransactionCompletes(actual, input) {
            if (input.optionSetReference !== graphRequest.optionSetReference) return reject();
            return proof(
              actual,
              input,
              [...commonKeys, "optionSetReference", "content"],
              "CATALOG_OPTION_SET_DRAFT",
              "catalog.option_set.read",
              currentFullOptionSetDraftReviewFields,
            );
          },
        };
        const frozenAuthority: FrozenFullOptionSetContentAuthority = {
          async holdUntilTransactionCompletes(actual, input) {
            if (
              input.optionSetReference !== graphRequest.optionSetReference ||
              input.versionReference !== graphRequest.versionReference
            )
              return reject();
            return proof(
              actual,
              input,
              [...commonKeys, "optionSetReference", "versionReference", "content"],
              "CATALOG_OPTION_SET_FROZEN_CONTENT",
              "catalog.option_set.read",
              frozenFullOptionSetContentFields,
            );
          },
        };
        const audit = (
          operation: string,
          actionCode: string,
          targetType: string,
          targetId: string,
          occurredAt: string,
          auditId = generate(),
        ) => ({
          auditId,
          brandId: bound.brandReference,
          actor: { type: "User" as const, reference: scope.actorReference },
          actionCode,
          targetType,
          targetId,
          reasonCode: command ? command.reasonCode : reject(),
          correlationId: operation,
          occurredAt,
          sourceChannel: "API",
          dataClassification: "Confidential" as const,
          retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
          retentionPolicyVersion: 1,
        });
        const operation = command?.operationReference ?? generate();
        const intent = command
          ? publishingOptionSetPublicationOperationDigest(command)
          : parsePublishingDigest(
              "sha256:" +
                sha256Hex(
                  canonicalizeRfc8785({
                    tenantReference: scope.tenantReference,
                    brandReference: bound.brandReference,
                    actorReference: scope.actorReference,
                    action: "Validate",
                    operationReference: operation,
                    graphRequest,
                  }),
                ),
            );
        const validatorOptions = (
          publicationSeal?: CurrentOptionSetPublicationValidationOptions["publicationSeal"],
        ): CurrentOptionSetPublicationValidationOptions => ({
          transaction: tx,
          tenantReference: scope.tenantReference,
          brandReference: bound.brandReference,
          storeReference: bound.storeReference,
          actorReference: scope.actorReference,
          sessionReference: session.sessionReference,
          clock: { now },
          originalObservedAt: startedAt,
          originalValidUntil: originalDeadline,
          currentAuthorization: current,
          capability,
          registerBeforeCommit: register,
          events: { generateReference: generate },
          operationReference: operation,
          policyReference,
          policyVersion,
          brandConfigurationVersionReference,
          expectedBrandVersion,
          mediaScope,
          qualificationAction:
            action === "SubmitReview" ? "SubmitReview" : action === "Publish" ? "Publish" : "Read",
          ...(publicationSeal ? { publicationSeal } : {}),
        });
        if (action === "Validate") {
          writing = true;
          await rehold();
          const validator = createCurrentOptionSetPublicationValidationSource(validatorOptions());
          const validation = await validator.withCurrentValidation(
            { graphRequest, originalIntentDigest: intent, activationAt: startedAt },
            async (packet) => packet,
          );
          check();
          ready = true;
          completed = Object.freeze({
            profile: "CatalogOptionSetPublicationCommandResultV1",
            storeReference: bound.storeReference,
            outcome: "Validated",
            validation: Object.freeze({
              checks: validation.checks,
              findings: validation.findings,
              decision: validation.decision,
              observedAt: validation.observedAt,
              qualifiedActivationAt: validation.qualifiedActivationAt,
              independentApproval: validation.independentApproval,
              saleEligibility: validation.saleEligibility,
            }),
          });
          return completed;
        }
        if (!command) return reject();
        const originalStore = createPostgresOptionSetPublicationOperationStore({
          tenantReference: scope.tenantReference,
          brandReference: bound.brandReference,
          selectedStoreReference: bound.storeReference,
          actorReference: scope.actorReference,
          optionSetPolicyFamilyReference: family,
          clock: { now },
          originalValidUntil: originalDeadline,
          async registerBeforeCommit(actual, guard, finalAssert) {
            if (actual !== tx) return reject();
            await register(tx, guard, finalAssert);
          },
          audit: {
            create({ command: originalCommand, observedAt }) {
              if (!equal(originalCommand, command)) return reject();
              return audit(
                command.operationReference,
                "PUBLISHING_OPTION_SET_OPERATION_ABANDONED",
                "PublishingOptionSetOperation",
                command.operationReference,
                observedAt,
              );
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
              const requested =
                input.mode === "Read"
                  ? ["catalog.option_set.read"]
                  : permissions.filter((value) => value !== "catalog.manage");
              if (
                actual !== tx ||
                !equal(input.command, command) ||
                !["Read", "Write"].includes(input.mode) ||
                input.permission !== "catalog.manage" ||
                input.actorKind !== "User" ||
                input.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION_OPERATION" ||
                !equal(input.requiredFields, optionSetPublicationOperationFields) ||
                !equal(input.requiredPermissions, requested) ||
                parseCatalogInstant(input.observedAt) < startedAt ||
                input.observedAt > now() ||
                input.validUntil > deadline ||
                input.validUntil <= input.observedAt
              )
                return reject();
              await rehold();
              return Object.freeze({
                validUntil: input.validUntil < deadline ? input.validUntil : deadline,
              });
            },
          },
        });
        const originalReceipt = await originalStore.inspectOriginalOperation(tx, command);
        check();
        if (originalReceipt.outcome !== "Absent") {
          if (!equal(originalReceipt.command, command)) return reject();
          if (originalReceipt.outcome === "Committed") {
            const mutation = parseRecordedPublishingMutation(originalReceipt.mutation);
            if (
              mutation.idempotencyKey !== command.operationReference ||
              mutation.operation !== command.action ||
              mutation.audit.auditId !== originalReceipt.auditReference ||
              mutation.audit.occurredAt !== originalReceipt.originalOccurredAt
            )
              return reject();
          }
          ready = true;
          completed = Object.freeze({
            profile: "CatalogOptionSetPublicationCommandResultV1",
            storeReference: bound.storeReference,
            resolution: originalReceipt,
          });
          return completed;
        }
        writing = true;
        await rehold();
        const sealCommand =
          action === "Publish"
            ? Object.freeze({
                ...graphRequest,
                operationReference: generate(),
                occurredAt: startedAt,
                reasonCode: command.reasonCode,
              })
            : undefined;
        const sourceAdmission = createPostgresFullOptionSetPublicationSourceAdmissionStore({
          tenantReference: scope.tenantReference,
          brandReference: bound.brandReference,
          actorReference: scope.actorReference,
          action: command.action,
          operationReference: command.operationReference,
          reasonCode: command.reasonCode,
          originalObservedAt: startedAt,
          originalValidUntil: originalDeadline,
          clock: { now },
          transactions: borrowed,
          registerBeforeCommit: register,
          currentDraftAuthority: readAuthority,
          ...(sealCommand ? { sealCommand, frozenAuthority } : {}),
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              if (
                !equal(input.request, graphRequest) ||
                input.operationReference !== command.operationReference ||
                input.reasonCode !== command.reasonCode ||
                input.originalObservedAt !== startedAt ||
                input.originalValidUntil !== originalDeadline ||
                !["Intent", "Current", "Final"].includes(input.phase)
              )
                return reject();
              return proof(
                actual,
                input,
                [
                  ...commonKeys,
                  "phase",
                  "request",
                  "operationReference",
                  "reasonCode",
                  "originalObservedAt",
                  "originalValidUntil",
                  "sealIdentity",
                  "current",
                ],
                "CATALOG_OPTION_SET_PUBLICATION",
                action === "SubmitReview"
                  ? "catalog.option_set.submit"
                  : action === "Publish"
                    ? "catalog.option_set.publish"
                    : "catalog.option_set.read",
                fullOptionSetPublicationSourceAdmissionFields,
              );
            },
          },
        });
        const resolution = await sourceAdmission.withOriginalSource(graphRequest, async (source) =>
          originalStore.withOriginalOperation(tx, command, async (original) => {
            if (original.outcome !== "Absent") return reject();
            const validator = createCurrentOptionSetPublicationValidationSource(
              validatorOptions(source.sealIdentity ?? undefined),
            );
            const validate = async () =>
              command.expectedReview
                ? validator.withCurrentRecordedReviewValidation(
                    {
                      graphRequest,
                      originalIntentDigest: intent,
                      expectedReviewOperationReference:
                        command.expectedReview.reviewOperationReference,
                      expectedReviewRecordDigest: command.expectedReview.recordDigest,
                      expectedReviewBindingDigest: command.expectedReview.bindingDigest,
                    },
                    async (packet) => packet,
                  )
                : validator.withCurrentValidation(
                    { graphRequest, originalIntentDigest: intent, activationAt: startedAt },
                    async (packet) => packet,
                  );
            const report = await validate();
            check();
            if (
              report.decision !== "Pass" ||
              report.checks.length !== 4 ||
              report.checks.some((value) => value.outcome !== "Pass")
            )
              return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
            const writer = createPostgresOptionSetReviewContentStore({
              tenantReference: scope.tenantReference,
              brandReference: bound.brandReference,
              actorReference: scope.actorReference,
              clock: { now },
              registerBeforeCommit: register,
              currentDraftAuthority: readAuthority,
              events: { generateReference: generate },
              authority: {
                async holdUntilTransactionCompletes(actual, input) {
                  if (input.optionSetReference !== graphRequest.optionSetReference) return reject();
                  const release = input.purposeCode === "CATALOG_OPTION_SET_RELEASE_RECORD";
                  if (
                    release
                      ? input.action !==
                        (input.phase === "Read"
                          ? "catalog.option_set.read"
                          : "catalog.option_set.publish")
                      : input.action !== "catalog.option_set.read" &&
                        input.action !== "catalog.option_set.submit"
                  )
                    return reject();
                  const held = await proof(
                    actual,
                    input,
                    [...commonKeys, "phase", "optionSetReference", "record"],
                    release
                      ? "CATALOG_OPTION_SET_RELEASE_RECORD"
                      : "CATALOG_OPTION_SET_REVIEW_RECORD",
                    input.action,
                    release ? optionSetReleaseRecordFields : optionSetReviewRecordFields,
                  );
                  if (input.phase === "Apply" && input.record) {
                    if (input.record.profile === "CatalogOptionSetReviewRecordV1") {
                      const actualReview =
                        await publisher.resolveRecordedOptionSetReviewForLifecycle({
                          familyReference: graphRequest.optionSetReference,
                          lifecycleReference: input.record.lifecycleReference,
                          observedAt: now(),
                        });
                      if (
                        !actualReview ||
                        !equal(
                          actualReview.reviewLifecycle.snapshotDigest,
                          input.record.binding.digest,
                        ) ||
                        String(actualReview.reviewOperationReference) !==
                          String(command.operationReference)
                      )
                        return reject();
                    } else {
                      const actualRelease =
                        await publisher.resolveCurrentOptionSetReleaseForReference({
                          publicationReference: input.record.release.releaseId,
                          observedAt: now(),
                        });
                      if (!equal(actualRelease.recorded.release, input.record.release))
                        return reject();
                    }
                  }
                  check();
                  return held;
                },
              },
            });
            if (
              action === "SubmitReview" &&
              (await writer.readCurrentReviewForDraft(tx, {
                optionSetReference: graphRequest.optionSetReference,
                expectedAggregateVersion: graphRequest.expectedAggregateVersion,
              })) !== null
            )
              return fail("CATALOG_VERSION_CONFLICT");
            let captured: CommitPublishingMutationInput | undefined;
            const service = async (input: ExecutePublishingMutationInput, createDraft = false) =>
              executePublishingMutation(input, {
                authorization: {
                  async authorize(request) {
                    readClosedRecord(request, [
                      "tenantContext",
                      "action",
                      "resourceScope",
                      "familyReference",
                      "purposeCode",
                      "expectedVersion",
                    ]);
                    if (
                      !equal(request.tenantContext, scope.context) ||
                      !equal(request.resourceScope, {
                        kind: "Brand",
                        brandReference: bound.brandReference,
                        storeReference: null,
                      }) ||
                      String(request.familyReference) !== graphRequest.optionSetReference ||
                      request.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
                      request.expectedVersion !== input.expectedVersion
                    )
                      return reject();
                    const expectedAction =
                      input.operation === "CreateDraft"
                        ? "publishing.draft.create"
                        : input.operation === "SubmitReview"
                          ? "publishing.review.submit"
                          : input.operation === "Approve"
                            ? "publishing.review.approve"
                            : "publishing.release.publish";
                    if (request.action !== expectedAction) return reject();
                    const decisions = await rehold();
                    check();
                    const matching = decisions.filter(
                      (decision) => decision.action === request.action,
                    );
                    if (matching.length !== 1) return reject();
                    const decision = matching[0];
                    if (
                      !decision ||
                      decision.effect !== "Allow" ||
                      decision.scopeKind !== "Brand" ||
                      decision.action !== request.action
                    )
                      return reject();
                    const actualDecision = readClosedRecord(decision, [
                        "effect",
                        "reason",
                        "source",
                        "action",
                        "scopeKind",
                        "policySnapshotReference",
                        "policyVersion",
                        "audit",
                      ]),
                      decisionAudit = readClosedRecord(actualDecision.audit, [
                        "effect",
                        "reason",
                        "source",
                      ]);
                    if (
                      (actualDecision.reason !== "EXPLICIT_ALLOW" &&
                        actualDecision.reason !== "ROLE_PERMISSION") ||
                      (actualDecision.source !== "ExplicitAllow" &&
                        actualDecision.source !== "RolePermission") ||
                      (actualDecision.reason === "EXPLICIT_ALLOW") !==
                        (actualDecision.source === "ExplicitAllow") ||
                      decisionAudit.effect !== actualDecision.effect ||
                      decisionAudit.reason !== actualDecision.reason ||
                      decisionAudit.source !== actualDecision.source
                    )
                      return reject();
                    parsePolicyReference(actualDecision.policySnapshotReference);
                    parsePolicyVersion(actualDecision.policyVersion);
                    return decision;
                  },
                },
                unitOfWork: {
                  async commit(value) {
                    check();
                    const parsed = parseRecordedPublishingMutation(value);
                    const receipt = createDraft
                      ? await original.createDraft(parsed)
                      : await original.commit(parsed);
                    check();
                    if (!createDraft) captured = parsed;
                    return receipt;
                  },
                },
              });
            const mutateBase = {
              tenantContext: scope.context,
              sourceChannel: parsePublishingCode("API"),
              correlationId: command.operationReference,
            };
            if (action === "SubmitReview") {
              let currentLifecycle;
              if (command.expectedLifecycle === null) {
                const time = parsePublishingInstant(now());
                currentLifecycle = createPublishingLifecycleRecord({
                  lifecycleId: generate(),
                  familyReference: command.optionSetReference,
                  configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
                  purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
                  snapshotReference: command.versionReference,
                  snapshotDigest: parsePublishingDigest(report.reviewBinding.digest),
                  scope: ownerScope,
                  version: parsePublishingVersion(1),
                  state: "Draft",
                  validationEvidenceReference: null,
                  approvalEvidenceReference: null,
                  createdAt: time,
                  changedAt: time,
                });
                const createOperation = generate();
                await service(
                  {
                    ...mutateBase,
                    operation: "CreateDraft",
                    expectedVersion: currentLifecycle.version,
                    current: null,
                    next: currentLifecycle,
                    idempotencyKey: createOperation,
                    correlationId: createOperation,
                    auditId: generate(),
                    occurredAt: time,
                  },
                  true,
                );
              } else {
                const existing = await publisher.resolveCurrentLifecycleMutation({
                  familyReference: command.optionSetReference,
                  lifecycleReference: command.expectedLifecycle.lifecycleReference,
                  configurationType: "CATALOG_OPTION_SET",
                  purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
                  observedAt: now(),
                });
                if (
                  !existing ||
                  existing.idempotencyKey !==
                    command.expectedLifecycle.latestMutationOperationReference ||
                  existing.next.state !== "Draft" ||
                  existing.next.version !== command.expectedLifecycle.version ||
                  existing.next.snapshotDigest !== report.reviewBinding.digest
                )
                  return reject();
                currentLifecycle = existing.next;
              }
              const evidence = createPublishingValidationEvidence({
                evidenceReference: generate(),
                snapshotReference: currentLifecycle.snapshotReference,
                snapshotDigest: currentLifecycle.snapshotDigest,
                scope: ownerScope,
                result: "Pass",
                checkedAt: parsePublishingInstant(report.observedAt),
                validUntil: parsePublishingInstant(report.validUntil),
                checkCodes: report.checks.map((value) => parsePublishingCode(value.code)),
              });
              const time = parsePublishingInstant(now()),
                next = createPublishingLifecycleRecord({
                  ...currentLifecycle,
                  version: parsePublishingVersion(currentLifecycle.version + 1),
                  state: "InReview",
                  validationEvidenceReference: evidence.evidenceReference,
                  changedAt: time,
                });
              const reviewPolicy = await publisher.resolveOptionSetReviewPolicy({
                reviewOperationReference: command.operationReference,
                reviewLifecycle: next,
                validationEvidence: evidence,
                submittedActorReference: scope.actorReference,
                submittedAt: time,
              });
              check();
              await service({
                ...mutateBase,
                operation: "SubmitReview",
                expectedVersion: currentLifecycle.version,
                current: currentLifecycle,
                next,
                idempotencyKey: command.operationReference,
                auditId: generate(),
                occurredAt: time,
                validationEvidence: evidence,
                optionSetReviewPolicy: reviewPolicy,
              });
              const record = createCatalogOptionSetReviewRecord({
                operationReference: generate(),
                sourceOperationReference: source.current.sourceOperationReference,
                lifecycleReference: next.lifecycleId,
                actorReference: scope.actorReference,
                auditReference: generate(),
                reasonCode: command.reasonCode,
                recordedAt: now(),
                binding: report.reviewBinding,
                content: report.content,
              });
              await writer.saveReview(
                tx,
                record,
                audit(
                  record.operationReference,
                  "CATALOG_OPTION_SET_REVIEW_RECORDED",
                  "CatalogOptionSet",
                  command.optionSetReference,
                  record.recordedAt,
                  parsePublishingReference(record.auditReference),
                ),
              );
            } else {
              if (!command.expectedReview || !command.expectedLifecycle || !report.recordedReview)
                return reject();
              const originalReview = await publisher.resolveRecordedOptionSetReviewForLifecycle({
                familyReference: command.optionSetReference,
                lifecycleReference: command.expectedLifecycle.lifecycleReference,
                observedAt: now(),
              });
              check();
              if (
                !originalReview ||
                String(originalReview.reviewOperationReference) !==
                  String(command.expectedReview.publishingReviewOperationReference) ||
                originalReview.latestMutationOperationReference !==
                  command.expectedLifecycle.latestMutationOperationReference ||
                originalReview.latestLifecycle.version !== command.expectedLifecycle.version ||
                originalReview.latestLifecycle.state !== command.expectedLifecycle.state ||
                originalReview.reviewLifecycle.snapshotDigest !== report.reviewBinding.digest
              )
                return reject();
              if (action === "Approve") {
                if (String(report.recordedReview.actorReference) === String(scope.actorReference))
                  return fail("CATALOG_PERMISSION_DENIED");
                const currentLifecycle = originalReview.latestLifecycle,
                  time = parsePublishingInstant(now()),
                  approval = createPublishingApprovalEvidence({
                    evidenceReference: generate(),
                    reviewLifecycleId: currentLifecycle.lifecycleId,
                    reviewVersion: currentLifecycle.version,
                    snapshotReference: currentLifecycle.snapshotReference,
                    snapshotDigest: currentLifecycle.snapshotDigest,
                    scope: ownerScope,
                    decision: "Accepted",
                    approvedActorReference: parsePublishingReference(scope.actorReference),
                    approvedAt: time,
                    validUntil: parsePublishingInstant(deadline),
                  }),
                  next = createPublishingLifecycleRecord({
                    ...currentLifecycle,
                    version: parsePublishingVersion(currentLifecycle.version + 1),
                    state: "Approved",
                    approvalEvidenceReference: approval.evidenceReference,
                    changedAt: time,
                  });
                await service({
                  ...mutateBase,
                  operation: "Approve",
                  current: currentLifecycle,
                  next,
                  expectedVersion: currentLifecycle.version,
                  idempotencyKey: command.operationReference,
                  auditId: generate(),
                  occurredAt: time,
                  approvalEvidence: approval,
                });
              } else {
                const candidate = await publisher.resolveCurrentOptionSetPublicationCandidate({
                  familyReference: command.optionSetReference,
                  lifecycleReference: command.expectedLifecycle.lifecycleReference,
                  observedAt: now(),
                });
                check();
                if (
                  candidate.latestMutationOperationReference !==
                    command.expectedLifecycle.latestMutationOperationReference ||
                  candidate.reviewOperationReference !==
                    command.expectedReview.publishingReviewOperationReference ||
                  candidate.lifecycle.snapshotDigest !== report.reviewBinding.digest
                )
                  return reject();
                const policyWaived =
                  candidate.lifecycle.state === "InReview" &&
                  candidate.reviewPolicy.policyContent.approvalPolicy === "NotRequired";
                if (candidate.lifecycle.state === "InReview" && !policyWaived) return reject();
                check();
                if (!sealCommand || !source.sealIdentity) return reject();
                const sealFields = currentFullOptionSetDraftReviewFields.filter(
                  (value) =>
                    ![
                      "brandReference",
                      "lifecycle",
                      "createdAt",
                      "createdByActorReference",
                      "updatedAt",
                      "sourceOperationReference",
                      "sourceSnapshotTuple",
                    ].includes(value),
                );
                const sealReadAuthority: CurrentFullOptionSetDraftAuthority = {
                  async holdUntilTransactionCompletes(actual, input) {
                    if (input.optionSetReference !== graphRequest.optionSetReference)
                      return reject();
                    return proof(
                      actual,
                      input,
                      [...commonKeys, "optionSetReference", "content"],
                      "CATALOG_OPTION_SET_DRAFT",
                      "catalog.option_set.read",
                      currentFullOptionSetDraftFields,
                    );
                  },
                };
                const sealAuthority: FullOptionSetSealAuthority = {
                  async holdUntilTransactionCompletes(actual, input) {
                    if (
                      !equal(input.command, sealCommand) ||
                      !equal(
                        input.requiredChecks,
                        input.phase === "Apply" ? fullOptionSealChecks : [],
                      ) ||
                      (input.phase === "Apply" &&
                        (report.decision !== "Pass" ||
                          (!policyWaived && !candidate.originalApprovalEvidence)))
                    )
                      return reject();
                    return proof(
                      actual,
                      input,
                      [...commonKeys, "requiredChecks", "phase", "command", "content"],
                      "CATALOG_OPTION_SET_PUBLICATION",
                      "catalog.option_set.publish",
                      sealFields,
                    );
                  },
                };
                const sealed = await createPostgresFullOptionSetContentSealStore({
                  tenantReference: scope.tenantReference,
                  brandReference: bound.brandReference,
                  actorReference: scope.actorReference,
                  clock: { now },
                  transactions: borrowed,
                  authority: sealAuthority,
                  readAuthority: sealReadAuthority,
                  references: { generateSuccessorVersion: generate },
                  events: { generateReference: generate },
                  audit: {
                    create(input) {
                      if (
                        input.operationReference !== sealCommand.operationReference ||
                        input.reasonCode !== command.reasonCode ||
                        input.occurredAt !== startedAt
                      )
                        return reject();
                      return audit(
                        input.operationReference,
                        "CATALOG_OPTION_SET_CONTENT_SEALED",
                        "CatalogOptionSet",
                        command.optionSetReference,
                        input.occurredAt,
                      );
                    },
                  },
                }).seal(sealCommand);
                await source.admitOwnSeal(sealed);
                await validator.admitOwnSeal(sealed);
                check();
                const qualification = parsePublishingOptionSetCurrentQualification({
                  profile: "PublishingOptionSetCurrentQualificationV1",
                  tenantReference: scope.tenantReference,
                  operationReference: command.operationReference,
                  actorReference: scope.actorReference,
                  scope: ownerScope,
                  familyReference: command.optionSetReference,
                  lifecycleReference: candidate.lifecycle.lifecycleId,
                  expectedLifecycleVersion: candidate.lifecycle.version,
                  latestMutationOperationReference: candidate.latestMutationOperationReference,
                  snapshotReference: candidate.lifecycle.snapshotReference,
                  snapshotDigest: candidate.lifecycle.snapshotDigest,
                  reviewOperationReference: candidate.reviewOperationReference,
                  validationEvidenceReference:
                    candidate.originalValidationEvidence.evidenceReference,
                  approvalOperationReference: candidate.approvalOperationReference,
                  approvalEvidenceReference:
                    candidate.originalApprovalEvidence?.evidenceReference ?? null,
                  policyReference: report.reviewBinding.policyReference,
                  policyVersion: report.reviewBinding.policyVersion,
                  policyContentDigest: report.reviewBinding.policyContentDigest,
                  policyPublicationReference:
                    report.reviewBinding.currentPolicyPublicationReference,
                  qualificationEvidenceReference: generate(),
                  qualificationReportDigest: report.digest,
                  result: "Pass",
                  originalObservedAt: startedAt,
                  checkedAt: report.observedAt,
                  validUntil: report.validUntil < deadline ? report.validUntil : deadline,
                  checkCodes: report.checks.map((value) => value.code),
                  sourceAssessmentDigests: Object.values(report.sourceAssessmentDigests),
                });
                const time = parsePublishingInstant(now()),
                  waiver = policyWaived
                    ? parsePublishingOptionSetApprovalWaiver({
                        profile: "PublishingOptionSetApprovalWaiverV1",
                        reviewPolicy: candidate.reviewPolicy,
                        currentQualification: qualification,
                        recordedAt: time,
                      })
                    : undefined,
                  next = createPublishingLifecycleRecord({
                    ...candidate.lifecycle,
                    version: parsePublishingVersion(candidate.lifecycle.version + 1),
                    state: "Published",
                    changedAt: time,
                  }),
                  release = createPublishingReleaseRecord({
                    releaseId: generate(),
                    familyReference: command.optionSetReference,
                    configurationType: next.configurationType,
                    purposeCode: next.purposeCode,
                    snapshotReference: next.snapshotReference,
                    snapshotDigest: next.snapshotDigest,
                    scope: ownerScope,
                    sequence: parseReleaseSequence((candidate.previousRelease?.sequence ?? 0) + 1),
                    sourceLifecycleId: next.lifecycleId,
                    kind: "Publish",
                    previousReleaseId: candidate.previousRelease?.releaseId ?? null,
                    createdAt: time,
                  });
                await service({
                  ...mutateBase,
                  operation: "Publish",
                  current: candidate.lifecycle,
                  next,
                  expectedVersion: candidate.lifecycle.version,
                  idempotencyKey: command.operationReference,
                  auditId: generate(),
                  occurredAt: time,
                  validationEvidence: candidate.originalValidationEvidence,
                  ...(candidate.originalApprovalEvidence
                    ? { approvalEvidence: candidate.originalApprovalEvidence }
                    : {}),
                  ...(candidate.previousRelease
                    ? { previousRelease: candidate.previousRelease }
                    : {}),
                  ...(waiver ? { optionSetApprovalWaiver: waiver } : {}),
                  optionSetCurrentQualification: qualification,
                  release,
                });
                const linkage = createCatalogOptionSetReleaseRecord({
                  tenantReference: scope.tenantReference,
                  brandReference: bound.brandReference,
                  optionSetReference: command.optionSetReference,
                  versionReference: command.versionReference,
                  operationReference: generate(),
                  reviewOperationReference: report.recordedReview.operationReference,
                  reviewRecordDigest: report.recordedReview.digest,
                  reviewBindingDigest: report.recordedReview.binding.digest,
                  sealOperationReference: sealCommand.operationReference,
                  sealRecordDigest: sealed.content.digest,
                  publishingOperationReference: command.operationReference,
                  actorReference: scope.actorReference,
                  auditReference: generate(),
                  reasonCode: command.reasonCode,
                  recordedAt: parseCatalogInstant(release.createdAt),
                  release,
                });
                await writer.saveRelease(
                  tx,
                  linkage,
                  audit(
                    linkage.operationReference,
                    "CATALOG_OPTION_SET_RELEASE_RECORDED",
                    "CatalogOptionSet",
                    command.optionSetReference,
                    linkage.recordedAt,
                    parsePublishingReference(linkage.auditReference),
                  ),
                );
                verifyOwnPublished = async () => {
                  await rehold();
                  const currentProof = await publisher.resolveCurrentOptionSetReleaseForReference({
                      publicationReference: release.releaseId,
                      observedAt: now(),
                    }),
                    currentLinkage = await writer.readRelease(
                      tx,
                      linkage.operationReference,
                      command.optionSetReference,
                    );
                  check();
                  if (
                    !equal(currentProof.recorded.release, release) ||
                    !equal(currentLinkage, linkage) ||
                    !captured ||
                    currentProof.recorded.auditReference !== captured.audit.auditId ||
                    !equal(currentProof.recorded.lifecycle, next) ||
                    !equal(currentProof.current.release, release)
                  )
                    return reject();
                };
                await verifyOwnPublished();
              }
            }
            check();
            if (!captured) return reject();
            return Object.freeze({
              outcome: "Committed" as const,
              command,
              originalOccurredAt: parsePublishingInstant(captured.audit.occurredAt),
              auditReference: parsePublishingReference(captured.audit.auditId),
              mutation: captured,
            });
          }),
        );
        check();
        ready = true;
        completed = Object.freeze({
          profile: "CatalogOptionSetPublicationCommandResultV1",
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
