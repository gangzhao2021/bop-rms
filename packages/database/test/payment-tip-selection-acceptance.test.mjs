import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresPaymentTipSelectionStore,
  parsePaymentTipSelection,
} from "../../rms/payment/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-10T12:00:00.000Z";
const scope = { brandReference: id(7), storeReference: id(8) };
const record = (n) =>
  parsePaymentTipSelection({
    selectionReference: id(n),
    paymentOperationReference: id(2),
    submissionReference: id(3),
    cartReference: id(4),
    cartVersion: 1,
    quoteReference: id(5),
    guestSessionReference: id(6),
    ...scope,
    tip: { amountMinor: 125n, currencyCode: "CAD" },
    selectedAt: at,
  });
it("persists explicit tips with immutable scoped replay, concurrency and atomic Audit", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_tip" }, async (env) => {
    const admin = new Client(env.clientConfig);
    await admin.connect();
    const role = "wp2402_tip_" + env.runId;
    assert.match(role, /^wp2402_tip_[a-f0-9]+$/u);
    let active = 0,
      sequence = 1000;
    const audit = (value) => ({
      auditId: id(++sequence),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "PAYMENT_TIP_SELECT",
      targetType: "PaymentTipSelection",
      targetId: value.selectionReference,
      reasonCode: "AUTHORIZED_PAYMENT_TIP_SELECT",
      correlationId: id(31),
      occurredAt: value.selectedAt,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    });
    const runner = ({ failAudit = false, loseAck = false } = {}) => ({
      async run(action) {
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
          if (loseAck) throw new Error("synthetic lost acknowledgement");
          return result;
        } catch (error) {
          if (!committed) await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
          active--;
        }
      },
    });
    const owner = (options) =>
      createPostgresPaymentTipSelectionStore(runner(options), scope, { now: () => at });
    const append = (store, value) => store.append({ record: value, audit: audit(value) });
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_payment,platform_audit,platform_helpers TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_payment.payment_tip_selection,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      const store = owner(),
        initial = record(100);
      assert.equal((await append(store, initial)).status, "Created");
      assert.deepEqual(await store.load(initial.selectionReference), initial);
      assert.equal((await append(store, initial)).status, "Existing");
      await assert.rejects(
        append(store, { ...initial, tip: { amountMinor: 126n, currencyCode: "CAD" } }),
        { code: "PAYMENT_TIP_CONFLICT" },
      );
      const foreign = createPostgresPaymentTipSelectionStore(
        runner(),
        { ...scope, storeReference: id(9) },
        { now: () => at },
      );
      assert.equal(await foreign.load(initial.selectionReference), null);
      await assert.rejects(append(foreign, initial), { code: "PAYMENT_TIP_CONFLICT" });
      // Exercise forced RLS itself, without relying on the adapter's WHERE filter.
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        await admin.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, id(9)],
        );
        assert.equal(
          Number(
            (await admin.query("SELECT count(*) AS count FROM rms_payment.payment_tip_selection"))
              .rows[0].count,
          ),
          0,
        );
        await assert.rejects(
          admin.query(
            "INSERT INTO rms_payment.payment_tip_selection (selection_id,brand_id,store_id,payment_operation_id,submission_id,cart_id,cart_version,quote_id,guest_session_id,tip_minor,currency_code,selected_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,0,'CAD',$9)",
            [
              id(199),
              scope.brandReference,
              scope.storeReference,
              id(2),
              id(3),
              id(4),
              id(5),
              id(6),
              at,
            ],
          ),
          (error) => error.code === "42501",
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      const zero = { ...record(101), tip: { amountMinor: 0n, currencyCode: "CAD" } };
      assert.equal((await append(store, zero)).record.tip.amountMinor, 0n);
      const concurrent = record(102);
      const results = await Promise.all([append(owner(), concurrent), append(owner(), concurrent)]);
      assert.deepEqual(results.map((r) => r.status).sort(), ["Created", "Existing"]);
      const failed = record(103);
      await assert.rejects(append(owner({ failAudit: true }), failed), {
        code: "PAYMENT_TIP_UNAVAILABLE",
      });
      assert.equal(await store.load(failed.selectionReference), null);
      const lost = record(104);
      await assert.rejects(append(owner({ loseAck: true }), lost), {
        code: "PAYMENT_TIP_UNAVAILABLE",
      });
      assert.deepEqual(await owner().load(lost.selectionReference), lost);
      assert.equal((await append(owner(), lost)).status, "Existing");
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_payment.payment_tip_selection SET tip_minor=999 WHERE selection_id=$1",
            [initial.selectionReference],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await admin.query("DELETE FROM rms_payment.payment_tip_selection WHERE selection_id=$1", [
            initial.selectionReference,
          ])
        ).rowCount,
        0,
      );
      assert.deepEqual(await store.load(initial.selectionReference), initial);
      assert.equal(
        Number(
          (await admin.query("SELECT count(*) AS count FROM rms_payment.payment_tip_selection"))
            .rows[0].count,
        ),
        4,
      );
      assert.equal(
        Number(
          (
            await admin.query(
              "SELECT count(*) AS count FROM platform_audit.audit_record WHERE action_code='PAYMENT_TIP_SELECT'",
            )
          ).rows[0].count,
        ),
        4,
      );
      assert.equal(active, 0);
    } finally {
      await admin.query("ROLLBACK");
      assert.equal(active, 0);
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});
