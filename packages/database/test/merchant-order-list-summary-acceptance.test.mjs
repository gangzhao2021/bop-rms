import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { loadMerchantOrderListSummaries } from "../../rms/ordering/src/index.ts";
import { configuredOrderItemFixture } from "../../rms/ordering/src/tests/configured-order-item.fixture.ts";
import { encodeConfiguredOrderItemSnapshot } from "../../rms/ordering/src/domain/order-item-snapshot-codec.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190ab30-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = "sha256:" + "e".repeat(64);
// TEST-ONLY contact: a fictitious 555 number, never shown by the list.
const testPhone = "+14165550199";

/**
 * Orders v2 (Owner 2026-10-26, "a row doesn't say what or who") under a restricted NOBYPASSRLS
 * role holding exactly the pilot ACL: each listed Order's first items and the pickup name — never
 * the phone or email; a contact removed after its retention period has no name; another Store's
 * Order is never read.
 */
it("Orders v2: list summaries say what and who, under the pilot api role", async () => {
  await withIsolatedDatabase({ caseId: "orders_v2_summary" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "orders_v2_api_" + context.runId,
      worker = "orders_v2_w_" + context.runId;
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

      const { item } = await configuredOrderItemFixture();
      const scope = {
        brandReference: item.catalog.brandReference,
        storeReference: item.catalog.storeReference,
      };
      const otherStore = { ...scope, storeReference: id(99) };
      const at = item.snapshotCapturedAt;
      const snapshot = encodeConfiguredOrderItemSnapshot(item);
      // Owner-side seeds (FKs and triggers are not under test here).
      await admin.query("SET session_replication_role = replica");
      const seed = async (store, order, number, contact) => {
        const guest = id(order + 1),
          submission = id(order + 2),
          batch = id(order + 3),
          cart = id(order + 4),
          details = id(order + 5);
        await admin.query(
          "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES ($1,$2,$3,$4::date,$5,'Pickup','Qr',$6,$6,1,'Submitted','Open','NotReported',$7)",
          [
            id(order),
            store.brandReference,
            store.storeReference,
            at.slice(0, 10),
            number,
            guest,
            at,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at,submission_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'Initial')",
          [
            submission,
            store.brandReference,
            store.storeReference,
            id(order),
            guest,
            digest,
            cart,
            item.pricing.quoteReference,
            at,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_batch (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)",
          [
            batch,
            store.brandReference,
            store.storeReference,
            id(order),
            submission,
            cart,
            id(order + 6),
            item.pricing.quoteReference,
            guest,
            at,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_item (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,1)",
          [
            id(order + 7),
            store.brandReference,
            store.storeReference,
            id(order),
            batch,
            item.cartItemReference,
            item.quantity,
            item.catalog.snapshotDigest,
            item.pricing.quoteInputDigest,
            snapshot,
            at,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,operation_id,guest_session_id,cart_id,snapshot_json,recorded_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)",
          [
            store.brandReference,
            store.storeReference,
            details,
            id(order + 8),
            guest,
            cart,
            {
              schemaVersion: 1,
              detailsReference: details,
              detailsVersion: 1,
              guestSessionReference: guest,
              brandReference: store.brandReference,
              storeReference: store.storeReference,
              cartReference: cart,
              cartVersion: 1,
              quoteReference: item.pricing.quoteReference,
              quoteVersion: 2,
              orderType: "Pickup",
              pickupContact: { name: contact.name, channel: "Phone", value: testPhone },
              receipt: { choice: "InSession", email: null },
              policies: [],
              recordedAt: at,
            },
            at,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_checkout_details_link (brand_id,store_id,submission_id,order_id,details_id,details_version) VALUES ($1,$2,$3,$4,$5,1)",
          [store.brandReference, store.storeReference, submission, id(order), details],
        );
        if (contact.removed)
          await admin.query(
            "INSERT INTO rms_ordering.checkout_contact_redaction (brand_id,store_id,details_id,details_version,redaction_id,policy_code,policy_version,retention_days,details_recorded_at,redacted_at) VALUES ($1,$2,$3,1,$4,'CUSTOMER_REQUEST',1,NULL,$5,now()::timestamptz(3))",
            [store.brandReference, store.storeReference, details, id(order + 9), at],
          );
      };
      await seed(scope, 0x100, "1", { name: "TEST Guest", removed: false });
      await seed(scope, 0x200, "2", { name: "TEST Removed", removed: true });
      await seed(otherStore, 0x300, "3", { name: "TEST Elsewhere", removed: false });
      await admin.query("SET session_replication_role = origin");

      const runAs = async (work) => {
        const client = new Client({ ...context.clientConfig, query_timeout: 5000 });
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + api);
          await client.query("SET LOCAL statement_timeout='5s'");
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
      const summaries = await runAs((tx) =>
        loadMerchantOrderListSummaries(tx, scope, [id(0x100), id(0x200), id(0x300)], "en-CA"),
      );
      // This Store's two Orders; the other Store's Order is never read.
      assert.deepEqual([...summaries.keys()].sort(), [id(0x100), id(0x200)]);
      const first = summaries.get(id(0x100));
      assert.equal(first.lineCount, 1);
      assert.equal(first.items.length, 1);
      assert.equal(first.items[0].quantity, item.quantity);
      assert.ok(first.items[0].name.length > 0);
      assert.equal(first.pickupName, "TEST Guest");
      // A contact removed after its retention period has no name.
      assert.equal(summaries.get(id(0x200)).pickupName, null);
      // Never the phone or email.
      assert.equal(JSON.stringify([...summaries.values()]).includes(testPhone), false);
      assert.equal(JSON.stringify([...summaries.values()]).includes("TEST Elsewhere"), false);
    } finally {
      await admin.query("SET session_replication_role = origin").catch(() => undefined);
      await admin.end();
    }
  });
});
