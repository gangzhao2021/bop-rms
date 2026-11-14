import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createIdentityActor, BrowserSessionError } from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import {
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseEvidenceReference,
  parseEvidenceInstant,
} from "@bop/permission";
import { parseRecordedPublishingMutation, publishingRecordedMutationDigest } from "@bop/publishing";
import {
  digitalReceiptRequiredFields,
  createDigitalReceiptTemplateDraftContent,
  parseDigitalReceiptTemplateDraft,
  parseDigitalReceiptTemplateArtifactVersion,
  parseDigitalReceiptTemplateSubmit,
} from "@rms/printing-device";
import { createMerchantReceiptTemplateSubmit } from "./merchant-receipt-template-submit.js";
const mocks = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.scope }));
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
const scope4 = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const body = () => ({
  command: "SubmitReview",
  operationReference: id(20),
  templateReference: id(6),
  expectedVersionReference: id(7),
  expectedRevision: 1,
});
const intent = () =>
  hash(
    parseDigitalReceiptTemplateSubmit({
      profile: "DigitalReceiptTemplateSubmitV1",
      ...scope4,
      operationReference: id(20),
      templateReference: id(6),
      expectedVersionReference: id(7),
      expectedRevision: 1,
      purposeCode: "RECEIPT_TEMPLATE_REVIEW",
    }),
  );
