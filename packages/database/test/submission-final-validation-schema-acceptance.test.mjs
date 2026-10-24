import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { parseSubmissionInventoryFinalValidation } from "../../rms/inventory/src/index.ts";
import { finalValidationFixture } from "../../rms/inventory/src/tests/submission-final-validation.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
it("persists scoped immutable final Inventory records and rejects missing reservation evidence", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_inv_final" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_final_" + context.runId;
    assert.match(role, /^wp2402_final_[a-f0-9]+$/u);
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query("GRANT USAGE ON SCHEMA rms_inventory,platform_helpers TO " + role);
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON rms_inventory.submission_final_validation TO " +
          role,
      );
      await admin.query("GRANT SELECT ON rms_inventory.stock_reservation_set TO " + role);
      const raw = finalValidationFixture();
      const record = parseSubmissionInventoryFinalValidation({
        ...raw,
        reservationSet: null,
        items: raw.items.map((item) => ({
          ...item,
          stockTrackingEnabled: false,
          disposition: "NotTracked",
        })),
      });
      const fields = {
        tenant_id: "tenantReference",
        brand_id: "brandReference",
        store_id: "storeReference",
        validation_id: "validationReference",
        operation_id: "operationReference",
        actor_id: "actorReference",
        audit_id: "auditReference",
        order_id: "orderReference",
        submission_id: "submissionReference",
        cart_id: "cartReference",
        cart_version: "cartVersion",
        quote_id: "quoteReference",
        demand_id: "demandReference",
        demand_digest: "demandDigest",
        workflow_id: "workflowReference",
        workflow_version_id: "workflowVersionReference",
        workflow_version: "workflowVersion",
        transition_id: "transitionReference",
        observed_at: "observedAt",
      };
      async function transaction(work, tenant = record.tenantReference, rollback = false) {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, record.brandReference, record.storeReference],
          );
          const result = await work();
          await admin.query(rollback ? "ROLLBACK" : "COMMIT");
          return result;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      }
      async function insert(value) {
        const columns = [
          ...Object.keys(fields),
          "reservation_set_id",
          "record_digest",
          "record_json",
        ];
        const values = [
          ...Object.values(fields).map((key) => value[key]),
          value.reservationSet?.setReference ?? null,
          "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
          value,
        ];
        return admin.query(
          "INSERT INTO rms_inventory.submission_final_validation (" +
            columns.join(",") +
            ") VALUES (" +
            values.map((_, index) => "$" + (index + 1)).join(",") +
            ")",
          values,
        );
      }
      // Schema-only synthetic record; current Item/Workflow authority and Audit writer are separate.
      await transaction(() => insert(record), record.tenantReference, true);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_inventory.submission_final_validation",
          )
        ).rows[0].n,
        0,
      );
      await transaction(() => insert(record));
      const read = await transaction(() =>
        admin.query("SELECT record_json FROM rms_inventory.submission_final_validation"),
      );
      assert.deepEqual(read.rows, [{ record_json: record }]);
      const foreign = "01909997-0000-7000-8000-000000000fff";
      assert.equal(
        (
          await transaction(
            () => admin.query("SELECT record_json FROM rms_inventory.submission_final_validation"),
            foreign,
          )
        ).rowCount,
        0,
      );
      await assert.rejects(
        transaction(() => insert(record), foreign),
        { code: "42501" },
      );
      await assert.rejects(
        transaction(() => insert(record)),
        { code: "23505" },
      );
      for (const statement of [
        "UPDATE rms_inventory.submission_final_validation SET record_digest=record_digest",
        "DELETE FROM rms_inventory.submission_final_validation",
        "TRUNCATE rms_inventory.submission_final_validation",
      ])
        await assert.rejects(
          transaction(() => admin.query(statement)),
          { code: "55000" },
        );
      // Reserved cannot be asserted without the actual immutable owner set.
      await assert.rejects(
        transaction(() =>
          insert({
            ...raw,
            validationReference: foreign,
            operationReference: foreign,
            orderReference: foreign,
            submissionReference: foreign,
          }),
        ),
        { code: "23514" },
      );
      const forced = await admin.query(
        "SELECT relforcerowsecurity FROM pg_class WHERE oid='rms_inventory.submission_final_validation'::regclass",
      );
      assert.equal(forced.rows[0].relforcerowsecurity, true);
    } finally {
      await admin.query("RESET ROLE");
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});
