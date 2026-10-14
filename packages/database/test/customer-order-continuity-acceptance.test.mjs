import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  checkoutContactRetentionPolicy,
  findLatestGuestSessionOrder,
  loadOrderCustomerSummary,
  loadOrderPickupContact,
  redactExpiredCheckoutContacts,
} from "../../rms/ordering/src/index.ts";
import { listOrderPaymentTerminalOutcomes } from "../../rms/payment/src/index.ts";
import {
  createCustomerOrderNotificationService,
  createPostgresCustomerOrderNotificationRecords,
} from "../../bop/notification/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190aa10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const brand = id(1);
const store = id(2);
const otherStore = id(3);
const scope = { brandReference: brand, storeReference: store };
const account = id(4);
const day = 24 * 60 * 60 * 1000;
const at = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

/**
 * WP-2423 Q10 under restricted NOBYPASSRLS roles: the api role reads only (latest order for the
 * Guest Session, the pickup contact on a staff detail, Payment's terminal facts), and the retention
 * role removes a contact only after its period and only with evidence (grants PENDING OWNER
 * APPROVAL, see DEC-CUSTOMER-ORDER-CONTINUITY).
 */
it("WP-2423 Q10: order continuity reads, staff contact, retention removal and payment facts", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_q10" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const apiRole = "wp2423_q10_api_" + context.runId;
    const retentionRole = "wp2423_q10_ret_" + context.runId;
    try {
      for (const role of [apiRole, retentionRole]) {
        await admin.query(
          "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
        await admin.query(
          "GRANT USAGE ON SCHEMA rms_ordering,rms_payment,platform_helpers TO " + role,
        );
        await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
        await admin.query(
          "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
            role,
        );
      }
      // The pilot api role's existing grants for these reads (docs/spec/pilot-acl-matrix.json),
      // plus SELECT on the new evidence table (PENDING OWNER APPROVAL).
      await admin.query(
        "GRANT SELECT ON rms_ordering.order_header,rms_ordering.order_submission_record,rms_ordering.order_checkout_details_link,rms_ordering.checkout_details_record,rms_ordering.checkout_contact_redaction,rms_payment.payment_terminal_fact TO " +
          apiRole,
      );
      // Retention role (PENDING OWNER APPROVAL): read/redact details, append evidence.
      await admin.query(
        "GRANT SELECT,UPDATE ON rms_ordering.checkout_details_record TO " + retentionRole,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_ordering.checkout_contact_redaction TO " + retentionRole,
      );

      // Seed history as the owner without parent rows (FKs are not under test here).
      await admin.query("SET session_replication_role = replica");
      const seedOrder = async ({
        order,
        number,
        guest,
        createdAt,
        storeId = store,
        details,
        orderType = "Pickup",
      }) => {
        await admin.query(
          "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES ($1,$2,$3,$4::date,$5,$6,'Qr',$7,$8,$8,1,'Submitted','Open','NotReported',$9)",
          [
            order,
            brand,
            storeId,
            createdAt.slice(0, 10),
            number,
            orderType,
            orderType === "DineIn" ? id(900) : null,
            guest,
            createdAt,
          ],
        );
        const submission = id(Number.parseInt(order.slice(-4), 16) + 0x1000);
        const cart = id(Number.parseInt(order.slice(-4), 16) + 0x2000);
        await admin.query(
          "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)",
          [
            submission,
            brand,
            storeId,
            order,
            guest,
            "sha256:" + "b".repeat(64),
            cart,
            id(801),
            createdAt,
          ],
        );
        if (details === undefined) return;
        const snapshot = {
          schemaVersion: 1,
          detailsReference: details.id,
          detailsVersion: 1,
          guestSessionReference: guest,
          brandReference: brand,
          storeReference: storeId,
          cartReference: cart,
          cartVersion: 1,
          quoteReference: id(801),
          quoteVersion: 2,
          orderType,
          pickupContact: details.contact,
          receipt: details.receipt ?? { choice: "InSession", email: null },
          policies: [],
          recordedAt: details.recordedAt,
        };
        await admin.query(
          "INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,operation_id,guest_session_id,cart_id,snapshot_json,recorded_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)",
          [
            brand,
            storeId,
            details.id,
            details.operation,
            guest,
            cart,
            snapshot,
            details.recordedAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_checkout_details_link (brand_id,store_id,submission_id,order_id,details_id,details_version) VALUES ($1,$2,$3,$4,$5,1)",
          [brand, storeId, submission, order, details.id],
        );
      };
      const guest = id(10),
        otherGuest = id(11);
      const old = at(-40 * day),
        recent = at(-60 * 60 * 1000);
      await seedOrder({
        order: id(0x101),
        number: "7",
        guest,
        createdAt: old,
        details: {
          id: id(0x201),
          operation: id(0x301),
          recordedAt: old,
          contact: { name: "Synthetic Old", channel: "Phone", value: "+14165550101" },
          receipt: { choice: "TransactionalEmail", email: "old@example.test" },
        },
      });
      await seedOrder({
        order: id(0x102),
        number: "8",
        guest,
        createdAt: recent,
        details: {
          id: id(0x202),
          operation: id(0x302),
          recordedAt: recent,
          contact: { name: "Synthetic Recent", channel: "Email", value: "recent@example.test" },
        },
      });
      await seedOrder({ order: id(0x103), number: "9", guest: otherGuest, createdAt: recent });
      await seedOrder({
        order: id(0x104),
        number: "1",
        guest,
        createdAt: at(-30 * 60 * 1000),
        storeId: otherStore,
      });
      await admin.query(
        "INSERT INTO rms_payment.payment_terminal_fact (payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,provider_intent_reference,provider_observation_id,authoritative_source,terminal_outcome,amount_minor,currency_code,occurred_at,recorded_at,evidence_digest,event_id,causation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'evt_Synthetic01',$8,'Test','pi_Synthetic01',$9,'VerifiedWebhook','Succeeded',1234,'CAD',$10,$10,$11,$12,$7)",
        [
          id(0x401),
          brand,
          store,
          id(0x402),
          id(0x403),
          id(0x102),
          id(0x404),
          account,
          id(0x405),
          recent,
          "sha256:" + "c".repeat(64),
          id(0x406),
        ],
      );
      await admin.query("SET session_replication_role = origin");

      const runAs = async (role, action) => {
        const client = new Client({ ...context.clientConfig, query_timeout: 5000 });
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          const result = await action({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      };

      // 1. Continue-your-order: the latest Order of exactly this Guest Session, in this Store.
      const now = at(0);
      const latest = await runAs(apiRole, (tx) =>
        findLatestGuestSessionOrder(tx, scope, { guestSessionReference: guest, observedAt: now }),
      );
      assert.deepEqual(
        {
          orderReference: latest.orderReference,
          orderNumber: latest.orderNumber,
          orderType: latest.orderType,
        },
        { orderReference: id(0x102), orderNumber: "8", orderType: "Pickup" },
      );
      assert.equal(
        (
          await runAs(apiRole, (tx) =>
            findLatestGuestSessionOrder(tx, scope, {
              guestSessionReference: otherGuest,
              observedAt: now,
            }),
          )
        ).orderReference,
        id(0x103),
      );
      assert.equal(
        await runAs(apiRole, (tx) =>
          findLatestGuestSessionOrder(tx, scope, {
            guestSessionReference: id(12),
            observedAt: now,
          }),
        ),
        null,
      );
      assert.equal(
        (
          await runAs(apiRole, (tx) =>
            findLatestGuestSessionOrder(
              tx,
              { brandReference: brand, storeReference: otherStore },
              { guestSessionReference: guest, observedAt: now },
            ),
          )
        ).orderReference,
        id(0x104),
      );
      // An order created after the observation instant is not "current".
      assert.equal(
        (
          await runAs(apiRole, (tx) =>
            findLatestGuestSessionOrder(tx, scope, {
              guestSessionReference: guest,
              observedAt: at(-2 * day),
            }),
          )
        ).orderReference,
        id(0x101),
      );

      // 2. Staff detail: the contact given for this order, or that none was given.
      assert.deepEqual(await runAs(apiRole, (tx) => loadOrderPickupContact(tx, scope, id(0x102))), {
        status: "Available",
        name: "Synthetic Recent",
        channel: "Email",
        value: "recent@example.test",
        detailsReference: id(0x202),
        detailsVersion: 1,
      });
      assert.deepEqual(await runAs(apiRole, (tx) => loadOrderPickupContact(tx, scope, id(0x103))), {
        status: "NotGiven",
      });
      // RLS: another Store's scope cannot see this Store's contact.
      assert.deepEqual(
        await runAs(apiRole, (tx) =>
          loadOrderPickupContact(
            tx,
            { brandReference: brand, storeReference: otherStore },
            id(0x101),
          ),
        ),
        { status: "NotGiven" },
      );
      // The api role cannot change checkout details at all.
      await assert.rejects(
        runAs(apiRole, (tx) =>
          redactExpiredCheckoutContacts(tx, scope, {
            observedAt: now,
            limit: 10,
            generateRedactionReference: () => id(0x501),
          }),
        ),
        /UNAVAILABLE|permission denied/u,
      );

      // 3. Payment's own terminal fact reaches the order status even before its projection.
      const outcomes = await runAs(apiRole, (tx) =>
        listOrderPaymentTerminalOutcomes(
          tx,
          { ...scope, providerAccountReference: account, environment: "Test" },
          id(0x102),
        ),
      );
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].outcome, "Succeeded");
      assert.equal(outcomes[0].amount.amountMinor, 1234n);
      assert.equal(outcomes[0].paymentIntentReference, id(0x402));
      assert.deepEqual(
        await runAs(apiRole, (tx) =>
          listOrderPaymentTerminalOutcomes(
            tx,
            { ...scope, providerAccountReference: id(99), environment: "Test" },
            id(0x102),
          ),
        ),
        [],
      );
      assert.deepEqual(
        await runAs(apiRole, (tx) =>
          listOrderPaymentTerminalOutcomes(
            tx,
            {
              brandReference: brand,
              storeReference: otherStore,
              providerAccountReference: account,
              environment: "Test",
            },
            id(0x102),
          ),
        ),
        [],
      );

      // 4. Retention: only the record older than the period is cleared, with evidence, once.
      const snapshotOf = async (details) =>
        (
          await admin.query(
            "SELECT snapshot_json FROM rms_ordering.checkout_details_record WHERE details_id=$1",
            [details],
          )
        ).rows[0].snapshot_json;
      const before = await snapshotOf(id(0x201));
      let references = 0x600;
      const redact = (role, s = scope) =>
        runAs(role, (tx) =>
          redactExpiredCheckoutContacts(tx, s, {
            observedAt: now,
            limit: 10,
            generateRedactionReference: () => id(references++),
          }),
        );
      // Another Store's scope finds nothing of this Store's to clear (RLS).
      assert.deepEqual(
        await redact(retentionRole, { brandReference: brand, storeReference: otherStore }),
        {
          redacted: 0,
        },
      );
      assert.deepEqual(await redact(retentionRole), { redacted: 1 });
      const after = await snapshotOf(id(0x201));
      assert.equal(after.pickupContact, null);
      assert.deepEqual(after.receipt, { choice: "InSession", email: null });
      const withoutContact = (snapshot) =>
        Object.fromEntries(
          Object.entries(snapshot).filter(([key]) => key !== "pickupContact" && key !== "receipt"),
        );
      assert.deepEqual(withoutContact(after), withoutContact(before));
      assert.equal((await snapshotOf(id(0x202))).pickupContact.value, "recent@example.test");
      const evidence = await admin.query(
        "SELECT * FROM rms_ordering.checkout_contact_redaction WHERE details_id=$1",
        [id(0x201)],
      );
      assert.equal(evidence.rows.length, 1);
      assert.equal(evidence.rows[0].policy_code, checkoutContactRetentionPolicy.policyCode);
      assert.equal(evidence.rows[0].retention_days, checkoutContactRetentionPolicy.retentionDays);
      const evidenceText = JSON.stringify(evidence.rows);
      for (const value of ["+14165550101", "old@example.test", "Synthetic Old"])
        assert.equal(evidenceText.includes(value), false);
      const removed = await runAs(apiRole, (tx) => loadOrderPickupContact(tx, scope, id(0x101)));
      assert.equal(removed.status, "Removed");
      assert.equal(Date.parse(removed.removedAt), Date.parse(now));
      // Idempotent: nothing left to clear.
      assert.deepEqual(await redact(retentionRole), { redacted: 0 });

      // 5. The details stay append-only for anything else.
      const tamper = await runAs(retentionRole, (tx) =>
        tx.query(
          "UPDATE rms_ordering.checkout_details_record SET snapshot_json=snapshot_json||'{\"cartVersion\":2}'::jsonb WHERE details_id=$1",
          [id(0x202)],
        ),
      ).catch((error) => error);
      // (No scope GUC: RLS hides the row; with scope the guard skips it.)
      assert.equal(tamper.rowCount ?? 0, 0);
      const scopedTamper = await runAs(retentionRole, async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        const unredacted = await tx.query(
          "UPDATE rms_ordering.checkout_details_record SET snapshot_json=snapshot_json||jsonb_build_object('pickupContact','null'::jsonb,'receipt',jsonb_build_object('choice','InSession','email','null'::jsonb)) WHERE details_id=$1",
          [id(0x202)],
        );
        const otherField = await tx.query(
          "UPDATE rms_ordering.checkout_details_record SET snapshot_json=snapshot_json||'{\"cartVersion\":2}'::jsonb WHERE details_id=$1",
          [id(0x201)],
        );
        return [unredacted.rowCount, otherField.rowCount];
      });
      assert.deepEqual(scopedTamper, [0, 0]);
      assert.equal((await snapshotOf(id(0x202))).pickupContact.value, "recent@example.test");
      assert.equal((await snapshotOf(id(0x201))).cartVersion, 1);
      // Evidence before the retention period is refused; evidence itself cannot change.
      await assert.rejects(
        runAs(retentionRole, async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          await tx.query(
            "INSERT INTO rms_ordering.checkout_contact_redaction (brand_id,store_id,details_id,details_version,redaction_id,policy_code,policy_version,retention_days,details_recorded_at,redacted_at) VALUES ($1,$2,$3,1,$4,'CHECKOUT_CONTACT_RETENTION',1,30,$5,$6)",
            [brand, store, id(0x202), id(0x700), recent, now],
          );
        }),
        /checkout_contact_redaction_after_retention/u,
      );
      await assert.rejects(
        admin.query("UPDATE rms_ordering.checkout_contact_redaction SET retention_days=1"),
        /append-only contact redaction evidence/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_ordering.checkout_contact_redaction"),
        /append-only contact redaction evidence/u,
      );
      await admin.query("DELETE FROM rms_ordering.checkout_details_record");
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.checkout_details_record"))
          .rows[0].n,
        2,
      );
    } finally {
      await admin.query("SET session_replication_role = origin").catch(() => undefined);
      for (const role of [apiRole, retentionRole]) {
        await admin.query("DROP OWNED BY " + role).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      }
      await admin.end();
    }
  });
});

