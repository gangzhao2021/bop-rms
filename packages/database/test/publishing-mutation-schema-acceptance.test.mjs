import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z";
it("stores exact Publishing mutation history and rejects broken chains, headers and history edits", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_publish" }, async (context) => {
    const client = new Client(context.clientConfig);
    await client.connect();
    try {
      const scope = { kind: "Store", brandReference: id(2), storeReference: id(3) };
      const next = {
        lifecycleId: id(5),
        familyReference: id(4),
        configurationType: "WORKFLOW_CONFIGURATION",
        purposeCode: "ORDER_FULFILLMENT",
        snapshotReference: id(6),
        snapshotDigest: "sha256:" + "a".repeat(64),
        scope,
        version: 1,
        state: "Draft",
        validationEvidenceReference: null,
        approvalEvidenceReference: null,
        createdAt: at,
        changedAt: at,
      };
      const draft = {
        operation: "CreateDraft",
        expectedVersion: 1,
        idempotencyKey: id(10),
        current: null,
        next,
        release: null,
        supersededReleaseId: null,
        rollbackTargetReleaseId: null,
        validationEvidence: null,
        approvalEvidence: null,
        audit: {
          auditId: id(11),
          actor: { type: "User", reference: id(7) },
          brandId: id(2),
          storeId: id(3),
          targetType: "PublishingLifecycle",
          targetId: id(5),
        },
      };
      async function insert(value, version, op, audit, release = null, sequence = null) {
        return client.query(
          "INSERT INTO bop_publishing.publishing_mutation_record (tenant_id,brand_id,store_id,family_id,lifecycle_id,lifecycle_version,operation_id,operation_code,actor_id,audit_id,intent_hash,release_id,release_sequence,changed_at,mutation_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)",
          [
            id(1),
            id(2),
            id(3),
            id(4),
            id(5),
            version,
            op,
            value.operation,
            id(7),
            audit,
            "sha256:" + "b".repeat(64),
            release,
            sequence,
            at,
            value,
          ],
        );
      }
      await insert(draft, 1, id(10), id(11));
      const malformed = {
        ...draft,
        idempotencyKey: id(12),
        current: next,
        next: { ...next, version: 2 },
        audit: { ...draft.audit, auditId: id(13) },
      };
      delete malformed.next.familyReference;
      await assert.rejects(insert(malformed, 2, id(12), id(13)), { code: "23514" });
      const review = {
        ...draft,
        operation: "SubmitReview",
        idempotencyKey: id(14),
        current: next,
        next: { ...next, version: 2, state: "InReview", validationEvidenceReference: id(20) },
        validationEvidence: { evidenceReference: id(20), result: "Pass" },
        audit: { ...draft.audit, auditId: id(15) },
      };
      await insert(review, 2, id(14), id(15));
      const broken = {
        ...review,
        expectedVersion: 2,
        idempotencyKey: id(16),
        next: { ...review.next, version: 3 },
        audit: { ...draft.audit, auditId: id(17) },
      };
      await assert.rejects(insert(broken, 3, id(16), id(17)), { code: "23514" });
      await assert.rejects(
        client.query(
          "UPDATE bop_publishing.publishing_mutation_record SET intent_hash='sha256:' || repeat('c',64)",
        ),
        { code: "55000" },
      );
      await assert.rejects(client.query("DELETE FROM bop_publishing.publishing_mutation_record"), {
        code: "55000",
      });
      await assert.rejects(client.query("TRUNCATE bop_publishing.publishing_mutation_record"), {
        code: "55000",
      });
      const stored = await client.query(
        "SELECT mutation_json FROM bop_publishing.publishing_mutation_record ORDER BY lifecycle_version",
      );
      assert.deepEqual(
        stored.rows.map((r) => r.mutation_json),
        [draft, review],
      );
    } finally {
      await client.end();
    }
  });
});
