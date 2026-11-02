import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";
import { exercisePilotStoreSetupPublication } from "../test-support/pilot-store-setup-publication.mjs";
import { exercisePilotPlatformSupport } from "../test-support/pilot-platform-support.mjs";

/**
 * WP-2423 取舍 15 (Owner 2026-10-28): platform support staff, on a published Store, through the real
 * session and merchant routes, as the restricted role holding the rendered pilot API grants.
 */
it("support views and is recorded, changes only while the Owner allows, never touches money", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_support" }, (context) =>
    exerciseStoreSetupRuntimeHttp({
      ...context,
      afterSetup: (input) =>
        exercisePilotStoreSetupPublication({
          ...input,
          afterPublication: exercisePilotPlatformSupport,
        }),
    }),
  );
});

/**
 * WP-2423 (full regression 2026-11-02, migration 2000_144): nobody reaches these through PUBLIC. The
 * API role holds exactly its rendered grants, and its writes still pass through the triggers, which
 * need no EXECUTE from it. The whole journey above runs on the same grants.
 */
it("PUBLIC can't use support's tables or functions; the API role still writes through its grants", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_sup_public" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_sp_" + context.runId,
      worker = "wp2423_sp_w_" + context.runId,
      stranger = "wp2423_sp_s_" + context.runId;
    try {
      for (const name of [api, worker, stranger])
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
      const can = async (kind, role, object, right) =>
        (await admin.query(`SELECT has_${kind}_privilege($1,$2,$3) ok`, [role, object, right]))
          .rows[0].ok;
      for (const name of [
        "validate_store_support_permission",
        "reject_platform_support_mutation",
        "reject_support_person_role",
        "reject_role_holder_as_support",
      ])
        for (const role of [stranger, api, worker])
          assert.equal(
            await can("function", role, "bop_permission." + name + "()", "EXECUTE"),
            false,
            role + " " + name,
          );
      for (const table of [
        "platform_support_person",
        "store_support_permission",
        "store_support_access_log",
      ])
        for (const right of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          assert.equal(await can("table", stranger, "bop_permission." + table, right), false);
          assert.equal(await can("table", worker, "bop_permission." + table, right), false);
        }

      const id = (n) => "018fb000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
      const brand = id(1),
        store = id(2);
      await admin.query("BEGIN");
      await admin.query("SET LOCAL ROLE " + api);
      await admin.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [id(3), brand, store],
      );
      const permission = (version, operation) =>
        admin.query(
          "INSERT INTO bop_permission.store_support_permission (brand_id,store_id,version,operation_id,mode,allowed_until,actor_id,occurred_at) VALUES ($1,$2,$3,$4,'Standing',NULL,$5,now())",
          [brand, store, version, id(operation), id(4)],
        );
      await permission(1, 10);
      // The ordering trigger runs for this role, with no EXECUTE of its own.
      await admin.query("SAVEPOINT out_of_order");
      await assert.rejects(permission(3, 11), { code: "23514" });
      await admin.query("ROLLBACK TO SAVEPOINT out_of_order");
      await admin.query(
        "INSERT INTO bop_permission.store_support_access_log (log_id,brand_id,store_id,support_actor_id,kind,subject_code,occurred_at) VALUES ($1,$2,$3,$4,'Viewed','Orders',now())",
        [id(12), brand, store, id(4)],
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM bop_permission.store_support_permission"))
          .rows[0].n,
        1,
      );
      await admin.query("ROLLBACK");
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.end();
    }
  });
});
