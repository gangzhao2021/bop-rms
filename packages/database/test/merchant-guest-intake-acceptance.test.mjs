import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import {
  BrandGuestIntakeError,
  readBrandGuestIntake,
  recordBrandGuestIntake,
} from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const id = (n) => "018fb180-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const merchantA = { tenantReference: id(1), brandReference: id(2) };
const merchantB = { tenantReference: id(11), brandReference: id(12) };
const support = id(21);

/**
 * WP-2423 item 13 ② (Owner 2026-11-05): the platform pauses and resumes a merchant's new guests,
 * under the restricted API role holding exactly the pilot ACL. One merchant's pause never reaches
 * another merchant, and every pause or resume stays recorded.
 */
it("pauses and resumes one merchant's new guests, recorded, and never another merchant's", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_guest_intake" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_gi_" + context.runId,
      worker = "wp2423_gi_w_" + context.runId;
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
      for (const [merchant, code] of [
        [merchantA, "SYNTHETIC_INTAKE_A"],
        [merchantB, "SYNTHETIC_INTAKE_B"],
      ])
        await admin.query(
          "INSERT INTO bop_tenant.brand (brand_id,code,display_name,default_locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,$2,'en-CA','CAD','Active',1,now(),now())",
          [merchant.brandReference, code],
        );

      const asApi = async (work, store = null) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + api);
          await admin.query("SET LOCAL statement_timeout='10s'");
          // A caller in the middle of a Store-scoped read: its scope must come back unchanged.
          await admin.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [store?.brand ?? "", store?.store ?? ""],
          );
          const value = await work(admin);
          await admin.query("COMMIT");
          return value;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const change = (merchant, overrides) =>
        asApi((tx) =>
          recordBrandGuestIntake(tx, {
            ...merchant,
            actorReference: support,
            recordedAt: new Date().toISOString(),
            ...overrides,
          }),
        );
      const changed = (promise) =>
        assert.rejects(
          promise,
          (error) => error instanceof BrandGuestIntakeError && error.code === "Changed",
        );

      // Never paused: takes new guests.
      assert.deepEqual(await asApi((tx) => readBrandGuestIntake(tx, merchantA.brandReference)), {
        version: 0,
        state: "Open",
        since: null,
        reason: null,
      });
      // Resuming a merchant that is not paused changes nothing.
      await changed(
        change(merchantA, {
          expectedVersion: 0,
          operationReference: id(100),
          state: "Open",
          reason: "TEST",
        }),
      );
      const pause = {
        expectedVersion: 0,
        operationReference: id(101),
        state: "Paused",
        reason: "  TEST: account review  ",
      };
      const paused = await change(merchantA, pause);
      assert.equal(paused.version, 1);
      assert.equal(paused.state, "Paused");
      assert.equal(paused.reason, "TEST: account review");
      // The same request again (an answer lost) returns what was recorded, once.
      assert.deepEqual(await change(merchantA, pause), paused);
      // The same operation for something else, a stale version, or pausing twice: changed.
      await changed(change(merchantA, { ...pause, reason: "other" }));
      await changed(change(merchantA, { ...pause, operationReference: id(102) }));
      await changed(
        change(merchantA, { ...pause, expectedVersion: 1, operationReference: id(103) }),
      );
      await assert.rejects(
        change(merchantA, { ...pause, operationReference: id(104), reason: " " }),
        (error) => error instanceof BrandGuestIntakeError && error.code === "Invalid",
      );

      // The caller's Store scope is put back after the read.
      const scope = await asApi(
        async (tx) => {
          const read = await readBrandGuestIntake(tx, merchantA.brandReference);
          const { rows } = await tx.query(
            "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
          );
          return { read, scope: rows[0] };
        },
        { brand: merchantB.brandReference, store: id(13) },
      );
      assert.equal(scope.read.state, "Paused");
      assert.deepEqual(scope.scope, { brand: merchantB.brandReference, store: id(13) });

      // Another merchant is not paused, and its scope sees none of the first merchant's records.
      assert.equal(
        (await asApi((tx) => readBrandGuestIntake(tx, merchantB.brandReference))).state,
        "Open",
      );
      const visible = await asApi(async (tx) => {
        await tx.query("SELECT set_config('bop.brand_id',$1,true)", [merchantB.brandReference]);
        return (await tx.query("SELECT count(*)::int n FROM bop_tenant.brand_guest_intake")).rows[0]
          .n;
      });
      assert.equal(visible, 0);
      // A record written under another merchant's scope is refused.
      await assert.rejects(
        asApi(async (tx) => {
          await tx.query("SELECT set_config('bop.brand_id',$1,true)", [merchantB.brandReference]);
          await tx.query(
            "INSERT INTO bop_tenant.brand_guest_intake (tenant_id,brand_id,version,state,reason,actor_id,recorded_at,operation_id) VALUES ($1,$2,1,'Paused','x',$3,date_trunc('milliseconds',now()),$4)",
            [merchantA.tenantReference, merchantA.brandReference, support, id(105)],
          );
        }),
        /row-level security/u,
      );

      const resumed = await change(merchantA, {
        expectedVersion: 1,
        operationReference: id(106),
        state: "Open",
        reason: "TEST: review finished",
      });
      assert.equal(resumed.version, 2);
      assert.equal(
        (await asApi((tx) => readBrandGuestIntake(tx, merchantA.brandReference))).state,
        "Open",
      );

      // History is append-only, even for the API role's own rows.
      for (const sql of [
        "UPDATE bop_tenant.brand_guest_intake SET reason='hidden' WHERE brand_id=$1",
        "DELETE FROM bop_tenant.brand_guest_intake WHERE brand_id=$1",
      ])
        await assert.rejects(
          asApi(async (tx) => {
            await tx.query("SELECT set_config('bop.brand_id',$1,true)", [merchantA.brandReference]);
            await tx.query(sql, [merchantA.brandReference]);
          }),
        );
      const history = (
        await admin.query(
          "SELECT version::int v,state FROM bop_tenant.brand_guest_intake WHERE brand_id=$1 ORDER BY brand_guest_intake.version",
          [merchantA.brandReference],
        )
      ).rows;
      assert.deepEqual(history, [
        { v: 1, state: "Paused" },
        { v: 2, state: "Open" },
      ]);

      // Support people can now be given the pause permission, and nothing outside the list.
      await admin.query(
        "INSERT INTO bop_permission.platform_support_person (actor_id,version,display_name,lifecycle,actions,effective_until,recorded_by_reason,recorded_at) VALUES ($1,1,'TEST support','Active',ARRAY['platform.support.view','platform.merchant.pause'],now()+interval '1 day','TEST',now())",
        [support],
      );
      await assert.rejects(
        admin.query(
          "INSERT INTO bop_permission.platform_support_person (actor_id,version,display_name,lifecycle,actions,effective_until,recorded_by_reason,recorded_at) VALUES ($1,2,'TEST support','Active',ARRAY['platform.merchant.delete'],now()+interval '1 day','TEST',now())",
          [support],
        ),
        /platform_support_person_actions_check/u,
      );
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      for (const name of [api, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
