import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createGuestSessionCredentialProvider,
  createGuestSessionRecord,
  createPostgresGuestSessionEntryStore,
} from "../../bop/identity/src/index.ts";
import {
  fixture,
  id as entryId,
} from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { createCustomerEntryComposition } from "../../../apps/api/src/customer-entry-composition.ts";
import { CustomerEntryHandler } from "../../../apps/api/src/customer-entry.ts";
import { encodeOrderStatusSnapshot } from "../../rms/ordering/src/application/order-status-snapshot-codec.ts";
import { createApiRuntimeLogger, createApiServerRuntime } from "../../../apps/api/src/server.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createTenantTransactionRunner } from "../src/index.ts";

const { Client, Pool } = pg;
const id = (n) => "01a1e411-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
const businessDate = at.slice(0, 10);
const hours = (n) => n * 3_600_000;
const sha = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
// The Store the entry fixture's signed table code names (its public Store is entryId(4)).
const scope = { brandReference: entryId(1), storeReference: entryId(2) };
const origin = "https://customer.invalid";

/**
 * WP-2423 (b11 guest-and-staff-wording): a guest paid a pickup order, then scanned a table's code at
 * the same Store and joined the table (through the real entry, which keeps the pickup visit and
 * may neither rotate nor revoke it). The entry kept the pickup visit on the phone
 * (`__Host-bop-visits`), but the order's own page and its pickup code answered "This order isn't
 * available on this phone" (404) because they read only the table visit. They now read the kept
 * visit too, and only for a request that proved the current visit. The API's reads run as a
 * NOBYPASSRLS role holding exactly the rendered pilot API grants, and so does "remove my contact
 * details" under the kept visit (its redaction and audit row are written as that role). Test-only
 * stand-ins: a Guest binding that calls every visit current (the Store's QR registration is not
 * what this checks), the entry fixture's signed code, Store profile and admission, and pickup-code
 * recovery that is never reached (the order is not ready).
 */
