import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it("enforces checkout session identities, append-only history and Store RLS in PostgreSQL", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_session" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_session_" + context.runId;
    assert.match(role, /^wp2402_session_[a-f0-9]+$/u);
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query("GRANT USAGE ON SCHEMA rms_ordering,platform_helpers TO " + role);
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_ordering.checkout_session_record,rms_ordering.checkout_session_allocation TO " +
          role,
      );
      const now = new Date(Date.now() - 1000).toISOString();
      await admin.query(
        `INSERT INTO rms_ordering.cart
    (cart_id,brand_id,store_id,order_type,source_channel,created_by_actor_id,aggregate_version,created_at,updated_at,
     lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at)
    VALUES ($1,$2,$3,'Pickup','Qr',$4,1,$5,$5,'Active',$6,$7,3600,86400,$5::timestamptz+interval '1 hour',$5::timestamptz+interval '24 hours')`,
        [id(3), id(1), id(2), id(4), now, id(5), "sha256:" + "a".repeat(64)],
      );

      const snapshot = {
        schemaVersion: 1,
        checkoutSessionReference: id(10),
        createOperationReference: id(11),
        submissionReference: id(12),
        paymentOperationReference: id(13),
        validation: {
          brandReference: id(1),
          storeReference: id(2),
          guestSessionReference: id(4),
          cartReference: id(3),
        },
        createdAt: now,
      };
      // Minimal SQL fixture tests column binding; full domain parsing belongs to the adapter.
      async function scoped(store, work) {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(1), store],
          );
          const result = await work();
          await admin.query("COMMIT");
          return result;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      }
      function insert(value = snapshot) {
        return admin.query(
          "INSERT INTO rms_ordering.checkout_session_record (brand_id,store_id,checkout_session_id,create_operation_id,submission_id,payment_operation_id,guest_session_id,cart_id,snapshot_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
          [
            id(1),
            id(2),
            value.checkoutSessionReference,
            value.createOperationReference,
            value.submissionReference,
            value.paymentOperationReference,
            id(4),
            id(3),
            JSON.stringify(value),
            now,
          ],
        );
      }

      async function allocate(operation = 60, session = 61, submission = 62, payment = 63) {
        return admin.query(
          "INSERT INTO rms_ordering.checkout_session_allocation (brand_id,store_id,create_operation_id,guest_session_id,cart_id,cart_version,quote_id,quote_version,checkout_session_id,submission_id,payment_operation_id,allocated_at) VALUES ($1,$2,$3,$4,$5,1,$6,1,$7,$8,$9,$10)",
          [
            id(1),
            id(2),
            id(operation),
            id(4),
            id(3),
            id(64),
            id(session),
            id(submission),
            id(payment),
            now,
          ],
        );
      }
      await scoped(id(2), () => allocate());
      await assert.rejects(
        scoped(id(2), () => allocate(60, 71, 72, 73)),
        { code: "23505" },
      );
      await assert.rejects(
        scoped(id(2), () => allocate(70, 61, 72, 73)),
        { code: "23505" },
      );
      await assert.rejects(
        scoped(id(2), () => allocate(70, 71, 62, 73)),
        { code: "23505" },
      );
      await assert.rejects(
        scoped(id(2), () => allocate(70, 71, 72, 63)),
        { code: "23505" },
      );
      await assert.rejects(
        scoped(id(2), () => allocate(70, 71, 71, 73)),
        { code: "23514" },
      );
      await assert.rejects(
        scoped(id(99), () => allocate(70, 71, 72, 73)),
        { code: "42501" },
      );
      const allocated = () =>
        admin.query(
          "SELECT create_operation_id,checkout_session_id,submission_id,payment_operation_id FROM rms_ordering.checkout_session_allocation",
        );
      assert.equal((await scoped(id(99), allocated)).rowCount, 0);
      await scoped(id(2), () =>
        admin.query("UPDATE rms_ordering.checkout_session_allocation SET submission_id=$1", [
          id(90),
        ]),
      );
      await scoped(id(2), () =>
        admin.query("DELETE FROM rms_ordering.checkout_session_allocation"),
      );
      assert.deepEqual((await scoped(id(2), allocated)).rows, [
        {
          create_operation_id: id(60),
          checkout_session_id: id(61),
          submission_id: id(62),
          payment_operation_id: id(63),
        },
      ]);
      await scoped(id(2), () => insert());
      const read = () =>
        admin.query("SELECT snapshot_json FROM rms_ordering.checkout_session_record");
      assert.deepEqual((await scoped(id(2), read)).rows, [{ snapshot_json: snapshot }]);
      assert.equal((await scoped(id(99), read)).rowCount, 0);
      await assert.rejects(
        scoped(id(99), () => insert()),
        { code: "42501" },
      );
      for (const field of [
        "createOperationReference",
        "submissionReference",
        "paymentOperationReference",
      ]) {
        const other = {
          ...snapshot,
          checkoutSessionReference: id(20),
          createOperationReference: id(21),
          submissionReference: id(22),
          paymentOperationReference: id(23),
          [field]: snapshot[field],
        };
        await assert.rejects(
          scoped(id(2), () => insert(other)),
          { code: "23505" },
        );
      }
      await assert.rejects(
        scoped(id(2), () =>
          insert({
            ...snapshot,
            checkoutSessionReference: id(30),
            createOperationReference: id(31),
            submissionReference: id(30),
            paymentOperationReference: id(33),
          }),
        ),
        { code: "23514" },
      );
      const missing = {
        ...snapshot,
        checkoutSessionReference: id(40),
        createOperationReference: id(41),
        submissionReference: id(42),
        paymentOperationReference: id(43),
        validation: { ...snapshot.validation },
      };
      delete missing.validation.guestSessionReference;
      await assert.rejects(
        scoped(id(2), () => insert(missing)),
        { code: "23514" },
      );
      await scoped(id(2), () =>
        admin.query("UPDATE rms_ordering.checkout_session_record SET snapshot_json='{}'::jsonb"),
      );
      await scoped(id(2), () => admin.query("DELETE FROM rms_ordering.checkout_session_record"));
      assert.deepEqual((await scoped(id(2), read)).rows, [{ snapshot_json: snapshot }]);
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});
