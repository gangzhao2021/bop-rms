import assert from "node:assert/strict";
import pg from "pg";
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
 * professional/legal approval or ordinary workflow is asserted by this fixture. */
export async function verifyReceiptTemplateSubmissionSchema(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_receipt_submit_" + context.runId;
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
  const insert = async (record, overrides = {}) => {
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
  const count = async () =>
    (
      await admin.query(
        "SELECT count(*)::text n FROM rms_device.digital_receipt_template_submission",
      )
    ).rows[0].n;
  const rejected = async (work, codes = ["23514"], options = {}) => {
    const before = await count();
    await assert.rejects(transaction(work, options), (error) => codes.includes(error.code));
    assert.equal(await count(), before, "Rejected submission left a record");
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
        ",rms_device.digital_receipt_template_submission TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT ON rms_device.digital_receipt_template_submit_operation TO " + role,
    );
    const first = state(1, 201),
      second = state(2, 202, id(6));
    await transaction(() => pair(first), { commit: true });
    const original = submission(first, 501);
    await transaction(() => insert(original), { commit: true });
    await transaction(() => pair(second), { commit: true });
    const current = submission(second, 502, id(4));
    await transaction(() => insert(current), { commit: true });
    await transaction(async () => {
      const rows = (
        await admin.query(
          "SELECT record_json FROM rms_device.digital_receipt_template_submission ORDER BY draft_revision",
        )
      ).rows;
      assert.deepEqual(
        rows.map((row) => parseDigitalReceiptTemplateSubmission(row.record_json)),
        [original, current],
      );
      assert.notEqual(current.authoredByReference, current.submittedByReference);
    });
    // Declared validation interval is controlled metadata, not an approval policy or Publishing proof.
    const fresh = { ...current, operationReference: id(600) };
    for (const field of [
      "familyReference",
      "authoredByReference",
      "contentDigest",
      "versionReference",
      "templateReference",
    ]) {
      const changed = {
        ...fresh,
        [field]: field === "contentDigest" ? "sha256:" + "b".repeat(64) : id(999),
      };
      await rejected(() => insert(changed));
    }
    await rejected(() =>
      insert({
        ...fresh,
        versionReference: original.versionReference,
        draftRevision: 1,
        authoredByReference: original.authoredByReference,
        contentDigest: original.contentDigest,
      }),
    );
    await rejected(() => insert({ ...fresh, checkedAt: "2026-10-05T14:00:03.000Z" }));
    await rejected(() => insert({ ...fresh, validationValidUntil: fresh.submittedAt }));
    await rejected(() => insert(fresh, { draft_revision: null }), ["23514", "23502"]);
    await rejected(() => insert(fresh, { submitted_at: "2026-10-05T14:00:02.000001Z" }));
    await rejected(() =>
      insert(fresh, { record_json: JSON.stringify({ ...fresh, content: { html: "unexpected" } }) }),
    );
    await rejected(() =>
      insert(fresh, { record_json: JSON.stringify({ ...fresh, submittedByReference: null }) }),
    );
    await rejected(() => insert({ ...fresh, reviewVersion: 1 }));
    await rejected(() => insert(original), ["23514", "23505"]);
    await rejected(() => insert(fresh), ["23505"]);
    const foreignScope = { ...scope, store: id(903) };
    const otherSeed = state(1, 203, id(4), foreignScope, id(51), id(61));
    const otherSnapshot = parseDigitalReceiptTemplateDraft({
      ...otherSeed.snapshot,
      content: { ...otherSeed.snapshot.content, versionReference: id(103) },
    });
    const other = { ...otherSeed, snapshot: otherSnapshot, digest: digest(otherSnapshot) };
    await transaction(() => pair(other), { selected: foreignScope, commit: true });
    const collision = { ...submission(other, 501), storeReference: foreignScope.store };
    await rejected(() => insert(collision), ["23505"], { selected: foreignScope });
    for (const key of ["tenant", "brand", "store"]) {
      const selected = { ...scope, [key]: id(900) };
      await transaction(async () => assert.equal(await count(), "0"), { selected });
      await rejected(() => insert(fresh), ["55000", "42501"], { selected });
    }
    await admin.query(
      "GRANT UPDATE,DELETE,TRUNCATE ON rms_device.digital_receipt_template_submission TO " + role,
    );
    for (const sql of [
      "UPDATE rms_device.digital_receipt_template_submission SET data_classification='Internal'",
      "DELETE FROM rms_device.digital_receipt_template_submission",
      "TRUNCATE rms_device.digital_receipt_template_submission",
    ])
      await rejected(async () => {
        assert.equal(await count(), "2");
        await admin.query(sql);
      }, ["55000"]);
    assert.equal(await count(), "2");
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