function db() {
  return {
    publishing: [] as ReturnType<typeof parseRecordedPublishingMutation>[],
    submissions: [] as Record<string, unknown>[],
    operations: [] as Record<string, unknown>[],
    audits: [] as (readonly unknown[])[],
    nextSequence: 1,
    previousHash: null as string | null,
  };
}
function seed() {
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
  const snapshot = parseDigitalReceiptTemplateDraft({
    profile: "DigitalReceiptTemplateDraftV2",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    familyReference: id(10),
    revision: 1,
    authoredByReference: id(11),
    previousVersionReference: null,
    content,
    contentDigest: hash(content),
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  });
  return {
    template_id: id(6),
    family_id: id(10),
    version_id: id(7),
    revision: "1",
    publication_version_number: "1",
    operation_id: id(12),
    actor_id: id(11),
    previous_version_id: null,
    content_digest: hash(content),
    snapshot_json: snapshot,
    snapshot_digest: hash(snapshot),
    created_at: at,
    updated_at: at,
  };
}
function operationRow(values: readonly unknown[]) {
  return {
    operation_id: values[0],
    tenant_id: values[1],
    brand_id: values[2],
    store_id: values[3],
    actor_id: values[4],
    template_id: values[5],
    expected_version_id: values[6],
    expected_revision: String(values[7]),
    intent_digest: values[8],
    outcome: values[9],
    result_review_lifecycle_id: values[10],
    result_review_version: values[11] === null ? null : String(values[11]),
    submission_digest: values[12],
    audit_reference: values[13],
    occurred_at: values[14],
    receipt_json: JSON.parse(String(values[15])),
    receipt_digest: values[16],
  };
}
function submissionRow(values: readonly unknown[]) {
  return {
    tenant_id: values[0],
    brand_id: values[1],
    store_id: values[2],
    template_id: values[3],
    family_id: values[4],
    version_id: values[5],
    draft_revision: String(values[6]),
    content_digest: values[7],
    authored_by_id: values[8],
    submitted_by_id: values[9],
    operation_id: values[10],
    review_lifecycle_id: values[11],
    review_version: String(values[12]),
    validation_evidence_id: values[13],
    checked_at: values[14],
    validation_valid_until: values[15],
    submitted_at: values[16],
    audit_reference: values[17],
    data_classification: "Internal",
    record_json: JSON.parse(String(values[18])),
    record_digest: values[19],
  };
}
beforeEach(() => vi.resetAllMocks());
/** Actual Device/Publishing/Audit factories and transaction host; only SQL transport and Session scope are controlled. */
function fixture(database = db()) {
  const controls = {
    now: at,
    clockHook: () => undefined,
    allowed: true,
    fineDenied: "",
    lease: until,
    lateCreate: false,
    lateFine: false,
    artifactMissing: false,
    drift: false,
    lateGuard: false,
    expireOnSubmit: false,
  };
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
    code: "CONTROLLED",
    displayName: "Controlled Brand",
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
    code: "CONTROLLED",
    displayName: "Controlled Store",
    locale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const actorReference = actor.actorReference;
  if (actorReference === null) throw new Error("controlled User missing");
  const context = createTenantContext(actor, brand, store, at),
    sql: string[] = [],
    reads: string[] = [];
  const scope = {
    selected: { tenantReference: id(1) },
    context,
    actorReference: id(4),
    sessionReference: id(5),
    store,
    allowed: vi.fn(async () => controls.allowed),
    authorizationValidUntil: () => controls.lease,
    authorizeAction: vi.fn(async (action: string) =>
      evaluatePermission({
        tenantContext: context,
        action: parseBusinessAction(action),
        resourceScope: {
          kind: "Store",
          brandReference: brand.brandReference,
          storeReference: store.storeReference,
        },
        policySnapshotReference: parsePolicyReference(id(30)),
        policyVersion: parsePolicyVersion(1),
        evidence: [
          {
            source: controls.fineDenied === action ? "ExplicitDeny" : "ExplicitAllow",
            evidenceReference: parseEvidenceReference(id(31)),
            action: parseBusinessAction(action),
            actorReference,
            roleReference: null,
            brandReference: brand.brandReference,
            storeReference: store.storeReference,
            effectiveFrom: parseEvidenceInstant(at),
            effectiveUntil: null,
          },
        ],
      }),
    ),
  };
  mocks.scope.mockImplementation(async (_tx, _cookie, action, session) => {
    expect(action).toBe("organization.manage");
    expect(session).toBe(id(5));
    return scope;
  });
  const query = vi.fn(async (statement: string, v: readonly unknown[]) => {
    sql.push(statement);
    if (statement.includes("transaction_isolation"))
      return { rows: [{ isolation: "read committed" }], rowCount: 1 };
    if (statement.includes("FROM rms_device.digital_receipt_template_draft_revision")) {
      reads.push("Draft");
      return { rows: [seed()], rowCount: 1 };
    }
    if (statement.includes("FROM rms_device.digital_receipt_template_artifact_version")) {
      const kind = v[3] === "Layout" ? "Layout" : "Compliance",
        reference = String(v[4]);
      reads.push(kind + ":" + reference);
      if (controls.artifactMissing) return { rows: [], rowCount: 0 };
      const snapshot = parseDigitalReceiptTemplateArtifactVersion({
        profile: "DigitalReceiptTemplateArtifactV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        artifactKind: kind,
        artifactReference: reference,
        revision: 1,
        authoredByReference: id(11),
        previousArtifactReference: null,
        content:
          kind === "Layout"
            ? {
                profile: "AccessibleDigitalReceiptLayoutV1",
                dataContractVersion: 1,
                renderEngineVersion: 1,
                outputProfile: "AccessibleDigitalReceipt",
                requiredFields: [...digitalReceiptRequiredFields],
              }
            : {
                profile: "DigitalReceiptRequiredFieldRuleV1",
                dataContractVersion: 1,
                requiredFields: [...digitalReceiptRequiredFields],
                professionalReviewStatus: "NotEvaluated",
                legalConclusion: "NotEvaluated",
              },
        createdAt: at,
        updatedAt: at,
        dataClassification: "Internal",
      });
      return {
        rows: [
          {
            artifact_kind: kind,
            artifact_id: reference,
            revision: "1",
            operation_id: id(32),
            actor_id: id(11),
            previous_artifact_id: null,
            snapshot_json: snapshot,
            snapshot_digest: hash(snapshot),
            created_at: at,
            updated_at: at,
          },
        ],
        rowCount: 1,
      };
    }
    if (statement.includes("FROM rms_device.digital_receipt_template_submit_operation")) {
      if (controls.lateGuard && database.operations.length > 0)
        controls.fineDenied = "publishing.draft.create";
      return { rows: database.operations, rowCount: database.operations.length };
    }
    if (statement.includes("FROM rms_device.digital_receipt_template_submission")) {
      const rows = database.submissions.filter((r) =>
        statement.includes("operation_id=$4")
          ? r.operation_id === v[3]
          : r.template_id === v[3] && r.version_id === v[4],
      );
      return {
        rows: statement.startsWith("SELECT record_json,record_digest")
          ? rows.map((r) => ({ record_json: r.record_json, record_digest: r.record_digest }))
          : rows,
        rowCount: rows.length,
      };
    }
    if (statement.startsWith("INSERT INTO rms_device.digital_receipt_template_submission")) {
      database.submissions.push(submissionRow(v));
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("INSERT INTO rms_device.digital_receipt_template_submit_operation")) {
      database.operations.push(operationRow(v));
      if (controls.lateCreate) controls.fineDenied = "publishing.draft.create";
      if (controls.lateFine) controls.fineDenied = "publishing.review.submit";
      if (controls.drift) options.persistence.now = () => at;
      return { rows: [], rowCount: 1 };
    }
    if (statement.includes("FROM bop_publishing.publishing_mutation_record")) {
      let history = database.publishing;
      if (statement.includes("operation_id=$4"))
        history = history.filter((m) => m.idempotencyKey === v[3]);
      else if (statement.includes("lifecycle_id=$4"))
        history = history.filter((m) => m.next.lifecycleId === v[3]);
      history = [...history].sort((a, b) => b.next.version - a.next.version);
      if (statement.includes("LIMIT 1") && !statement.includes("1025"))
        history = history.slice(0, 1);
      return {
        rows: history.map((m) => ({
          mutation_json: m,
          intent_hash: publishingRecordedMutationDigest(m),
          audit_id: m.audit.auditId,
        })),
        rowCount: history.length,
      };
    }
    if (statement.startsWith("INSERT INTO bop_publishing.publishing_mutation_record")) {
      const mutation = parseRecordedPublishingMutation(v[14]);
      expect(v[10]).toBe(publishingRecordedMutationDigest(mutation));
      database.publishing.push(mutation);
      if (controls.expireOnSubmit && mutation.operation === "SubmitReview")
        controls.now = controls.lease;
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("INSERT INTO platform_audit.audit_chain_head"))
      return { rows: [], rowCount: 1 };
    if (statement.includes("FROM platform_audit.audit_chain_head"))
      return {
        rows: [
          {
            next_sequence: String(database.nextSequence),
            previous_hash: database.previousHash,
            recorded_at: controls.now,
          },
        ],
        rowCount: 1,
      };
    if (statement.startsWith("INSERT INTO platform_audit.audit_record")) {
      database.audits.push(v);
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("UPDATE platform_audit.audit_chain_head")) {
      database.nextSequence++;
      database.previousHash = Buffer.isBuffer(v[2]) ? v[2].toString("hex") : null;
      return { rows: [{ next_sequence: String(database.nextSequence) }], rowCount: 1 };
    }
    if (
      statement.startsWith("SELECT set_config") ||
      statement.startsWith("SELECT pg_advisory") ||
      statement.startsWith("LOCK TABLE")
    )
      return { rows: [], rowCount: 1 };
    throw new Error("unexpected controlled SQL");
  });
  const run = vi.fn(async (work: (tx: { query: typeof query }) => Promise<unknown>) => {
    const original = {
      publishing: [...database.publishing],
      submissions: [...database.submissions],
      operations: [...database.operations],
      audits: [...database.audits],
      nextSequence: database.nextSequence,
      previousHash: database.previousHash,
    };
    try {
      return await work({ query });
    } catch (error) {
      Object.assign(database, original);
      throw error;
    }
  });
  let next = 100 + database.publishing.length * 10;
  const options = {
    persistence: {
      now: () => {
        controls.clockHook();
        return controls.now;
      },
      transactions: { run },
      identity: { hasher: {} },
      currentActor: async () => undefined,
      validateAssociation: async () => true,
    },
    authentication: { authorize: vi.fn(async () => ({ sessionReference: id(5) })) },
    nextReference: vi.fn(() => id(next++)),
    reviewValidityMs: 60000,
  };
  const service = createMerchantReceiptTemplateSubmit(
    options as unknown as Parameters<typeof createMerchantReceiptTemplateSubmit>[0],
  );
  return { service, options, database, controls, scope, sql, reads };
}
const write = (
  f: ReturnType<typeof fixture>,
  command: unknown = body(),
  expectedScope: unknown = scope4,
) => f.service.write({ sessionCookie: "synthetic", csrf: "synthetic", expectedScope, command });
const resolve = () => ({ ...body(), command: "ResolveOriginal", intentDigest: intent() });
it("uses actual Draft/historical artifacts and two Publishing mutations, writing 006+007 with only kernel Audits", async () => {
  const f = fixture(),
    result = await write(f);
  expect(result.outcome).toBe("Committed");
  expect(f.database.publishing.map((m) => m.operation)).toEqual(["CreateDraft", "SubmitReview"]);
  expect(f.database.publishing[0]?.idempotencyKey).not.toBe(id(20));
  expect(f.database.publishing[1]?.idempotencyKey).toBe(id(20));
  expect(f.database.submissions).toHaveLength(1);
  expect(f.database.operations).toHaveLength(1);
  expect(f.database.audits.map((v) => v[5])).toEqual([
    "PUBLISHING_DRAFT_CREATED",
    "PUBLISHING_REVIEW_SUBMITTED",
  ]);
  expect(result.submission?.validationValidUntil).toBe("2026-10-05T10:01:00.000Z");
  expect(result.submission?.authoredByReference).toBe(id(11));
  expect(result.submission?.submittedByReference).toBe(id(4));
  expect(f.reads).toContain("Layout:" + id(8));
  expect(f.reads).toContain("Compliance:" + id(9));
  expect(
    f.sql.some((s) =>
      s.startsWith("INSERT INTO rms_device.digital_receipt_template_draft_revision"),
    ),
  ).toBe(false);
});
it("recovers immutable committed history after business expiry without Create permission or current sources", async () => {
  const first = fixture();
  const original = await write(first);
  const f = fixture(first.database);
  f.controls.now = "2026-10-05T10:02:00.000Z";
  f.controls.lease = "2026-10-05T10:02:05.000Z";
  f.controls.fineDenied = "publishing.draft.create";
  expect(await write(f, resolve())).toEqual(original);
  expect(f.options.nextReference).not.toHaveBeenCalled();
  expect(f.reads).toEqual([]);
  expect(f.database.publishing).toHaveLength(2);
  expect(f.database.audits).toHaveLength(2);
});
it("resolves absence durably then late Submit returns Abandoned without Create or producer artifacts", async () => {
  const first = fixture();
  first.controls.fineDenied = "publishing.draft.create";
  const original = await write(first, resolve());
  expect(original.outcome).toBe("Abandoned");
  expect(first.database.audits.map((v) => v[5])).toEqual([
    "RECEIPT_TEMPLATE_SUBMIT_ORIGINAL_ABANDONED",
  ]);
  const f = fixture(first.database);
  f.controls.fineDenied = "publishing.draft.create";
  expect(await write(f)).toEqual(original);
  expect(f.reads).toEqual([]);
  expect(f.options.nextReference).not.toHaveBeenCalled();
  expect(f.database.publishing).toHaveLength(0);
});
it("returns isolated expired 006 historical fact without terminal backfill or new Create authority", async () => {
  const first = fixture();
  const original = await write(first);
  first.database.operations = [];
  const f = fixture(first.database);
  f.controls.now = "2026-10-05T10:02:00.000Z";
  f.controls.lease = "2026-10-05T10:02:05.000Z";
  f.controls.fineDenied = "publishing.draft.create";
  expect(await write(f)).toEqual(original);
  expect(f.database.operations).toEqual([]);
  expect(f.reads).toEqual([]);
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
it.each(["publishing.review.submit", "publishing.draft.create"])(
  "denies missing fresh %s before allocation",
  async (action) => {
    const f = fixture();
    f.controls.fineDenied = action;
    await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
    expect(f.options.nextReference).not.toHaveBeenCalled();
    expect(f.database.operations).toEqual([]);
  },
);
it.each(["lateCreate", "lateFine"] as const)(
  "rolls back all real kernel/source/Audit transport writes on %s",
  async (flag) => {
    const f = fixture();
    f.controls[flag] = true;
    await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
    expect(f.database.publishing).toEqual([]);
    expect(f.database.submissions).toEqual([]);
    expect(f.database.operations).toEqual([]);
    expect(f.database.audits).toEqual([]);
  },
);
it("denies organization permission and scope mismatch before writes", async () => {
  const f = fixture();
  f.controls.allowed = false;
  await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(f.options.nextReference).not.toHaveBeenCalled();
  const g = fixture();
  await expect(write(g, body(), { ...scope4, actorReference: id(40) })).rejects.toThrow(
    "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  );
  expect(g.database.audits).toEqual([]);
});
it("denies expired and invalid Session/CSRF before the source host", async () => {
  const f = fixture();
  f.options.authentication.authorize.mockRejectedValueOnce(
    new BrowserSessionError("BROWSER_SESSION_DENIED"),
  );
  await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(f.sql).toEqual([]);
  f.options.authentication.authorize.mockRejectedValueOnce(
    new BrowserSessionError("BROWSER_SESSION_INPUT_INVALID"),
  );
  await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
});
it("fails closed on historical artifact absence without kernel allocation", async () => {
  const f = fixture();
  f.controls.artifactMissing = true;
  await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_CONFLICT");
  expect(f.options.nextReference).not.toHaveBeenCalled();
  expect(f.database.publishing).toEqual([]);
});
it("captures configurable business duration independently of five-second authority lease", async () => {
  const f = fixture();
  f.options.reviewValidityMs = 120000;
  await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(f.sql).toEqual([]);
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
it("rejects captured clock replacement during late finalization and rolls everything back", async () => {
  const f = fixture();
  f.controls.drift = true;
  await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(f.database.operations).toEqual([]);
  expect(f.database.audits).toEqual([]);
});
it("rejects malformed browser intent and prevents TTL or source-evidence injection", async () => {
  const f = fixture();
  await expect(write(f, { ...body(), validationValidUntil: until })).rejects.toThrow(
    "RECEIPT_TEMPLATE_INPUT_INVALID",
  );
  expect(f.options.authentication.authorize).not.toHaveBeenCalled();
  expect(f.sql).toEqual([]);
});
it("replays the same original after a lost response without extra IDs, mutations or Audit", async () => {
  const f = fixture();
  const original = await write(f);
  const g = fixture(f.database);
  expect(await write(g)).toEqual(original);
  expect(g.options.nextReference).not.toHaveBeenCalled();
  expect(g.database.publishing).toHaveLength(2);
  expect(g.database.audits).toHaveLength(2);
});

it("retains newly required Create permission through the actual async COMMIT checks", async () => {
  const f = fixture();
  f.controls.lateGuard = true;
  await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(f.database.publishing).toEqual([]);
  expect(f.database.submissions).toEqual([]);
  expect(f.database.operations).toEqual([]);
  expect(f.database.audits).toEqual([]);
});
it("honors a shorter actual permission lease consumed during the real kernel Submit", async () => {
  const f = fixture();
  f.controls.lease = "2026-10-05T10:00:01.000Z";
  f.controls.expireOnSubmit = true;
  await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(f.database.publishing).toEqual([]);
  expect(f.database.audits).toEqual([]);
  expect(f.database.operations).toEqual([]);
});

it("rejects actual Actor replacement inside the last allowed callback and rolls back the compound Submit", async () => {
  const baseline = fixture();
  await write(baseline);
  const count = baseline.scope.allowed.mock.calls.length;
  expect(count).toBeGreaterThan(1);
  const f = fixture();
  let calls = 0;
  f.scope.allowed.mockImplementation(async () => {
    if (++calls === count) f.scope.actorReference = id(90);
    return true;
  });
  await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(calls).toBe(count);
  expect(f.database.publishing).toEqual([]);
  expect(f.database.submissions).toEqual([]);
  expect(f.database.operations).toEqual([]);
  expect(f.database.audits).toEqual([]);
});
it.each(["Session", "Context"] as const)(
  "rejects final %s lease callback drift and retains no terminal or kernel Audit",
  async (mode) => {
    const baseline = fixture(),
      lease = vi.fn(() => until);
    baseline.scope.authorizationValidUntil = lease;
    await write(baseline);
    const count = lease.mock.calls.length;
    expect(count).toBeGreaterThan(1);
    const f = fixture();
    let calls = 0;
    f.scope.authorizationValidUntil = () => {
      if (++calls === count) {
        if (mode === "Session") f.scope.sessionReference = id(90);
        else f.scope.context = { ...f.scope.context };
      }
      return until;
    };
    await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
    expect(calls).toBe(count);
    expect(f.database.publishing).toEqual([]);
    expect(f.database.submissions).toEqual([]);
    expect(f.database.operations).toEqual([]);
    expect(f.database.audits).toEqual([]);
  },
);
it("checks captured context after the actual clock callback following the last Submit lease", async () => {
  const baseline = fixture(),
    lease = vi.fn(() => until);
  baseline.scope.authorizationValidUntil = lease;
  await write(baseline);
  const count = lease.mock.calls.length,
    f = fixture();
  let calls = 0,
    armed = false;
  f.scope.authorizationValidUntil = () => {
    if (++calls === count) armed = true;
    return until;
  };
  f.controls.clockHook = () => {
    if (armed) {
      armed = false;
      f.scope.context = { ...f.scope.context };
    }
    return undefined;
  };
  await expect(write(f)).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(calls).toBe(count);
  expect(f.database.publishing).toEqual([]);
  expect(f.database.submissions).toEqual([]);
  expect(f.database.operations).toEqual([]);
  expect(f.database.audits).toEqual([]);
});