it("a paid pickup order's page, pickup code and contact removal still work after the phone joined a table at the same Store", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_kept_pickup" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_kp_" + context.runId,
      worker = "wp2423_kp_w_" + context.runId;
    assert.match(api, /^wp2423_kp_[a-f0-9]+$/u);
    const pool = new Pool({
      ...context.clientConfig,
      max: 2,
      connectionTimeoutMillis: 2000,
      query_timeout: 5000,
    });
    let runtime;
    const logs = [];
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
      const runner = createTenantTransactionRunner(
        {
          options: pool.options,
          async connect() {
            const client = await pool.connect();
            try {
              await client.query("SET ROLE " + api);
              return client;
            } catch (error) {
              client.release(true);
              throw error;
            }
          },
        },
        { brandId: scope.brandReference, storeId: scope.storeReference },
      );
      const credentials = createGuestSessionCredentialProvider(randomBytes(32));
      let sequence = 100;
      /** A visit as the entry keeps it, with the CSRF the server derives for it. */
      const visit = async (channel) => {
        const credential = credentials.generateCredential("Session");
        const sessionReference = id(++sequence);
        await createPostgresGuestSessionEntryStore(runner, scope).create({
          record: createGuestSessionRecord({
            session: {
              sessionReference,
              status: "Active",
              version: 1,
              ...scope,
              publicStoreReference: entryId(4),
              publicTableReference: null,
              channel,
              locale: "en-CA",
              qrReference: id(3),
              qrRevocationVersion: 1,
              diningState: "ContextOnly",
              diningSessionReference: null,
              diningParticipantReference: null,
              createdAt: at,
              lastSeenAt: at,
              idleExpiresAt: new Date(Date.parse(at) + hours(4)).toISOString(),
              absoluteExpiresAt: new Date(Date.parse(at) + hours(24)).toISOString(),
              orderClosedAt: null,
              closureExpiresAt: null,
              rotatedFromGuestSessionReference: null,
              revocationReason: null,
              revokedAt: null,
            },
            sessionSelectorHash: credentials.hashCredential("Session", credential),
            csrfSelectorHash: credentials.hashCredential(
              "Csrf",
              credentials.deriveForegroundCsrf(credential),
            ),
            operationReference: id(++sequence),
            operationIntentHash: credentials.hashOperationIntent("Create:" + sequence),
          }),
        });
        return { credential, sessionReference, csrf: credentials.deriveForegroundCsrf(credential) };
      };
      const pickup = await visit("Pickup");
      // A different phone's pickup visit at the same Store.
      const stranger = await visit("Pickup");

      // The pickup order the first visit placed, with its status projection (seeded by
      // the test as Ordering's owner writes them).
      const order = id(10);
      await admin.query(
        `INSERT INTO rms_ordering.order_number_allocation
        (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,business_date_configuration_id,business_date_configuration_version,business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation)
        VALUES ($1,$2,$3,$4,7,'7',$5,$6,1,$7,'America/Toronto','04:00:00',$5,'Exact')`,
        [order, scope.brandReference, scope.storeReference, businessDate, at, id(11), sha("bd")],
      );
      await admin.query(
        `INSERT INTO rms_ordering.order_header
        (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at)
        VALUES ($1,$2,$3,$4,'7','Pickup','Qr',$5,$5,1,'Submitted','Open','NotReported',$6)`,
        [
          order,
          scope.brandReference,
          scope.storeReference,
          businessDate,
          pickup.sessionReference,
          at,
        ],
      );
      const snapshot = encodeOrderStatusSnapshot({
        sourceVersion: 1,
        sourceCheckpoint: id(21),
        sourceDigest: sha("order-7"),
        orderReference: order,
        ...scope,
        guestSessionReference: pickup.sessionReference,
        submissionReference: id(12),
        businessDate,
        orderNumber: "7",
        orderType: "Pickup",
        sourceChannel: "Qr",
        canonicalPhase: "Submitted",
        closureStatus: "Open",
        paymentStatus: "NotReported",
        kitchenStatus: "Unavailable",
        fulfillmentStatus: "Unavailable",
        fulfillmentReference: null,
        fulfillmentCompletionEventReference: null,
        fulfillmentCompletedAt: null,
        eta: null,
        submittedAt: at,
        batches: [
          {
            orderBatchReference: id(30),
            submittedAt: at,
            items: [
              {
                orderItemReference: id(31),
                displayName: "Wonton soup",
                quantity: 1,
                lineTotal: { amountMinor: 1295n, currencyCode: "CAD" },
              },
            ],
          },
        ],
      });
      await admin.query(
        `INSERT INTO rms_ordering.order_status_projection_generation
        (generation_id,brand_id,store_id,order_id,projection_name,projection_version,source_version,source_checkpoint,projected_at,freshness_status,customer_guest_session_id,order_number,submitted_at,projection_snapshot_json)
        VALUES ($1,$2,$3,$4,'ordering_order_status_v1',1,1,$5,$6,'Fresh',$7,'7',$6,$8::jsonb)`,
        [
          id(20),
          scope.brandReference,
          scope.storeReference,
          order,
          id(21),
          at,
          pickup.sessionReference,
          snapshot,
        ],
      );
      await admin.query(
        `INSERT INTO rms_ordering.order_status_projection (order_id,brand_id,store_id,generation_id,source_version,source_checkpoint,projected_at) VALUES ($1,$2,$3,$4,1,$5,$6)`,
        [order, scope.brandReference, scope.storeReference, id(20), id(21), at],
      );
      // The pickup contact the checkout recorded for this order (FKs not under test).
      const details = id(40);
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)",
          [
            id(12),
            scope.brandReference,
            scope.storeReference,
            order,
            pickup.sessionReference,
            sha("intent"),
            id(41),
            id(42),
            at,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,operation_id,guest_session_id,cart_id,snapshot_json,recorded_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)",
          [
            scope.brandReference,
            scope.storeReference,
            details,
            id(43),
            pickup.sessionReference,
            id(41),
            {
              schemaVersion: 1,
              detailsReference: details,
              detailsVersion: 1,
              guestSessionReference: pickup.sessionReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              cartReference: id(41),
              cartVersion: 1,
              quoteReference: id(42),
              quoteVersion: 2,
              orderType: "Pickup",
              pickupContact: { name: "Synthetic Guest", channel: "Phone", value: "+14165550123" },
              receipt: { choice: "InSession", email: null },
              policies: [],
              recordedAt: at,
            },
            at,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_checkout_details_link (brand_id,store_id,submission_id,order_id,details_id,details_version) VALUES ($1,$2,$3,$4,$5,1)",
          [scope.brandReference, scope.storeReference, id(12), order, details],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const statusOptions = {
        scope,
        transactions: runner,
        credentials,
        // Test-only stand-in: every visit's QR registration is current.
        binding: () => ({ validate: async () => "Current" }),
        now: () => new Date().toISOString(),
      };
      const notUsed = () => assert.fail("no pickup code is recovered for an order not ready");
      // The real entry, its Guest Sessions read and written as the pilot API role. It may neither
      // rotate nor revoke a visit: joining a table keeps the pickup visit as it is.
      const f = fixture(at);
      const entryStore = createPostgresGuestSessionEntryStore(runner, scope);
      const forbidden = async () => assert.fail("joining a table never rotates or revokes a visit");
      let sequence2 = 900;
      runtime = createApiServerRuntime({
        port: 0,
        logger: createApiRuntimeLogger({ write: (line) => logs.push(String(line)) }),
        customerEntry: new CustomerEntryHandler({
          requestAdmission: { consume: async () => ({ status: "Allowed" }) },
          port: createCustomerEntryComposition({
            ...f.options,
            session: {
              ...f.options.session,
              credentials,
              store: { ...entryStore, rotate: forbidden, revoke: forbidden },
            },
          }),
          allowedOrigin: origin,
          now: () => at,
          uuidV7Factory: () => id(++sequence2),
        }),
        customerContactRemoval: {
          ...statusOptions,
          allowedOrigin: origin,
          newReference: () => id(++sequence2),
        },
        customerOrderStatus: { ...statusOptions, allowedOrigin: origin },
        customerPickupCode: {
          allowedOrigin: origin,
          status: statusOptions,
          readiness: {
            ...scope,
            sha256: sha,
            now: statusOptions.now,
            authorize: async () => true,
            validateCurrentSource: async () => true,
          },
          proof: {
            ...scope,
            sha256: sha,
            now: statusOptions.now,
            authorize: async () => true,
            validateCurrentSource: async () => true,
          },
          credentials: { recoverOpaque: notUsed, recoverCounterCode: notUsed },
          storeDisplayName: "Harbour Store",
          pickupInstruction: "Show this code at the counter.",
        },
      });
      await runtime.listen();
      const address = runtime.server.address();
      assert(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}`;
      const send = (method, path, { guest, csrf, visits }) =>
        globalThis.fetch(`${base}/api/v1/orders/${order}/${path}`, {
          method,
          ...(method === "POST" ? { body: "{}" } : {}),
          headers: {
            ...(method === "POST" ? { "content-type": "application/json" } : {}),
            accept: "application/json",
            origin,
            "sec-fetch-site": "same-origin",
            "x-csrf-token": csrf,
            cookie:
              `__Host-bop-guest=${guest}` +
              (visits === undefined ? "" : `; __Host-bop-visits=${visits}`),
          },
        });
      const get = (path, cookies) => send("GET", path, cookies);
      const removeContact = (cookies) => send("POST", "contact-removal", cookies);

      // 1. On the pickup visit itself: the order opens.
      const own = await get("status", { guest: pickup.credential, csrf: pickup.csrf });
      assert.equal(own.status, 200);
      assert.equal((await own.json()).status.order.orderNumber, "7");

      // 2. The phone scans a table's code at the same Store through the real entry: a new table
      //    visit, with the pickup visit kept on the phone (never rotated, revoked or renewed).
      const entered = await globalThis.fetch(`${base}/bff/customer/entry`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          cookie: `__Host-bop-guest=${pickup.credential}`,
        },
        body: JSON.stringify({ qrToken: f.token() }),
      });
      assert.equal(entered.status, 201);
      const joined = await entered.json();
      const set = entered.headers.getSetCookie();
      const cookie = (name) =>
        set
          .find((value) => value.startsWith(name + "="))
          ?.split(";")[0]
          .slice(name.length + 1);
      const table = { credential: cookie("__Host-bop-guest"), csrf: joined.csrfToken };
      assert.match(table.credential, /^[A-Za-z0-9_-]{43}$/u);
      assert.notEqual(table.credential, pickup.credential);
      assert.equal(joined.channel ?? "DineIn", "DineIn");
      assert.equal(cookie("__Host-bop-visits"), pickup.credential);
      const tableVisit = await entryStore.resolve(
        credentials.hashCredential("Session", table.credential),
      );
      assert.equal(tableVisit.session.channel, "DineIn");
      const pickupNow = await entryStore.resolve(
        credentials.hashCredential("Session", pickup.credential),
      );
      assert.equal(pickupNow.session.status, "Active");
      assert.equal(pickupNow.session.version, 1);

      //    With the cookies the entry set, the order and its pickup code still open (before: 404,
      //    "This order isn't available on this phone").
      const kept = {
        guest: table.credential,
        csrf: table.csrf,
        visits: cookie("__Host-bop-visits"),
      };
      const status = await get("status", kept);
      assert.equal(status.status, 200);
      const body = await status.json();
      assert.equal(body.status.order.orderNumber, "7");
      assert.equal(body.status.order.orderType, "Pickup");
      const code = await get("pickup-code", kept);
      assert.equal(code.status, 200);
      assert.equal((await code.json()).status, "NotReady");

      // 3. Never the kept visit without proving the current one: the table visit's credential with
      //    a CSRF that is not its own (the kept visit's, or none of either) is refused.
      for (const csrf of [pickup.csrf, stranger.csrf]) {
        const refused = await get("status", { ...kept, csrf });
        assert.equal(refused.status, 404);
        assert.equal((await get("pickup-code", { ...kept, csrf })).status, 404);
      }
      // 4. Nor a visit that is not this order's: another phone's pickup visit kept here still
      //    reads 404, and so does the table visit with nothing kept.
      assert.equal((await get("status", { ...kept, visits: stranger.credential })).status, 404);
      assert.equal(
        (await get("status", { guest: table.credential, csrf: table.csrf })).status,
        404,
      );
      // 5. The kept visit is read, never renewed: its version stays where the entry left it.
      const after = await createPostgresGuestSessionEntryStore(runner, scope).resolve(
        credentials.hashCredential("Session", pickup.credential),
      );
      assert.equal(after.session.version, 1);

      // 6. "Remove my contact details" under the kept visit: never without proving the current
      //    visit, never for another phone's visit; then removed once, as the pilot API role, with
      //    one redaction and one audit row that hold no contact value. A repeat changes nothing.
      const redactions = async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_ordering.checkout_contact_redaction WHERE details_id=$1",
            [details],
          )
        ).rows[0].n;
      const audits = async () =>
        (
          await admin.query(
            "SELECT row_to_json(a)::text AS text FROM platform_audit.audit_record a WHERE action_code='CHECKOUT_CONTACT_REMOVED_ON_REQUEST' AND target_id=$1",
            [order],
          )
        ).rows;
      for (const refused of [
        { ...kept, csrf: pickup.csrf },
        { ...kept, visits: stranger.credential },
        { guest: table.credential, csrf: table.csrf },
      ])
        assert.equal((await removeContact(refused)).status, 404);
      assert.equal(await redactions(), 0);
      assert.equal((await audits()).length, 0);
      const removed = await removeContact(kept);
      assert.equal(removed.status, 200);
      assert.equal((await removed.json()).removal.status, "Removed");
      assert.equal(await redactions(), 1);
      const written = await audits();
      assert.equal(written.length, 1);
      assert.equal(written[0].text.includes("4165550123"), false);
      const again = await removeContact(kept);
      assert.equal(again.status, 200);
      assert.equal((await again.json()).removal.status, "AlreadyRemoved");
      assert.equal(await redactions(), 1);
      assert.equal((await audits()).length, 1);

      // Credentials never reach the request log.
      for (const value of [pickup, table, stranger].flatMap((v) => [v.credential, v.csrf]))
        assert(!logs.join("\n").includes(value));
    } finally {
      if (runtime) await runtime.shutdown("SIGTERM");
      await pool.end().catch(() => undefined);
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
