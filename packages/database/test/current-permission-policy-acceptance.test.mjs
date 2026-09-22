import { verifyWorkforceAuthorityComposition } from "../test-support/workforce-authority-composition.mjs";
import assert from "node:assert/strict";
import { verifyBrowserSessionStore } from "../test-support/browser-session-store.mjs";
import { verifyOidcAuthorizationStore } from "../test-support/oidc-authorization-store.mjs";
import { verifyMerchantAuthorizationRead } from "../test-support/merchant-authorization-read.mjs";
import pg from "pg";
import { it } from "vitest";
import { createPostgresCurrentPermissionPolicySource } from "../../bop/permission/src/index.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
it("evaluates actual workforce policy, deny precedence, revocation and lock retention", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_permission" }, async (context) => {
    const admin = new Client(context.clientConfig),
      client = new Client(context.clientConfig);
    await admin.connect();
    await client.connect();
    const role = "wp2402_policy_" + context.runId;
    let createdRole = false;
    try {
      await admin.query("INSERT INTO bop_permission.policy_state VALUES ($1,$2,1,$3)", [
        f.BRAND,
        f.SNAPSHOT,
        f.FROM,
      ]);
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
        [f.PERMISSION, f.ACTION, f.FROM],
      );
      await admin.query(
        "INSERT INTO bop_permission.role VALUES ($1,$2,$3,'synthetic_operator','Active',$4,$5,1,$4,$4)",
        [f.STORE_ROLE, f.BRAND, f.STORE, f.FROM, f.UNTIL],
      );
      await admin.query(
        "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
        [
          f.STORE_ROLE_ASSIGNMENT,
          f.STORE_ROLE,
          f.MEMBERSHIP,
          f.STORE_ASSIGNMENT,
          f.ACTOR,
          f.BRAND,
          f.STORE,
          f.FROM,
          f.UNTIL,
        ],
      );
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
        [f.STORE_GRANT, f.STORE_ROLE, f.PERMISSION, f.BRAND, f.STORE, f.FROM, f.UNTIL],
      );
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      createdRole = true;
      await admin.query("GRANT USAGE ON SCHEMA bop_permission,platform_helpers TO " + role);
      await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA bop_permission TO " + role);
      // SHARE table locks require owner mutation privileges; this is an internal owner role.
      await admin.query(
        "GRANT UPDATE ON bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override TO " +
          role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await verifyOidcAuthorizationStore({ admin, client, role });
      await verifyBrowserSessionStore({ admin, client, role });
      await verifyMerchantAuthorizationRead({ admin, client, role });
      await verifyWorkforceAuthorityComposition({ admin, client, role });
      const request = {
        tenantContext: f.tenantContext,
        membership: f.membership,
        storeAssignment: f.storeAssignment,
        action: f.ACTION,
      };
      async function evaluate(work) {
        let databaseFailure = null;
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL ROLE " + role);
          const source = createPostgresCurrentPermissionPolicySource({
            query: async (sql, values) => {
              try {
                return await client.query(sql, [...values]);
              } catch (error) {
                databaseFailure = error.code;
                throw error;
              }
            },
          });
          const result = await source.authorize(request);
          if (work) await work(result);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          if (databaseFailure)
            throw new Error("synthetic policy query failed: " + databaseFailure, { cause: error });
          throw error;
        }
      }
      const allowed = await evaluate(async () => {
        await admin.query("BEGIN");
        try {
          await assert.rejects(
            admin.query(
              "LOCK TABLE bop_permission.permission_override IN ROW EXCLUSIVE MODE NOWAIT",
            ),
            { code: "55P03" },
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      });
      assert.equal(allowed.effect, "Allow");
      assert.equal(allowed.reason, "ROLE_PERMISSION");
      for (const [reference, effect] of [
        [f.ALLOW, "Allow"],
        [f.DENY, "Deny"],
      ]) {
        await admin.query(
          "INSERT INTO bop_permission.permission_override VALUES ($1,$2,$3,$4,$5,$6,'Active',$7,$8,$9,$10,1,$9,$9)",
          [
            reference,
            f.PERMISSION,
            f.ACTOR,
            f.BRAND,
            f.STORE,
            effect,
            f.REASON,
            f.CORRELATION,
            f.FROM,
            f.UNTIL,
          ],
        );
      }
      const denied = await evaluate();
      assert.equal(denied.effect, "Deny");
      assert.equal(denied.reason, "EXPLICIT_DENY");
      await admin.query(
        "UPDATE bop_permission.permission_override SET lifecycle='Revoked',version=2",
      );
      await admin.query("UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=2");
      assert.equal((await evaluate()).reason, "DEFAULT_DENY");
    } finally {
      await client.end();
      if (createdRole) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
});
