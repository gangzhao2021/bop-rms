import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { countStoreOrdersOfBusinessDate } from "../../rms/ordering/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190b156-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = "sha256:" + "e".repeat(64);

/**
 * Batch 56 (v15 batch 55 live, Test Merchant 2): the Orders header said "51 orders today" (the
 * page's 50 plus a 19-day-old table order) while the Store had 74 that business day. The day's
 * Orders are counted where Ordering keeps them, under a restricted NOBYPASSRLS role holding exactly
 * the pilot ACL: every Order of this Store on the day, never another day's, never another Store's.
 */
it("batch 56: the Orders header counts the Store's Orders of the business day, under the pilot api role", async () => {
  await withIsolatedDatabase({ caseId: "orders_day_count" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "orders_day_api_" + context.runId,
      worker = "orders_day_w_" + context.runId;
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

      const scope = { brandReference: id(1), storeReference: id(2) };
      const otherStore = { ...scope, storeReference: id(3) };
      // Owner-side seeds (FKs and triggers are not under test here).
      await admin.query("SET session_replication_role = replica");
      const seed = async (store, order, day, number, at, type = "Pickup") => {
        const submission = id(order + 1),
          batch = id(order + 2);
        await admin.query(
          "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at,dining_session_id) VALUES ($1,$2,$3,$4::date,$5,$6,'Qr',$7,$7,1,'Submitted','Open','NotReported',$8,$9)",
          [
            id(order),
            store.brandReference,
            store.storeReference,
            day,
            number,
            type,
            id(order + 3),
            at,
            type === "DineIn" ? id(order + 7) : null,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at,submission_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'Initial')",
          [
            submission,
            store.brandReference,
            store.storeReference,
            id(order),
            id(order + 3),
            digest,
            id(order + 4),
            id(order + 5),
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
            id(order + 4),
            id(order + 6),
            id(order + 5),
            id(order + 3),
            at,
          ],
        );
      };
      // Today (11/23): three pickups and a table at this Store.
      for (let n = 1; n <= 3; n += 1)
        await seed(scope, 0x100 * n, "2026-11-23", String(n), "2026-11-23T15:0" + n + ":00.000Z");
      await seed(scope, 0x400, "2026-11-23", "4", "2026-11-23T16:00:00.000Z", "DineIn");
      // The 11/4 table still waiting to be accepted, and another Store's order today.
      await seed(scope, 0x500, "2026-11-04", "2", "2026-11-05T01:47:04.758Z", "DineIn");
      await seed(otherStore, 0x600, "2026-11-23", "1", "2026-11-23T15:00:00.000Z");
      await admin.query("SET session_replication_role = origin");

      const runAs = async (work) => {
        const client = new Client({ ...context.clientConfig, query_timeout: 5000 });
        await client.connect();
        try {
          await client.query("BEGIN READ ONLY");
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
      assert.equal(
        await runAs((tx) =>
          countStoreOrdersOfBusinessDate(tx, scope, { businessDate: "2026-11-23" }),
        ),
        4,
      );
      assert.equal(
        await runAs((tx) =>
          countStoreOrdersOfBusinessDate(tx, scope, { businessDate: "2026-11-04" }),
        ),
        1,
      );
      assert.equal(
        await runAs((tx) =>
          countStoreOrdersOfBusinessDate(tx, otherStore, { businessDate: "2026-11-23" }),
        ),
        1,
      );
      assert.equal(
        await runAs((tx) =>
          countStoreOrdersOfBusinessDate(tx, scope, { businessDate: "2026-11-22" }),
        ),
        0,
      );
      await assert.rejects(
        runAs((tx) => countStoreOrdersOfBusinessDate(tx, scope, { businessDate: "11/23" })),
        /MERCHANT_ORDER_INDEX_UNAVAILABLE/u,
      );
    } finally {
      await admin.query("SET session_replication_role = origin").catch(() => undefined);
      await admin.end();
    }
  });
});
