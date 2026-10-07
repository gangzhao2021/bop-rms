import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createIdentityActor } from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import {
  evaluatePermission,
  parsePolicyReference,
  parsePolicyVersion,
  parseEvidenceReference,
  parseEvidenceInstant,
} from "@bop/permission";
import {
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
  type CommitPublishingMutationInput,
  type PublishingTransaction,
} from "@bop/publishing";
import {
  createDigitalReceiptTemplateDraftContent,
  parseDigitalReceiptTemplateDraft,
  parseDigitalReceiptTemplateArtifactVersion,
  parseDigitalReceiptTemplateSubmit,
  digitalReceiptRequiredFields,
  DigitalReceiptTemplateError,
} from "@rms/printing-device";
import {
  createMerchantReceiptTemplateSubmitKernel,
  type MerchantReceiptTemplateSubmitKernelOptions,
} from "./merchant-receipt-template-submit-kernel.js";
import {
  createMerchantReceiptTemplateLifecycleKernel,
  type MerchantReceiptTemplateLifecycleKernelOptions,
} from "./merchant-receipt-template-lifecycle-kernel.js";
import {
  parseDigitalReceiptTemplateSubmission,
  createDigitalReceiptTemplateAuthoredContent,
  parseDigitalReceiptTemplateLifecycleAction,
  materializeDigitalReceiptTemplateContent,
  type DigitalReceiptTemplateLifecycleAction,
} from "@rms/printing-device";
// Actual public Core/store/Audit SQL with controlled owner sources; not native IAM or receipt qualification.
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-04T10:00:00.000Z",
  until = "2026-10-04T10:00:05.000Z",
  businessUntil = "2026-10-04T11:00:00.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const command = () =>
  parseDigitalReceiptTemplateSubmit({
    profile: "DigitalReceiptTemplateSubmitV1",
    ...scope,
    operationReference: id(5),
    templateReference: id(6),
    expectedVersionReference: id(7),
    expectedRevision: 1,
    purposeCode: "RECEIPT_TEMPLATE_REVIEW",
  });
