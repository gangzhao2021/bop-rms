import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withTenantContextTransaction } from "../src/tenant-context.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client, Pool } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (digit) => `018f3f7a-8b1c-7a11-8d01-0000000000${digit.padStart(2, "0")}`;
const expectedForcedTables = [
  "bop_identity.guest_session",
  "bop_membership.membership",
  "bop_membership.store_assignment",
  "bop_operating_entity.brand_operating_entity_assignment",
  "bop_operating_entity.operating_entity",
  "bop_operating_entity.store_operating_entity_assignment",
  "bop_permission.permission_grant",
  "bop_permission.permission_override",
  "bop_permission.policy_state",
  "bop_permission.role",
  "bop_permission.role_assignment",
  "bop_tenant.brand",
  "bop_tenant.store",
  "platform_audit.audit_chain_head",
  "platform_audit.audit_record",
  "platform_eventing.consumer_inbox",
  "platform_eventing.consumer_retry_schedule",
  "platform_eventing.dead_letter_action",
  "platform_eventing.dead_letter_item",
  "platform_eventing.delivery_attempt",
  "platform_eventing.outbox_event",
  "rms_catalog.category",
  "rms_catalog.category_operation_record",
  "rms_catalog.menu",
  "rms_catalog.menu_operation_record",
  "rms_catalog.menu_section",
  "rms_catalog.menu_section_category",
  "rms_catalog.menu_version",
  "rms_catalog.menu_version_channel",
  "rms_catalog.menu_version_order_type",
  "rms_catalog.menu_version_store",
  "rms_catalog.product",
  "rms_catalog.product_operation_record",
  "rms_catalog.product_version",
  "rms_catalog.sellable_placement",
  "rms_catalog.sku",
  "rms_kitchen.kitchen_action_record",
  "rms_kitchen.kitchen_order_item_ready_result",
  "rms_kitchen.kitchen_ticket",
  "rms_kitchen.kitchen_work_item",
  "rms_kitchen.kitchen_work_lifecycle_operation",
  "rms_kitchen.kitchen_work_queue_projection",
  "rms_kitchen.kitchen_work_queue_projection_generation",
  "rms_ordering.cart",
  "rms_ordering.cart_line",
  "rms_ordering.cart_operation_record",
  "rms_ordering.order_batch",
  "rms_ordering.order_header",
  "rms_ordering.order_item",
  "rms_ordering.order_number_allocation",
  "rms_ordering.order_number_counter",
  "rms_ordering.order_status_projection",
  "rms_ordering.order_status_projection_generation",
  "rms_ordering.order_submission_record",
  "rms_payment.payment_attempt",
  "rms_payment.payment_intent",
  "rms_payment.payment_intent_operation_record",
  "rms_payment.payment_provider_observation",
  "rms_payment.payment_reconciliation_exception",
  "rms_payment.payment_reconciliation_record",
  "rms_payment.payment_reconciliation_run",
  "rms_payment.payment_status_projection",
  "rms_payment.payment_terminal_fact",
  "rms_payment.provider_webhook_processing_record",
  "rms_payment.provider_webhook_raw_evidence",
  "rms_payment.provider_webhook_record",
];

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `bop_wp0103_${context.runId}`;
  const pool = new Pool({ ...context.clientConfig, max: 1 });
  await admin.connect();
  try {
    assert.equal(expectedForcedTables.length, 66);
    const forced = await admin.query(
      `SELECT format('%I.%I', namespace.nspname, relation.relname) AS table_name
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE relation.relkind = 'r'
         AND relation.relrowsecurity
         AND relation.relforcerowsecurity
         AND format('%I.%I', namespace.nspname, relation.relname) = ANY($1::text[])
       ORDER BY table_name`,
      [expectedForcedTables],
    );
    assert.deepEqual(
      forced.rows.map((row) => row.table_name),
      expectedForcedTables,
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(
      `CREATE TABLE public.wp0103_scope_probe (
         probe_id uuid PRIMARY KEY,
         brand_id uuid NOT NULL,
         store_id uuid NOT NULL,
         label text NOT NULL
       )`,
    );
    await admin.query(`ALTER TABLE public.wp0103_scope_probe ENABLE ROW LEVEL SECURITY`);
    await admin.query(`ALTER TABLE public.wp0103_scope_probe FORCE ROW LEVEL SECURITY`);
    await admin.query(
      `CREATE POLICY wp0103_scope_probe_select ON public.wp0103_scope_probe
       FOR SELECT
       USING (
         brand_id = platform_helpers.current_brand_id()
         AND (
           platform_helpers.current_store_id() IS NULL
           OR store_id = platform_helpers.current_store_id()
         )
       )`,
    );
    await admin.query(
      `INSERT INTO public.wp0103_scope_probe (probe_id,brand_id,store_id,label)
       VALUES
         ($1,$2,$3,'brand-a-store-a'),
         ($4,$2,$5,'brand-a-store-b'),
         ($6,$7,$8,'brand-b-store-a')`,
      [id("01"), id("11"), id("21"), id("02"), id("22"), id("03"), id("12"), id("23")],
    );
    await admin.query(`GRANT USAGE ON SCHEMA public, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION
         platform_helpers.current_brand_id(),
         platform_helpers.current_store_id()
       TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON public.wp0103_scope_probe TO ${role}`);

    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query("SELECT * FROM public.wp0103_scope_probe")).rowCount, 0);
    await admin.query("RESET ROLE");

    const selectLabels = async (scope) =>
      await withTenantContextTransaction(pool, scope, async (client) => {
        await client.query(`SET LOCAL ROLE ${role}`);
        const result = await client.query({
          name: "wp0103-scope-probe-v1",
          text: "SELECT label FROM public.wp0103_scope_probe ORDER BY label",
        });
        return result.rows.map((row) => row.label);
      });

    assert.deepEqual(await selectLabels({ brandId: id("11"), storeId: id("21") }), [
      "brand-a-store-a",
    ]);
    assert.deepEqual(await selectLabels({ brandId: id("12"), storeId: id("23") }), [
      "brand-b-store-a",
    ]);
    assert.deepEqual(await selectLabels({ brandId: id("11") }), [
      "brand-a-store-a",
      "brand-a-store-b",
    ]);

    const borrowed = await pool.connect();
    try {
      const settings = await borrowed.query(
        `SELECT
           NULLIF(current_setting('bop.brand_id', true), '') AS brand_id,
           NULLIF(current_setting('bop.store_id', true), '') AS store_id`,
      );
      assert.deepEqual(settings.rows, [{ brand_id: null, store_id: null }]);
    } finally {
      borrowed.release();
    }

    const callbackError = new Error("synthetic-business-failure");
    await assert.rejects(
      withTenantContextTransaction(pool, { brandId: id("11"), storeId: id("21") }, async () => {
        throw callbackError;
      }),
      (error) => error === callbackError,
    );
    assert.deepEqual(await selectLabels({ brandId: id("12"), storeId: id("23") }), [
      "brand-b-store-a",
    ]);

    const parallelPool = new Pool({ ...context.clientConfig, max: 2 });
    try {
      const parallel = await Promise.all([
        withTenantContextTransaction(
          parallelPool,
          { brandId: id("11"), storeId: id("22") },
          async (client) => {
            await client.query(`SET LOCAL ROLE ${role}`);
            await client.query("SELECT pg_sleep(0.05)");
            const result = await client.query(
              "SELECT label FROM public.wp0103_scope_probe ORDER BY label",
            );
            return result.rows.map((row) => row.label);
          },
        ),
        withTenantContextTransaction(
          parallelPool,
          { brandId: id("12"), storeId: id("23") },
          async (client) => {
            await client.query(`SET LOCAL ROLE ${role}`);
            await client.query("SELECT pg_sleep(0.05)");
            const result = await client.query(
              "SELECT label FROM public.wp0103_scope_probe ORDER BY label",
            );
            return result.rows.map((row) => row.label);
          },
        ),
      ]);
      assert.deepEqual(parallel, [["brand-a-store-b"], ["brand-b-store-a"]]);
    } finally {
      await parallelPool.end();
    }
  } finally {
    await pool.end().catch(() => undefined);
    await admin.query(`DROP TABLE IF EXISTS public.wp0103_scope_probe`).catch(() => undefined);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

it("proves transaction-local Tenant scope, pool isolation and required forced-RLS entries", async () => {
  await withIsolatedDatabase({ caseId: "tenant_context", root }, prove);
}, 180_000);
