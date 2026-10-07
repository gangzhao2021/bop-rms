import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createIdentityActor } from "@bop/identity";
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
  parseDigitalReceiptTemplateLifecycleAction,
} from "@rms/printing-device";
import { createMerchantReceiptTemplateLifecycle } from "./merchant-receipt-template-lifecycle.js";
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
function db() {
  return {
    lifecycle: [] as Record<string, unknown>[],
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
function fixture(database = db(), actorNumber = 4) {
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
    actorReference: id(actorNumber),
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
    actorReference: id(actorNumber),
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
    if (statement.includes("FROM rms_device.digital_receipt_template_lifecycle_operation")) {
      const rows = database.lifecycle.filter((r) => r.operation_id === v[3]);
      return { rows, rowCount: rows.length };
    }
    if (
      statement.startsWith("INSERT INTO rms_device.digital_receipt_template_lifecycle_operation")
    ) {
      const columns = [
        "operation_id",
        "tenant_id",
        "brand_id",
        "store_id",
        "actor_id",
        "action",
        "template_id",
        "expected_version_id",
        "expected_revision",
        "review_lifecycle_id",
        "expected_review_version",
        "expected_review_operation_id",
        "intent_digest",
        "outcome",
        "result_digest",
        "audit_reference",
        "occurred_at",
        "receipt_json",
        "receipt_digest",
        "data_classification",
      ];
      const row = Object.fromEntries(
        columns.map((c, i) => [
          c,
          c === "data_classification"
            ? "Confidential"
            : c === "receipt_json"
              ? JSON.parse(String(v[i]))
              : c === "expected_revision" || c === "expected_review_version"
                ? String(v[i])
                : v[i],
        ]),
      );
      database.lifecycle.push(row);
      return { rows: [], rowCount: 1 };
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
      if (statement.includes("lifecycle_version IN ($5,$6,$7)"))
        history = history.filter((m) => v.slice(4, 7).includes(m.next.version));
      else if (statement.includes("lifecycle_version=$5"))
        history = history.filter((m) => m.next.version === v[4]);
      history = [...history].sort((a, b) =>
        statement.includes("ORDER BY lifecycle_version ASC")
          ? a.next.version - b.next.version
          : b.next.version - a.next.version,
      );
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
      lifecycle: [...database.lifecycle],
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
  const seedService = createMerchantReceiptTemplateSubmit(
    options as unknown as Parameters<typeof createMerchantReceiptTemplateSubmit>[0],
  );
  const service = createMerchantReceiptTemplateLifecycle(
    options as unknown as Parameters<typeof createMerchantReceiptTemplateLifecycle>[0],
  );
  return { service, seedService, options, database, controls, scope, sql, reads };
}

const scopeFor = (f: ReturnType<typeof fixture>) => ({
  ...scope4,
  actorReference: String(f.scope.actorReference),
});
async function submitted() {
  const f = fixture();
  await f.seedService.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command: body(),
  });
  return f.database;
}
function actionBody(f: ReturnType<typeof fixture>, action = "Approve") {
  const submission = f.database.submissions[0]?.record_json as Record<string, unknown> | undefined;
  if (!submission) throw new Error("real controlled Submit absent");
  return {
    command: action,
    operationReference: id(70),
    templateReference: id(6),
    expectedVersionReference: id(7),
    expectedRevision: 1,
    reviewLifecycleReference: submission.reviewLifecycleReference,
    expectedReviewVersion: 2,
    expectedReviewOperationReference: submission.operationReference,
  };
}
const write = (
  f: ReturnType<typeof fixture>,
  command: unknown,
  expectedScope: unknown = scopeFor(f),
) => f.service.write({ sessionCookie: "synthetic", csrf: "synthetic", expectedScope, command });
it("approves through actual Submission/Authored readers and actual Core with an independent reader Actor", async () => {
  const f = fixture(await submitted(), 7),
    r = await write(f, actionBody(f));
  expect(r.outcome).toBe("Committed");
  expect(r.result?.state).toBe("Approved");
  expect(r.result?.approvedByReference).toBe(id(7));
  expect(f.database.lifecycle).toHaveLength(1);
  expect(f.database.publishing).toHaveLength(3);
  expect(f.database.audits).toHaveLength(3);
  expect(f.sql.some((s) => s.includes("SAVEPOINT"))).toBe(false);
});
it("refuses the actual original author/submitter self approval with no terminal or Core artifacts", async () => {
  const f = fixture(await submitted()),
    before = f.database.audits.length;
  await expect(write(f, actionBody(f))).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_CONFLICT",
  });
  expect(f.database.lifecycle).toHaveLength(0);
  expect(f.database.publishing).toHaveLength(2);
  expect(f.database.audits).toHaveLength(before);
});
it("committed exact original replay is historical and neither requalifies nor allocates evidence", async () => {
  const f = fixture(await submitted(), 7),
    command = actionBody(f),
    r = await write(f, command),
    allocations = f.options.nextReference.mock.calls.length;
  f.controls.now = "2026-10-05T11:00:00.000Z";
  f.controls.lease = "2026-10-05T11:00:05.000Z";
  const repeated = await write(f, command);
  expect(repeated).toEqual(r);
  expect(f.options.nextReference.mock.calls).toHaveLength(allocations);
  expect(f.database.audits).toHaveLength(3);
});
it("resolve true absence commits a permanent Abandoned original without reading current business sources", async () => {
  const f = fixture(),
    command = {
      command: "Approve",
      operationReference: id(70),
      templateReference: id(6),
      expectedVersionReference: id(7),
      expectedRevision: 1,
      reviewLifecycleReference: id(71),
      expectedReviewVersion: 2,
      expectedReviewOperationReference: id(72),
    };
  const digest = hash(
    parseDigitalReceiptTemplateLifecycleAction({
      profile: "DigitalReceiptTemplateLifecycleActionV1",
      ...scope4,
      action: "Approve",
      operationReference: command.operationReference,
      templateReference: command.templateReference,
      expectedVersionReference: command.expectedVersionReference,
      expectedRevision: 1,
      reviewLifecycleReference: command.reviewLifecycleReference,
      expectedReviewVersion: 2,
      expectedReviewOperationReference: command.expectedReviewOperationReference,
      purposeCode: "RECEIPT_TEMPLATE_REVIEW",
    }),
  );
  const r = await write(f, {
    ...command,
    command: "ResolveOriginal",
    action: "Approve",
    intentDigest: digest,
  });
  expect(r.outcome).toBe("Abandoned");
  expect(await write(f, command)).toEqual(r);
  expect(f.database.publishing).toHaveLength(0);
  expect(f.database.submissions).toHaveLength(0);
  expect(f.database.audits).toHaveLength(1);
});
it("checks current organization and action authority even for historical originals", async () => {
  const f = fixture(await submitted(), 7),
    command = actionBody(f);
  await write(f, command);
  f.controls.fineDenied = "publishing.review.approve";
  await expect(write(f, command)).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  });
  expect(f.database.audits).toHaveLength(3);
});
it("scope mismatch and injected business expiry refuse before any original allocation", async () => {
  const f = fixture(await submitted(), 7),
    command = actionBody(f);
  await expect(write(f, command, { ...scopeFor(f), actorReference: id(90) })).rejects.toMatchObject(
    { code: "RECEIPT_TEMPLATE_PERMISSION_DENIED" },
  );
  await expect(write(f, { ...command, approvalValidUntil: until })).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_INPUT_INVALID",
  });
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
it("captures configuration and original clock ports rather than accepting replacement after construction", async () => {
  const f = fixture(await submitted(), 7),
    command = actionBody(f);
  f.options.persistence.now = () => until;
  await expect(write(f, command)).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_UNAVAILABLE" });
  expect(f.database.lifecycle).toHaveLength(0);
});
it("expired original validation cannot produce approval and rolls back all writes", async () => {
  const f = fixture(await submitted(), 7);
  f.controls.now = "2026-10-05T10:01:00.000Z";
  f.controls.lease = "2026-10-05T10:01:05.000Z";
  await expect(write(f, actionBody(f))).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_CONFLICT",
  });
  expect(f.database.lifecycle).toHaveLength(0);
  expect(f.database.publishing).toHaveLength(2);
});

