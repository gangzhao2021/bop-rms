import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  findGuestSessionOrder,
  loadOrderGuestSession,
  loadOrderReceiptEmail,
} from "../../rms/ordering/src/index.ts";
import {
  createContactDigester,
  createCustomerOrderNotificationService,
  createPostgresCustomerOrderNotificationRecords,
  createPostgresDeliveryFeedbackStore,
  createSesEmailAdapter,
} from "../../bop/notification/src/index.ts";
import {
  OrderRecoveryError,
  buildOrderRecoveryLink,
  createGuestSessionCredentialProvider,
  createOrderRecoveryAbuseKey,
  createOrderRecoveryService,
  createOrderRecoveryTokenHasher,
  createPostgresOrderRecoveryStore,
} from "../../bop/identity/src/index.ts";
import { createAbuseBudgetConsumer } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { grantPilotApiAcl } from "../test-support/pilot-api-acl.mjs";

const { Client } = pg;
const id = (n) => "0190aa30-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const brand = id(1);
const store = id(2);
const otherStore = id(3);
const scope = { brandReference: brand, storeReference: store };
const minute = 60_000;
const at = (offsetMs) => new Date(Math.floor((Date.now() + offsetMs) / 1000) * 1000).toISOString();

/**
 * DEC-PILOT-NOTIFICATIONS (2026-10-20) under a restricted NOBYPASSRLS role holding exactly the
 * rendered pilot api ACL: customer order messages with a local SES fake, the IDR-0031 one-time
 * order link (mint, single use, sibling revocation, expiry, cross-Store refusal, abuse budget,
 * Guest Session re-key guard) and SES bounce/complaint suppression. No real AWS call.
 */
