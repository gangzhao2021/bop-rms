import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  parseRecordedPublishingMutation,
  type CommitPublishingMutationInput,
} from "@bop/publishing";
import {
  createPostgresDigitalReceiptTemplateSubmissionStore,
  type DigitalReceiptTemplateSubmissionStoreOptions,
} from "../infrastructure/persistence/digital-receipt-template-submission-store.js";
import { createDigitalReceiptTemplateDraftContent } from "../contracts/digital-receipt-template-draft-fields.js";
import { parseDigitalReceiptTemplateDraft } from "../contracts/digital-receipt-template-draft.js";
import { DigitalReceiptTemplateError } from "../contracts/digital-receipt-template.js";
// Controlled owning SQL/current Publishing/admission ports: component behavior, not native IAM or producer proof.
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
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(Object.getOwnPropertyDescriptor(v, k)?.value)}`)
      .join(",")}}`;
  const s = JSON.stringify(v);
  if (s === undefined) throw new Error("noncanonical fixture");
  return s;
}
const hash = (v: string) => `sha256:${createHash("sha256").update(v).digest("hex")}`;
const command = () => ({
  templateReference: id(6),
  versionReference: id(7),
  expectedRevision: 1,
  operationReference: id(11),
  reviewLifecycleReference: id(12),
});
function draft() {
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
  return parseDigitalReceiptTemplateDraft({
    profile: "DigitalReceiptTemplateDraftV2",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    familyReference: id(5),
    revision: 1,
    authoredByReference: id(10),
    previousVersionReference: null,
    content,
    contentDigest: hash(canonical(content)),
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  });
}
function mutation(): CommitPublishingMutationInput {
  const d = draft(),
    s = { kind: "Store", brandReference: id(2), storeReference: id(3) },
    current = {
      lifecycleId: id(12),
      familyReference: id(5),
      configurationType: "RECEIPT_TEMPLATE",
      purposeCode: "RECEIPT_ISSUANCE",
      snapshotReference: id(7),
      snapshotDigest: d.contentDigest,
      scope: s,
      version: 1,
      state: "Draft",
      validationEvidenceReference: null,
      approvalEvidenceReference: null,
      createdAt: at,
      changedAt: at,
    };
  return parseRecordedPublishingMutation({
    operation: "SubmitReview",
    expectedVersion: 1,
    idempotencyKey: id(11),
    current,
    next: { ...current, version: 2, state: "InReview", validationEvidenceReference: id(13) },
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: {
      evidenceReference: id(13),
      snapshotReference: id(7),
      snapshotDigest: d.contentDigest,
      scope: s,
      result: "Pass",
      checkedAt: at,
      validUntil: businessUntil,
      checkCodes: ["CURRENT_REFERENCES"],
    },
    approvalEvidence: null,
    audit: {
      auditId: id(14),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "User", reference: id(4) },
      actionCode: "PUBLISHING_REVIEW_SUBMITTED",
      targetType: "PublishingLifecycle",
      targetId: id(12),
      reasonCode: "PUBLISHING_REVIEW_SUBMITTED",
      correlationId: id(11),
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "AUDIT_SECURITY",
      retentionPolicyVersion: 1,
    },
  });
}
function fixture(records: Record<string, unknown>[] = []) {
  let now = at,
    allowed = true,
    current = draft(),
    pub: CommitPublishingMutationInput | null = mutation(),
    lease = until;
  const guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    locks: string[] = [];
  const holds: unknown[] = [];
  let scoped = false;
  const query = vi.fn(async (sql: string, v: readonly unknown[]) => {
    if (sql.includes("bop.tenant_id")) {
      scoped = v[0] === id(1) && v[1] === id(2) && v[2] === id(3);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("transaction_isolation"))
      return { rows: [{ isolation: "read committed" }], rowCount: 1 };
    if (sql.includes("pg_advisory")) {
      locks.push(String(v[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM rms_device.digital_receipt_template_draft_revision")) {
      if (!scoped) throw new Error("controlled scope denial");
      if (sql.includes("version_id=$5") && v[4] !== current.content.versionReference)
        return { rows: [] };
      return {
        rows: [
          {
            template_id: current.content.templateReference,
            family_id: current.familyReference,
            version_id: current.content.versionReference,
            revision: String(current.revision),
            publication_version_number: String(current.content.versionNumber),
            operation_id: id(20),
            actor_id: current.authoredByReference,
            previous_version_id: current.previousVersionReference,
            content_digest: current.contentDigest,
            snapshot_json: current,
            snapshot_digest: hash(canonical(current)),
            created_at: current.createdAt,
            updated_at: current.updatedAt,
          },
        ],
      };
    }
    if (sql.includes("FROM rms_device.digital_receipt_template_submission")) {
      const found = records.filter(
        (r) =>
          r.tenant_id === v[0] &&
          r.brand_id === v[1] &&
          r.store_id === v[2] &&
          (sql.includes("operation_id=$4")
            ? r.operation_id === v[3]
            : r.template_id === v[3] &&
              (sql.includes("version_id=$5") ? r.version_id === v[4] : true)),
      );
      return { rows: found.slice(0, 1) };
    }
    if (sql.startsWith("INSERT INTO rms_device.digital_receipt_template_submission")) {
      if (!scoped) throw new Error("controlled scope denial");
      const keys = [
        "tenant_id",
        "brand_id",
        "store_id",
        "template_id",
        "family_id",
        "version_id",
        "draft_revision",
        "content_digest",
        "authored_by_id",
        "submitted_by_id",
        "operation_id",
        "review_lifecycle_id",
        "review_version",
        "validation_evidence_id",
        "checked_at",
        "validation_valid_until",
        "submitted_at",
        "audit_reference",
      ];
      const row: Record<string, unknown> = Object.fromEntries(
        keys.map((k, i) => [
          k,
          k === "draft_revision" || k === "review_version" ? String(v[i]) : v[i],
        ]),
      );
      row.data_classification = "Internal";
      row.record_json = JSON.parse(String(v[18]));
      row.record_digest = v[19];
      records.push(row);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const tx = { query };
  const readPublishingReview = vi.fn(async () => {
    scoped = false;
    return pub;
  });
  const options: DigitalReceiptTemplateSubmissionStoreOptions = {
    ...scope,
    transaction: tx,
    clock: { now: () => now },
    originalObservedAt: at,
    originalValidUntil: until,
    references: { canonicalize: canonical, hashIntent: hash },
    registerBeforeCommit: (_tx, guard, final) => {
      guards.push(guard);
      finals.push(final);
    },
    authority: {
      holdUntilTransactionCompletes: async (_tx, input) => {
        holds.push(input);
        if (!allowed) throw new Error("controlled withdrawal");
        return { validUntil: lease };
      },
    },
    readPublishingReview,
  };
  const source = createPostgresDigitalReceiptTemplateSubmissionStore(options);
  return {
    source,
    options,
    tx,
    query,
    records,
    locks,
    holds,
    guards,
    finals,
    readPublishingReview,
    deny: () => {
      allowed = false;
    },
    advance: (v: string) => {
      now = v;
    },
    shorten: (v: string) => {
      lease = v;
    },
    setPublishing: (v: CommitPublishingMutationInput | null) => {
      pub = v;
    },
    setDraft: (v: typeof current) => {
      current = v;
    },
    finish: async () => {
      for (const guard of guards) await guard();
      for (const final of finals) final();
      return source.assertFinalized(tx);
    },
  };
}
it("records exact immutable Draft and actual current Submit, preserves author/submitter and Kernel Audit without another Audit", async () => {
  const f = fixture(),
    r = await f.source.write(command());
  expect(r.authoredByReference).toBe(id(10));
  expect(r.submittedByReference).toBe(id(4));
  expect(r.auditReference).toBe(id(14));
  expect(r.reviewVersion).toBe(2);
  expect(f.records).toHaveLength(1);
  expect(f.locks.every((k) => k === `ReceiptTemplate:${id(2)}:${id(3)}:${id(6)}`)).toBe(true);
  expect(
    f.query.mock.calls.some(
      ([s]) => s.includes("INSERT INTO platform_audit") || s.startsWith("SET CONSTRAINTS"),
    ),
  ).toBe(false);
  await expect(f.finish()).resolves.toBe(until);
  expect(f.readPublishingReview).toHaveBeenCalledTimes(2);
});
it("replays original after current Review expiry without today's Publishing qualification or allocation", async () => {
  const first = fixture();
  const r = await first.source.write(command());
  await first.finish();
  const replay = fixture(first.records);
  replay.setPublishing(null);
  const actual = await replay.source.write(command());
  expect(actual).toEqual(r);
  expect(replay.readPublishingReview).not.toHaveBeenCalled();
  await replay.finish();
  expect(replay.records).toHaveLength(1);
});
it("historical authored content joins seven fields for a different current reader without claiming approval", async () => {
  const first = fixture();
  await first.source.write(command());
  await first.finish();
  const f = fixture(first.records);
  Object.defineProperty(f.options, "actorReference", { value: id(99) });
  const s = createPostgresDigitalReceiptTemplateSubmissionStore(f.options);
  const r = await s.readAuthoredContent({ templateReference: id(6), versionReference: id(7) });
  expect(r && Object.keys(r)).toHaveLength(7);
  expect(r?.authoredByReference).toBe(id(10));
  expect(r?.submittedByReference).toBe(id(4));
  for (const g of f.guards) await g();
  for (const a of f.finals) a();
  expect(s.assertFinalized(f.tx)).toBe(until);
  expect(f.readPublishingReview).not.toHaveBeenCalled();
});
it("truthful missing historical and latest records remain null under final authority", async () => {
  for (const latest of [false, true]) {
    const f = fixture();
    expect(
      await (latest
        ? f.source.readLatestSubmission({ templateReference: id(6) })
        : f.source.readSubmission({ templateReference: id(6), versionReference: id(7) })),
    ).toBeNull();
    await f.finish();
    expect(f.readPublishingReview).not.toHaveBeenCalled();
  }
});
it("rejects current Draft CAS mismatch before any new Submission", async () => {
  const f = fixture();
  await expect(f.source.write({ ...command(), expectedRevision: 2 })).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_CONFLICT",
  });
  expect(f.records).toHaveLength(0);
});
it("rejects changed same-operation intent and actor on original replay", async () => {
  const first = fixture();
  await first.source.write(command());
  await first.finish();
  const changed = fixture(first.records);
  await expect(
    changed.source.write({ ...command(), reviewLifecycleReference: id(90) }),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_CONFLICT" });
  const reader = fixture(first.records);
  Object.defineProperty(reader.options, "actorReference", { value: id(90) });
  const s = createPostgresDigitalReceiptTemplateSubmissionStore(reader.options);
  await expect(s.write(command())).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  });
  expect(first.records).toHaveLength(1);
});
for (const patch of [
  { idempotencyKey: id(90) },
  { next: { ...mutation().next, state: "Approved" } },
  { audit: { ...mutation().audit, actor: { type: "User", reference: id(90) } } },
  { validationEvidence: { ...mutation().validationEvidence, validUntil: at } },
])
  it("fails closed on substituted nonce/head/actor or expired actual validation", async () => {
    const f = fixture();
    Object.defineProperty(f.options, "readPublishingReview", {
      value: async () => parseRecordedPublishingMutation({ ...mutation(), ...patch }),
    });
    const s = createPostgresDigitalReceiptTemplateSubmissionStore(f.options);
    await expect(s.write(command())).rejects.toBeInstanceOf(DigitalReceiptTemplateError);
    expect(f.records).toHaveLength(0);
  });
it("final guard rereads actual Publishing head and refuses withdrawal after successful work", async () => {
  const f = fixture();
  await f.source.write(command());
  f.setPublishing(null);
  await expect(f.finish()).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_CONFLICT" });
  expect(() => f.source.assertFinalized(f.tx)).toThrow(DigitalReceiptTemplateError);
});
it("final guard detects immutable Audit identity drift even though public mutation digest omits Audit ID", async () => {
  const f = fixture();
  await f.source.write(command());
  f.setPublishing(
    parseRecordedPublishingMutation({
      ...mutation(),
      audit: { ...mutation().audit, auditId: id(90) },
    }),
  );
  await expect(f.finish()).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_CONFLICT" });
});
it("natural shortest authority expiry and late revocation poison final response", async () => {
  const f = fixture();
  await f.source.write(command());
  f.deny();
  await expect(f.finish()).rejects.toBeInstanceOf(DigitalReceiptTemplateError);
  const expired = fixture();
  expired.shorten("2026-10-04T10:00:01.000Z");
  await expired.source.write(command());
  expired.advance("2026-10-04T10:00:01.000Z");
  await expect(expired.finish()).rejects.toBeInstanceOf(DigitalReceiptTemplateError);
});
it("captured callback drift, missing guards and repeated final guards cannot be swallowed into success", async () => {
  const f = fixture();
  await f.source.readSubmission({ templateReference: id(6), versionReference: id(7) });
  expect(() => f.source.assertFinalized(f.tx)).toThrow(DigitalReceiptTemplateError);
  const changed = fixture();
  await changed.source.write(command());
  Object.defineProperty(changed.options, "readPublishingReview", { value: async () => mutation() });
  await expect(changed.finish()).rejects.toBeInstanceOf(DigitalReceiptTemplateError);
  const twice = fixture();
  await twice.source.write(command());
  await twice.finish();
  expect(() => twice.finals[0]?.()).toThrow(DigitalReceiptTemplateError);
});
it("rejects getter/injection command without evaluating caller getter or invoking owner sources", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(6)),
    input = { ...command() };
  Object.defineProperty(input, "templateReference", { enumerable: true, get: getter });
  await expect(f.source.write(input)).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_INPUT_INVALID",
  });
  expect(getter).not.toHaveBeenCalled();
  expect(f.readPublishingReview).not.toHaveBeenCalled();
});

