import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  changeDiningCheckoutScopeSetting,
  loadDiningCheckoutScopeSetting,
} from "../../rms/dining/src/index.ts";
import { grantPilotApiAcl } from "../test-support/pilot-api-acl.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { dbNow } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01902522-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 同桌结账 (DEC-OWNER-DEFAULTS-2026-11-06, 2000_522): the Store's setting for what a guest
 * paying on their phone at a shared table starts with. As the restricted pilot API role (rendered
 * pilot ACL, NOBYPASSRLS): never changed means the whole table; a manager's change is the next
 * version with who and when; the same operation replays; a change made on a stale version is
 * refused; two changes at once leave one; another Store reads its own (none); the record can't be
 * changed or deleted, and versions can't be skipped.
 */
it("WP-2423 同桌结账: a Store's default for paying at a shared table is versioned and its own", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_scope_setting" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_scopeset_" + context.runId;
    try {
      await admin.query(
        "CREATE ROLE " + api + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await grantPilotApiAcl(admin, api);
      const inTransaction = async (action) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + api);
          const value = await action({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      };
      const at = await dbNow(admin);
      const scope = {
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
      };
      const other = { ...scope, storeReference: id(4) };
      const load = (which = scope) =>
        inTransaction((tx) => loadDiningCheckoutScopeSetting(tx, which));
      const change = (operation, expectedVersion, defaultScope) =>
        inTransaction((tx) =>
          changeDiningCheckoutScopeSetting(tx, scope, {
            operationReference: id(operation),
            expectedVersion,
            defaultScope,
            actorReference: id(0x700),
            observedAt: at,
          }),
        );

      // Never changed: guests start with the whole table (the Owner's default).
      assert.deepEqual(await load(), { version: 0, defaultScope: "WholeTable", changedAt: null });
      const own = await change(10, 0, "OwnDishes");
      assert.deepEqual([own.version, own.defaultScope], [1, "OwnDishes"]);
      // The same operation again: the same answer, nothing new.
      assert.equal((await change(10, 0, "OwnDishes")).version, 1);
      await assert.rejects(change(10, 0, "WholeTable"), {
        code: "DINING_SESSION_IDEMPOTENCY_CONFLICT",
      });
      // A manager who saw an older version is refused (someone changed it meanwhile).
      await assert.rejects(change(11, 0, "WholeTable"), {
        code: "DINING_SESSION_IDEMPOTENCY_CONFLICT",
      });
      // Two managers change it at once from version 1: one change is kept, the other is told.
      const raced = await Promise.allSettled([
        change(12, 1, "WholeTable"),
        change(13, 1, "WholeTable"),
      ]);
      assert.equal(raced.filter((entry) => entry.status === "fulfilled").length, 1);
      assert.equal(
        raced.find((entry) => entry.status === "rejected")?.reason.code,
        "DINING_SESSION_IDEMPOTENCY_CONFLICT",
      );
      const after = await load();
      assert.deepEqual([after.version, after.defaultScope], [2, "WholeTable"]);
      const { rows } = await admin.query(
        "SELECT version,default_scope,actor_id::text AS actor FROM rms_dining.dining_checkout_scope_setting ORDER BY version",
      );
      assert.deepEqual(rows, [
        { version: 1, default_scope: "OwnDishes", actor: id(0x700) },
        { version: 2, default_scope: "WholeTable", actor: id(0x700) },
      ]);
      // Another Store has its own (none yet), and can't read or write this one's.
      assert.equal((await load(other)).version, 0);
      await assert.rejects(
        inTransaction((tx) =>
          tx.query(
            "INSERT INTO rms_dining.dining_checkout_scope_setting (tenant_id,brand_id,store_id,version,operation_id,default_scope,actor_id,occurred_at) SELECT $1,$2,$3,3,$4,'OwnDishes',$5,date_trunc('milliseconds',now()) FROM (SELECT set_config('bop.brand_id',$2,true),set_config('bop.store_id',$6,true)) x",
            [
              scope.tenantReference,
              scope.brandReference,
              scope.storeReference,
              id(20),
              id(0x700),
              other.storeReference,
            ],
          ),
        ),
      );
      // Append-only, and versions are never skipped.
      await assert.rejects(
        admin.query(
          "UPDATE rms_dining.dining_checkout_scope_setting SET default_scope='OwnDishes'",
        ),
      );
      await assert.rejects(admin.query("DELETE FROM rms_dining.dining_checkout_scope_setting"));
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_dining.dining_checkout_scope_setting (tenant_id,brand_id,store_id,version,operation_id,default_scope,actor_id,occurred_at) VALUES ($1,$2,$3,5,$4,'OwnDishes',$5,date_trunc('milliseconds',now()))",
          [scope.tenantReference, scope.brandReference, scope.storeReference, id(21), id(0x700)],
        ),
        /out of order/u,
      );
    } finally {
      await admin.query("DROP OWNED BY " + api).catch(() => undefined);
      await admin.query("DROP ROLE " + api).catch(() => undefined);
      await admin.end();
    }
  });
});
