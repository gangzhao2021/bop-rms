import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  readCheckoutContactPresence,
  removeCheckoutContactOnStaffRequest,
} from "../../rms/ordering/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190ab50-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * M108: a guest whose visit on their phone ended asks the store to remove the pickup contact they
 * gave. Staff remove it (2000_450): once, with append-only evidence naming the staff member and
 * never the value; the order is untouched. The code under test runs as a NOBYPASSRLS role holding
 * only the pilot api grants it uses (docs/spec/pilot-acl-additions.json, Owner 2026-10-14 Q10):
 * no new grant is needed.
 */
it("M108: staff remove a guest's pickup contact once, attributed, for this Store's order only", async () => {
  await withIsolatedDatabase({ caseId: "m108_staff" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const apiRole = "m108_api_" + context.runId;
    const scope = { brandReference: id(1), storeReference: id(2) };
    const otherStore = { brandReference: id(1), storeReference: id(3) };
    const staff = id(0x50);
    try {
      await admin.query(
        `CREATE ROLE ${apiRole} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA rms_ordering,platform_helpers TO ${apiRole}`);
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${apiRole}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${apiRole}`,
      );
      // The pilot api's grants on these tables (pilot ACL: Q10 contact removal additions).
      await admin.query(
        `GRANT SELECT ON rms_ordering.order_submission_record,rms_ordering.order_checkout_details_link,rms_ordering.checkout_details_record,rms_ordering.checkout_contact_redaction TO ${apiRole}`,
      );
      await admin.query(`GRANT UPDATE ON rms_ordering.checkout_details_record TO ${apiRole}`);
      await admin.query(`GRANT INSERT ON rms_ordering.checkout_contact_redaction TO ${apiRole}`);
      const api = async (work) => {
        const client = new Client({ ...context.clientConfig, query_timeout: 5000 });
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE ${apiRole}`);
          const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      };

      // A pickup order with a contact, seeded as the checkout writes it (FKs not under test).
      const recordedAt = new Date(Date.now() - 3_600_000).toISOString();
      const order = id(0x10),
        submission = id(0x11),
        cart = id(0x12),
        details = id(0x13),
        guest = id(0x14);
      await admin.query("SET session_replication_role = replica");
      await admin.query(
        "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)",
        [
          submission,
          scope.brandReference,
          scope.storeReference,
          order,
          guest,
          "sha256:" + "d".repeat(64),
          cart,
          id(0x15),
          recordedAt,
        ],
      );
      await admin.query(
        "INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,operation_id,guest_session_id,cart_id,snapshot_json,recorded_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)",
        [
          scope.brandReference,
          scope.storeReference,
          details,
          id(0x16),
          guest,
          cart,
          {
            schemaVersion: 1,
            detailsReference: details,
            detailsVersion: 1,
            guestSessionReference: guest,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            cartReference: cart,
            cartVersion: 1,
            quoteReference: id(0x15),
            quoteVersion: 2,
            orderType: "Pickup",
            pickupContact: { name: "Synthetic Guest", channel: "Phone", value: "+14165550123" },
            receipt: { choice: "InSession", email: null },
            policies: [],
            recordedAt,
          },
          recordedAt,
        ],
      );
      await admin.query(
        "INSERT INTO rms_ordering.order_checkout_details_link (brand_id,store_id,submission_id,order_id,details_id,details_version) VALUES ($1,$2,$3,$4,$5,1)",
        [scope.brandReference, scope.storeReference, submission, order, details],
      );
      await admin.query("SET session_replication_role = origin");

      const remove = (where, redaction) =>
        api((tx) =>
          removeCheckoutContactOnStaffRequest(tx, where, {
            orderReference: order,
            actorReference: staff,
            observedAt: new Date().toISOString(),
            redactionReference: redaction,
          }),
        );
      // Another Store's staff never reach this order.
      await assert.rejects(remove(otherStore, id(0x20)), {
        code: "CHECKOUT_CONTACT_REMOVAL_NOT_FOUND",
      });
      assert.deepEqual(await remove(scope, id(0x21)), { status: "Removed" });
      // A repeat writes nothing.
      assert.deepEqual(await remove(scope, id(0x22)), { status: "AlreadyRemoved" });
      assert.equal(
        await api((tx) =>
          readCheckoutContactPresence(tx, scope, {
            orderReference: order,
            guestSessionReference: guest,
          }),
        ),
        "Removed",
      );
      const evidence = await admin.query(
        "SELECT policy_code,retention_days,removed_by_actor_id::text AS actor,row_to_json(r)::text AS text FROM rms_ordering.checkout_contact_redaction r WHERE details_id=$1",
        [details],
      );
      assert.equal(evidence.rows.length, 1);
      assert.equal(evidence.rows[0].policy_code, "STAFF_ON_CUSTOMER_REQUEST");
      assert.equal(evidence.rows[0].retention_days, null);
      assert.equal(evidence.rows[0].actor, staff);
      assert.equal(evidence.rows[0].text.includes("4165550123"), false);
      const cleared = await admin.query(
        "SELECT snapshot_json->'pickupContact' AS contact,snapshot_json::text AS text FROM rms_ordering.checkout_details_record WHERE details_id=$1",
        [details],
      );
      assert.equal(cleared.rows[0].contact, null);
      assert.equal(cleared.rows[0].text.includes("4165550123"), false);

      // The evidence is append-only, even for the api role.
      for (const sql of [
        "UPDATE rms_ordering.checkout_contact_redaction SET removed_by_actor_id=NULL WHERE details_id=$1",
        "DELETE FROM rms_ordering.checkout_contact_redaction WHERE details_id=$1",
      ])
        await assert.rejects(api((tx) => tx.query(sql, [details])));
      // The database names who removed it only for a staff removal, and always then (checked on
      // details of their own, so the primary key can't be what refuses them).
      const spare = id(0x17);
      await admin.query("SET session_replication_role = replica");
      await admin.query(
        "INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,operation_id,guest_session_id,cart_id,snapshot_json,recorded_at) SELECT brand_id,store_id,$2::uuid,1,$3::uuid,guest_session_id,$5::uuid,snapshot_json||jsonb_build_object('detailsReference',$4::text,'cartReference',$6::text),recorded_at FROM rms_ordering.checkout_details_record WHERE details_id=$1",
        [details, spare, id(0x18), spare, id(0x19), id(0x19)],
      );
      await admin.query("SET session_replication_role = origin");
      const insert = (policy, retention, actor, redaction) =>
        admin.query(
          "INSERT INTO rms_ordering.checkout_contact_redaction (brand_id,store_id,details_id,details_version,redaction_id,policy_code,policy_version,retention_days,details_recorded_at,redacted_at,removed_by_actor_id) VALUES ($1,$2,$3,1,$4,$5,1,$6,$7,now()::timestamptz(3),$8)",
          [
            scope.brandReference,
            scope.storeReference,
            spare,
            redaction,
            policy,
            retention,
            recordedAt,
            actor,
          ],
        );
      for (const [policy, retention, actor, redaction] of [
        ["STAFF_ON_CUSTOMER_REQUEST", null, null, id(0x30)],
        ["CUSTOMER_REQUEST", null, staff, id(0x31)],
        ["CHECKOUT_CONTACT_RETENTION", 30, staff, id(0x32)],
      ])
        await assert.rejects(insert(policy, retention, actor, redaction), { code: "23514" });
      // The same row with its staff member is accepted.
      await insert("STAFF_ON_CUSTOMER_REQUEST", null, staff, id(0x33));
      const constraint = await admin.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='checkout_contact_redaction_policy'",
      );
      assert.match(constraint.rows[0].def, /STAFF_ON_CUSTOMER_REQUEST/u);
      assert.match(constraint.rows[0].def, /removed_by_actor_id IS NOT NULL/u);
    } finally {
      try {
        await admin.query(`DROP OWNED BY ${apiRole}`);
        await admin.query(`DROP ROLE ${apiRole}`);
      } finally {
        await admin.end();
      }
    }
  });
});
