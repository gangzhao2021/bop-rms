import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import { parseRecordedPublishingMutation } from "@bop/publishing";
import {
  createPostgresDigitalReceiptTemplateLifecycleStore,
  type DigitalReceiptTemplateLifecycleStoreOptions,
  type DigitalReceiptTemplateLifecycleActualPacket,
  type DigitalReceiptTemplateLifecycleTransaction,
} from "../infrastructure/persistence/digital-receipt-template-lifecycle-store.js";
import {
  parseDigitalReceiptTemplateLifecycleAction,
  parseDigitalReceiptTemplateLifecycleReceipt,
  type DigitalReceiptTemplateLifecycleReceipt,
} from "../contracts/digital-receipt-template-lifecycle-action.js";
import { parseDigitalReceiptTemplateSubmission } from "../contracts/digital-receipt-template-submission.js";
import { createDigitalReceiptTemplateDraftContent } from "../contracts/digital-receipt-template-draft-fields.js";
import {
  materializeDigitalReceiptTemplateContent,
  type DigitalReceiptTemplateContent,
} from "../contracts/digital-receipt-template-content.js";
import { DigitalReceiptTemplateError } from "../contracts/digital-receipt-template.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  end = "2026-10-05T10:00:05.000Z",
  historical = "2026-10-05T09:59:00.000Z",
  business = "2026-10-05T11:00:00.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function command(action: "Approve" | "Publish" = "Approve") {
  return parseDigitalReceiptTemplateLifecycleAction({
    profile: "DigitalReceiptTemplateLifecycleActionV1",
    ...scope,
    action,
    operationReference: action === "Approve" ? id(20) : id(21),
    templateReference: id(6),
    expectedVersionReference: id(7),
    expectedRevision: 1,
    reviewLifecycleReference: id(8),
    expectedReviewVersion: action === "Approve" ? 2 : 3,
    expectedReviewOperationReference: action === "Approve" ? id(9) : id(20),
    purposeCode: "RECEIPT_TEMPLATE_REVIEW",
  });
}
function facts() {
  const content = createDigitalReceiptTemplateDraftContent({
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    templateReference: id(6),
    versionReference: id(7),
    versionNumber: 1,
    fields: {
      locale: "en-CA",
      layoutDefinitionReference: id(10),
      complianceRuleReference: id(11),
      activation: { mode: "Immediate" },
      effectiveUntil: null,
    },
  });
  const submission = parseDigitalReceiptTemplateSubmission({
    profile: "DigitalReceiptTemplateSubmissionV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    templateReference: id(6),
    familyReference: id(12),
    versionReference: id(7),
    draftRevision: 1,
    contentDigest: hash(content),
    authoredByReference: id(13),
    submittedByReference: id(14),
    operationReference: id(9),
    reviewLifecycleReference: id(8),
    reviewVersion: 2,
    validationEvidenceReference: id(15),
    checkedAt: historical,
    validationValidUntil: business,
    submittedAt: historical,
    auditReference: id(16),
    dataClassification: "Internal",
  });
  return { content, submission };
}
function actual(
  action: "Approve" | "Publish",
  content: DigitalReceiptTemplateContent,
): DigitalReceiptTemplateLifecycleActualPacket {
  const c = command(action),
    h = hash(content),
    pubScope = { kind: "Store", brandReference: id(2), storeReference: id(3) };
  const approval = {
    evidenceReference: id(17),
    reviewLifecycleId: id(8),
    reviewVersion: 2,
    snapshotReference: id(7),
    snapshotDigest: h,
    scope: pubScope,
    decision: "Accepted",
    approvedActorReference: id(4),
    approvedAt: at,
    validUntil: business,
  };
  const base = {
    lifecycleId: id(8),
    familyReference: id(12),
    configurationType: "RECEIPT_TEMPLATE",
    purposeCode: "RECEIPT_ISSUANCE",
    snapshotReference: id(7),
    snapshotDigest: h,
    scope: pubScope,
    validationEvidenceReference: id(15),
    createdAt: historical,
  };
  const version =
    action === "Publish"
      ? materializeDigitalReceiptTemplateContent({
          content,
          publicationReference: id(18),
          publishedAt: at,
        })
      : null;
  const mutation = parseRecordedPublishingMutation({
    operation: action,
    expectedVersion: c.expectedReviewVersion,
    idempotencyKey: c.operationReference,
    current: {
      ...base,
      version: c.expectedReviewVersion,
      state: action === "Approve" ? "InReview" : "Approved",
      changedAt: action === "Approve" ? historical : at,
      approvalEvidenceReference: action === "Approve" ? null : id(17),
    },
    next: {
      ...base,
      version: c.expectedReviewVersion + 1,
      state: action === "Approve" ? "Approved" : "Published",
      changedAt: at,
      approvalEvidenceReference: id(17),
    },
    release:
      action === "Approve"
        ? null
        : {
            releaseId: id(18),
            familyReference: id(12),
            configurationType: "RECEIPT_TEMPLATE",
            purposeCode: "RECEIPT_ISSUANCE",
            snapshotReference: id(7),
            snapshotDigest: h,
            scope: pubScope,
            kind: "Publish",
            sequence: 1,
            sourceLifecycleId: id(8),
            previousReleaseId: null,
            createdAt: at,
          },
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: null,
    approvalEvidence: approval,
    audit: validateAuditRecord({
      auditId: action === "Approve" ? id(30) : id(31),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "User", reference: id(4) },
      actionCode:
        action === "Approve" ? "PUBLISHING_REVIEW_APPROVED" : "PUBLISHING_RELEASE_PUBLISHED",
      targetType: "PublishingLifecycle",
      targetId: id(8),
      reasonCode:
        action === "Approve" ? "PUBLISHING_REVIEW_APPROVED" : "PUBLISHING_RELEASE_PUBLISHED",
      correlationId: c.operationReference,
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "AUDIT_SECURITY",
      retentionPolicyVersion: 1,
    }),
  });
  if (!mutation.approvalEvidence) throw new Error("actual fixture approval missing");
  return {
    mutation,
    approval: mutation.approvalEvidence,
    publishedVersion: version,
    publicationDigest: version ? h : null,
  };
}
function database() {
  return {
    originals: new Map<string, DigitalReceiptTemplateLifecycleReceipt>(),
    ...facts(),
    published: null as DigitalReceiptTemplateLifecycleActualPacket | null,
    deviceAuditReference: id(32),
    corrupt: false,
    collision: false,
  };
}
function row(r: DigitalReceiptTemplateLifecycleReceipt) {
  return {
    operation_id: r.operationReference,
    tenant_id: r.tenantReference,
    brand_id: r.brandReference,
    store_id: r.storeReference,
    actor_id: r.actorReference,
    action: r.action,
    template_id: r.templateReference,
    expected_version_id: r.expectedVersionReference,
    expected_revision: String(r.expectedRevision),
    review_lifecycle_id: r.reviewLifecycleReference,
    expected_review_version: String(r.expectedReviewVersion),
    expected_review_operation_id: r.expectedReviewOperationReference,
    intent_digest: r.intentDigest,
    outcome: r.outcome,
    result_digest: r.result ? hash(r.result) : null,
    audit_reference: r.auditReference,
    occurred_at: r.occurredAt,
    receipt_json: r,
    receipt_digest: hash(r),
    data_classification: "Confidential",
  };
}
/** Controlled SQL and Core callbacks, not native IAM or publication proof. All owning parsers and host guards are real. */
function fixture(db = database(), action: "Approve" | "Publish" = "Approve", origin = at) {
  let now = origin,
    lease = new Date(Date.parse(origin) + 5000).toISOString(),
    deny = false,
    source = actual(action, db.content),
    persistPublished = true;
  const guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    locks: unknown[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    if (sql.includes("pg_advisory")) {
      locks.push(values[0]);
      return { rows: [] };
    }
    if (sql.startsWith("SELECT") && sql.includes("digital_receipt_template_lifecycle_operation")) {
      const r = db.originals.get(String(values[3]));
      return { rows: r ? [{ ...row(r), receipt_digest: db.corrupt ? hash("bad") : hash(r) }] : [] };
    }
    if (sql.startsWith("SELECT record_json"))
      return { rows: [{ record_json: db.submission, record_digest: hash(db.submission) }] };
    if (sql.startsWith("SELECT version_json")) {
      const p = db.published;
      return {
        rows: p
          ? [
              {
                version_json: p.publishedVersion,
                operation_id: id(21),
                audit_id: db.deviceAuditReference,
                publication_digest: p.publicationDigest,
              },
            ]
          : [],
      };
    }
    if (sql.startsWith("INSERT")) {
      if (db.collision)
        throw Object.assign(new Error("controlled hidden terminal collision"), { code: "23505" });
      expect(values).toHaveLength(19);
      const r = parseDigitalReceiptTemplateLifecycleReceipt(JSON.parse(String(values[17])));
      expect(values[18]).toBe(hash(r));
      expect(values[14]).toBe(r.result ? hash(r.result) : null);
      db.originals.set(r.operationReference, r);
      return { rows: [], rowCount: 1 };
    }
    throw new Error("unexpected controlled query");
  });
  const tx = { query };
  const perform = vi.fn(
    async (actualTx: DigitalReceiptTemplateLifecycleTransaction, c: ReturnType<typeof command>) => {
      expect(actualTx).toBe(tx);
      expect(c).toEqual(command(action));
      if (action === "Publish" && persistPublished) db.published = source;
      return source;
    },
  );
  const read = vi.fn(async (actualTx: DigitalReceiptTemplateLifecycleTransaction) => {
    expect(actualTx).toBe(tx);
    return source;
  });
  const abandon = vi.fn(
    async (actualTx: DigitalReceiptTemplateLifecycleTransaction, p: { occurredAt: string }) => {
      expect(actualTx).toBe(tx);
      return { auditReference: id(40), occurredAt: p.occurredAt };
    },
  );
  const hold = vi.fn(
    async (
      actualTx: DigitalReceiptTemplateLifecycleTransaction,
      p: Parameters<
        DigitalReceiptTemplateLifecycleStoreOptions["authority"]["holdUntilTransactionCompletes"]
      >[1],
    ) => {
      expect(actualTx).toBe(tx);
      expect(p.permission).toBe(
        action === "Approve" ? "publishing.review.approve" : "publishing.release.publish",
      );
      if (deny) throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_PERMISSION_DENIED");
      return { validUntil: lease };
    },
  );
  const options: DigitalReceiptTemplateLifecycleStoreOptions = {
    ...scope,
    transaction: tx,
    clock: { now: () => now },
    originalObservedAt: origin,
    originalValidUntil: lease,
    references: { canonicalize: canonicalizeRfc8785, hashIntent: (v) => "sha256:" + sha256Hex(v) },
    registerBeforeCommit: (_tx, g, f) => {
      guards.push(g);
      finals.push(f);
    },
    authority: { holdUntilTransactionCompletes: hold },
    performAction: perform,
    readActualAction: read,
    appendAbandonedIntent: abandon,
  };
  const store = createPostgresDigitalReceiptTemplateLifecycleStore(options);
  const commit = async () => {
    for (const g of guards) await g();
    for (const f of finals) f();
    return store.assertFinalized(tx);
  };
  const resolve = () => ({
    ...command(action),
    profile: "DigitalReceiptTemplateLifecycleResolveV1",
    intentDigest: hash(command(action)),
  });
  return {
    db,
    store,
    options,
    tx,
    query,
    hold,
    perform,
    read,
    abandon,
    guards,
    finals,
    locks,
    commit,
    resolve,
    setNow: (s: string) => {
      now = s;
    },
    setLease: (s: string) => {
      lease = s;
    },
    setDeny: () => {
      deny = true;
    },
    setPacket: (p: DigitalReceiptTemplateLifecycleActualPacket) => {
      source = p;
    },
    getPacket: () => source,
    noPublished: () => {
      persistPublished = false;
    },
  };
}
it("commits actual independent Approve result, original intent and mandatory final guards under global-before-template fences", async () => {
  const f = fixture(),
    r = await f.store.execute(command());
  expect(r.result?.state).toBe("Approved");
  expect(r.auditReference).toBe(id(30));
  expect(f.locks.slice(0, 2)).toEqual([
    `ReceiptTemplateLifecycleOriginal:${id(20)}`,
    `ReceiptTemplate:${id(2)}:${id(3)}:${id(6)}`,
  ]);
  expect(f.abandon).not.toHaveBeenCalled();
  await expect(f.commit()).resolves.toBe(end);
  expect(f.read).toHaveBeenCalledTimes(1);
});
it("publishes only with the actual original Approve terminal and exact owning appended version", async () => {
  const db = database(),
    a = fixture(db);
  await a.store.execute(command());
  await a.commit();
  const f = fixture(db, "Publish"),
    r = await f.store.execute(command("Publish"));
  expect(r.result?.publishedVersion?.publicationReference).toBe(id(18));
  await f.commit();
  expect(db.originals.size).toBe(2);
});
it("retains the separate actual Device audit tuple through final publication guard", async () => {
  const db = database(),
    a = fixture(db);
  await a.store.execute(command());
  await a.commit();
  const f = fixture(db, "Publish");
  await f.store.execute(command("Publish"));
  expect(db.deviceAuditReference).not.toBe(id(31));
  db.deviceAuditReference = id(33);
  await expect(f.commit()).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_UNAVAILABLE" });
});
it("recovers expired original approvals without re-reading today's submission or running Core", async () => {
  const db = database(),
    a = fixture(db);
  const original = await a.store.execute(command());
  await a.commit();
  const f = fixture(db, "Approve", "2026-10-05T12:00:00.000Z");
  expect(await f.store.resolve(f.resolve())).toEqual(original);
  await f.commit();
  expect(f.perform).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.query.mock.calls.some((c) => c[0].startsWith("SELECT record_json"))).toBe(false);
});
it("durably abandons a genuine absence, then refuses late Execute without producing an action", async () => {
  const db = database(),
    a = fixture(db),
    r = await a.store.resolve(a.resolve());
  expect(r.outcome).toBe("Abandoned");
  await a.commit();
  expect(a.abandon).toHaveBeenCalledTimes(1);
  const f = fixture(db);
  expect(await f.store.execute(command())).toEqual(r);
  await f.commit();
  expect(f.perform).not.toHaveBeenCalled();
});
it("does not claim absence on a hidden original PK collision", async () => {
  const f = fixture();
  f.db.collision = true;
  await expect(f.store.resolve(f.resolve())).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  await expect(f.commit()).rejects.toThrow();
});
it("refuses Publish without a real prior Approve terminal or owning version append", async () => {
  const f = fixture(undefined, "Publish");
  await expect(f.store.execute(command("Publish"))).rejects.toThrow("RECEIPT_TEMPLATE_CONFLICT");
  const db = database(),
    a = fixture(db);
  await a.store.execute(command());
  await a.commit();
  const p = fixture(db, "Publish");
  p.noPublished();
  await expect(p.store.execute(command("Publish"))).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("refuses a structurally valid approval authored by the Draft author or original submitter", async () => {
  for (const actorField of ["authoredByReference", "submittedByReference"]) {
    const f = fixture();
    f.db.submission = parseDigitalReceiptTemplateSubmission({
      ...f.db.submission,
      [actorField]: id(4),
    });
    await expect(f.store.execute(command())).rejects.toThrow("RECEIPT_TEMPLATE_CONFLICT");
  }
});
it("refuses changed original identity and Actor, and corrupt immutable receipt hashes", async () => {
  const db = database(),
    a = fixture(db);
  await a.store.execute(command());
  await a.commit();
  const changed = fixture(db);
  await expect(changed.store.execute({ ...command(), expectedRevision: 2 })).rejects.toThrow(
    "RECEIPT_TEMPLATE_CONFLICT",
  );
  const wrong = fixture(db);
  await expect(wrong.store.execute({ ...command(), actorReference: id(80) })).rejects.toThrow(
    "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  );
  const bad = fixture(db);
  db.corrupt = true;
  await expect(bad.store.execute(command())).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("holds current fine permissions even on original recovery and rejects late withdrawal", async () => {
  const f = fixture();
  await f.store.execute(command());
  f.setDeny();
  await expect(f.commit()).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(() => f.store.assertFinalized(f.tx)).toThrow();
});
it("refuses final current action or owning provenance drift rather than trusting the initial callback", async () => {
  const f = fixture();
  await f.store.execute(command());
  const p = f.getPacket();
  f.setPacket({ ...p, publicationDigest: hash("forged") });
  await expect(f.commit()).rejects.toThrow();
  const g = fixture();
  await g.store.execute(command());
  g.db.submission = parseDigitalReceiptTemplateSubmission({
    ...g.db.submission,
    authoredByReference: id(70),
  });
  await expect(g.commit()).rejects.toThrow("RECEIPT_TEMPLATE_CONFLICT");
});
it("poisons query, callback and clock replacement, original expiry and missing mandatory hooks", async () => {
  const f = fixture();
  await f.store.execute(command());
  f.tx.query = vi.fn(async () => ({ rows: [] }));
  await expect(f.commit()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  const g = fixture();
  await g.store.execute(command());
  g.setNow(end);
  await expect(g.commit()).rejects.toThrow();
  const h = fixture();
  await h.store.execute(command());
  expect(() => h.store.assertFinalized(h.tx)).toThrow();
});
it("does not invoke getter-bearing commands or allow a swallowed second invocation to commit", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(7)),
    c = { ...command() };
  Object.defineProperty(c, "expectedVersionReference", { enumerable: true, get: getter });
  await expect(f.store.execute(c)).rejects.toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
  expect(getter).not.toHaveBeenCalled();
  const g = fixture();
  await g.store.execute(command());
  await expect(g.store.execute(command())).rejects.toThrow();
  await expect(g.commit()).rejects.toThrow();
});
it("tightens a shorter genuine authority lease and checks repeated async/final execution", async () => {
  const f = fixture();
  f.setLease("2026-10-05T10:00:02.000Z");
  await f.store.execute(command());
  expect(await f.commit()).toBe("2026-10-05T10:00:02.000Z");
  const g = fixture();
  await g.store.execute(command());
  await g.commit();
  const guard = g.guards[0];
  if (!guard) throw new Error("missing actual hook");
  await expect(guard()).rejects.toThrow();
});
it("captures the actual action read port and rejects callback replacement before COMMIT", async () => {
  const f = fixture();
  await f.store.execute(command());
  Object.defineProperty(f.options, "readActualAction", { value: async () => f.getPacket() });
  await expect(f.commit()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
});
it("rejects backwards actual clock and changed lease without renewing the original host window", async () => {
  const f = fixture();
  await f.store.execute(command());
  f.setNow(historical);
  await expect(f.commit()).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  const g = fixture();
  g.setLease(at);
  await expect(g.store.execute(command())).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(g.perform).not.toHaveBeenCalled();
});
it("requires original Resolve digest and exact receipt scope independently of a successful callback", async () => {
  const f = fixture();
  await expect(
    f.store.resolve({ ...f.resolve(), intentDigest: hash("different") }),
  ).rejects.toThrow("RECEIPT_TEMPLATE_CONFLICT");
  expect(f.abandon).not.toHaveBeenCalled();
  const g = fixture();
  await expect(g.store.execute({ ...command(), storeReference: id(99) })).rejects.toThrow(
    "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  );
  expect(g.perform).not.toHaveBeenCalled();
});
