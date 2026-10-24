import assert from "node:assert/strict";
import pg from "pg";
import { parseDigitalReceiptTemplateLifecycleReceipt } from "../../rms/printing-device/src/contracts/digital-receipt-template-lifecycle-action.ts";
import { parseDigitalReceiptTemplateVersion } from "../../rms/printing-device/src/contracts/digital-receipt-template.ts";
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
 * Core lifecycle/evidence records remain the public producer responsibility;
 * standalone legacy published rows are never backfilled into lifecycle receipts. */
export async function verifyReceiptTemplateLifecycleOperationSchema(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_receipt_lifecycle_" + context.runId;
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
  const when = "2026-10-05T14:00:03.000Z";
  const publishAt = "2026-10-05T14:00:04.000Z";
  const expiry = "2026-10-05T14:10:00.000Z";
  const makeReceipt = (record, action, operation, outcome = "Committed") => {
    const occurredAt = action === "Approve" ? when : publishAt;
    const d = first.snapshot.content;
    const publishedVersion =
      action === "Publish"
        ? parseDigitalReceiptTemplateVersion({
            templateReference: d.templateReference,
            versionReference: d.versionReference,
            versionNumber: d.versionNumber,
            versionCode: d.versionCode,
            brandReference: d.brandReference,
            storeReference: d.storeReference,
            locale: d.locale,
            dataContractVersion: 1,
            renderEngineVersion: 1,
            outputProfile: "AccessibleDigitalReceipt",
            layoutDefinitionReference: d.layoutDefinitionReference,
            complianceRuleReference: d.complianceRuleReference,
            requiredFields: d.requiredFields,
            publicationReference: id(801),
            publishedAt: publishAt,
            effectiveFrom: publishAt,
            effectiveUntil: null,
          })
        : null;
    return parseDigitalReceiptTemplateLifecycleReceipt({
      profile: "DigitalReceiptTemplateLifecycleReceiptV1",
      tenantReference: scope.tenant,
      brandReference: scope.brand,
      storeReference: scope.store,
      actorReference: action === "Approve" ? id(7) : id(8),
      action,
      operationReference: id(operation),
      templateReference: record.templateReference,
      expectedVersionReference: record.versionReference,
      expectedRevision: record.draftRevision,
      reviewLifecycleReference: record.reviewLifecycleReference,
      expectedReviewVersion: action === "Approve" ? 2 : 3,
      expectedReviewOperationReference: action === "Approve" ? record.operationReference : id(601),
      intentDigest: "sha256:" + "a".repeat(64),
      outcome,
      result:
        outcome === "Abandoned"
          ? null
          : {
              lifecycleReference: record.reviewLifecycleReference,
              lifecycleVersion: action === "Approve" ? 3 : 4,
              state: action === "Approve" ? "Approved" : "Published",
              mutationOperationReference: id(operation),
              changedAt: occurredAt,
              approvalEvidenceReference: id(802),
              approvedByReference: id(7),
              approvedAt: when,
              approvalValidUntil: expiry,
              publishedVersion,
            },
      auditReference: id(operation + 1000),
      occurredAt,
    });
  };
  const terminalColumns = [
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
  const insertTerminal = async (value, overrides = {}) => {
    const row = {
      operation_id: value.operationReference,
      tenant_id: value.tenantReference,
      brand_id: value.brandReference,
      store_id: value.storeReference,
      actor_id: value.actorReference,
      action: value.action,
      template_id: value.templateReference,
      expected_version_id: value.expectedVersionReference,
      expected_revision: value.expectedRevision,
      review_lifecycle_id: value.reviewLifecycleReference,
      expected_review_version: value.expectedReviewVersion,
      expected_review_operation_id: value.expectedReviewOperationReference,
      intent_digest: value.intentDigest,
      outcome: value.outcome,
      result_digest: value.result ? digest(value.result) : null,
      audit_reference: value.auditReference,
      occurred_at: value.occurredAt,
      receipt_json: JSON.stringify(value),
      receipt_digest: digest(value),
      data_classification: "Confidential",
      ...overrides,
    };
    await admin.query(
      "INSERT INTO rms_device.digital_receipt_template_lifecycle_operation(" +
        terminalColumns.join(",") +
        ") VALUES(" +
        terminalColumns.map((_, i) => "$" + (i + 1) + (i === 17 ? "::jsonb" : "")).join(",") +
        ")",
      terminalColumns.map((c) => row[c]),
    );
  };
  const insertPublished = async (r, overrides = {}) => {
    const v = r.result.publishedVersion;
    const row = {
      version: v.versionReference,
      brand: v.brandReference,
      store: v.storeReference,
      template: v.templateReference,
      number: v.versionNumber,
      code: v.versionCode,
      operation: r.operationReference,
      audit: id(900),
      publication: v.publicationReference,
      digest: first.snapshot.contentDigest,
      at: v.publishedAt,
      json: JSON.stringify(v),
      ...overrides,
    };
    await admin.query(
      "INSERT INTO rms_device.digital_receipt_template_version(version_id,brand_id,store_id,template_id,version_number,version_code,operation_id,audit_id,publication_id,publication_digest,published_at,version_json,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'Confidential')",
      [
        row.version,
        row.brand,
        row.store,
        row.template,
        row.number,
        row.code,
        row.operation,
        row.audit,
        row.publication,
        row.digest,
        row.at,
        row.json,
      ],
    );
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::text FROM rms_device.digital_receipt_template_lifecycle_operation) terminals,(SELECT count(*)::text FROM rms_device.digital_receipt_template_version) versions,(SELECT count(*)::text FROM rms_device.digital_receipt_template_submission) submissions",
      )
    ).rows[0];
  const rejected = async (work, codes = ["23514"], options = {}) => {
    const before = await counts();
    await assert.rejects(transaction(work, options), (error) => codes.includes(error.code));
    assert.deepEqual(await counts(), before, "Rejected lifecycle write left an artifact");
  };
  const first = state(1, 201),
    original = submission(first, 501);
  const approve = makeReceipt(original, "Approve", 601),
    publish = makeReceipt(original, "Publish", 602);
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
        ",rms_device.digital_receipt_template_submission,rms_device.digital_receipt_template_submit_operation,rms_device.digital_receipt_template_lifecycle_operation,rms_device.digital_receipt_template_version TO " +
        role,
    );
    await transaction(() => pair(first), { commit: true });
    await transaction(() => insertSubmission(original), { commit: true });
    // Only owner schema facts are exercised: Core approval/IAM/Audit evidence is not fabricated or asserted.
    for (const override of [
      { result_digest: null },
      { expected_revision: null },
      { occurred_at: "2026-10-05T14:00:03.000001Z" },
      { data_classification: "Internal" },
      { receipt_json: JSON.stringify({ ...approve, extra: "unknown" }) },
      {
        receipt_json: JSON.stringify({
          ...approve,
          result: { ...approve.result, approvedByReference: first.actor },
        }),
      },
      {
        receipt_json: JSON.stringify({
          ...approve,
          result: { ...approve.result, approvedByReference: original.submittedByReference },
        }),
      },
      {
        receipt_json: JSON.stringify({
          ...approve,
          result: { ...approve.result, approvalValidUntil: when },
        }),
      },
      {
        receipt_json: JSON.stringify({
          ...approve,
          result: { ...approve.result, approvalEvidenceReference: null },
        }),
      },
      { receipt_json: JSON.stringify({ ...approve, expectedVersionReference: id(999) }) },
      {
        receipt_json: JSON.stringify({
          ...approve,
          result: { ...approve.result, lifecycleVersion: 4 },
        }),
      },
    ])
      await rejected(() => insertTerminal(approve, override), ["23514", "23502"]);
    await rejected(() => insertTerminal({ ...approve, expectedVersionReference: id(999) }));
    await rejected(() => insertTerminal({ ...approve, expectedRevision: 2 }));
    await rejected(() => insertTerminal({ ...approve, reviewLifecycleReference: id(999) }));
    await rejected(() => insertTerminal({ ...approve, expectedReviewOperationReference: id(999) }));
    const expired = {
      ...approve,
      operationReference: id(604),
      occurredAt: expiry,
      result: {
        ...approve.result,
        mutationOperationReference: id(604),
        changedAt: expiry,
        approvedAt: expiry,
        approvalValidUntil: "2026-10-05T14:11:00.000Z",
      },
    };
    await rejected(() => insertTerminal(expired));
    await rejected(() =>
      insertTerminal({
        ...approve,
        result: { ...approve.result, approvalValidUntil: "2026-10-05T14:11:00.000Z" },
      }),
    );
    await transaction(() => insertTerminal(approve), { commit: true });
    await rejected(() => insertTerminal(publish)); // missing actual own published version
    await rejected(async () => {
      await insertPublished(publish, { digest: "sha256:" + "b".repeat(64) });
      await insertTerminal(publish);
    });
    await rejected(async () => {
      await insertPublished(publish);
      await insertTerminal(publish, {
        receipt_json: JSON.stringify({
          ...publish,
          result: {
            ...publish.result,
            publishedVersion: { ...publish.result.publishedVersion, extra: "HTML" },
          },
        }),
      });
    });
    await transaction(
      async () => {
        await insertPublished(publish);
        await insertTerminal(publish);
      },
      { commit: true },
    );
    // A genuine earlier immutable publication may never be borrowed into a later terminal transaction.
    await rejected(() => insertTerminal(publish));
    const abandoned = makeReceipt(original, "Publish", 603, "Abandoned");
    await transaction(() => insertTerminal(abandoned), { commit: true });
    await rejected(() =>
      insertPublished({ ...publish, operationReference: abandoned.operationReference }),
    );
    await rejected(() => insertTerminal(abandoned), ["23505"]);
    await transaction(async () => {
      const rows = (
        await admin.query(
          "SELECT receipt_json FROM rms_device.digital_receipt_template_lifecycle_operation ORDER BY operation_id",
        )
      ).rows;
      assert.deepEqual(
        rows.map((r) => parseDigitalReceiptTemplateLifecycleReceipt(r.receipt_json)),
        [approve, publish, abandoned],
      );
    });
    for (const key of ["tenant", "brand", "store"]) {
      const selected = { ...scope, [key]: id(990) };
      await transaction(
        async () =>
          assert.equal(
            (
              await admin.query(
                "SELECT operation_id FROM rms_device.digital_receipt_template_lifecycle_operation",
              )
            ).rows.length,
            0,
          ),
        { selected },
      );
      await rejected(() => insertTerminal(abandoned), ["55000", "42501"], { selected });
    }
    const foreignScope = { ...scope, store: id(991) };
    await rejected(
      () => insertTerminal({ ...abandoned, storeReference: foreignScope.store }),
      ["23505"],
      { selected: foreignScope },
    );
    await admin.query(
      "GRANT UPDATE,DELETE,TRUNCATE ON rms_device.digital_receipt_template_lifecycle_operation TO " +
        role,
    );
    for (const sql of [
      "UPDATE rms_device.digital_receipt_template_lifecycle_operation SET intent_digest=intent_digest",
      "DELETE FROM rms_device.digital_receipt_template_lifecycle_operation",
      "TRUNCATE rms_device.digital_receipt_template_lifecycle_operation",
    ])
      await rejected(async () => {
        assert.equal(
          (
            await admin.query(
              "SELECT operation_id FROM rms_device.digital_receipt_template_lifecycle_operation",
            )
          ).rows.length,
          3,
        );
        await admin.query(sql);
      }, ["55000"]);
    assert.deepEqual(await counts(), { terminals: "3", versions: "1", submissions: "1" });
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
