import assert from "node:assert/strict";
import pg from "pg";
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
export async function verifyReceiptTemplateDraftSchema(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_receipt_drafts_" + context.runId;
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
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::text FROM rms_device.digital_receipt_template_draft_revision) revisions,(SELECT count(*)::text FROM rms_device.digital_receipt_template_draft_operation) operations",
      )
    ).rows[0];
  const rejected = async (work, codes = ["23514"], options = {}) => {
    const before = await counts();
    await assert.rejects(transaction(work, options), (error) => codes.includes(error.code));
    assert.deepEqual(
      await counts(),
      before,
      "Rejected raw Receipt Template Draft left an artifact",
    );
  };
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN");
    roleCreated = true;
    await admin.query("GRANT USAGE ON SCHEMA rms_device,platform_helpers TO " + role);
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
        role,
    );
    await admin.query("GRANT SELECT,INSERT ON " + tables + " TO " + role);
    const first = state(1, 201),
      second = state(2, 202, id(6));
    await transaction(() => pair(first), { commit: true });
    await transaction(() => pair(second), { commit: true });
    await transaction(async () => {
      const rows = (
        await admin.query(
          "SELECT snapshot_json FROM rms_device.digital_receipt_template_draft_revision ORDER BY revision",
        )
      ).rows;
      assert.deepEqual(
        rows.map((row) => parseDigitalReceiptTemplateDraft(row.snapshot_json)),
        [first.snapshot, second.snapshot],
      );
      assert.equal(first.snapshot.content.versionNumber, 1);
      assert.equal(second.snapshot.content.versionNumber, 1);
      assert.notEqual(
        first.snapshot.content.versionReference,
        second.snapshot.content.versionReference,
      );
      assert.equal(
        second.snapshot.previousVersionReference,
        first.snapshot.content.versionReference,
      );
      assert.equal(second.snapshot.familyReference, first.snapshot.familyReference);
      assert.equal(
        second.snapshot.content.templateReference,
        first.snapshot.content.templateReference,
      );
      assert.equal(second.snapshot.createdAt, first.snapshot.createdAt);
      assert.notEqual(second.snapshot.authoredByReference, first.snapshot.authoredByReference);
      const original = (
        await admin.query(
          "SELECT template_id,result_version_id FROM rms_device.digital_receipt_template_draft_operation WHERE operation_id=$1",
          [first.operation],
        )
      ).rows[0];
      assert.equal(original.template_id, null);
      assert.equal(original.result_version_id, first.snapshot.content.versionReference);
    });
    let next = 300;
    const candidate = () => state(3, ++next);
    // Valid Scheduled authored content and an independently supplied publication
    // counter exercise schema shape only; no Published row is fabricated.
    for (const [effectiveFrom, effectiveUntil] of [
      ["2026-10-06T14:00:00.000Z", "2026-10-07T14:00:00.000Z"],
      ["0000-02-29T14:00:00.000Z", "0000-03-01T14:00:00.000Z"],
    ])
      await transaction(async () => {
        const value = candidate();
        const content = createDigitalReceiptTemplateDraftContent({
          tenantReference: scope.tenant,
          brandReference: scope.brand,
          storeReference: scope.store,
          templateReference: id(50),
          versionReference: value.snapshot.content.versionReference,
          versionNumber: 2,
          fields: {
            locale: "fr-CA",
            layoutDefinitionReference: id(70),
            complianceRuleReference: id(71),
            activation: { mode: "Scheduled", effectiveFrom },
            effectiveUntil,
          },
        });
        const snapshot = parseDigitalReceiptTemplateDraft({
          ...value.snapshot,
          content,
          contentDigest: digest(content),
        });
        await pair({ ...value, snapshot, digest: digest(snapshot) });
      });
    await rejected(async () => {
      await insertRevision(candidate());
      await admin.query(flush);
    });
    await rejected(async () => {
      await insertOperation(candidate());
      await admin.query(flush);
    });
    await rejected(async () => {
      await insertOperation(first, { operation: id(299), audit: id(10299) });
      await admin.query(flush);
    });
    for (const overrides of [
      { resultRevision: null },
      { actor: id(99) },
      { template: id(88) },
      { expectedVersion: id(88) },
      { digest: "sha256:" + "b".repeat(64) },
      { resultVersion: id(88) },
      { expectedRevision: 0 },
      { template: null },
    ])
      await rejected(async () => pair(candidate(), {}, overrides));
    for (const mutate of [
      (value) => ({ ...value, familyReference: id(88) }),
      (value) => ({ ...value, previousVersionReference: null }),
      (value) => ({ ...value, createdAt: later }),
      (value) => ({ ...value, html: "Synthetic forbidden metadata" }),
      (value) => ({ ...value, content: { ...value.content, profile: "Unknown" } }),
      (value) => ({ ...value, content: { ...value.content, templateReference: id(88) } }),
      (value) => ({ ...value, content: { ...value.content, versionReference: id(88) } }),
      (value) => ({ ...value, content: { ...value.content, versionNumber: 2 } }),
      (value) => ({ ...value, content: { ...value.content, versionNumber: null } }),
      (value) => ({ ...value, content: { ...value.content, versionCode: "CUSTOM" } }),
      (value) => ({ ...value, content: { ...value.content, renderEngineVersion: null } }),
      (value) => ({
        ...value,
        content: { ...value.content, requiredFields: [...value.content.requiredFields].reverse() },
      }),
      (value) => ({ ...value, content: { ...value.content, layoutDefinitionReference: null } }),
      (value) => ({ ...value, content: { ...value.content, complianceRuleReference: "unknown" } }),
      (value) => ({
        ...value,
        content: { ...value.content, professionalReviewStatus: "Certified" },
      }),
      (value) => ({
        ...value,
        content: { ...value.content, activation: { mode: "Immediate", effectiveFrom: at } },
      }),
      (value) => ({
        ...value,
        content: {
          ...value.content,
          activation: { mode: "Scheduled", effectiveFrom: "2026-02-30T00:00:00.000Z" },
        },
      }),
      (value) => ({
        ...value,
        content: {
          ...value.content,
          activation: { mode: "Scheduled", effectiveFrom: "0001-02-29T00:00:00.000Z" },
        },
      }),
      (value) => ({
        ...value,
        content: {
          ...value.content,
          activation: { mode: "Scheduled", effectiveFrom: later },
          effectiveUntil: at,
        },
      }),
      (value) => ({ ...value, content: { ...value.content, effectiveUntil: null, locale: null } }),
    ])
      await rejected(async () => {
        const value = candidate();
        await pair(value, { snapshot: mutate(value.snapshot) });
      });
    await rejected(async () => {
      const value = candidate();
      await pair(value, {
        family: id(88),
        snapshot: { ...value.snapshot, familyReference: id(88) },
      });
    });
    await rejected(async () => {
      const value = candidate();
      await pair(
        value,
        { previous: id(88), snapshot: { ...value.snapshot, previousVersionReference: id(88) } },
        { expectedVersion: id(88) },
      );
    });
    await rejected(async () => {
      const value = candidate();
      await pair(value, { created: later, snapshot: { ...value.snapshot, createdAt: later } });
    });
    await rejected(async () => {
      const value = candidate();
      await pair(value, { revision: 4, snapshot: { ...value.snapshot, revision: 4 } });
    });
    for (const field of ["created", "updated"])
      await rejected(async () => pair(candidate(), { [field]: "2026-10-05T14:00:01.000123Z" }));
    await rejected(async () => pair(candidate(), {}, { occurred: "2026-10-05T14:00:01.000123Z" }));
    await rejected(async () => {
      const value = candidate();
      await pair({ ...value, operation: first.operation });
    }, ["23505", "23514"]);
    for (const key of ["tenant", "brand", "store"]) {
      const selected = { ...scope, [key]: id(90) };
      await transaction(
        async () => {
          for (const table of [
            "digital_receipt_template_draft_revision",
            "digital_receipt_template_draft_operation",
          ])
            assert.deepEqual(
              (await admin.query("SELECT operation_id FROM rms_device." + table)).rows,
              [],
            );
        },
        { selected },
      );
      await rejected(() => pair(candidate()), ["55000", "42501"], { selected });
    }
    const foreign = { tenant: id(90), brand: id(91), store: id(92) };
    for (const reuse of ["Template", "Family", "Version"]) {
      const value = state(
        1,
        ++next,
        id(7),
        foreign,
        reuse === "Template" ? id(50) : id(80),
        reuse === "Family" ? id(60) : id(81),
      );
      const updatedContent = {
        ...value.snapshot.content,
        versionReference: reuse === "Version" ? first.snapshot.content.versionReference : id(82),
      };
      const revised = {
        ...value.snapshot,
        content: updatedContent,
        contentDigest: digest(updatedContent),
      };
      await rejected(
        () => pair({ ...value, snapshot: revised, digest: digest(revised) }),
        ["23505"],
        { selected: foreign },
      );
    }
    await rejected(async () => {
      const value = candidate();
      await insertRevision(value);
      await insertOperation(value);
      await setScope(foreign);
      await admin.query(flush);
    }, ["55000"]);
    await transaction(async () => {
      const value = candidate();
      await insertRevision(value);
      await insertOperation(value);
      await setScope(foreign);
      await setScope();
      await admin.query(flush);
    });
    const abandoned = candidate();
    await transaction(
      async () => {
        await insertOperation(abandoned, {
          outcome: "Abandoned",
          resultVersion: null,
          resultRevision: null,
          digest: null,
        });
        await admin.query(flush);
      },
      { commit: true },
    );
    await rejected(() => pair(abandoned), ["23505", "23514"]);
    await rejected(
      async () => {
        await insertOperation(state(1, ++next, id(7), foreign, id(80), id(81)), {
          operation: first.operation,
          outcome: "Abandoned",
          resultVersion: null,
          resultRevision: null,
          digest: null,
        });
        await admin.query(flush);
      },
      ["23505"],
      { selected: foreign },
    );
    await admin.query("GRANT UPDATE,DELETE,TRUNCATE ON " + tables + " TO " + role);
    // TRUNCATE ... CASCADE checks privileges on every table that references these (including later
    // ones) before any trigger runs; grant them so the append-only trigger is what refuses.
    const cascaded = (
      await admin.query(
        "WITH RECURSIVE d(t) AS (SELECT unnest($1::regclass[]) UNION SELECT c.conrelid FROM pg_constraint c JOIN d ON c.confrelid=d.t WHERE c.contype='f') SELECT string_agg(DISTINCT t::text, ',') AS tables FROM d",
        [
          [
            "rms_device.digital_receipt_template_draft_revision",
            "rms_device.digital_receipt_template_draft_operation",
          ],
        ],
      )
    ).rows[0].tables;
    await admin.query("GRANT TRUNCATE ON " + cascaded + " TO " + role);
    for (const table of [
      "digital_receipt_template_draft_revision",
      "digital_receipt_template_draft_operation",
    ])
      for (const statement of [
        "UPDATE rms_device." + table + " SET data_classification='Internal'",
        "DELETE FROM rms_device." + table,
        "TRUNCATE rms_device." + table + " CASCADE",
      ])
        await rejected(async () => {
          assert.ok(
            (await admin.query("SELECT operation_id FROM rms_device." + table)).rows.length > 0,
          );
          await admin.query(statement);
        }, ["55000"]);
    assert.deepEqual(await counts(), { revisions: "2", operations: "3" });
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
