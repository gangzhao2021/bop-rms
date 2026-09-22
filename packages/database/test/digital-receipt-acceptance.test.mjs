import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createRefundReceiptSnapshot,
  createPostgresDigitalReceiptStore,
} from "../../rms/ordering/src/index.ts";
import { encodeDigitalReceiptRecord } from "../../rms/ordering/src/domain/digital-receipt-codec.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190ec01-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
const at = "2026-09-12T12:00:00.000Z";
const digest = "sha256:" + "a".repeat(64);
const money = (amountMinor) => ({ amountMinor, currencyCode: "CAD" });
const snapshot = {
  receiptReference: id(5),
  orderReference: id(3),
  guestSessionReference: id(4),
  operatingEntityReference: id(6),
  operatingEntityDisplayName: "Synthetic receipt issuer",
  ...scope,
  storeDisplayName: "Synthetic receipt store",
  orderNumber: "1",
  issuedAt: at,
  locale: "en-CA",
  templateVersion: "RECEIPT_V1",
  lines: [
    { lineReference: id(7), displayName: "Synthetic item", quantity: 1, lineTotal: money(1100n) },
  ],
  subtotal: money(1000n),
  adjustments: { discount: money(50n), fee: money(20n) },
  tax: money(130n),
  tip: money(100n),
  total: money(1200n),
  paymentStatus: "Paid",
  refundedTotal: money(0n),
};
const record = (version, kind = version === 1 ? "Original" : "Reissue") => ({
  recordReference: id(100 + version),
  version,
  kind,
  recordedAt: at,
  previousRecordReference: version === 1 ? null : id(99 + version),
  reasonCode: version === 1 ? null : "SYNTHETIC_REISSUE",
  snapshot,
});
const input = (value) => ({
  record: value,
  operationReference: id(200 + value.version),
  sourceDigest: digest,
  audit: {
    auditId: id(300 + value.version),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode: "DIGITAL_RECEIPT_APPEND",
    targetType: "DigitalReceipt",
    targetId: value.recordReference,
    reasonCode: "SYNTHETIC_RECEIPT",
    correlationId: id(200 + value.version),
    occurredAt: value.recordedAt,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  },
});