it("WP-2423 Q10: customer order notification evidence is once per order and purpose, append-only and holds no contact", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_q10_notify" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_q10_notify_" + context.runId;
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query("GRANT USAGE ON SCHEMA bop_notification,platform_helpers TO " + role);
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      // PENDING OWNER APPROVAL (WP-2423 Q10): the sender (worker) role appends evidence.
      await admin.query(
        "GRANT SELECT,INSERT ON bop_notification.customer_order_notification_attempt,bop_notification.customer_order_notification_outcome TO " +
          role,
      );
      const runner = {
        async run(action) {
          const client = new Client({ ...context.clientConfig, query_timeout: 5000 });
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            const result = await action({
              query: (sql, values) => client.query(sql, [...values]),
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const records = createPostgresCustomerOrderNotificationRecords(runner, scope);
      const sent = [];
      let next = 0x900;
      const service = createCustomerOrderNotificationService({
        messaging: {
          sms: {
            channel: "Sms",
            async send(message) {
              sent.push(message);
              return {
                outcome: "Accepted",
                providerMessageReference: "SM-synthetic-" + sent.length,
              };
            },
          },
          email: null,
        },
        records,
        clock: { now: () => at(0) },
        references: { generateNotification: () => id(next++) },
      });
      const input = {
        purpose: "PickupReady",
        brandReference: brand,
        storeReference: store,
        orderReference: id(0x102),
        orderNumber: "8",
        storeDisplayName: "DEMO Store",
        contact: { channel: "Phone", value: "+14165550123" },
        contactDetailsReference: id(0x202),
        contactDetailsVersion: 1,
        orderLink: null,
      };
      assert.equal((await service.notify(input)).status, "Accepted");
      // A redelivered trigger never sends twice.
      assert.deepEqual(await service.notify(input), { status: "AlreadyRecorded" });
      assert.equal(sent.length, 1);
      // Email has no provider: inactive, nothing recorded.
      assert.deepEqual(
        await service.notify({
          ...input,
          purpose: "OrderPlaced",
          contact: { channel: "Email", value: "guest@example.test" },
        }),
        { status: "NotConfigured" },
      );
      const attempts = await admin.query(
        "SELECT * FROM bop_notification.customer_order_notification_attempt",
      );
      const outcomes = await admin.query(
        "SELECT * FROM bop_notification.customer_order_notification_outcome",
      );
      assert.equal(attempts.rows.length, 1);
      assert.equal(outcomes.rows.length, 1);
      assert.equal(outcomes.rows[0].outcome, "Accepted");
      const evidence = JSON.stringify([attempts.rows, outcomes.rows]);
      for (const value of ["+14165550123", "guest@example.test", "DEMO Store", "is ready"])
        assert.equal(evidence.includes(value), false);
      // Another Store's scope can neither read nor write this Store's evidence (RLS).
      const other = createPostgresCustomerOrderNotificationRecords(runner, {
        brandReference: brand,
        storeReference: otherStore,
      });
      await assert.rejects(
        other.appendAttempt({
          notificationReference: id(0x950),
          brandReference: brand,
          storeReference: store,
          orderReference: id(0x102),
          purpose: "OrderPlaced",
          channel: "Sms",
          contactDetailsReference: id(0x202),
          contactDetailsVersion: 1,
          createdAt: at(0),
        }),
      );
      assert.equal(
        (
          await runner.run(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [brand, otherStore],
            );
            return tx.query(
              "SELECT count(*)::int AS n FROM bop_notification.customer_order_notification_attempt",
              [],
            );
          })
        ).rows[0].n,
        0,
      );
      // An outcome needs its attempt; evidence never changes.
      await assert.rejects(
        records.appendOutcome({
          notificationReference: id(0x951),
          brandReference: brand,
          storeReference: store,
          outcome: "Unknown",
          providerMessageReference: null,
          recordedAt: at(0),
        }),
        /customer_order_notification_outcome_attempt_fk/u,
      );
      for (const table of [
        "customer_order_notification_attempt",
        "customer_order_notification_outcome",
      ]) {
        await assert.rejects(
          admin.query("UPDATE bop_notification." + table + " SET brand_id=brand_id"),
          /append-only customer order notification evidence/u,
        );
        await assert.rejects(
          admin.query("DELETE FROM bop_notification." + table),
          /append-only customer order notification evidence/u,
        );
      }
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});

it("WP-2423 Q10: the order summary read names the order for a customer message", async () => {
  // The number and type a customer message names, read under the restricted role and Store scope.
  await withIsolatedDatabase({ caseId: "wp2423_q10_summary" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_q10_sum_" + context.runId;
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
      await admin.query("GRANT SELECT ON rms_ordering.order_header TO " + role);
      await admin.query("SET session_replication_role = replica");
      await admin.query(
        "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES ($1,$2,$3,current_date,'21','Pickup','Qr',NULL,$4,$4,1,'Submitted','Open','NotReported',now())",
        [id(0x111), brand, store, id(10)],
      );
      await admin.query("SET session_replication_role = origin");
      const read = async (s) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          const result = await loadOrderCustomerSummary(
            { query: (sql, values) => client.query(sql, [...values]) },
            s,
            id(0x111),
          );
          await client.query("COMMIT");
          return result;
        } finally {
          await client.end();
        }
      };
      assert.deepEqual(await read(scope), { orderNumber: "21", orderType: "Pickup" });
      assert.equal(await read({ brandReference: brand, storeReference: otherStore }), null);
    } finally {
      await admin.query("SET session_replication_role = origin").catch(() => undefined);
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});
