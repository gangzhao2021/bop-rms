import assert from "node:assert/strict";
import pg from "pg";
import { parseDigitalReceiptTemplateSubmitReceipt } from "../../rms/printing-device/src/contracts/digital-receipt-template-submit.ts";
import { parseDigitalReceiptTemplateSubmission } from "../../rms/printing-device/src/contracts/digital-receipt-template-submission.ts";
import { createDigitalReceiptTemplateDraftContent } from "../../rms/printing-device/src/contracts/digital-receipt-template-draft-fields.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { parseDigitalReceiptTemplateDraft } from "../../rms/printing-device/src/contracts/digital-receipt-template-draft.ts";

const id = (n) => "01902421-1605-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T14:00:00.000Z";
const later = "2026-10-05T14:00:01.000Z";
const scope = { tenant: id(1), brand: id(2), store: id(3) };
const tables =
  "rms_device.digital_receipt_template_draft_revision,rms_device.digital_receipt_template_draft_operation";
const flush =
  "SET CONSTRAINTS rms_device.digital_receipt_template_draft_revision_coherence,rms_device.digital_receipt_template_draft_operation_coherence IMMEDIATE";

/** Controlled metadata exercises the actual schema only. No IAM, Audit append,
 * professional/legal approval or ordinary workflow is asserted by this fixture.
 * Validation deadlines are declared synthetic metadata, never a configured policy.
 * Legacy standalone 006 rows are deliberately not backfilled into original receipts. */