it("DEC-PILOT-NOTIFICATIONS: order messages, one-time order link and bounce suppression", async () => {
  await withIsolatedDatabase({ caseId: "pilot_notifications" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const apiRole = "pilot_notif_api_" + context.runId;
    try {
      await admin.query(
        "CREATE ROLE " + apiRole + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query("GRANT USAGE ON SCHEMA platform_helpers TO " + apiRole);
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + apiRole);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          apiRole,
      );
      await grantPilotApiAcl(admin, apiRole);

      const credentials = createGuestSessionCredentialProvider(randomBytes(32));
      const originalCredential = credentials.generateCredential("Session");
      const guest = id(10);
      const createdAt = at(-60 * minute);
      const order = id(0x101),
        otherOrder = id(0x102);

      // Seed as the owner without parent rows (FKs and triggers are not under test here).
      await admin.query("SET session_replication_role = replica");
      await admin.query(
        "INSERT INTO bop_identity.guest_session (guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,operation_intent_hash,brand_id,store_id,public_store_id,public_table_id,channel,locale,qr_id,qr_revocation_version,dining_state,status,created_at,last_seen_at,idle_expires_at,absolute_expires_at,version) VALUES ($1,decode($2,'hex'),decode($3,'hex'),$4,decode($5,'hex'),$6,$7,$8,NULL,'Pickup','en-CA',$9,1,'ContextOnly','Active',$10,$10,$10::timestamptz + interval '4 hours',$10::timestamptz + interval '24 hours',1)",
        [
          guest,
          credentials.hashCredential("Session", originalCredential),
          credentials.hashCredential("Csrf", credentials.generateCredential("Csrf")),
          id(11),
          credentials.hashOperationIntent("seed"),
          brand,
          store,
          id(12),
          id(13),
          createdAt,
        ],
      );
      for (const [orderId, number, email] of [
        [order, "21", "guest@example.test"],
        [otherOrder, "22", "guest@example.test"],
      ]) {
        const n = Number.parseInt(orderId.slice(-4), 16);
        await admin.query(
          "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES ($1,$2,$3,$4::date,$5,'Pickup','Qr',NULL,$6,$6,1,'Submitted','Open','NotReported',$7)",
          [orderId, brand, store, createdAt.slice(0, 10), number, guest, createdAt],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)",
          [
            id(n + 0x1000),
            brand,
            store,
            orderId,
            guest,
            "sha256:" + "b".repeat(64),
            id(n + 0x2000),
            id(801),
            createdAt,
          ],
        );
        const snapshot = {
          schemaVersion: 1,
          detailsReference: id(n + 0x3000),
          detailsVersion: 1,
          guestSessionReference: guest,
          brandReference: brand,
          storeReference: store,
          cartReference: id(n + 0x2000),
          cartVersion: 1,
          quoteReference: id(801),
          quoteVersion: 2,
          orderType: "Pickup",
          pickupContact: { name: "Synthetic Guest", channel: "Email", value: email },
          receipt: { choice: "TransactionalEmail", email },
          policies: [],
          recordedAt: createdAt,
        };
        await admin.query(
          "INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,operation_id,guest_session_id,cart_id,snapshot_json,recorded_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)",
          [
            brand,
            store,
            id(n + 0x3000),
            id(n + 0x4000),
            guest,
            id(n + 0x2000),
            snapshot,
            createdAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_checkout_details_link (brand_id,store_id,submission_id,order_id,details_id,details_version) VALUES ($1,$2,$3,$4,$5,1)",
          [brand, store, id(n + 0x1000), orderId, id(n + 0x3000)],
        );
      }
      await admin.query("SET session_replication_role = origin");

      const runAs = async (role, action) => {
        const client = new Client({ ...context.clientConfig, query_timeout: 10_000 });
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
      const runner = { run: (work) => runAs(apiRole, work) };
      let sequence = 0x500;
      const references = () => id(sequence++);
      let now = at(0);
      const clock = { now: () => now };

      // Local SES fake with fault injection: Accepted with an opaque id, or a timeout.
      const sent = [];
      let sesFault = null;
      const ses = createSesEmailAdapter(
        {
          region: "ca-central-1",
          fromAddress: "orders@mail.example.test",
          fromDisplayName: "DEMO Store",
          configurationSetName: "bop-transactional",
        },
        {
          async sendEmail(input) {
            if (sesFault) throw sesFault;
            sent.push(input);
            return { MessageId: "ses-fake-" + sent.length };
          },
        },
      );
      const digester = createContactDigester([{ version: 1, key: randomBytes(32) }]);
      const feedback = createPostgresDeliveryFeedbackStore(runner, scope, {
        digester,
        references: { generate: references },
        clock,
      });
      const notifications = createCustomerOrderNotificationService({
        messaging: { sms: null, email: ses },
        records: createPostgresCustomerOrderNotificationRecords(runner, scope),
        clock,
        references: { generateNotification: references },
        suppression: { isSuppressed: (channel, value) => feedback.isSuppressed(channel, value) },
      });
      const abuse = createOrderRecoveryAbuseKey(randomBytes(32));
      const recoveryFor = (storeScope) =>
        createOrderRecoveryService({
          hasher: createOrderRecoveryTokenHasher([{ version: 1, key: randomBytesFixed }]),
          store: createPostgresOrderRecoveryStore(runner, storeScope),
          budget: {
            async consume({ orderReference, peerAddress, observedAt }) {
              const result = await createAbuseBudgetConsumer({
                bucketClass: "ORDER_RESUME",
                windowSeconds: 3600,
                limitCount: 5,
                now: () => observedAt,
                query: (sql, values) => runAs(apiRole, (tx) => tx.query(sql, values)),
              }).consume(abuse(orderReference, peerAddress));
              return result.allowed
                ? { status: "Allowed" }
                : { status: "RateLimited", retryAfterSeconds: result.retry_after_seconds };
            },
          },
          credentials,
          references: { generate: references },
          clock,
        });
      const randomBytesFixed = randomBytes(32);
      const recovery = recoveryFor(scope);
      const mintOrderLink = (orderReference) => async (attemptReference) => {
        const session = await runner.run((tx) => loadOrderGuestSession(tx, scope, orderReference));
        const minted = await recovery.mint({
          orderReference,
          guestSessionReference: session,
          notificationAttemptReference: attemptReference,
        });
        return minted === null
          ? null
          : buildOrderRecoveryLink("https://order.example.test", minted.token);
      };
      const tokenOf = (link) => /#t=([A-Za-z0-9_-]{43})$/u.exec(link)[1];

      // 1. "Your order is ready" by email with the one-time link, recorded without the address.
      const readyInput = {
        purpose: "PickupReady",
        brandReference: brand,
        storeReference: store,
        orderReference: order,
        orderNumber: "21",
        storeDisplayName: "DEMO Store",
        contact: { channel: "Email", value: "guest@example.test" },
        contactDetailsReference: id(0x101 + 0x3000),
        contactDetailsVersion: 1,
        orderLink: null,
      };
      const ready = await notifications.notify({
        ...readyInput,
        mintOrderLink: mintOrderLink(order),
      });
      assert.equal(ready.status, "Accepted");
      const text = sent[0].Content.Simple.Body.Text.Data;
      assert.match(text, /your order 21 is ready/u);
      const firstToken = tokenOf(
        /https:\/\/order\.example\.test\/resume#t=[A-Za-z0-9_-]{43}/u.exec(text)[0],
      );
      const evidence = await admin.query(
        "SELECT row_to_json(a)::text AS a FROM bop_notification.customer_order_notification_attempt a UNION ALL SELECT row_to_json(o)::text FROM bop_notification.customer_order_notification_outcome o UNION ALL SELECT row_to_json(r)::text FROM bop_identity.order_recovery_authorization r",
      );
      const stored = evidence.rows.map((row) => row.a).join("\n");
      assert.ok(!stored.includes("guest@example.test") && !stored.includes(firstToken));
      assert.equal((await notifications.notify(readyInput)).status, "AlreadyRecorded");

      // 2. A timeout after submission is Unknown and never resent; at most two live siblings.
      sesFault = Object.assign(new Error("TimeoutError"), { name: "TimeoutError", $metadata: {} });
      const placed = await notifications.notify({
        purpose: "OrderPlaced",
        brandReference: brand,
        storeReference: store,
        orderReference: order,
        orderNumber: "21",
        storeDisplayName: "DEMO Store",
        contact: { channel: "Email", value: "guest@example.test" },
        contactDetailsReference: id(0x101 + 0x3000),
        contactDetailsVersion: 1,
        orderLink: null,
        mintOrderLink: mintOrderLink(order),
      });
      assert.equal(placed.status, "Unknown");
      sesFault = null;
      assert.equal(
        await recovery.mint({
          orderReference: order,
          guestSessionReference: guest,
          notificationAttemptReference: id(0x900),
        }),
        null,
        "a third live sibling is refused",
      );

      // 3. The link opens the order on a new device: same Guest Session, re-keyed, siblings revoked.
      const opened = await recovery.consume({ token: firstToken, peerAddress: "203.0.113.7" });
      assert.equal(opened.orderReference, order);
      const session = await admin.query(
        "SELECT encode(session_selector_hash,'hex') AS selector, version, status FROM bop_identity.guest_session WHERE guest_session_id=$1",
        [guest],
      );
      assert.equal(
        session.rows[0].selector,
        credentials.hashCredential("Session", opened.sessionCredential),
      );
      assert.deepEqual([session.rows[0].version, session.rows[0].status], [2, "Active"]);
      assert.equal(
        (
          await runner.run((tx) =>
            findGuestSessionOrder(tx, scope, {
              orderReference: order,
              guestSessionReference: guest,
            }),
          )
        ).orderNumber,
        "21",
      );
      const facts = await admin.query(
        "SELECT outcome, count(*)::int AS n FROM bop_identity.order_recovery_consumption GROUP BY outcome ORDER BY outcome",
      );
      assert.deepEqual(facts.rows, [
        { outcome: "Consumed", n: 1 },
        { outcome: "Revoked", n: 1 },
      ]);
      await assert.rejects(
        recovery.consume({ token: firstToken, peerAddress: "203.0.113.7" }),
        (error) =>
          error instanceof OrderRecoveryError && error.code === "ORDER_RECOVERY_UNAVAILABLE",
      );

      // 4. Expired and cross-Store links are refused the same way.
      const late = await recovery.mint({
        orderReference: order,
        guestSessionReference: guest,
        notificationAttemptReference: id(0x901),
      });
      now = at(31 * minute);
      await assert.rejects(
        recovery.consume({ token: late.token, peerAddress: "203.0.113.8" }),
        (error) => error.code === "ORDER_RECOVERY_UNAVAILABLE",
      );
      now = at(0);
      const fresh = await recovery.mint({
        orderReference: order,
        guestSessionReference: guest,
        notificationAttemptReference: id(0x902),
      });
      await assert.rejects(
        recoveryFor({ brandReference: brand, storeReference: otherStore }).consume({
          token: fresh.token,
          peerAddress: "203.0.113.9",
        }),
        (error) => error.code === "ORDER_RECOVERY_UNAVAILABLE",
      );

      // 5. The abuse budget: 5 tries per hour per Order and peer, then 429-equivalent.
      for (let attempt = 0; attempt < 5; attempt += 1)
        await recovery
          .consume({ token: late.token, peerAddress: "198.51.100.1" })
          .catch(() => undefined);
      await assert.rejects(
        recovery.consume({ token: late.token, peerAddress: "198.51.100.1" }),
        (error) => error.code === "ORDER_RECOVERY_RATE_LIMITED",
      );

      // 6. The database accepts a credential change only with a Consumed recovery fact.
      await assert.rejects(
        runAs(apiRole, async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          const changed = await tx.query(
            "UPDATE bop_identity.guest_session SET session_selector_hash=decode($2,'hex'), csrf_selector_hash=decode($3,'hex'), operation_id=$4, version=version+1 WHERE guest_session_id=$1",
            [guest, "a".repeat(64), "b".repeat(64), id(0x903)],
          );
          assert.equal(changed.rowCount, 1, "the row is visible in scope");
        }),
        /order recovery/u,
      );
      await assert.rejects(
        runAs(apiRole, (tx) =>
          tx.query("UPDATE bop_identity.order_recovery_authorization SET pepper_version=2", []),
        ),
        /permission denied/u,
      );

      // 7. A hard bounce (signed SNS event, normalized) suppresses the address for this Store.
      const resolved = await feedback.resolveTransactional({
        destination: "guest@example.test",
        providerMessageId: "ses-fake-1",
      });
      assert.ok(resolved);
      const event = {
        providerEventId: "018faa00-0000-4000-8000-000000000001",
        providerMessageId: "ses-fake-1",
        recipientReference: resolved.recipientReference,
        purpose: "Transactional",
        eventType: "HardBounce",
        occurredAt: at(0),
        acceptedAt: at(0),
        retentionPolicyReference: id(0x999),
      };
      const apply = () =>
        feedback.acceptAndApply({
          event,
          suppression: "Immediate",
          createOperationalCase: true,
          suppressionDigest: resolved.suppressionDigest,
        });
      assert.equal(await apply(), "Accepted");
      assert.equal(await apply(), "Duplicate");
      assert.equal(await feedback.isSuppressed("Email", "Guest@Example.test"), true);
      const suppressed = await notifications.notify({
        purpose: "PickupReady",
        brandReference: brand,
        storeReference: store,
        orderReference: otherOrder,
        orderNumber: "22",
        storeDisplayName: "DEMO Store",
        contact: { channel: "Email", value: "guest@example.test" },
        contactDetailsReference: id(0x102 + 0x3000),
        contactDetailsVersion: 1,
        orderLink: null,
      });
      assert.equal(suppressed.status, "Suppressed");
      assert.equal(sent.length, 1);
      const cases = await admin.query(
        "SELECT kind FROM bop_notification.delivery_issue_case UNION ALL SELECT reason FROM bop_notification.contact_suppression",
      );
      assert.deepEqual(cases.rows.map((row) => row.kind).sort(), ["HardBounce", "HardBounce"]);
      const digests = await admin.query(
        "SELECT destination_digest FROM bop_notification.contact_suppression",
      );
      assert.match(digests.rows[0].destination_digest, /^hmac-sha256:v1:[0-9a-f]{64}$/u);

      // 8. "Email my receipt": requested, but not before the receipt is issued (the consumer retries).
      assert.equal(
        (await runner.run((tx) => loadOrderReceiptEmail(tx, scope, order))).status,
        "ReceiptPending",
      );
    } finally {
      await admin.end();
    }
  });
});
