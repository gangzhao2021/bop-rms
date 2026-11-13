import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { createMerchantPickupContactRemoval } from "../../../apps/api/src/merchant-pickup-contact-removal.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { storeRoleTemplateActions } from "../../bop/permission/src/index.ts";
import {
  loadOrderPickupContact,
  readCheckoutContactPresence,
  removeCheckoutContactOnCustomerRequest,
  removeCheckoutContactOnStaffRequest,
} from "../../rms/ordering/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";

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
      // v15 b12: the staff order detail reads why it was removed, as the api role: staff removed it
      // at the guest's request, never "kept only for a limited time".
      const staffRead = await api((tx) => loadOrderPickupContact(tx, scope, order));
      assert.equal(staffRead.status, "Removed");
      assert.equal(staffRead.because, "StaffOnGuestRequest");
      // A guest who removed it from their own order page: the guest asked.
      const own = await seedPickupOrderWithContact(admin, scope, 0x70);
      assert.deepEqual(
        await api((tx) =>
          removeCheckoutContactOnCustomerRequest(tx, scope, {
            orderReference: own.order,
            guestSessionReference: id(0x70 + 4),
            observedAt: new Date().toISOString(),
            redactionReference: id(0x80),
          }),
        ),
        { status: "Removed" },
      );
      const guestRead = await api((tx) => loadOrderPickupContact(tx, scope, own.order));
      assert.equal(guestRead.status, "Removed");
      assert.equal(guestRead.because, "GuestAsked");
      assert.equal(JSON.stringify(guestRead).includes("4165550123"), false);
      // An order whose contact is still kept reads it, with no reason.
      const kept = await seedPickupOrderWithContact(admin, scope, 0x90);
      assert.equal(
        (await api((tx) => loadOrderPickupContact(tx, scope, kept.order))).status,
        "Available",
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

/** A pickup order with a contact, seeded as the checkout writes it (FKs not under test). */
async function seedPickupOrderWithContact(admin, scope, n) {
  const recordedAt = new Date(Date.now() - 3_600_000).toISOString();
  const [order, submission, cart, details, guest, quote, operation] = [0, 1, 2, 3, 4, 5, 6].map(
    (k) => id(n + k),
  );
  await admin.query("SET session_replication_role = replica");
  try {
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
        quote,
        recordedAt,
      ],
    );
    await admin.query(
      "INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,operation_id,guest_session_id,cart_id,snapshot_json,recorded_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)",
      [
        scope.brandReference,
        scope.storeReference,
        details,
        operation,
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
          quoteReference: quote,
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
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
  return { order, details };
}

/**
 * M108 through the merchant command itself: the real staff session, Membership, role grants and
 * permission decision, the Ordering removal and the staff audit, as a NOBYPASSRLS role holding
 * exactly the rendered pilot API grants. A Kitchen preset holder is refused and nothing changes;
 * a Front of House holder removes it once; a retry with the same operation reference answers the
 * same; that reference sent for another order is refused instead of answering "Removed".
 */
it("M108: the merchant removal refuses the Kitchen preset, and a reused operation reference never answers for another order", async () => {
  await withIsolatedDatabase({ caseId: "m108_staff_cmd" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "m108_cmd_" + context.runId,
      worker = "m108_cmd_w_" + context.runId;
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));
      const transactions = {
        async run(work) {
          const client = new Client({ ...context.clientConfig, query_timeout: 10_000 });
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            const result = await work({
              query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const scope = {
        tenantReference: id(0x60),
        brandReference: id(0x61),
        storeReference: id(0x62),
      };
      const at = new Date().toISOString();
      const base = new Set(["merchant.access", "order.accept", "ordering.operate"]);
      const staffWith = (preset, actor, prefix, sessionPrefix) =>
        seedMerchantAcceptanceSession({
          admin,
          runner: transactions,
          scope,
          actor,
          at,
          extraPermissions: storeRoleTemplateActions(preset).filter((code) => !base.has(code)),
          referencePrefix: prefix,
          sessionReferencePrefix: sessionPrefix,
        });
      const cook = await staffWith("kitchen", id(0x70), "0190ab61", "0190ab71");
      const host = await staffWith("front-of-house", id(0x71), "0190ab62", "0190ab72");
      const first = await seedPickupOrderWithContact(admin, scope, 0x100);
      const second = await seedPickupOrderWithContact(admin, scope, 0x200);
      const removeAs = (staff, orderReference, operationReference) =>
        createMerchantPickupContactRemoval({
          persistence: { ...staff.persistence, transactions },
          authentication: staff.authentication,
        })({
          sessionCookie: staff.sessionCookie,
          csrf: staff.csrf,
          command: { orderReference, operationReference },
        });
      const contactOf = async (details) =>
        (
          await admin.query(
            "SELECT snapshot_json->'pickupContact' AS contact FROM rms_ordering.checkout_details_record WHERE details_id=$1",
            [details],
          )
        ).rows[0].contact;
      const audits = async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='CHECKOUT_CONTACT_REMOVED_BY_STAFF'",
          )
        ).rows[0].n;

      // The Kitchen preset does not hand orders over, so it can't remove a guest's contact.
      await assert.rejects(removeAs(cook, first.order, id(0x300)), {
        code: "PICKUP_CONTACT_REMOVAL_PERMISSION_DENIED",
      });
      assert.notEqual(await contactOf(first.details), null);
      assert.equal(await audits(), 0);

      // Front of House removes it, once, with one staff audit naming them.
      assert.deepEqual(await removeAs(host, first.order, id(0x301)), { status: "Removed" });
      assert.equal(await contactOf(first.details), null);
      assert.equal(await audits(), 1);
      const audit = await admin.query(
        "SELECT actor_reference::text AS actor,target_id::text AS target,row_to_json(a)::text AS text FROM platform_audit.audit_record a WHERE audit_id=$1",
        [id(0x301)],
      );
      assert.equal(audit.rows[0].actor, id(0x71));
      assert.equal(audit.rows[0].target, first.order);
      assert.equal(audit.rows[0].text.includes("4165550123"), false);
      // A retry of the same operation answers the same and writes nothing.
      assert.deepEqual(await removeAs(host, first.order, id(0x301)), { status: "Removed" });
      assert.equal(await audits(), 1);
      // The same reference sent for another order is refused; that order keeps its contact.
      await assert.rejects(removeAs(host, second.order, id(0x301)), {
        code: "PICKUP_CONTACT_REMOVAL_INPUT_INVALID",
      });
      assert.notEqual(await contactOf(second.details), null);
      assert.deepEqual(await removeAs(host, second.order, id(0x302)), { status: "Removed" });
      assert.equal(await contactOf(second.details), null);
      assert.equal(await audits(), 2);
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      for (const name of [api, worker])
        await admin
          .query("DROP OWNED BY " + name + " CASCADE")
          .then(() => admin.query("DROP ROLE " + name))
          .catch(() => undefined);
      await admin.end();
    }
  });
});
