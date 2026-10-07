import { verifyWorkforceAuthorityComposition } from "../test-support/workforce-authority-composition.mjs";
import assert from "node:assert/strict";
import { verifyBrowserSessionStore } from "../test-support/browser-session-store.mjs";
import { verifyOidcAuthorizationStore } from "../test-support/oidc-authorization-store.mjs";
import { verifyMerchantAuthorizationRead } from "../test-support/merchant-authorization-read.mjs";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCurrentPermissionPolicySource,
  createPostgresTransactionCurrentPermissionPolicySource,
} from "../../bop/permission/src/index.ts";
import { createIdentityActor } from "../../bop/identity/src/index.ts";
import { createMembership, createStoreAssignment } from "../../bop/membership/src/index.ts";
import { createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
// Existing synthetic Permission-owner seed; no live IAM/Store assertion.
async function seedSyntheticStorePolicy(admin) {
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
}

it("evaluates actual workforce policy, deny precedence, revocation and lock retention", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_permission" }, async (context) => {
    const admin = new Client(context.clientConfig),
      client = new Client(context.clientConfig);
    await admin.connect();
    await client.connect();
    const role = "wp2402_policy_" + context.runId;
    let createdRole = false;
    try {
      await seedSyntheticStorePolicy(admin);
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
      await verifyMerchantAuthorizationRead({
        admin,
        client,
        role,
        fixtureClock: {
          from: f.FROM,
          at: f.AT,
          until: f.UNTIL,
          businessWeekday: 2,
          businessDate: "2026-07-28",
          targetBusinessDate: "2026-07-27",
        },
      });
      await verifyWorkforceAuthorityComposition({ admin, client, role });
      const request = {
        tenantContext: f.tenantContext,
        membership: f.membership,
        storeAssignment: f.storeAssignment,
        action: f.ACTION,
      };
      async function evaluate(work, action = f.ACTION) {
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
          const result = await source.authorize({ ...request, action });
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
      const historyAction = "catalog.option_set.history.read";
      const historyPermission = f.uuid("81");
      const historyGrant = f.uuid("82");
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
        [historyPermission, historyAction, f.FROM],
      );
      assert.equal((await evaluate(undefined, historyAction)).reason, "DEFAULT_DENY");
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
        [historyGrant, f.STORE_ROLE, historyPermission, f.BRAND, f.STORE, f.FROM, f.UNTIL],
      );
      const historyAllowed = await evaluate(undefined, historyAction);
      assert.equal(historyAllowed.effect, "Allow");
      assert.equal(historyAllowed.action, historyAction);
      // DEC-PERM-CATALOG: well-formed underscore names are valid; only the catalog provisioner
      // writes definitions. The format still rejects case, control characters and wildcards.
      for (const action of [
        "catalog.option_set.history.read\n",
        "catalog.option_set.History.read",
        "catalog.option_set.history.*",
      ]) {
        await assert.rejects(
          admin.query(
            "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
            [f.uuid("83"), action, f.FROM],
          ),
          { code: "23514" },
        );
      }
      await admin.query(
        "INSERT INTO bop_permission.permission_override VALUES ($1,$2,$3,$4,$5,'Deny','Active',$6,$7,$8,$9,1,$8,$8)",
        [
          f.uuid("84"),
          historyPermission,
          f.ACTOR,
          f.BRAND,
          f.STORE,
          f.REASON,
          f.CORRELATION,
          f.FROM,
          f.UNTIL,
        ],
      );
      assert.equal((await evaluate(undefined, historyAction)).reason, "EXPLICIT_DENY");
      await admin.query(
        "UPDATE bop_permission.permission_override SET lifecycle='Revoked',version=2 WHERE override_id=$1",
        [f.uuid("84")],
      );
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=2 WHERE grant_id=$1",
        [historyGrant],
      );
      assert.equal((await evaluate(undefined, historyAction)).reason, "DEFAULT_DENY");
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

it("recomputes synthetic owning Permission decisions from fresh PG packets while retaining one transaction SHARE lock", async () => {
  await withIsolatedDatabase({ caseId: "tx_permission" }, async (context) => {
    const admin = new Client(context.clientConfig),
      client = new Client(context.clientConfig);
    const role = "wp2421_transaction_policy_" + context.runId;
    assert.match(role, /^wp2421_transaction_policy_[a-f0-9]+$/u);
    let createdRole = false;
    const tables =
      "bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override";
    const deniedAction = "catalog.option_set.history.read",
      deniedPermission = f.uuid("91");
    const denyStarts = new Date(Date.parse(f.AT) + 500).toISOString();
    const grantEnds = new Date(Date.parse(f.AT) + 1000).toISOString();
    try {
      await admin.connect();
      await client.connect();
      await seedSyntheticStorePolicy(admin);
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
        [deniedPermission, deniedAction, f.FROM],
      );
      await admin.query(
        "INSERT INTO bop_permission.role VALUES($1,$2,NULL,'synthetic_brand','Active',$3,$4,1,$3,$3)",
        [f.BRAND_ROLE, f.BRAND, f.FROM, f.UNTIL],
      );
      await admin.query(
        "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
        [f.BRAND_ASSIGNMENT, f.BRAND_ROLE, f.MEMBERSHIP, f.ACTOR, f.BRAND, f.FROM, f.UNTIL],
      );
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
        [f.BRAND_GRANT, f.BRAND_ROLE, f.PERMISSION, f.BRAND, f.FROM, f.UNTIL],
      );
      await admin.query(
        "INSERT INTO bop_permission.permission_override VALUES($1,$2,$3,$4,$5,'Deny','Active',$6,$7,$8,$9,1,$10,$10)",
        [
          f.DENY,
          f.PERMISSION,
          f.ACTOR,
          f.BRAND,
          f.STORE,
          f.REASON,
          f.CORRELATION,
          denyStarts,
          f.UNTIL,
          f.FROM,
        ],
      );
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      createdRole = true;
      await admin.query("GRANT USAGE ON SCHEMA bop_permission,platform_helpers TO " + role);
      // Same six owning tables/lock ACL as the legacy case; no other Domain table.
      await admin.query("GRANT SELECT,UPDATE ON " + tables + " TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      const scope = (store = f.store, observedAt = f.AT) =>
        createTenantContext(f.actor, f.brand, store, observedAt);
      const input = (
        tenantContext = scope(),
        membership = f.membership,
        storeAssignment = f.storeAssignment,
      ) => ({
        tenantContext,
        membership,
        storeAssignment,
        actions: [f.ACTION, deniedAction],
      });
      async function transaction(work) {
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL statement_timeout = '10s'");
          await client.query("SET LOCAL lock_timeout = '5s'");
          let packetReads = 0,
            shareLocks = 0,
            scopeRestores = 0;
          const tx = {
            query: async (sql, values) => {
              if (sql.startsWith("LOCK TABLE ")) {
                assert.equal(sql, "LOCK TABLE " + tables + " IN SHARE MODE");
                shareLocks++;
              } else if (sql.includes("'PermissionCurrentPolicyPacketV1'")) packetReads++;
              else if (sql.startsWith("SELECT set_config(")) scopeRestores++;
              // Never replace the PG rows/packet or authorization result.
              return client.query(sql, [...values]);
            },
          };
          const source = createPostgresTransactionCurrentPermissionPolicySource(tx);
          async function evaluate(request) {
            const before = packetReads,
              result = await source.authorizeActionsWithRoles(request);
            assert.equal(
              packetReads,
              before + 1,
              "Every successful checkpoint must read a fresh complete owning packet",
            );
            assert.deepEqual(
              result.decisions.map((decision) => decision.action),
              request.actions,
            );
            assert(Object.isFrozen(result) && Object.isFrozen(result.decisions));
            for (const decision of result.decisions) {
              assert(Object.isFrozen(decision));
              assert(Object.isFrozen(decision.audit));
              assert.equal(decision.policySnapshotReference, f.SNAPSHOT);
              assert.equal(decision.policyVersion, 1);
            }
            return result;
          }
          await work({
            source,
            evaluate,
            stats: () => ({ packetReads, shareLocks, scopeRestores }),
          });
          await client.query("ROLLBACK"); // All deliberate same-tx mutations are isolated.
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      await transaction(async ({ evaluate, stats }) => {
        const brand = await evaluate(input(scope(null), f.membership, null));
        assert.deepEqual(
          brand.decisions.map((decision) => decision.effect),
          ["Allow", "Deny"],
        );
        assert.equal(brand.validUntil, f.UNTIL);
        const store = await evaluate(input());
        assert.deepEqual(
          store.decisions.map((decision) => decision.effect),
          ["Allow", "Deny"],
        );
        assert.equal(
          store.validUntil,
          denyStarts,
          "Earliest future natural policy boundary must shorten the observation",
        );
        const repeated = await evaluate(input());
        assert.notEqual(
          repeated.decisions[0],
          store.decisions[0],
          "Decisions cannot be cached even when facts are unchanged",
        );
        assert.deepEqual(repeated, store);
        const started = await evaluate(input(scope(f.store, denyStarts)));
        assert.equal(started.decisions[0].reason, "EXPLICIT_DENY");
        assert.equal(started.decisions[0].effect, "Deny");
        // SQL data changes with unchanged row versions are deliberately visible
        // to the next real packet; a version-only positive cache would fail here.
        const changedOverride = await client.query(
          "UPDATE bop_permission.permission_override SET effect='Allow' WHERE override_id=$1 RETURNING version",
          [f.DENY],
        );
        assert.equal(changedOverride.rows[0].version, "1");
        assert.equal(
          (await evaluate(input(scope(f.store, denyStarts)))).decisions[0].reason,
          "EXPLICIT_ALLOW",
        );
        await client.query(
          "UPDATE bop_permission.permission_override SET lifecycle='Revoked' WHERE override_id=$1",
          [f.DENY],
        );
        const changedGrants = await client.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked' WHERE grant_id=ANY($1::uuid[]) RETURNING version",
          [[f.STORE_GRANT, f.BRAND_GRANT]],
        );
        assert.equal(changedGrants.rows.length, 2);
        assert(changedGrants.rows.every((row) => row.version === "1"));
        assert.equal(
          (await evaluate(input(scope(f.store, denyStarts)))).decisions[0].reason,
          "DEFAULT_DENY",
        );
        await client.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Active',effective_until=$2 WHERE grant_id=$1",
          [f.STORE_GRANT, grantEnds],
        );
        const beforeExpiry = await evaluate(input(scope(f.store, denyStarts)));
        assert.equal(beforeExpiry.decisions[0].effect, "Allow");
        assert.equal(beforeExpiry.validUntil, grantEnds);
        assert.equal(
          (await evaluate(input(scope(f.store, grantEnds)))).decisions[0].reason,
          "DEFAULT_DENY",
        );
        assert.deepEqual(stats(), { packetReads: 8, shareLocks: 1, scopeRestores: 8 });
        // Actual PG lock retention, not a query-counter claim of successful lock.
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
      for (const changed of ["Membership", "StoreAssignment", "StoreAssignmentIdentity"]) {
        await transaction(async ({ source, evaluate, stats }) => {
          await evaluate(input());
          const membership =
            changed === "Membership"
              ? createMembership({ ...f.membership, lifecycle: "Suspended" }, f.actor)
              : f.membership;
          const assignment =
            changed === "StoreAssignment"
              ? createStoreAssignment(
                  { ...f.storeAssignment, lifecycle: "Suspended" },
                  f.membership,
                  f.store,
                )
              : changed === "StoreAssignmentIdentity"
                ? createStoreAssignment(
                    { ...f.storeAssignment, storeAssignmentReference: f.uuid("94") },
                    f.membership,
                    f.store,
                  )
                : f.storeAssignment;
          await assert.rejects(
            source.authorizeActionsWithRoles(input(scope(), membership, assignment)),
            { code: "PERMISSION_POLICY_MATERIALIZATION_INVALID" },
          );
          assert.deepEqual(stats(), { packetReads: 2, shareLocks: 1, scopeRestores: 2 });
          await assert.rejects(source.authorizeActionsWithRoles(input()), {
            code: "PERMISSION_POLICY_MATERIALIZATION_INVALID",
          });
          assert.equal(
            stats().packetReads,
            2,
            "Failed dependency cannot fall back to the prior positive result",
          );
        });
      }
      for (const changed of ["Actor", "Brand", "Store"]) {
        await transaction(async ({ source, evaluate, stats }) => {
          await evaluate(input());
          const otherActor = createIdentityActor({ ...f.actor, actorReference: f.uuid("92") });
          const otherStore = createStore({
            ...f.store,
            storeReference: f.uuid("93"),
            code: "OTHER_SYNTHETIC",
          });
          const context =
            changed === "Actor"
              ? createTenantContext(otherActor, f.brand, f.store, f.AT)
              : changed === "Brand"
                ? createTenantContext(f.actor, f.otherBrand, null, f.AT)
                : createTenantContext(f.actor, f.brand, otherStore, f.AT);
          await assert.rejects(source.authorizeActionsWithRoles(input(context)), {
            code: "PERMISSION_POLICY_MATERIALIZATION_INVALID",
          });
          assert.deepEqual(stats(), { packetReads: 1, shareLocks: 1, scopeRestores: 1 });
          await assert.rejects(source.authorizeActionsWithRoles(input()), {
            code: "PERMISSION_POLICY_MATERIALIZATION_INVALID",
          });
          assert.equal(stats().packetReads, 1);
        });
      }
    } finally {
      try {
        await client.end();
      } finally {
        try {
          if (createdRole) {
            await admin.query("DROP OWNED BY " + role);
            await admin.query("DROP ROLE " + role);
          }
        } finally {
          await admin.end();
        }
      }
    }
  });
}, 120_000);