it("default approval duration is clamped to original business validation, not the five-second authority lease", async () => {
  const f = fixture(await submitted(), 7),
    r = await write(f, actionBody(f));
  expect(r.result?.approvalValidUntil).toBe("2026-10-05T10:01:00.000Z");
  expect(r.result?.approvalValidUntil).not.toBe(until);
});
it("fine withdrawal during the actual final owner checkpoint rolls back the Core and durable terminal", async () => {
  const f = fixture(await submitted(), 7);
  f.controls.clockHook = () => {
    if (f.database.lifecycle.length) f.controls.fineDenied = "publishing.review.approve";
  };
  await expect(write(f, actionBody(f))).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  });
  expect(f.database.lifecycle).toHaveLength(0);
  expect(f.database.publishing).toHaveLength(2);
  expect(f.database.audits).toHaveLength(2);
});
it("short actual authorization lease consumed at finalization refuses COMMIT without changing historical review", async () => {
  const f = fixture(await submitted(), 7);
  f.controls.clockHook = () => {
    if (f.database.lifecycle.length) f.controls.lease = at;
  };
  await expect(write(f, actionBody(f))).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_UNAVAILABLE",
  });
  expect(f.database.lifecycle).toHaveLength(0);
  expect(f.database.publishing).toHaveLength(2);
});
