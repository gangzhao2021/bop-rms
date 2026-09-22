import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPostgresKillSwitchQueryStore,
  createPostgresKillSwitchMutationStore,
  executeFeatureControlMutation,
  createFeatureControlDefinition,
} from "../../bop/feature-control/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-11T00:00:00.000Z",
  key = "ordering.checkout.safety";
const definition = (version, phase, store = id(3)) =>
  createFeatureControlDefinition({
    controlId: store === null ? id(8) : id(9),
    key,
    version,
    ownerReference: id(6),
    purposeCode: "CHECKOUT_SAFETY",
    scope: {
      kind: store === null ? "Brand" : "Store",
      brandReference: id(2),
      storeReference: store,
    },
    effectiveFrom: at,
    effectiveUntil: null,
    reviewAt: at,
    expiresAt: null,
    kind: "KillSwitch",
    defaultActive: true,
    mode: "BlockNew",
    inFlightPolicy: "AllowToComplete",
    recoveryPolicy: "Progressive",
    recoveryStages: [2500, 10000],
    state: phase === "Recovering" ? { phase, rolloutBasisPoints: 2500 } : { phase },
  });
const tenant = () =>
  createTenantContext(
    {
      actorType: "User",
      accountKind: "Workforce",
      actorReference: id(1),
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    },
    createBrand({
      brandReference: id(2),
      code: "SYNTHETIC",
      displayName: "Synthetic brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    createStore({
      storeReference: id(3),
      brandReference: id(2),
      code: "SYNTHETIC",
      displayName: "Synthetic store",
      timeZone: "UTC",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    at,
  );
it("commits authorized Kill Switch versions with atomic Audit and exact lost-ack replay", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_kill_write" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_kill_write_" + context.runId;
    let failAudit = false,
      loseAck = false;
    const runner = {
      async run(action) {
        const c = new Client(context.clientConfig);
        await c.connect();
        let committed = false;
        try {
          await c.query("BEGIN");
          await c.query("SET LOCAL ROLE " + role);
          const result = await action({
            query: async (sql, values) => {
              if (failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                throw new Error("synthetic audit failure");
              return c.query(sql, values);
            },
          });
          await c.query("COMMIT");
          committed = true;
          if (loseAck) {
            loseAck = false;
            throw new Error("synthetic lost acknowledgement");
          }
          return result;
        } catch (e) {
          if (!committed) await c.query("ROLLBACK");
          throw e;
        } finally {
          await c.end();
        }
      },
    };
    const current = definition(1, "Inactive"),
      next = definition(2, "Active");
    await admin.query(
      "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
    );
    try {
      await admin.query(
        "GRANT USAGE ON SCHEMA bop_feature_control,platform_audit,platform_helpers TO " + role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON bop_feature_control.kill_switch_version,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "INSERT INTO bop_feature_control.kill_switch_version(brand_id,store_id,control_id,control_key,control_version,definition_json,recorded_at,audit_reference) VALUES($1,$2,$3,$4,1,$5::jsonb,$6,$7)",
        [id(2), id(3), id(9), key, JSON.stringify(current), at, id(20)],
      );
      const unitOfWork = createPostgresKillSwitchMutationStore(
        runner,
        { brandReference: id(2), storeReference: id(3) },
        { now: () => at },
      );
      const authorization = {
        async authorize(request) {
          return Object.freeze({
            effect: "Allow",
            action: request.action,
            scopeKind: request.resourceScope.kind,
            policySnapshotReference: id(70),
            policyVersion: 1,
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            audit: Object.freeze({
              effect: "Allow",
              reason: "ROLE_PERMISSION",
              source: "RolePermission",
            }),
          });
        },
      };
      const command = {
        tenantContext: tenant(),
        operation: "Activate",
        expectedVersion: 1,
        current,
        next,
        auditId: id(61),
        correlationId: id(62),
        sourceChannel: "MERCHANT_WEB",
      };
      const execute = (input = command) =>
        executeFeatureControlMutation(input, { authorization, unitOfWork });
      const counts = async () => ({
        versions: (
          await admin.query(
            "SELECT count(*)::int AS n FROM bop_feature_control.kill_switch_version",
          )
        ).rows[0].n,
        audit: (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE brand_id=$1",
            [id(2)],
          )
        ).rows[0].n,
      });
      failAudit = true;
      await assert.rejects(execute(), { code: "FEATURE_CONTROL_COMMIT_FAILED" });
      assert.deepEqual(await counts(), { versions: 1, audit: 0 });
      failAudit = false;
      loseAck = true;
      await assert.rejects(execute(), { code: "FEATURE_CONTROL_COMMIT_FAILED" });
      assert.deepEqual(await counts(), { versions: 2, audit: 1 });
      assert.equal((await execute()).control.version, 2);
      assert.deepEqual(await counts(), { versions: 2, audit: 1 });
      await assert.rejects(execute({ ...command, auditId: id(63) }), {
        code: "FEATURE_CONTROL_COMMIT_FAILED",
      });
      const update = {
        ...command,
        operation: "Change",
        current: next,
        expectedVersion: 2,
        next: createFeatureControlDefinition({ ...next, version: 3, ownerReference: id(7) }),
        auditId: id(64),
      };
      const competing = {
        ...update,
        next: createFeatureControlDefinition({ ...next, version: 3, ownerReference: id(8) }),
        auditId: id(65),
      };
      const results = await Promise.allSettled([execute(update), execute(competing)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.deepEqual(await counts(), { versions: 3, audit: 2 });
      // An exact historical successful operation remains recoverable after a later version.
      assert.equal((await execute()).control.version, 2);
      assert.deepEqual(await counts(), { versions: 3, audit: 2 });
      const read = createPostgresKillSwitchQueryStore(runner, {
        brandReference: id(2),
        storeReference: id(3),
      });
      assert.equal((await read.loadCurrent({ key, observedAt: at }))[0].version, 3);
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
});
