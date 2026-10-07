import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import type { PermissionDecision } from "@bop/permission";
import { createTenantContext, type TenantContext } from "@bop/tenant";
import {
  createPostgresPublishingMutationStore,
  executePublishingMutation,
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingApprovalEvidence,
  createPublishingReleaseRecord,
  parsePublishingReference,
  parsePublishingVersion,
  parsePublishingCode,
  parsePublishingInstant,
  parseReleaseSequence,
  parseRecordedPublishingMutation,
  PublishingServiceError,
  type PublishingTransaction,
  type PublishingAuthorizationRequest,
  type ExecutePublishingMutationInput,
  type CommitPublishingMutationInput,
  type PublishingApprovalEvidence,
  type PublishingReleaseRecord,
} from "@bop/publishing";
import {
  DigitalReceiptTemplateError,
  parseDeviceReference,
  parseDeviceInstant,
  parseDigitalReceiptTemplateLifecycleAction,
  parseDigitalReceiptTemplateSubmission,
  parseDigitalReceiptTemplateContent,
  parseDigitalReceiptTemplateVersion,
  materializeDigitalReceiptTemplateContent,
  type DigitalReceiptTemplateLifecycleAction,
  type DigitalReceiptTemplateSubmission,
  type DigitalReceiptTemplateAuthoredContent,
  type DigitalReceiptTemplateContent,
  type DigitalReceiptTemplateVersion,
  type DigitalReceiptTemplateDraftActorScope,
} from "@rms/printing-device";
export interface MerchantReceiptTemplateLifecycleActualPacket {
  readonly mutation: CommitPublishingMutationInput;
  readonly approval: PublishingApprovalEvidence;
  readonly publishedVersion: DigitalReceiptTemplateVersion | null;
  readonly publicationDigest: string | null;
}
export interface MerchantReceiptTemplateLifecycleKernelOptions {
  readonly transaction: PublishingTransaction;
  readonly currentTenantContext: TenantContext;
  readonly scope: DigitalReceiptTemplateDraftActorScope;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  /** Explicit business duration, bounded by the actual original validation deadline. */
  readonly approvalValidityMs: number;
  readonly nextReference: (kind: "Audit" | "Approval" | "Release") => string;
  readonly readReviewSources: (
    tx: PublishingTransaction,
    action: DigitalReceiptTemplateLifecycleAction,
  ) => Promise<
    Readonly<{
      submission: DigitalReceiptTemplateSubmission;
      authoredContent: DigitalReceiptTemplateAuthoredContent;
      current: CommitPublishingMutationInput;
    }>
  >;
  readonly authorizePublishing: (
    request: PublishingAuthorizationRequest,
  ) => Promise<PermissionDecision>;
  readonly appendPublication: (
    tx: PublishingTransaction,
    input: Readonly<{
      content: DigitalReceiptTemplateContent;
      release: PublishingReleaseRecord;
      operationReference: string;
    }>,
  ) => Promise<DigitalReceiptTemplateVersion>;
}
/** Fresh-only producer under the actual outer original fence. Caller owns all
 * current source/IAM guards, durable terminal and COMMIT; no internal savepoint.
 * Historical original recovery bypasses this live producer entirely. */