it("fresh current Draft successor between work and COMMIT is refused while original historical read remains stable", async () => {
  const f = fixture();
  await f.source.write(command());
  const old = draft(),
    content = { ...old.content, versionReference: id(30) };
  f.setDraft(
    parseDigitalReceiptTemplateDraft({
      ...old,
      revision: 2,
      previousVersionReference: old.content.versionReference,
      content,
      contentDigest: hash(canonical(content)),
    }),
  );
  await expect(f.finish()).rejects.toBeInstanceOf(DigitalReceiptTemplateError);
});
it("authority receives exact read/write purpose, inventory and captured identity, and source returns no prospective qualification", async () => {
  const f = fixture();
  await f.source.write(command());
  expect(f.holds[0]).toMatchObject({
    ...scope,
    permission: "publishing.review.submit",
    purposeCode: "RECEIPT_TEMPLATE_SUBMISSION",
    mode: "Write",
    command: command(),
  });
  await f.finish();
  const read = fixture(f.records);
  await read.source.readLatestSubmission({ templateReference: id(6) });
  expect(read.holds[0]).toMatchObject({
    ...scope,
    permission: "organization.manage",
    mode: "ReadLatestSubmission",
    versionReference: null,
  });
  await read.finish();
});
it("nonvoid registration and substituted transaction query refuse before persistent inserts", async () => {
  const f = fixture();
  Object.defineProperty(f.options, "registerBeforeCommit", { value: () => ({ unexpected: true }) });
  const s = createPostgresDigitalReceiptTemplateSubmissionStore(f.options);
  await expect(s.write(command())).rejects.toBeInstanceOf(DigitalReceiptTemplateError);
  expect(f.records).toHaveLength(0);
  const changed = fixture();
  await changed.source.write(command());
  changed.tx.query = vi.fn(async () => ({ rows: [] }));
  await expect(changed.finish()).rejects.toBeInstanceOf(DigitalReceiptTemplateError);
});
it("an actual business validation expiry within the original five-second lease is Conflict, never renewed by admission", async () => {
  const f = fixture();
  const original = mutation();
  f.setPublishing(
    parseRecordedPublishingMutation({
      ...original,
      validationEvidence: {
        ...original.validationEvidence,
        validUntil: "2026-10-04T10:00:01.000Z",
      },
    }),
  );
  f.advance("2026-10-04T10:00:02.000Z");
  await expect(f.source.write(command())).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_CONFLICT",
  });
  expect(f.records).toHaveLength(0);
});

it("a known original nonce on another template is rejected before today's Review callback", async () => {
  const first = fixture();
  await first.source.write(command());
  await first.finish();
  const next = fixture(first.records);
  await expect(
    next.source.write({ ...command(), templateReference: id(90) }),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_CONFLICT" });
  expect(next.readPublishingReview).not.toHaveBeenCalled();
  expect(next.records).toHaveLength(1);
});