it("persists an immutable receipt chain with authorized replay, concurrency, RLS and atomic Audit", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_receipt" }, async (env) => {
    const admin = new Client(env.clientConfig);
    await admin.connect();
    const role = "wp2402_receipt_" + env.runId;
    assert.match(role, /^wp2402_receipt_[a-f0-9]+$/u);
    let authorized = true,
      sourcesAvailable = true,
      sourceChecks = 0,
      active = 0;
    const owner = (store = scope.storeReference) =>
      createPostgresDigitalReceiptStore({
        ...scope,
        storeReference: store,
        authorize: async () => authorized,
        validateSources: async (_tx, candidate, source) => {
          sourceChecks++;
          return (
            sourcesAvailable && source === digest && candidate.snapshot.orderReference === id(3)
          );
        },
      });
    const run = async (action, { failAudit = false, loseAck = false } = {}) => {
      const client = new Client({
        ...env.clientConfig,
        connectionTimeoutMillis: 2000,
        query_timeout: 5000,
      });
      await client.connect();
      active++;
      let committed = false;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL lock_timeout='5s'");
        const result = await action({
          query: async (sql, values) => {
            if (failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
              throw new Error("synthetic audit failure");
            return client.query(sql, [...values]);
          },
        });
        await client.query("COMMIT");
        committed = true;
        if (loseAck) throw new Error("synthetic lost response");
        return result;
      } catch (error) {
        if (!committed) await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
        active--;
      }
    };
    const append = (value, settings) =>
      run((transaction) => owner().append({ transaction, ...input(value) }), settings);
    const load = () => run((transaction) => owner().load({ transaction, orderReference: id(3) }));
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_ordering,platform_audit,platform_helpers TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_ordering.digital_receipt_record,platform_audit.audit_record TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,UPDATE ON rms_ordering.order_header,rms_ordering.order_submission_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "INSERT INTO rms_ordering.order_number_allocation (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,business_date_configuration_id,business_date_configuration_version,business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) " +
          "VALUES ($1,$2,$3,'2026-09-12',1,'1',$4,$5,1,$6,'America/Toronto','00:00',$4,'Exact')",
        [id(3), id(1), id(2), at, id(8), digest],
      );
      await admin.query(
        "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) " +
          "VALUES ($1,$2,$3,'2026-09-12','1','Pickup','Web',$4,$4,1,'Submitted','Open','NotReported',$5)",
        [id(3), id(1), id(2), id(4), at],
      );
      await admin.query(
        "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)",
        [id(9), id(1), id(2), id(3), id(4), digest, id(10), id(11), at],
      );
      const original = record(1);
      await assert.rejects(
        append({ ...original, snapshot: { ...snapshot, guestSessionReference: id(99) } }),
        { code: "DIGITAL_RECEIPT_CHAIN_CONFLICT" },
      );
      await assert.rejects(append({ ...original, snapshot: { ...snapshot, orderNumber: "2" } }), {
        code: "DIGITAL_RECEIPT_CHAIN_CONFLICT",
      });
      const results = await Promise.all([append(original), append(original)]);
      assert.deepEqual(results.map((value) => value.status).sort(), ["Created", "Existing"]);
      // Fresh append validates before and after Audit; replay does not re-read sources.
      assert.equal(sourceChecks, 2);
      authorized = false;
      await assert.rejects(append(original), { code: "DIGITAL_RECEIPT_PERMISSION_DENIED" });
      await assert.rejects(load(), { code: "DIGITAL_RECEIPT_PERMISSION_DENIED" });
      authorized = true;
      await assert.rejects(
        append({ ...original, snapshot: { ...snapshot, storeDisplayName: "Changed" } }),
        { code: "DIGITAL_RECEIPT_CHAIN_CONFLICT" },
      );
      const correction = {
        ...record(2, "Correction"),
        snapshot: { ...snapshot, storeDisplayName: "Synthetic corrected name" },
      };
      assert.equal((await append(correction)).status, "Created");
      const reissue = { ...record(3), snapshot: correction.snapshot };
      assert.equal((await append(reissue)).status, "Created");
      assert.deepEqual((await load()).records, [original, correction, reissue]);
      const next = { ...record(4), snapshot: correction.snapshot };
      await run(
        async (transaction) => {
          await assert.rejects(owner().append({ transaction, ...input(next) }), {
            code: "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE",
          });
        },
        { failAudit: true },
      ); // Deliberately commit after catching: savepoint must undo both writes.
      assert.equal((await load()).records.length, 3);
      sourcesAvailable = false;
      await assert.rejects(append(next), { code: "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE" });
      sourcesAvailable = true;
      await assert.rejects(append(next, { loseAck: true }), /synthetic lost response/u);
      assert.equal((await append(next)).status, "Existing");
      assert.equal((await load()).records.length, 4);
      assert.equal(
        await run((transaction) => owner(id(99)).load({ transaction, orderReference: id(3) })),
        null,
      );
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        await admin.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(1), id(99)],
        );
        assert.equal(
          Number(
            (await admin.query("SELECT count(*) AS count FROM rms_ordering.digital_receipt_record"))
              .rows[0].count,
          ),
          0,
        );
        const foreignWrite = { ...record(5), snapshot: correction.snapshot };
        await assert.rejects(
          admin.query(
            "INSERT INTO rms_ordering.digital_receipt_record " +
              "(record_id,operation_id,audit_id,brand_id,store_id,order_id,receipt_id,guest_session_id,version,kind,previous_record_id,source_digest,recorded_at,receipt_record_json) " +
              "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,5,'Reissue',$9,$10,$11,$12)",
            [
              id(105),
              id(205),
              id(305),
              id(1),
              id(2),
              id(3),
              id(5),
              id(4),
              id(104),
              digest,
              at,
              encodeDigitalReceiptRecord(foreignWrite),
            ],
          ),
          (error) => error.code === "42501",
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      assert.equal(
        (
          await admin.query("UPDATE rms_ordering.digital_receipt_record SET source_digest=$1", [
            digest,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (await admin.query("DELETE FROM rms_ordering.digital_receipt_record")).rowCount,
        0,
      );
      assert.equal(
        Number(
          (
            await admin.query(
              "SELECT count(*) AS count FROM platform_audit.audit_record WHERE action_code='DIGITAL_RECEIPT_APPEND'",
            )
          ).rows[0].count,
        ),
        4,
      );
      let refundIdentities = 0;
      const createRefund = (amount) => async (chain) => {
        const previous = chain.records.at(-1);
        const changed = createRefundReceiptSnapshot(previous, {
          ...scope,
          orderReference: id(3),
          observedAt: at,
          captured: money(1200n),
          refunded: money(amount),
          pendingRefund: money(0n),
        });
        if (changed === null) return null;
        refundIdentities++;
        return input({
          ...record(previous.version + 1, "Refund"),
          previousRecordReference: previous.recordReference,
          reasonCode: "PAYMENT_REFUND_STATUS_CHANGED",
          snapshot: changed,
        });
      };
      const issueRefund = () =>
        run((transaction) =>
          owner().issueRefund({
            transaction,
            orderReference: id(3),
            create: createRefund(100n),
          }),
        );
      const refundPair = await Promise.all([issueRefund(), issueRefund()]);
      assert.deepEqual(refundPair.map((result) => result.status).sort(), ["Created", "Existing"]);
      assert.deepEqual(refundPair[0].record, refundPair[1].record);
      assert.equal(refundIdentities, 1);
      const refunded = await load();
      assert.equal(refunded.records.length, 5);
      assert.equal(refunded.records[4].kind, "Refund");
      assert.equal(refunded.records[4].snapshot.paymentStatus, "PartiallyRefunded");
      assert.equal(refunded.records[4].snapshot.refundedTotal.amountMinor, 100n);
      assert.equal((await issueRefund()).status, "Existing");
      assert.equal(refundIdentities, 1);
      // Revocation after the Audit append must roll back both records even when
      // the caller catches the failure and commits its outer transaction.
      for (const losePermission of [true, false]) {
        await run(async (transaction) => {
          const intercepted = {
            query: async (sql, values) => {
              const result = await transaction.query(sql, values);
              if (sql.includes("INSERT INTO platform_audit.audit_record")) {
                if (losePermission) authorized = false;
                else sourcesAvailable = false;
              }
              return result;
            },
          };
          await assert.rejects(
            owner().issueRefund({
              transaction: intercepted,
              orderReference: id(3),
              create: createRefund(200n),
            }),
            { code: "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE" },
          );
        });
        authorized = true;
        sourcesAvailable = true;
        assert.equal((await load()).records.length, 5);
      }
      const finalAudit = await admin.query(
        "SELECT count(*)::int AS count FROM platform_audit.audit_record WHERE action_code='DIGITAL_RECEIPT_APPEND'",
      );
      assert.equal(finalAudit.rows[0].count, 5);
      assert.deepEqual((await load()).records[0], original);
      assert.equal(active, 0);
    } finally {
      try {
        await admin.query("ROLLBACK");
        assert.equal(active, 0);
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      } finally {
        await admin.end();
      }
    }
  });
});