export function createMerchantReceiptTemplateLifecycleKernel(
  options: MerchantReceiptTemplateLifecycleKernelOptions,
) {
  const tx = options.transaction,
    query = tx.query,
    contextOwner = options.currentTenantContext,
    scopeOwner = options.scope,
    clockOwner = options.clock,
    now = clockOwner.now,
    allocate = options.nextReference,
    readSources = options.readReviewSources,
    authorize = options.authorizePublishing,
    append = options.appendPublication;
  const r = readClosedRecord(scopeOwner, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
  ]);
  const fixed = Object.freeze({
    tenantReference: parseDeviceReference(r.tenantReference),
    brandReference: parseDeviceReference(r.brandReference),
    storeReference: parseDeviceReference(r.storeReference),
    actorReference: parseDeviceReference(r.actorReference),
  });
  const origin = parseDeviceInstant(options.originalObservedAt),
    deadline = parseDeviceInstant(options.originalValidUntil),
    duration = options.approvalValidityMs;
  const context = createTenantContext(
      contextOwner.actor,
      contextOwner.brand,
      contextOwner.store,
      contextOwner.resolvedAt,
    ),
    contextDigest = canonicalizeRfc8785(context),
    scope = createPublishingScope({
      kind: "Store",
      brandReference: fixed.brandReference,
      storeReference: fixed.storeReference,
    });
  let latest = origin,
    failed = false,
    active = false,
    used = false;
  let action: DigitalReceiptTemplateLifecycleAction | undefined,
    submission: DigitalReceiptTemplateSubmission | undefined,
    authored: DigitalReceiptTemplateAuthoredContent | undefined,
    committed: MerchantReceiptTemplateLifecycleActualPacket | undefined;
  const fail = (
    code: DigitalReceiptTemplateError["code"] = "RECEIPT_TEMPLATE_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new DigitalReceiptTemplateError(code);
  };
  if (
    [query, now, allocate, readSources, authorize, append].some((p) => typeof p !== "function") ||
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    deadline <= origin ||
    Date.parse(deadline) - Date.parse(origin) > 5000 ||
    context.scopeKind !== "Store" ||
    String(context.brand.brandReference) !== fixed.brandReference ||
    String(context.store?.storeReference) !== fixed.storeReference ||
    String(context.actor.actorReference) !== fixed.actorReference
  )
    return fail();
  const captured = () => {
    if (
      failed ||
      options.transaction !== tx ||
      tx.query !== query ||
      options.currentTenantContext !== contextOwner ||
      canonicalizeRfc8785(contextOwner) !== contextDigest ||
      options.scope !== scopeOwner ||
      canonicalizeRfc8785(scopeOwner) !== canonicalizeRfc8785(fixed) ||
      options.clock !== clockOwner ||
      clockOwner.now !== now ||
      options.nextReference !== allocate ||
      options.readReviewSources !== readSources ||
      options.authorizePublishing !== authorize ||
      options.appendPublication !== append ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== deadline ||
      options.approvalValidityMs !== duration
    )
      return fail();
  };
  const check = () => {
    captured();
    const at = parseDeviceInstant(now.call(clockOwner));
    captured();
    if (at < latest || at >= deadline) return fail();
    latest = at;
    return at;
  };
  if (String(context.resolvedAt) > check()) return fail();
  const reference = (kind: Parameters<typeof allocate>[0]) => {
    check();
    const value = parsePublishingReference(allocate.call(options, kind));
    check();
    return value;
  };
  const owner = createPostgresPublishingMutationStore(
    {
      run: async (work) => {
        check();
        const result = await work(tx);
        check();
        return result;
      },
    },
    fixed.tenantReference,
    scope,
  );
  const evidenceCurrent = (s: DigitalReceiptTemplateSubmission, a?: PublishingApprovalEvidence) => {
    const at = check();
    if (at >= s.validationValidUntil || (a && String(a.validUntil) <= at))
      return fail("RECEIPT_TEMPLATE_CONFLICT");
  };
  const boundAction = (value: unknown) => {
    const parsed = parseDigitalReceiptTemplateLifecycleAction(value);
    if (
      Object.entries(fixed).some(
        ([key, v]) => Object.getOwnPropertyDescriptor(parsed, key)?.value !== v,
      )
    )
      return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
    return parsed;
  };
  const sourcePins = (
    s: DigitalReceiptTemplateSubmission,
    c: DigitalReceiptTemplateLifecycleAction,
  ) => {
    if (
      s.tenantReference !== fixed.tenantReference ||
      s.brandReference !== fixed.brandReference ||
      s.storeReference !== fixed.storeReference ||
      s.templateReference !== c.templateReference ||
      s.versionReference !== c.expectedVersionReference ||
      s.draftRevision !== c.expectedRevision ||
      s.reviewLifecycleReference !== c.reviewLifecycleReference ||
      s.submittedAt > check()
    )
      return fail("RECEIPT_TEMPLATE_CONFLICT");
  };
  const headPins = (m: CommitPublishingMutationInput, s: DigitalReceiptTemplateSubmission) => {
    if (
      String(m.next.familyReference) !== s.familyReference ||
      String(m.next.lifecycleId) !== s.reviewLifecycleReference ||
      String(m.next.snapshotReference) !== s.versionReference ||
      String(m.next.snapshotDigest) !== s.contentDigest ||
      m.next.configurationType !== "RECEIPT_TEMPLATE" ||
      m.next.purposeCode !== "RECEIPT_ISSUANCE" ||
      canonicalizeRfc8785(m.next.scope) !== canonicalizeRfc8785(scope) ||
      String(m.next.validationEvidenceReference) !== s.validationEvidenceReference ||
      String(m.next.changedAt) > check() ||
      m.audit.actor.type !== "User" ||
      m.audit.brandId !== fixed.brandReference ||
      m.audit.storeId !== fixed.storeReference
    )
      return fail();
  };
  const approvalPins = (a: PublishingApprovalEvidence, s: DigitalReceiptTemplateSubmission) => {
    if (
      String(a.reviewLifecycleId) !== s.reviewLifecycleReference ||
      Number(a.reviewVersion) !== s.reviewVersion ||
      String(a.snapshotReference) !== s.versionReference ||
      String(a.snapshotDigest) !== s.contentDigest ||
      canonicalizeRfc8785(a.scope) !== canonicalizeRfc8785(scope) ||
      String(a.approvedActorReference) === s.authoredByReference ||
      String(a.approvedActorReference) === s.submittedByReference ||
      String(a.approvedAt) < s.submittedAt ||
      String(a.validUntil) > s.validationValidUntil
    )
      return fail("RECEIPT_TEMPLATE_CONFLICT");
    evidenceCurrent(s, a);
  };
  const readHead = async (s: DigitalReceiptTemplateSubmission) => {
    check();
    const raw = await owner.resolveCurrentLifecycleMutation({
      familyReference: s.familyReference,
      lifecycleReference: s.reviewLifecycleReference,
      configurationType: "RECEIPT_TEMPLATE",
      purposeCode: "RECEIPT_ISSUANCE",
      observedAt: check(),
    });
    check();
    if (!raw) return fail();
    const m = parseRecordedPublishingMutation(raw);
    headPins(m, s);
    return m;
  };
  const executeCore = async (input: ExecutePublishingMutationInput) => {
    let mutation: CommitPublishingMutationInput | undefined;
    const result = await executePublishingMutation(input, {
      authorization: {
        authorize: async (request) => {
          readClosedRecord(request, [
            "tenantContext",
            "action",
            "resourceScope",
            "familyReference",
            "purposeCode",
            "expectedVersion",
          ]);
          if (
            canonicalizeRfc8785(request.tenantContext) !== contextDigest ||
            canonicalizeRfc8785(request.resourceScope) !== canonicalizeRfc8785(scope) ||
            request.familyReference !== input.next.familyReference ||
            request.purposeCode !== input.next.purposeCode ||
            request.expectedVersion !== input.expectedVersion ||
            request.action !==
              (input.operation === "Approve"
                ? "publishing.review.approve"
                : "publishing.release.publish")
          )
            return fail();
          check();
          const decision = await authorize.call(options, request);
          check();
          return decision;
        },
      },
      unitOfWork: {
        commit: async (value) => {
          check();
          const parsed = parseRecordedPublishingMutation(value),
            receipt = await owner.commit(parsed);
          check();
          if (String(receipt.auditReference) !== parsed.audit.auditId) return fail();
          mutation = parsed;
          return receipt;
        },
      },
    });
    check();
    if (!mutation || canonicalizeRfc8785(result.lifecycle) !== canonicalizeRfc8785(mutation.next))
      return fail();
    return mutation;
  };
  const actual = async (): Promise<MerchantReceiptTemplateLifecycleActualPacket> => {
    if (!action || !submission || !authored || !committed) return fail();
    evidenceCurrent(submission, committed.approval);
    const m = await readHead(submission);
    if (
      m.idempotencyKey !== action.operationReference ||
      m.operation !== action.action ||
      m.next.version !== action.expectedReviewVersion + 1 ||
      m.next.state !== (action.action === "Approve" ? "Approved" : "Published") ||
      m.audit.actor.type !== "User" ||
      m.audit.actor.reference !== fixed.actorReference ||
      canonicalizeRfc8785(m) !== canonicalizeRfc8785(committed.mutation) ||
      !m.approvalEvidence
    )
      return fail();
    const approval = createPublishingApprovalEvidence(m.approvalEvidence);
    approvalPins(approval, submission);
    if (action.action === "Approve") {
      const proof = await owner.resolveCurrentIndependentApproval({
        familyReference: submission.familyReference,
        lifecycleReference: submission.reviewLifecycleReference,
        configurationType: "RECEIPT_TEMPLATE",
        purposeCode: "RECEIPT_ISSUANCE",
        snapshotReference: submission.versionReference,
        snapshotDigest: submission.contentDigest,
        requiredCheckCodes: ["DATA_CONTRACT", "DIGITAL_RENDERER"],
        observedAt: check(),
      });
      check();
      if (
        String(proof.reviewOperationReference) !== submission.operationReference ||
        String(proof.approvalOperationReference) !== action.operationReference ||
        String(proof.approvedByActorReference) !== fixed.actorReference
      )
        return fail();
    } else {
      const proof = await owner.resolveCurrentRelease({
        familyReference: submission.familyReference,
        configurationType: "RECEIPT_TEMPLATE",
        purposeCode: "RECEIPT_ISSUANCE",
        observedAt: check(),
      });
      check();
      if (
        !m.release ||
        canonicalizeRfc8785(proof.release) !== canonicalizeRfc8785(m.release) ||
        canonicalizeRfc8785(proof.approvalEvidence) !== canonicalizeRfc8785(approval) ||
        !committed.publishedVersion ||
        !committed.publicationDigest
      )
        return fail();
    }
    check();
    return Object.freeze({
      mutation: m,
      approval,
      publishedVersion: committed.publishedVersion,
      publicationDigest: committed.publicationDigest,
    });
  };
  const protect = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      failed = true;
      if (error instanceof DigitalReceiptTemplateError) throw error;
      if (error instanceof PublishingServiceError && error.code === "PUBLISHING_PERMISSION_DENIED")
        throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_PERMISSION_DENIED");
      throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_UNAVAILABLE");
    } finally {
      active = false;
    }
  };
  return Object.freeze({
    execute: async (
      actualTx: PublishingTransaction,
      value: unknown,
    ): Promise<MerchantReceiptTemplateLifecycleActualPacket> =>
      protect(async () => {
        if (actualTx !== tx || active || used) return fail();
        active = true;
        used = true;
        check();
        const command = boundAction(value);
        action = command;
        const raw = readClosedRecord(await readSources.call(options, tx, command), [
          "submission",
          "authoredContent",
          "current",
        ]);
        check();
        const s = parseDigitalReceiptTemplateSubmission(raw.submission);
        sourcePins(s, command);
        submission = s;
        evidenceCurrent(s);
        const a = readClosedRecord(raw.authoredContent, [
            "profile",
            "content",
            "authoredByReference",
            "submittedByReference",
            "familyReference",
            "reviewLifecycleReference",
            "reviewVersion",
          ]),
          content = parseDigitalReceiptTemplateContent(a.content);
        if (
          a.profile !== "DigitalReceiptTemplateAuthoredContentV2" ||
          a.authoredByReference !== s.authoredByReference ||
          a.submittedByReference !== s.submittedByReference ||
          a.familyReference !== s.familyReference ||
          a.reviewLifecycleReference !== s.reviewLifecycleReference ||
          a.reviewVersion !== s.reviewVersion ||
          content.tenantReference !== fixed.tenantReference ||
          content.brandReference !== fixed.brandReference ||
          content.storeReference !== fixed.storeReference ||
          content.templateReference !== s.templateReference ||
          content.versionReference !== s.versionReference ||
          `sha256:${sha256Hex(canonicalizeRfc8785(content))}` !== s.contentDigest
        )
          return fail();
        authored = Object.freeze({
          profile: "DigitalReceiptTemplateAuthoredContentV2",
          content,
          authoredByReference: s.authoredByReference,
          submittedByReference: s.submittedByReference,
          familyReference: s.familyReference,
          reviewLifecycleReference: s.reviewLifecycleReference,
          reviewVersion: s.reviewVersion,
        });
        const current = parseRecordedPublishingMutation(raw.current);
        headPins(current, s);
        if (
          current.idempotencyKey !== command.expectedReviewOperationReference ||
          current.next.version !== command.expectedReviewVersion ||
          current.next.state !== (command.action === "Approve" ? "InReview" : "Approved")
        )
          return fail("RECEIPT_TEMPLATE_CONFLICT");
        let approval: PublishingApprovalEvidence,
          mutation: CommitPublishingMutationInput,
          publishedVersion: DigitalReceiptTemplateVersion | null = null,
          publicationDigest: string | null = null;
        if (command.action === "Approve") {
          if (
            fixed.actorReference === s.authoredByReference ||
            fixed.actorReference === s.submittedByReference
          )
            return fail("RECEIPT_TEMPLATE_CONFLICT");
          const validation = current.validationEvidence;
          if (
            current.operation !== "SubmitReview" ||
            current.idempotencyKey !== s.operationReference ||
            current.next.version !== s.reviewVersion ||
            !validation ||
            String(validation.evidenceReference) !== s.validationEvidenceReference ||
            String(validation.checkedAt) !== s.checkedAt ||
            String(validation.validUntil) !== s.validationValidUntil ||
            String(validation.snapshotDigest) !== s.contentDigest ||
            String(validation.snapshotReference) !== s.versionReference ||
            canonicalizeRfc8785(validation.scope) !== canonicalizeRfc8785(scope) ||
            canonicalizeRfc8785([...validation.checkCodes].sort()) !==
              canonicalizeRfc8785(["DATA_CONTRACT", "DIGITAL_RENDERER"]) ||
            current.audit.actor.type !== "User" ||
            current.audit.actor.reference !== s.submittedByReference ||
            current.audit.occurredAt !== s.submittedAt
          )
            return fail();
          const approvedAt = parsePublishingInstant(check()),
            validUntil = parsePublishingInstant(
              new Date(
                Math.min(Date.parse(approvedAt) + duration, Date.parse(s.validationValidUntil)),
              ).toISOString(),
            );
          approval = createPublishingApprovalEvidence({
            evidenceReference: reference("Approval"),
            reviewLifecycleId: current.next.lifecycleId,
            reviewVersion: current.next.version,
            snapshotReference: current.next.snapshotReference,
            snapshotDigest: current.next.snapshotDigest,
            scope,
            decision: "Accepted",
            approvedActorReference: parsePublishingReference(fixed.actorReference),
            approvedAt,
            validUntil,
          });
          approvalPins(approval, s);
          const next = createPublishingLifecycleRecord({
            ...current.next,
            version: parsePublishingVersion(current.next.version + 1),
            state: "Approved",
            approvalEvidenceReference: approval.evidenceReference,
            changedAt: approvedAt,
          });
          mutation = await executeCore({
            tenantContext: context,
            operation: "Approve",
            expectedVersion: current.next.version,
            current: current.next,
            next,
            approvalEvidence: approval,
            idempotencyKey: parsePublishingReference(command.operationReference),
            auditId: reference("Audit"),
            correlationId: parsePublishingReference(command.operationReference),
            occurredAt: next.changedAt,
            sourceChannel: parsePublishingCode("MERCHANT_WEB"),
          });
        } else {
          const proof = await owner.resolveCurrentIndependentApproval({
            familyReference: s.familyReference,
            lifecycleReference: s.reviewLifecycleReference,
            configurationType: "RECEIPT_TEMPLATE",
            purposeCode: "RECEIPT_ISSUANCE",
            snapshotReference: s.versionReference,
            snapshotDigest: s.contentDigest,
            requiredCheckCodes: ["DATA_CONTRACT", "DIGITAL_RENDERER"],
            observedAt: check(),
          });
          check();
          const candidate = await owner.resolvePublicationCandidate({
            familyReference: s.familyReference,
            lifecycleReference: s.reviewLifecycleReference,
            configurationType: "RECEIPT_TEMPLATE",
            purposeCode: "RECEIPT_ISSUANCE",
            observedAt: check(),
          });
          check();
          approval = createPublishingApprovalEvidence(candidate.approvalEvidence);
          approvalPins(approval, s);
          if (
            String(proof.reviewOperationReference) !== s.operationReference ||
            String(proof.approvalOperationReference) !== command.expectedReviewOperationReference ||
            canonicalizeRfc8785(candidate.lifecycle) !== canonicalizeRfc8785(current.next) ||
            String(candidate.validationEvidence.evidenceReference) !==
              s.validationEvidenceReference ||
            String(candidate.validationEvidence.checkedAt) !== s.checkedAt ||
            String(candidate.validationEvidence.validUntil) !== s.validationValidUntil
          )
            return fail();
          const occurredAt = parsePublishingInstant(check()),
            release = createPublishingReleaseRecord({
              releaseId: reference("Release"),
              familyReference: current.next.familyReference,
              configurationType: current.next.configurationType,
              purposeCode: current.next.purposeCode,
              snapshotReference: current.next.snapshotReference,
              snapshotDigest: current.next.snapshotDigest,
              scope,
              sequence: parseReleaseSequence((candidate.previousRelease?.sequence ?? 0) + 1),
              sourceLifecycleId: current.next.lifecycleId,
              kind: "Publish",
              previousReleaseId: candidate.previousRelease?.releaseId ?? null,
              createdAt: occurredAt,
            });
          const next = createPublishingLifecycleRecord({
            ...current.next,
            version: parsePublishingVersion(current.next.version + 1),
            state: "Published",
            changedAt: occurredAt,
          });
          mutation = await executeCore({
            tenantContext: context,
            operation: "Publish",
            expectedVersion: current.next.version,
            current: current.next,
            next,
            validationEvidence: candidate.validationEvidence,
            approvalEvidence: approval,
            release,
            ...(candidate.previousRelease ? { previousRelease: candidate.previousRelease } : {}),
            idempotencyKey: parsePublishingReference(command.operationReference),
            auditId: reference("Audit"),
            correlationId: parsePublishingReference(command.operationReference),
            occurredAt,
            sourceChannel: parsePublishingCode("MERCHANT_WEB"),
          });
          check();
          const expected = materializeDigitalReceiptTemplateContent({
              content,
              publicationReference: release.releaseId,
              publishedAt: release.createdAt,
            }),
            rawVersion = await append.call(
              options,
              tx,
              Object.freeze({ content, release, operationReference: command.operationReference }),
            );
          check();
          publishedVersion = parseDigitalReceiptTemplateVersion(rawVersion);
          if (canonicalizeRfc8785(publishedVersion) !== canonicalizeRfc8785(expected))
            return fail();
          publicationDigest = s.contentDigest;
        }
        committed = Object.freeze({ mutation, approval, publishedVersion, publicationDigest });
        return actual();
      }),
    readActualAction: async (
      actualTx: PublishingTransaction,
      value: unknown,
    ): Promise<MerchantReceiptTemplateLifecycleActualPacket> =>
      protect(async () => {
        if (actualTx !== tx || active || !used || !action || !committed) return fail();
        active = true;
        check();
        const command = boundAction(value);
        if (canonicalizeRfc8785(command) !== canonicalizeRfc8785(action)) return fail();
        return actual();
      }),
  });
}