export async function verifyReceiptTemplateSubmitOperationSchema(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_receipt_terminal_" + context.runId;
  let roleCreated = false;
  await admin.connect();
  const setScope = async (selected = scope) => {
    await admin.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [selected.tenant, selected.brand, selected.store],
    );
  };
  const transaction = async (work, { selected = scope, commit = false } = {}) => {
    await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await admin.query("SET LOCAL ROLE " + role);
      await admin.query("SET LOCAL statement_timeout='5s'");
      await admin.query("SET LOCAL lock_timeout='5s'");
      await setScope(selected);
      const result = await work();
      await admin.query(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  };
  const digest = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
  const state = (
    revision,
    operation,
    actor = id(4),
    selected = scope,
    template = id(50),
    family = id(60),
  ) => {
    const content = createDigitalReceiptTemplateDraftContent({
      tenantReference: selected.tenant,
      brandReference: selected.brand,
      storeReference: selected.store,
      templateReference: template,
      versionReference: id(100 + revision),
      versionNumber: 1,
      fields: {
        locale: "en-CA",
        layoutDefinitionReference: id(70),
        complianceRuleReference: id(71),
        activation: { mode: "Immediate" },
        effectiveUntil: null,
      },
    });
    const snapshot = parseDigitalReceiptTemplateDraft({
      profile: "DigitalReceiptTemplateDraftV2",
      tenantReference: selected.tenant,
      brandReference: selected.brand,
      storeReference: selected.store,
      familyReference: family,
      revision,
      authoredByReference: actor,
      previousVersionReference: revision === 1 ? null : id(100 + revision - 1),
      content,
      contentDigest: digest(content),
      createdAt: at,
      updatedAt: revision === 1 ? at : later,
      dataClassification: "Internal",
    });
    return { snapshot, operation: id(operation), digest: digest(snapshot), actor };
  };
  const insertRevision = async (value, overrides = {}) => {
    const s = value.snapshot,
      c = s.content;
    const row = {
      tenant: s.tenantReference,
      brand: s.brandReference,
      store: s.storeReference,
      template: c.templateReference,
      family: s.familyReference,
      version: c.versionReference,
      revision: s.revision,
      publicationNumber: c.versionNumber,
      operation: value.operation,
      actor: value.actor,
      previous: s.previousVersionReference,
      contentDigest: s.contentDigest,
      snapshot: s,
      digest: value.digest,
      created: s.createdAt,
      updated: s.updatedAt,
      ...overrides,
    };
    await admin.query(
      "INSERT INTO rms_device.digital_receipt_template_draft_revision(tenant_id,brand_id,store_id,template_id,family_id,version_id,revision,publication_version_number,operation_id,actor_id,previous_version_id,content_digest,snapshot_json,snapshot_digest,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,'Internal')",
      [
        row.tenant,
        row.brand,
        row.store,
        row.template,
        row.family,
        row.version,
        row.revision,
        row.publicationNumber,
        row.operation,
        row.actor,
        row.previous,
        row.contentDigest,
        JSON.stringify(row.snapshot),
        row.digest,
        row.created,
        row.updated,
      ],
    );
  };
  const insertOperation = async (value, overrides = {}) => {
    const s = value.snapshot;
    const row = {
      operation: value.operation,
      tenant: s.tenantReference,
      brand: s.brandReference,
      store: s.storeReference,
      actor: value.actor,
      template: s.revision === 1 ? null : s.content.templateReference,
      expectedVersion: s.previousVersionReference,
      expectedRevision: s.revision - 1,
      outcome: "Committed",
      resultVersion: s.content.versionReference,
      resultRevision: s.revision,
      digest: value.digest,
      audit: id(Number.parseInt(value.operation.slice(-12), 16) + 10000),
      occurred: s.updatedAt,
      ...overrides,
    };
    await admin.query(
      "INSERT INTO rms_device.digital_receipt_template_draft_operation(operation_id,tenant_id,brand_id,store_id,actor_id,template_id,intent_digest,expected_version_id,expected_revision,outcome,result_version_id,result_revision,snapshot_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Internal')",
      [
        row.operation,
        row.tenant,
        row.brand,
        row.store,
        row.actor,
        row.template,
        "sha256:" + "a".repeat(64),
        row.expectedVersion,
        row.expectedRevision,
        row.outcome,
        row.resultVersion,
        row.resultRevision,
        row.digest,
        row.audit,
        row.occurred,
      ],
    );
  };
  const pair = async (value, revisionOverrides = {}, operationOverrides = {}) => {
    await insertRevision(value, revisionOverrides);
    await insertOperation(value, operationOverrides);
    await admin.query(flush);
  };
  const submission = (draft, operation, actor = id(6)) =>
    parseDigitalReceiptTemplateSubmission({
      profile: "DigitalReceiptTemplateSubmissionV1",
      tenantReference: scope.tenant,
      brandReference: scope.brand,
      storeReference: scope.store,
      templateReference: draft.snapshot.content.templateReference,
      familyReference: draft.snapshot.familyReference,
      versionReference: draft.snapshot.content.versionReference,
      draftRevision: draft.snapshot.revision,
      contentDigest: draft.snapshot.contentDigest,
      authoredByReference: draft.actor,
      submittedByReference: actor,
      operationReference: id(operation),
      reviewLifecycleReference: id(operation + 1000),
      reviewVersion: 2,
      validationEvidenceReference: id(operation + 2000),
      checkedAt: later,
      validationValidUntil: "2026-10-05T14:10:00.000Z",
      submittedAt: "2026-10-05T14:00:02.000Z",
      auditReference: id(operation + 3000),
      dataClassification: "Internal",
    });
  const columns = [
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
    "data_classification",
    "record_json",
    "record_digest",
  ];
  const fields = [
    "tenantReference",
    "brandReference",
    "storeReference",
    "templateReference",
    "familyReference",
    "versionReference",
    "draftRevision",
    "contentDigest",
    "authoredByReference",
    "submittedByReference",
    "operationReference",
    "reviewLifecycleReference",
    "reviewVersion",
    "validationEvidenceReference",
    "checkedAt",
    "validationValidUntil",
    "submittedAt",
    "auditReference",
    "dataClassification",
  ];
  const insertSubmission = async (record, overrides = {}) => {
    const row = Object.fromEntries(fields.map((field, index) => [columns[index], record[field]]));
    Object.assign(
      row,
      { record_json: JSON.stringify(record), record_digest: digest(record) },
      overrides,
    );
    await admin.query(
      "INSERT INTO rms_device.digital_receipt_template_submission(" +
        columns.join(",") +
        ") VALUES(" +
        columns.map((_, i) => "$" + (i + 1) + (i === 19 ? "::jsonb" : "")).join(",") +
        ")",
      columns.map((column) => row[column]),
    );
  };
  const receipt = (record, outcome = "Committed") =>
    parseDigitalReceiptTemplateSubmitReceipt({
      profile: "DigitalReceiptTemplateSubmitReceiptV1",
      tenantReference: record.tenantReference,
      brandReference: record.brandReference,
      storeReference: record.storeReference,
      actorReference: record.submittedByReference,
      operationReference: record.operationReference,
      templateReference: record.templateReference,
      expectedVersionReference: record.versionReference,
      expectedRevision: record.draftRevision,
      intentDigest: "sha256:" + "a".repeat(64),
      outcome,
      submission: outcome === "Committed" ? record : null,
      auditReference: record.auditReference,
      occurredAt: record.submittedAt,
    });
  const terminalColumns = [
    "operation_id",
    "tenant_id",
    "brand_id",
    "store_id",
    "actor_id",
    "template_id",
    "expected_version_id",
    "expected_revision",
    "intent_digest",
    "outcome",
    "result_review_lifecycle_id",
    "result_review_version",
    "submission_digest",
    "audit_reference",
    "occurred_at",
    "receipt_json",
    "receipt_digest",
  ];
  const insertTerminal = async (value, overrides = {}) => {
    const r = value.submission;
    const row = {
      operation_id: value.operationReference,
      tenant_id: value.tenantReference,
      brand_id: value.brandReference,
      store_id: value.storeReference,
      actor_id: value.actorReference,
      template_id: value.templateReference,
      expected_version_id: value.expectedVersionReference,
      expected_revision: value.expectedRevision,
      intent_digest: value.intentDigest,
      outcome: value.outcome,
      result_review_lifecycle_id: r?.reviewLifecycleReference ?? null,
      result_review_version: r?.reviewVersion ?? null,
      submission_digest: r ? digest(r) : null,
      audit_reference: value.auditReference,
      occurred_at: value.occurredAt,
      receipt_json: JSON.stringify(value),
      receipt_digest: digest(value),
      ...overrides,
    };
    await admin.query(
      "INSERT INTO rms_device.digital_receipt_template_submit_operation(" +
        terminalColumns.join(",") +
        ") VALUES(" +
        terminalColumns.map((_, i) => "$" + (i + 1) + (i === 15 ? "::jsonb" : "")).join(",") +
        ")",
      terminalColumns.map((c) => row[c]),
    );
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::text FROM rms_device.digital_receipt_template_submission) submissions,(SELECT count(*)::text FROM rms_device.digital_receipt_template_submit_operation) terminals",
      )
    ).rows[0];
  const rejected = async (work, codes = ["23514"], options = {}) => {
    const before = await counts();
    await assert.rejects(transaction(work, options), (error) => codes.includes(error.code));
    assert.deepEqual(await counts(), before, "Rejected terminal left an artifact");
  };
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN");
    roleCreated = true;
    await admin.query("GRANT USAGE ON SCHEMA rms_device,platform_helpers TO " + role);
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON " +
        tables +
        ",rms_device.digital_receipt_template_submission,rms_device.digital_receipt_template_submit_operation TO " +
        role,
    );
    const first = state(1, 201),
      second = state(2, 202, id(6));
    await transaction(() => pair(first), { commit: true });
    const original = submission(first, 501),
      originalReceipt = receipt(original);
    await transaction(
      async () => {
        await insertSubmission(original);
        await insertTerminal(originalReceipt);
      },
      { commit: true },
    );
    await transaction(() => pair(second), { commit: true });
    const next = submission(second, 502, id(4)),
      nextReceipt = receipt(next);
    await rejected(() => insertTerminal(nextReceipt));
    for (const override of [
      { actor_id: id(999) },
      { audit_reference: id(999) },
      { submission_digest: "sha256:" + "b".repeat(64) },
      { result_review_version: null },
      { expected_revision: 1 },
      { occurred_at: "2026-10-05T14:00:02.000001Z" },
      { receipt_json: JSON.stringify({ ...nextReceipt, extra: "unexpected" }) },
    ])
      await rejected(async () => {
        await insertSubmission(next);
        await insertTerminal(nextReceipt, override);
      }, ["23514", "23502"]);
    await rejected(async () => {
      await insertSubmission(next);
      await insertTerminal(receipt(next, "Abandoned"));
    });
    await transaction(() => insertSubmission(next), { commit: true });
    await rejected(() => insertTerminal(nextReceipt)); // Genuine old rows cannot be borrowed after the original transaction.
    const abandonedRecord = { ...next, operationReference: id(503), auditReference: id(3503) };
    const abandoned = receipt(abandonedRecord, "Abandoned");
    await transaction(() => insertTerminal(abandoned), { commit: true });
    await rejected(() => insertSubmission(abandonedRecord), ["23514"]);
    await rejected(() => insertTerminal({ ...abandoned, submission: next }), ["23514"]);
    await rejected(() => insertTerminal(abandoned), ["23505"]);
    await transaction(async () => {
      const rows = (
        await admin.query(
          "SELECT receipt_json FROM rms_device.digital_receipt_template_submit_operation ORDER BY operation_id",
        )
      ).rows;
      assert.deepEqual(
        rows.map((r) => parseDigitalReceiptTemplateSubmitReceipt(r.receipt_json)),
        [originalReceipt, abandoned],
      );
    });
    for (const key of ["tenant", "brand", "store"]) {
      const selected = { ...scope, [key]: id(900) };
      await transaction(
        async () =>
          assert.equal(
            (
              await admin.query(
                "SELECT operation_id FROM rms_device.digital_receipt_template_submit_operation",
              )
            ).rows.length,
            0,
          ),
        { selected },
      );
      await rejected(() => insertTerminal(abandoned), ["55000", "42501"], { selected });
    }
    const foreignScope = { ...scope, store: id(901) };
    const collision = { ...abandoned, storeReference: foreignScope.store };
    await rejected(() => insertTerminal(collision), ["23505"], { selected: foreignScope });
    await admin.query(
      "GRANT UPDATE,DELETE,TRUNCATE ON rms_device.digital_receipt_template_submit_operation TO " +
        role,
    );
    for (const sql of [
      "UPDATE rms_device.digital_receipt_template_submit_operation SET intent_digest=intent_digest",
      "DELETE FROM rms_device.digital_receipt_template_submit_operation",
      "TRUNCATE rms_device.digital_receipt_template_submit_operation",
    ])
      await rejected(async () => {
        assert.equal(
          (
            await admin.query(
              "SELECT operation_id FROM rms_device.digital_receipt_template_submit_operation",
            )
          ).rows.length,
          2,
        );
        await admin.query(sql);
      }, ["55000"]);
    assert.deepEqual(await counts(), { submissions: "2", terminals: "2" });
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("RESET ROLE");
    if (roleCreated) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    }
    await admin.end();
  }
}
