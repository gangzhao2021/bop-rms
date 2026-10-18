import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import type { PermissionDecision } from "@bop/permission";
import { createTenantContext, type TenantContext } from "@bop/tenant";
import {
  createPostgresPublishingMutationStore,
  executePublishingMutation,
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  parsePublishingReference,
  parsePublishingVersion,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingInstant,
  PublishingServiceError,
  type PublishingTransaction,
  type PublishingAuthorizationRequest,
  type ExecutePublishingMutationInput,
} from "@bop/publishing";
import {
  DigitalReceiptTemplateError,
  parseDeviceReference,
  parseDeviceInstant,
  parseDigitalReceiptTemplateSubmit,
  parseDigitalReceiptTemplateDraft,
  parseDigitalReceiptTemplateArtifactVersion,
  digitalReceiptRequiredFields,
  type DigitalReceiptTemplateSubmit,
  type DigitalReceiptTemplateDraft,
  type DigitalReceiptTemplateDraftActorScope,
  type DigitalReceiptTemplateArtifactVersion,
} from "@rms/printing-device";
export interface MerchantReceiptTemplateSubmitKernelOptions {
  readonly transaction: PublishingTransaction;
  readonly currentTenantContext: TenantContext;
  readonly scope: DigitalReceiptTemplateDraftActorScope;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  /** Explicit server policy business deadline; never derived from the authority lease. */
  readonly reviewValidUntil: string;
  readonly nextReference: (kind: "Lifecycle" | "Operation" | "Audit" | "Validation") => string;
  readonly readCurrentDraft: (
    tx: PublishingTransaction,
    command: DigitalReceiptTemplateSubmit,
  ) => Promise<DigitalReceiptTemplateDraft | null>;
  readonly readArtifact: (
    tx: PublishingTransaction,
    input: Readonly<{ kind: "Layout" | "Compliance"; reference: string }>,
  ) => Promise<DigitalReceiptTemplateArtifactVersion | null>;
  readonly authorizePublishing: (
    request: PublishingAuthorizationRequest,
  ) => Promise<PermissionDecision>;
}
/** Fresh-original-only producer. The surrounding held service owns COMMIT,
 * current IAM/source final guards and the durable original/submission facts. */
