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
// Real public Publishing kernel, persistence and Audit with controlled SQL/current admission sources.
// These component fixtures do not establish native PG/IAM or professional/legal receipt qualification.
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
function fixture() {
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
    if (sql.startsWith("SELECT mutation_json,intent_hash,audit_id"))
      return {
        rows: records
          .filter((m) => m.idempotencyKey === values[3])
          .map((m) => ({
            mutation_json: m,
            intent_hash: publishingRecordedMutationDigest(m),
            audit_id: m.audit.auditId,
          })),
      };
    if (sql.startsWith("SELECT mutation_json FROM"))
      return { rows: [...records].reverse().map((m) => ({ mutation_json: m })) };
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
    reviewValidUntil: businessUntil,
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
it("creates actual Publishing Draft and Submit on one held tx with original nonce, explicit business deadline and real Kernel Audits", async () => {
  const f = fixture();
  f.controls.advanceOnCreate = true;
  const result = await f.kernel.submit(f.tx, command());
  expect(f.records).toHaveLength(2);
  const create = f.records[0],
    submit = f.records[1];
  if (!create || !submit) throw Error("actual records required");
  expect(create.operation).toBe("CreateDraft");
  expect(create.expectedVersion).toBe(1);
  expect(create.idempotencyKey).not.toBe(command().operationReference);
  expect(submit.operation).toBe("SubmitReview");
  expect(submit.idempotencyKey).toBe(command().operationReference);
  expect(submit.current).toEqual(create.next);
  expect(submit.next.state).toBe("InReview");
  expect(submit.next.version).toBe(2);
  expect(submit.next.familyReference).toBe(f.draft.familyReference);
  expect(submit.validationEvidence).toMatchObject({
    snapshotReference: id(7),
    snapshotDigest: f.draft.contentDigest,
    validUntil: businessUntil,
    checkCodes: ["DATA_CONTRACT", "DIGITAL_RENDERER"],
  });
  expect(submit.validationEvidence?.checkedAt).toBe("2026-10-04T10:00:00.001Z");
  expect(submit.audit.actor).toEqual({ type: "User", reference: id(4) });
  expect(submit.audit.actionCode).toBe("PUBLISHING_REVIEW_SUBMITTED");
  expect(result).toEqual({
    reviewLifecycleReference: submit.next.lifecycleId,
    submissionOperationReference: id(5),
  });
  expect(f.artifacts).toEqual(["Layout", "Compliance"]);
  expect(f.actions).toEqual(["publishing.draft.create", "publishing.review.submit"]);
  expect(
    f.calls.filter((s) => s.startsWith("INSERT INTO platform_audit.audit_record")),
  ).toHaveLength(2);
  expect(f.calls.some((s) => /^COMMIT|SAVEPOINT/iu.test(s))).toBe(false);
});
it("requires explicit server business expiry and never infers it from the five-second authority window", () => {
  const f = fixture();
  const missing = { ...f.options };
  Object.defineProperty(missing, "reviewValidUntil", { value: undefined });
  expect(() => createMerchantReceiptTemplateSubmitKernel(missing)).toThrow();
  expect(() =>
    createMerchantReceiptTemplateSubmitKernel({ ...f.options, reviewValidUntil: at }),
  ).toThrow();
});
it("missing actual Draft or immutable artifacts refuses before allocating publication identities", async () => {
  for (const missing of ["missingDraft", "missingArtifact"] as const) {
    const f = fixture();
    f.controls[missing] = true;
    await expect(f.kernel.submit(f.tx, command())).rejects.toMatchObject({
      code: "RECEIPT_TEMPLATE_CONFLICT",
    });
    expect(f.allocations).toHaveLength(0);
    expect(f.records).toHaveLength(0);
  }
});
it("foreign actual draft scope or changed CAS is conflict, not another version or invented source", async () => {
  const f = fixture();
  Object.defineProperty(f.options, "readCurrentDraft", {
    value: async () =>
      parseDigitalReceiptTemplateDraft({
        ...f.draft,
        revision: 2,
        previousVersionReference: id(50),
      }),
  });
  const k = createMerchantReceiptTemplateSubmitKernel(f.options);
  await expect(k.submit(f.tx, command())).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_CONFLICT",
  });
  expect(f.records).toHaveLength(0);
});
it("foreign artifact pins are rejected and professional review remains NotEvaluated", async () => {
  const f = fixture();
  Object.defineProperty(f.options, "readArtifact", {
    value: async () =>
      parseDigitalReceiptTemplateArtifactVersion({
        ...f.artifact("Layout"),
        storeReference: id(50),
      }),
  });
  const k = createMerchantReceiptTemplateSubmitKernel(f.options);
  await expect(k.submit(f.tx, command())).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_CONFLICT",
  });
  expect(f.records).toHaveLength(0);
  expect(f.artifact("Compliance").content).toMatchObject({
    professionalReviewStatus: "NotEvaluated",
    legalConclusion: "NotEvaluated",
  });
});
it("actual deny and late Submit permission withdrawal poison the compound operation for caller rollback", async () => {
  const denied = fixture();
  denied.controls.denied = true;
  await expect(denied.kernel.submit(denied.tx, command())).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  });
  expect(denied.records).toHaveLength(0);
  const late = fixture();
  late.controls.submitDenied = true;
  await expect(late.kernel.submit(late.tx, command())).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  });
  expect(late.records.map((m) => m.operation)).toEqual(["CreateDraft"]);
  await expect(late.kernel.submit(late.tx, command())).rejects.toBeInstanceOf(
    DigitalReceiptTemplateError,
  );
});
it("actual tx identity, captured ports and current Actor scope substitutions cannot produce mutations", async () => {
  const f = fixture();
  await expect(f.kernel.submit({ query: f.tx.query }, command())).rejects.toBeInstanceOf(
    DigitalReceiptTemplateError,
  );
  expect(f.records).toHaveLength(0);
  const changed = fixture();
  Object.defineProperty(changed.options, "authorizePublishing", {
    value: async () => {
      throw new Error("substitute");
    },
  });
  await expect(changed.kernel.submit(changed.tx, command())).rejects.toBeInstanceOf(
    DigitalReceiptTemplateError,
  );
  const actor = fixture();
  await expect(
    actor.kernel.submit(actor.tx, { ...command(), actorReference: id(50) }),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_PERMISSION_DENIED" });
  expect(actor.allocations).toHaveLength(0);
});
it("natural original deadline cannot be extended by a future business expiry or source callbacks", async () => {
  const f = fixture();
  f.controls.now = until;
  await expect(f.kernel.submit(f.tx, command())).rejects.toBeInstanceOf(
    DigitalReceiptTemplateError,
  );
  expect(f.records).toHaveLength(0);
});
it("fresh-original producer refuses reentry and a second call after success", async () => {
  const f = fixture();
  await f.kernel.submit(f.tx, command());
  await expect(f.kernel.submit(f.tx, command())).rejects.toBeInstanceOf(
    DigitalReceiptTemplateError,
  );
  expect(f.records).toHaveLength(2);
});
it("a swallowed concurrent reentry poisons the active fresh-original callback before any Publishing write", async () => {
  const f = fixture();

  Object.defineProperty(f.options, "readCurrentDraft", {
    value: async () => {
      if (!kernel) throw new Error("fixture kernel required");
      await expect(kernel.submit(f.tx, command())).rejects.toBeInstanceOf(
        DigitalReceiptTemplateError,
      );
      return f.draft;
    },
  });
  const kernel = createMerchantReceiptTemplateSubmitKernel(f.options);
  await expect(kernel.submit(f.tx, command())).rejects.toBeInstanceOf(DigitalReceiptTemplateError);
  expect(f.records).toHaveLength(0);
});
it("explicit current Store and Actor anchors are checked before using any source or generated identifier", () => {
  const f = fixture();
  expect(() =>
    createMerchantReceiptTemplateSubmitKernel({
      ...f.options,
      scope: { ...scope, storeReference: id(50) },
    }),
  ).toThrow(DigitalReceiptTemplateError);
  expect(() =>
    createMerchantReceiptTemplateSubmitKernel({
      ...f.options,
      scope: { ...scope, actorReference: id(50) },
    }),
  ).toThrow(DigitalReceiptTemplateError);
  expect(f.records).toHaveLength(0);
  expect(f.allocations).toHaveLength(0);
});

it("accepts a real context resolved after request origin but before current held clock", async () => {
  const f = fixture();
  const c = f.options.currentTenantContext;
  f.controls.now = "2026-10-04T10:00:00.020Z";
  const kernel = createMerchantReceiptTemplateSubmitKernel({
    ...f.options,
    currentTenantContext: createTenantContext(
      c.actor,
      c.brand,
      c.store,
      "2026-10-04T10:00:00.010Z",
    ),
  });
  await kernel.submit(f.tx, command());
  expect(f.records).toHaveLength(2);
});
it("rejects a context observation ahead of current held clock", () => {
  const f = fixture();
  const c = f.options.currentTenantContext;
  expect(() =>
    createMerchantReceiptTemplateSubmitKernel({
      ...f.options,
      currentTenantContext: createTenantContext(
        c.actor,
        c.brand,
        c.store,
        "2026-10-04T10:00:00.010Z",
      ),
    }),
  ).toThrow(DigitalReceiptTemplateError);
});