function submittedFixture(reviewUntil = businessUntil) {
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: id(4),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  });
  const brand = createBrand({
    brandReference: id(2),
    code: "BRAND",
    displayName: "Controlled",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    storeReference: id(3),
    brandReference: id(2),
    code: "STORE",
    displayName: "Controlled",
    timeZone: "UTC",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const content = createDigitalReceiptTemplateDraftContent({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    templateReference: id(6),
    versionReference: id(7),
    versionNumber: 1,
    fields: {
      locale: "en-CA",
      layoutDefinitionReference: id(8),
      complianceRuleReference: id(9),
      activation: { mode: "Immediate" },
      effectiveUntil: null,
    },
  });
  const draft = parseDigitalReceiptTemplateDraft({
    profile: "DigitalReceiptTemplateDraftV2",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    familyReference: id(10),
    revision: 1,
    authoredByReference: id(9),
    previousVersionReference: null,
    content,
    contentDigest: `sha256:${sha256Hex(canonicalizeRfc8785(content))}`,
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  });
  const artifact = (kind: "Layout" | "Compliance") =>
    parseDigitalReceiptTemplateArtifactVersion({
      profile: "DigitalReceiptTemplateArtifactV1",
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      artifactKind: kind,
      artifactReference: kind === "Layout" ? id(8) : id(9),
      revision: 1,
      authoredByReference: id(9),
      previousArtifactReference: null,
      content:
        kind === "Layout"
          ? {
              profile: "AccessibleDigitalReceiptLayoutV1",
              dataContractVersion: 1,
              renderEngineVersion: 1,
              outputProfile: "AccessibleDigitalReceipt",
              requiredFields: digitalReceiptRequiredFields,
            }
          : {
              profile: "DigitalReceiptRequiredFieldRuleV1",
              dataContractVersion: 1,
              requiredFields: digitalReceiptRequiredFields,
              professionalReviewStatus: "NotEvaluated",
              legalConclusion: "NotEvaluated",
            },
      createdAt: at,
      updatedAt: at,
      dataClassification: "Internal",
    });
  const controls = {
    now: at,
    denied: false,
    submitDenied: false,
    missingDraft: false,
    missingArtifact: false,
    advanceOnCreate: false,
  };
  const records: CommitPublishingMutationInput[] = [],
    calls: string[] = [],
    allocations: string[] = [],
    actions: string[] = [],
    artifacts: string[] = [];
  let sequence = 1,
    next = 100;
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    calls.push(sql);
    if (sql.startsWith("SELECT mutation_json,intent_hash")) {
      let found = records.filter((m) => m.next.lifecycleId === values[3]);
      if (sql.includes("operation_id=$4"))
        found = records.filter((m) => m.idempotencyKey === values[3]);
      else if (sql.includes("lifecycle_version IN"))
        found = found.filter((m) => values.slice(4).includes(m.next.version));
      else if (sql.includes("lifecycle_version=$5"))
        found = found.filter((m) => m.next.version === values[4]);
      else if (sql.includes("release_id IS NOT NULL"))
        found = records
          .filter((m) => m.next.familyReference === values[3] && m.release !== null)
          .slice(-1);
      else found = found.slice(-1);
      return {
        rows: found.map((m) => ({
          mutation_json: m,
          intent_hash: publishingRecordedMutationDigest(m),
          audit_id: m.audit.auditId,
        })),
        rowCount: found.length,
      };
    }
    if (sql.startsWith("SELECT release_id FROM")) {
      const rows = records
        .filter((m) => m.next.familyReference === values[3] && m.release !== null)
        .slice(-1)
        .map((m) => ({ release_id: m.release?.releaseId }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT mutation_json FROM")) {
      const found = sql.includes("release_id IS NOT NULL")
        ? records
            .filter((m) => m.next.familyReference === values[3] && m.release !== null)
            .slice(-1)
        : records
            .filter((m) => m.next.lifecycleId === values[3])
            .slice()
            .reverse();
      return { rows: found.map((m) => ({ mutation_json: m })), rowCount: found.length };
    }
    if (sql.startsWith("INSERT INTO bop_publishing.publishing_mutation_record")) {
      const m = parseRecordedPublishingMutation(values[14]);
      records.push(m);
      if (controls.advanceOnCreate && m.operation === "CreateDraft")
        controls.now = "2026-10-04T10:00:00.001Z";
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM platform_audit.audit_chain_head"))
      return {
        rows: [
          {
            next_sequence: String(sequence),
            previous_hash: sequence === 1 ? null : "b".repeat(64),
            recorded_at: controls.now,
          },
        ],
      };
    if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
      return { rows: [{ next_sequence: String(++sequence) }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const tx: PublishingTransaction = { query };
  const options: MerchantReceiptTemplateSubmitKernelOptions = {
    transaction: tx,
    currentTenantContext: createTenantContext(actor, brand, store, at),
    scope,
    clock: { now: () => controls.now },
    originalObservedAt: at,
    originalValidUntil: until,
    reviewValidUntil: reviewUntil,
    nextReference: (kind) => {
      allocations.push(kind);
      return id(next++);
    },
    readCurrentDraft: async (actual, c) => {
      expect(actual).toBe(tx);
      expect(c).toEqual(command());
      return controls.missingDraft ? null : draft;
    },
    readArtifact: async (actual, input) => {
      expect(actual).toBe(tx);
      artifacts.push(input.kind);
      return controls.missingArtifact ? null : artifact(input.kind);
    },
    authorizePublishing: async (request) => {
      actions.push(request.action);
      const actorReference = request.tenantContext.actor.actorReference;
      if (actorReference === null) throw new Error("controlled actor missing");
      return evaluatePermission({
        tenantContext: request.tenantContext,
        action: request.action,
        resourceScope: request.resourceScope,
        policySnapshotReference: parsePolicyReference(id(40)),
        policyVersion: parsePolicyVersion(1),
        evidence: [
          {
            source:
              controls.denied ||
              (controls.submitDenied && request.action === "publishing.review.submit")
                ? "ExplicitDeny"
                : "ExplicitAllow",
            evidenceReference: parseEvidenceReference(id(41)),
            action: request.action,
            actorReference,
            roleReference: null,
            brandReference: request.resourceScope.brandReference,
            storeReference: request.resourceScope.storeReference,
            effectiveFrom: parseEvidenceInstant(at),
            effectiveUntil: parseEvidenceInstant(businessUntil),
          },
        ],
      });
    },
  };
  return {
    options,
    tx,
    controls,
    draft,
    artifact,
    records,
    calls,
    allocations,
    actions,
    artifacts,
    kernel: createMerchantReceiptTemplateSubmitKernel(options),
  };
}
async function fixture(actorReference = id(14), reviewUntil = businessUntil) {
  const f = submittedFixture(reviewUntil);
  await f.kernel.submit(f.tx, command());
  const original = f.records.at(-1);
  if (!original || original.audit.actor.type !== "User" || !original.validationEvidence)
    throw new Error("actual submitted record required");
  const submission = parseDigitalReceiptTemplateSubmission({
    profile: "DigitalReceiptTemplateSubmissionV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    templateReference: command().templateReference,
    familyReference: f.draft.familyReference,
    versionReference: command().expectedVersionReference,
    draftRevision: f.draft.revision,
    contentDigest: f.draft.contentDigest,
    authoredByReference: f.draft.authoredByReference,
    submittedByReference: original.audit.actor.reference,
    operationReference: original.idempotencyKey,
    reviewLifecycleReference: original.next.lifecycleId,
    reviewVersion: original.next.version,
    validationEvidenceReference: original.validationEvidence.evidenceReference,
    checkedAt: original.validationEvidence.checkedAt,
    validationValidUntil: original.validationEvidence.validUntil,
    submittedAt: original.audit.occurredAt,
    auditReference: original.audit.auditId,
    dataClassification: "Internal",
  });
  const authored = createDigitalReceiptTemplateAuthoredContent(submission, f.draft),
    actor = createIdentityActor({
      actorType: "User",
      actorReference,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    });
  let ordinal = 500;
  const options: {
    -readonly [
      K in keyof MerchantReceiptTemplateLifecycleKernelOptions
    ]: MerchantReceiptTemplateLifecycleKernelOptions[K];
  } = {
    transaction: f.tx,
    currentTenantContext: createTenantContext(
      actor,
      f.options.currentTenantContext.brand,
      f.options.currentTenantContext.store,
      at,
    ),
    scope: { ...scope, actorReference },
    clock: f.options.clock,
    originalObservedAt: at,
    originalValidUntil: until,
    approvalValidityMs: 24 * 60 * 60 * 1000,
    nextReference: () => id(ordinal++),
    readReviewSources: async () => {
      const current = f.records.at(-1);
      if (!current) throw new Error("actual head missing");
      return { submission, authoredContent: authored, current };
    },
    authorizePublishing: f.options.authorizePublishing,
    appendPublication: vi.fn(async (actual, input) => {
      expect(actual).toBe(f.tx);
      return materializeDigitalReceiptTemplateContent({
        content: input.content,
        publicationReference: input.release.releaseId,
        publishedAt: input.release.createdAt,
      });
    }),
  };

  const action = (
    kind: "Approve" | "Publish" = "Approve",
  ): DigitalReceiptTemplateLifecycleAction => {
    const current = f.records.at(-1);
    if (!current) throw new Error("actual current required");
    return parseDigitalReceiptTemplateLifecycleAction({
      profile: "DigitalReceiptTemplateLifecycleActionV1",
      ...scope,
      actorReference,
      action: kind,
      operationReference: kind === "Approve" ? id(600) : id(601),
      templateReference: command().templateReference,
      expectedVersionReference: command().expectedVersionReference,
      expectedRevision: f.draft.revision,
      reviewLifecycleReference: submission.reviewLifecycleReference,
      expectedReviewVersion: current.next.version,
      expectedReviewOperationReference: current.idempotencyKey,
      purposeCode: "RECEIPT_TEMPLATE_REVIEW",
    });
  };
  return {
    ...f,
    submission,
    authored,
    lifecycleOptions: options,
    action,
    create: () => createMerchantReceiptTemplateLifecycleKernel(options),
  };
}
it("actual public Core independently approves and clamps the explicit 24h business duration to original validation", async () => {
  const f = await fixture(),
    c = f.create(),
    action = f.action(),
    result = await c.execute(f.tx, action);
  expect(result.mutation.operation).toBe("Approve");
  expect(result.mutation.idempotencyKey).toBe(action.operationReference);
  expect(result.mutation.next.version).toBe(3);
  expect(result.approval.approvedActorReference).toBe(id(14));
  expect(result.approval.validUntil).toBe(businessUntil);
  expect(result.publishedVersion).toBeNull();
  expect(f.records).toHaveLength(3);
  expect(f.calls.some((sql) => /SAVEPOINT|COMMIT/u.test(sql))).toBe(false);
  expect(await c.readActualAction(f.tx, action)).toEqual(result);
});
it("retains one actual approval timestamp while reference allocation advances the held clock", async () => {
  const f = await fixture(),
    allocate = f.lifecycleOptions.nextReference;
  f.lifecycleOptions.nextReference = (kind) => {
    const value = allocate(kind);
    if (kind === "Approval") f.controls.now = "2026-10-04T10:00:00.001Z";
    return value;
  };
  const result = await f.create().execute(f.tx, f.action());
  expect(result.mutation.next.changedAt).toBe(result.approval.approvedAt);
  expect(result.mutation.audit.occurredAt).toBe(result.approval.approvedAt);
  expect(f.controls.now).toBe("2026-10-04T10:00:00.001Z");
});
it.each([id(4), id(9)])(
  "rejects the real submitter or original Draft author %s without another mutation",
  async (actor) => {
    const f = await fixture(actor);
    await expect(f.create().execute(f.tx, f.action())).rejects.toMatchObject({
      code: "RECEIPT_TEMPLATE_CONFLICT",
    });
    expect(f.records).toHaveLength(2);
  },
);
it("real Approved history publishes with exact original content activation, release and materialized metadata", async () => {
  const f = await fixture();
  await f.create().execute(f.tx, f.action());
  const c = f.create(),
    action = f.action("Publish"),
    result = await c.execute(f.tx, action);
  expect(result.mutation.operation).toBe("Publish");
  expect(result.mutation.next.version).toBe(4);
  expect(result.mutation.release?.sequence).toBe(1);
  expect(result.publishedVersion?.publicationReference).toBe(result.mutation.release?.releaseId);
  expect(result.publishedVersion?.effectiveFrom).toBe(result.mutation.release?.createdAt);
  expect(result.publicationDigest).toBe(f.submission.contentDigest);
  expect(f.records).toHaveLength(4);
  expect(f.lifecycleOptions.appendPublication).toHaveBeenCalledTimes(1);
  expect(await c.readActualAction(f.tx, action)).toEqual(result);
});
it("readActualAction performs fresh owning reads and refuses tampered latest head", async () => {
  const f = await fixture(),
    c = f.create(),
    action = f.action();
  await c.execute(f.tx, action);
  const before = f.calls.length;
  await c.readActualAction(f.tx, action);
  expect(f.calls.length).toBeGreaterThan(before);
  const head = f.records.at(-1);
  if (!head) throw new Error("actual head required");
  f.records[f.records.length - 1] = parseRecordedPublishingMutation({
    ...head,
    idempotencyKey: id(900),
    audit: { ...head.audit, correlationId: id(900) },
  });
  await expect(c.readActualAction(f.tx, action)).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_UNAVAILABLE",
  });
});
it("refuses expired source validation, future context and an expired original authority clock", async () => {
  const expired = await fixture(id(14), "2026-10-04T10:00:00.001Z");
  expired.controls.now = "2026-10-04T10:00:00.001Z";
  await expect(expired.create().execute(expired.tx, expired.action())).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_CONFLICT",
  });
  const future = await fixture();
  future.lifecycleOptions.currentTenantContext = createTenantContext(
    future.lifecycleOptions.currentTenantContext.actor,
    future.lifecycleOptions.currentTenantContext.brand,
    future.lifecycleOptions.currentTenantContext.store,
    "2026-10-04T10:00:00.001Z",
  );
  expect(() => future.create()).toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  const clock = await fixture();
  clock.controls.now = until;
  expect(() => clock.create()).toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("accepts context resolved after original observation but before actual held time", async () => {
  const f = await fixture();
  f.controls.now = "2026-10-04T10:00:00.002Z";
  f.lifecycleOptions.currentTenantContext = createTenantContext(
    f.lifecycleOptions.currentTenantContext.actor,
    f.lifecycleOptions.currentTenantContext.brand,
    f.lifecycleOptions.currentTenantContext.store,
    "2026-10-04T10:00:00.001Z",
  );
  expect((await f.create().execute(f.tx, f.action())).mutation.operation).toBe("Approve");
});
it("late approval expiry is checked afresh while the original five second authority remains alive", async () => {
  const f = await fixture();
  f.lifecycleOptions.approvalValidityMs = 1;
  const c = f.create(),
    action = f.action();
  await c.execute(f.tx, action);
  f.controls.now = "2026-10-04T10:00:00.001Z";
  await expect(c.readActualAction(f.tx, action)).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_CONFLICT",
  });
});
it("captures callbacks and rejects foreign operation, source snapshot or current root", async () => {
  const drift = await fixture(),
    c = drift.create();
  drift.lifecycleOptions.authorizePublishing = async () => {
    throw new Error("replaced");
  };
  await expect(c.execute(drift.tx, drift.action())).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(drift.records).toHaveLength(2);
  const pins = await fixture();
  const submitted = pins.records[1];
  if (!submitted) throw new Error("actual submitted head required");
  pins.lifecycleOptions.readReviewSources = async () => ({
    submission: pins.submission,
    authoredContent: pins.authored,
    current: parseRecordedPublishingMutation({
      ...submitted,
      next: { ...submitted.next, snapshotDigest: `sha256:${"a".repeat(64)}` },
    }),
  });
  await expect(pins.create().execute(pins.tx, pins.action())).rejects.toThrow();
  expect(pins.records).toHaveLength(2);
});
it("actual permission Deny and failed Device append poison the kernel without an invented published success", async () => {
  const denied = await fixture();
  denied.controls.denied = true;
  await expect(denied.create().execute(denied.tx, denied.action())).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  });
  expect(denied.records).toHaveLength(2);
  const f = await fixture();
  await f.create().execute(f.tx, f.action());
  f.lifecycleOptions.appendPublication = async () => {
    throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_UNAVAILABLE");
  };
  const c = f.create(),
    action = f.action("Publish");
  await expect(c.execute(f.tx, action)).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_UNAVAILABLE",
  });
  await expect(c.readActualAction(f.tx, action)).rejects.toThrow();
  // The borrowed component transport has no COMMIT/rollback; real outer service
  // must roll back the tentative Publishing mutation and Device append together.
  expect(f.calls.some((sql) => /SAVEPOINT|COMMIT/u.test(sql))).toBe(false);
});
it("read-before-execute, reentry and a changed exact original cannot become another action", async () => {
  const f = await fixture(),
    c = f.create(),
    action = f.action();
  await expect(c.readActualAction(f.tx, action)).rejects.toThrow();
  const g = await fixture(),
    k = g.create(),
    a = g.action();
  await k.execute(g.tx, a);
  await expect(k.execute(g.tx, a)).rejects.toThrow();
  const h = await fixture(),
    reader = h.create(),
    original = h.action();
  await reader.execute(h.tx, original);
  await expect(
    reader.readActualAction(h.tx, { ...original, operationReference: id(901) }),
  ).rejects.toThrow();
});
