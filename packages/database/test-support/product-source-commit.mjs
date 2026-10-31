import assert from "node:assert/strict";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { eventCatalog } from "../../contracts/events/catalog.ts";

export async function assertProductSourceCommits(admin) {
  const records = (
    await admin.query(`SELECT c.*,c.actor_id receipt_actor,c.correlation_id receipt_correlation,s.snapshot_json,h.source_revision head_revision,
    e.event_type outbox_type,e.brand_id event_brand,e.aggregate_id,e.aggregate_version event_version,
    e.actor_id,e.correlation_id,e.payload_json,e.replay_metadata_json,e.redaction_classification,
    a.actor_reference audit_actor,a.correlation_id audit_correlation
    FROM rms_catalog.product_source_commit c
    JOIN rms_catalog.product_operation_snapshot s ON s.operation_id=c.operation_id
    JOIN rms_catalog.product_source_head h ON h.brand_id=c.brand_id
    JOIN platform_eventing.outbox_event e ON e.event_id=c.event_id
    JOIN platform_audit.audit_record a ON a.correlation_id=e.correlation_id AND a.target_id=c.product_id`)
  ).rows;
  const totals = (
    await admin.query(`SELECT (SELECT count(*)::int FROM rms_catalog.product_source_commit) receipts,
    (SELECT count(*)::int FROM platform_eventing.outbox_event WHERE producer_module='@rms/catalog' AND aggregate_type='Product') events`)
  ).rows[0];
  assert.equal(records.length, totals.receipts);
  assert.equal(records.length, totals.events);
  const brands = new Map();
  for (const row of records) {
    const schema = eventCatalog.find(
      (entry) => entry.eventType === row.event_type && entry.schemaVersion === 1,
    );
    assert.ok(schema);
    schema.payloadSchema.parse(row.payload_json);
    assert.equal(row.event_type, row.outbox_type);
    assert.equal(row.brand_id, row.event_brand);
    assert.equal(row.product_id, row.aggregate_id);
    assert.equal(String(row.result_aggregate_version), row.event_version);
    assert.equal(row.actor_id, row.audit_actor);
    assert.equal(row.receipt_actor, row.actor_id);
    assert.equal(row.receipt_correlation, row.correlation_id);
    assert.equal(row.correlation_id, row.audit_correlation);
    assert.equal(row.redaction_classification, "indirect_identifier");
    assert.equal(row.payload_json.sourceRevision, row.source_revision);
    assert.equal(row.payload_json.operationReference, row.operation_id);
    assert.equal(
      row.payload_json.productVersionReference,
      row.snapshot_json.draft.versionReference,
    );
    assert.equal(row.payload_json.lifecycle, row.snapshot_json.lifecycle);
    assert.equal(
      row.payload_json.snapshotDigest,
      "sha256:" + sha256Hex(canonicalizeRfc8785(row.snapshot_json)),
    );
    assert.equal(row.snapshot_digest, row.payload_json.snapshotDigest);
    assert.deepEqual(row.replay_metadata_json, {
      operationReference: row.operation_id,
      sourceRevision: row.source_revision,
    });
    const entries = brands.get(row.brand_id) ?? [];
    entries.push(BigInt(row.source_revision));
    brands.set(row.brand_id, entries);
  }
  for (const [brand, revisions] of brands) {
    revisions.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(
      revisions,
      Array.from({ length: revisions.length }, (_, i) => BigInt(i + 1)),
    );
    assert.equal(
      (
        await admin.query(
          "SELECT source_revision::text revision FROM rms_catalog.product_source_head WHERE brand_id=$1",
          [brand],
        )
      ).rows[0].revision,
      String(revisions.length),
    );
  }
  return records;
}