export function createMerchantReceiptTemplateSubmitKernel(
  options: MerchantReceiptTemplateSubmitKernelOptions,
) {
  const tx = options.transaction,
    query = tx.query,
    contextOwner = options.currentTenantContext,
    scopeOwner = options.scope,
    clockOwner = options.clock,
    now = clockOwner.now,
    allocate = options.nextReference,
    readDraft = options.readCurrentDraft,
    readArtifact = options.readArtifact,
    authorize = options.authorizePublishing;
  const rawScope = readClosedRecord(scopeOwner, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
  ]);
  const fixed = Object.freeze({
    tenantReference: parseDeviceReference(rawScope.tenantReference),
    brandReference: parseDeviceReference(rawScope.brandReference),
    storeReference: parseDeviceReference(rawScope.storeReference),
    actorReference: parseDeviceReference(rawScope.actorReference),
  });
  const origin = parseDeviceInstant(options.originalObservedAt),
    deadline = parseDeviceInstant(options.originalValidUntil),
    businessUntil = parseDeviceInstant(options.reviewValidUntil),
    context = createTenantContext(
      contextOwner.actor,
      contextOwner.brand,
      contextOwner.store,
      contextOwner.resolvedAt,
    ),
    contextDigest = canonicalizeRfc8785(context);
  let latest = origin,
    failed = false,
    active = false,
    used = false;
  const fail = (
    code: DigitalReceiptTemplateError["code"] = "RECEIPT_TEMPLATE_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new DigitalReceiptTemplateError(code);
  };
  if (
    [query, now, allocate, readDraft, readArtifact, authorize].some(
      (p) => typeof p !== "function",
    ) ||
    deadline <= origin ||
    Date.parse(deadline) - Date.parse(origin) > 5000 ||
    businessUntil <= origin ||
    context.scopeKind !== "Store" ||
    String(context.brand.brandReference) !== fixed.brandReference ||
    String(context.store?.storeReference) !== fixed.storeReference ||
    String(context.actor.actorReference) !== fixed.actorReference
  )
    return fail();
  const check = () => {
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
      options.readCurrentDraft !== readDraft ||
      options.readArtifact !== readArtifact ||
      options.authorizePublishing !== authorize ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== deadline ||
      options.reviewValidUntil !== businessUntil
    )
      return fail();
    const at = parseDeviceInstant(now.call(clockOwner));
    if (at < latest || at >= deadline || at >= businessUntil) return fail();
    latest = at;
    return at;
  };
  if (String(context.resolvedAt) > check()) return fail();
  const reference = (kind: Parameters<typeof allocate>[0]) => {
    check();
    const ref = parsePublishingReference(allocate.call(options, kind));
    check();
    return ref;
  };
  const scope = createPublishingScope({
    kind: "Store",
    brandReference: fixed.brandReference,
    storeReference: fixed.storeReference,
  });
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
  const service = async (input: ExecutePublishingMutationInput) => {
    check();
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
              (input.operation === "CreateDraft"
                ? "publishing.draft.create"
                : "publishing.review.submit")
          )
            return fail();
          check();
          const decision = await authorize.call(options, request);
          check();
          return decision;
        },
      },
      unitOfWork: {
        commit: async (mutation) => {
          check();
          const receipt = await owner.commit(mutation);
          check();
          return receipt;
        },
      },
    });
    check();
    return result;
  };
  return Object.freeze({
    submit: async (actualTx: PublishingTransaction, value: unknown) => {
      try {
        if (actualTx !== tx || active || used) return fail();
        active = true;
        used = true;
        check();
        const command = parseDigitalReceiptTemplateSubmit(value);
        if (
          Object.entries(fixed).some(
            ([key, v]) => Object.getOwnPropertyDescriptor(command, key)?.value !== v,
          )
        )
          return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
        const raw = await readDraft.call(options, tx, command);
        check();
        if (raw === null) return fail("RECEIPT_TEMPLATE_CONFLICT");
        const draft = parseDigitalReceiptTemplateDraft(raw);
        if (
          draft.tenantReference !== fixed.tenantReference ||
          draft.brandReference !== fixed.brandReference ||
          draft.storeReference !== fixed.storeReference ||
          draft.content.templateReference !== command.templateReference ||
          draft.content.versionReference !== command.expectedVersionReference ||
          draft.revision !== command.expectedRevision ||
          draft.updatedAt > check() ||
          `sha256:${sha256Hex(canonicalizeRfc8785(draft.content))}` !== draft.contentDigest
        )
          return fail("RECEIPT_TEMPLATE_CONFLICT");
        for (const [kind, referenceValue] of [
          ["Layout", draft.content.layoutDefinitionReference],
          ["Compliance", draft.content.complianceRuleReference],
        ] as const) {
          const rawArtifact = await readArtifact.call(
            options,
            tx,
            Object.freeze({ kind, reference: referenceValue }),
          );
          check();
          if (rawArtifact === null) return fail("RECEIPT_TEMPLATE_CONFLICT");
          const artifact = parseDigitalReceiptTemplateArtifactVersion(rawArtifact);
          if (
            artifact.artifactKind !== kind ||
            artifact.artifactReference !== referenceValue ||
            artifact.tenantReference !== fixed.tenantReference ||
            artifact.brandReference !== fixed.brandReference ||
            artifact.storeReference !== fixed.storeReference ||
            artifact.updatedAt > check() ||
            canonicalizeRfc8785(artifact.content.requiredFields) !==
              canonicalizeRfc8785(digitalReceiptRequiredFields) ||
            artifact.content.dataContractVersion !== draft.content.dataContractVersion ||
            (kind === "Layout" &&
              (artifact.content.profile !== "AccessibleDigitalReceiptLayoutV1" ||
                artifact.content.renderEngineVersion !== draft.content.renderEngineVersion ||
                artifact.content.outputProfile !== draft.content.outputProfile)) ||
            (kind === "Compliance" &&
              (artifact.content.profile !== "DigitalReceiptRequiredFieldRuleV1" ||
                artifact.content.professionalReviewStatus !== "NotEvaluated" ||
                artifact.content.legalConclusion !== "NotEvaluated"))
          )
            return fail("RECEIPT_TEMPLATE_CONFLICT");
        }
        const lifecycle = reference("Lifecycle"),
          createOperation = reference("Operation"),
          createAudit = reference("Audit"),
          submitAudit = reference("Audit"),
          validationReference = reference("Validation");
        const ids = [
          String(lifecycle),
          String(createOperation),
          String(createAudit),
          String(submitAudit),
          String(validationReference),
          command.operationReference,
        ];
        if (new Set(ids).size !== ids.length) return fail();
        const createdAt = parsePublishingInstant(check()),
          draftLifecycle = createPublishingLifecycleRecord({
            lifecycleId: lifecycle,
            familyReference: parsePublishingReference(draft.familyReference),
            configurationType: parsePublishingCode("RECEIPT_TEMPLATE"),
            purposeCode: parsePublishingCode("RECEIPT_ISSUANCE"),
            snapshotReference: parsePublishingReference(draft.content.versionReference),
            snapshotDigest: parsePublishingDigest(draft.contentDigest),
            scope,
            version: parsePublishingVersion(1),
            state: "Draft",
            validationEvidenceReference: null,
            approvalEvidenceReference: null,
            createdAt,
            changedAt: createdAt,
          });
        const created = await service({
          tenantContext: context,
          operation: "CreateDraft",
          expectedVersion: parsePublishingVersion(1),
          current: null,
          next: draftLifecycle,
          idempotencyKey: createOperation,
          auditId: createAudit,
          correlationId: createOperation,
          occurredAt: createdAt,
          sourceChannel: parsePublishingCode("MERCHANT_WEB"),
        });
        const checkedAt = parsePublishingInstant(check()),
          validation = createPublishingValidationEvidence({
            evidenceReference: validationReference,
            snapshotReference: draftLifecycle.snapshotReference,
            snapshotDigest: draftLifecycle.snapshotDigest,
            scope,
            result: "Pass",
            checkedAt,
            validUntil: parsePublishingInstant(businessUntil),
            checkCodes: [
              parsePublishingCode("DATA_CONTRACT"),
              parsePublishingCode("DIGITAL_RENDERER"),
            ],
          });
        const submittedAt = parsePublishingInstant(check()),
          next = createPublishingLifecycleRecord({
            ...created.lifecycle,
            version: parsePublishingVersion(2),
            state: "InReview",
            validationEvidenceReference: validation.evidenceReference,
            changedAt: submittedAt,
          });
        await service({
          tenantContext: context,
          operation: "SubmitReview",
          expectedVersion: parsePublishingVersion(1),
          current: created.lifecycle,
          next,
          validationEvidence: validation,
          idempotencyKey: parsePublishingReference(command.operationReference),
          auditId: submitAudit,
          correlationId: parsePublishingReference(command.operationReference),
          occurredAt: submittedAt,
          sourceChannel: parsePublishingCode("MERCHANT_WEB"),
        });
        check();
        return Object.freeze({
          reviewLifecycleReference: String(lifecycle),
          submissionOperationReference: command.operationReference,
        });
      } catch (error) {
        failed = true;
        if (error instanceof DigitalReceiptTemplateError) throw error;
        if (
          error instanceof PublishingServiceError &&
          error.code === "PUBLISHING_PERMISSION_DENIED"
        )
          throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_PERMISSION_DENIED");
        throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_UNAVAILABLE");
      } finally {
        active = false;
      }
    },
  });
}
