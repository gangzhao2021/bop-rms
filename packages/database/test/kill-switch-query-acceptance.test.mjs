import { verifyPaymentProviderAdmission } from "../../rms/payment/src/index.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPostgresKillSwitchQueryStore,
  createCurrentKillSwitchEvaluationService,
  createFeatureControlDefinition,
  evaluateFeatureControl,
} from "../../bop/feature-control/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-11T00:00:00.000Z",
  later = "2026-09-11T00:00:01.000Z",
  key = "payment.provider.admission";
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
it("reads actual append-only scoped Kill Switch versions without replaying stale inactive state", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_kill" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_kill_" + context.runId;
    const runner = {
      async run(action) {
        const c = new Client(context.clientConfig);
        await c.connect();
        try {
          await c.query("BEGIN READ ONLY");
          await c.query("SET LOCAL ROLE " + role);
          assert.equal(
            (
              await c.query(
                "SELECT count(*)::int AS n FROM bop_feature_control.kill_switch_version",
              )
            ).rows[0].n,
            0,
          );
          const result = await action({ query: (sql, values) => c.query(sql, values) });
          await c.query("COMMIT");
          assert.equal(
            (await c.query("SELECT nullif(current_setting('bop.brand_id',true),'') AS brand"))
              .rows[0].brand,
            null,
          );
          return result;
        } finally {
          await c.query("ROLLBACK");
          await c.end();
        }
      },
    };
    const insert = async (d, recorded = at) =>
      admin.query(
        "INSERT INTO bop_feature_control.kill_switch_version(brand_id,store_id,control_id,control_key,control_version,definition_json,recorded_at,audit_reference) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
        [
          d.scope.brandReference,
          d.scope.storeReference,
          d.controlId,
          d.key,
          d.version,
          JSON.stringify(d),
          recorded,
          id(20),
        ],
      );
    await admin.query(
      "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    try {
      await admin.query("GRANT USAGE ON SCHEMA bop_feature_control,platform_helpers TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query("GRANT SELECT ON bop_feature_control.kill_switch_version TO " + role);
      const store = createPostgresKillSwitchQueryStore(runner, {
        brandReference: id(2),
        storeReference: id(3),
      });
      assert.deepEqual(await store.loadCurrent({ key, observedAt: at }), []);
      await insert(definition(1, "Inactive"));
      assert.equal((await store.loadCurrent({ key, observedAt: at }))[0].state.phase, "Inactive");
      let revoked = false,
        lookups = 0,
        revokeAfterRead = false;
      const currentQuery = createCurrentKillSwitchEvaluationService(
        {
          clock: { now: () => at },
          context: {
            async resolveCurrent({ observedAt }) {
              if (revoked) return null;
              const t = tenant();
              return createTenantContext(t.actor, t.brand, t.store, observedAt);
            },
          },
          definitions: {
            async loadCurrent(input) {
              lookups++;
              const result = await store.loadCurrent(input);
              if (revokeAfterRead) revoked = true;
              return result;
            },
          },
        },
        { brandReference: id(2), storeReference: id(3) },
      );
      const expected = {
        action: "CreatePaymentIntent",
        brandReference: id(2),
        storeReference: id(3),
        evaluatedAt: at,
      };
      const evaluate = () => currentQuery.evaluate({ key, rolloutBucket: 0, evaluatedAt: at });
      assert.equal(
        verifyPaymentProviderAdmission(await evaluate(), expected).inFlightPolicy,
        "AllowToComplete",
      );
      revoked = true;
      const beforeDenied = lookups;
      await assert.rejects(evaluate(), { code: "FEATURE_CONTROL_EVALUATION_UNAVAILABLE" });
      assert.equal(lookups, beforeDenied);
      revoked = false;
      revokeAfterRead = true;
      await assert.rejects(evaluate(), { code: "FEATURE_CONTROL_EVALUATION_UNAVAILABLE" });
      revoked = false;
      revokeAfterRead = false;

      await assert.rejects(insert(definition(3, "Active")), /version sequence/);
      await insert(definition(2, "Active"));
      assert.equal(verifyPaymentProviderAdmission(await evaluate(), expected), null);
      let definitions = await store.loadCurrent({ key, observedAt: at });
      assert.equal(definitions.length, 1);
      assert.equal(definitions[0].version, 2);
      assert.equal(
        evaluateFeatureControl({
          tenantContext: tenant(),
          key,
          definitions,
          rolloutBucket: 0,
          evaluatedAt: at,
        }).backendExecution,
        "Deny",
      );
      await assert.rejects(
        admin.query("UPDATE bop_feature_control.kill_switch_version SET control_version=7"),
        /append-only/,
      );
      await admin.query("DELETE FROM bop_feature_control.kill_switch_version");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM bop_feature_control.kill_switch_version",
          )
        ).rows[0].n,
        2,
      );
      await assert.rejects(
        insert({ ...definition(3, "Active"), key: "ordering.other.safety" }),
        /version sequence/,
      );
      await insert(definition(3, "Recovering"), later);
      await assert.rejects(store.loadCurrent({ key, observedAt: at }), {
        code: "FEATURE_CONTROL_DEPENDENCY_UNAVAILABLE",
      });
      definitions = await store.loadCurrent({ key, observedAt: later });
      assert.equal(definitions[0].state.rolloutBasisPoints, 2500);
      for (const [rolloutBucket, expected] of [
        [0, "Allow"],
        [9999, "Deny"],
      ])
        assert.equal(
          evaluateFeatureControl({
            tenantContext: tenant(),
            key,
            definitions,
            rolloutBucket,
            evaluatedAt: later,
          }).backendExecution,
          expected,
        );
      await insert(definition(1, "Active", null));
      assert.equal((await store.loadCurrent({ key, observedAt: later })).length, 2);
      assert.equal(
        (
          await createPostgresKillSwitchQueryStore(runner, {
            brandReference: id(2),
            storeReference: id(99),
          }).loadCurrent({ key, observedAt: later })
        ).length,
        1,
      );
      assert.deepEqual(
        await createPostgresKillSwitchQueryStore(runner, {
          brandReference: id(99),
          storeReference: id(3),
        }).loadCurrent({ key, observedAt: later }),
        [],
      );
      await assert.rejects(
        insert({
          ...definition(4, "Active"),
          scope: { kind: "Store", brandReference: id(2), storeReference: id(99) },
        }),
        /version sequence/,
      );
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
});
