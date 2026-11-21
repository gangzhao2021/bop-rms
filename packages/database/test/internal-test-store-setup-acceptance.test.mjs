import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { recordStoreOpening } from "../../../apps/api/src/merchant-store-opening.ts";
import { createPostgresPublishedStoreOperatingStatusReader } from "../../rms/store/src/index.ts";
import {
  renderStoreSetupRoleSql,
  renewInternalTestStore,
  setUpInternalTestStore,
  storeSetupRoleName,
} from "../../../tooling/environment/pilot-internal-test-store-setup.mjs";
import {
  storeConfigurationContentHash,
  storeConfigurationSetupSnapshotReferences,
  storeConfigurationValidationCheckCodes,
} from "../../../tooling/environment/pilot-store-publication-codes.mjs";
import { prepareEntryOperatingPublication } from "../test-support/entry-operating-publication.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a2e-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const store2 = "01909a2e-1000-7000-8000-000000000010",
  store3 = "01909a2e-1000-7000-8000-000000000020";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION 3b (InternalTest only, a test-environment-only
 * shortcut): a TEST Store opened in the product gets its first published configuration (store 1's
 * hours in its own time zone) and its first synthetic launch gate, through the Publishing and Store
 * owners' writers as the setup role's exact grants, audited; the services' api role (rendered pilot
 * ACL) then reads its published operating status. It refuses a Store not labelled TEST, one already
 * set up, and a dry run writes nothing.
 */
it("InternalTest: a TEST Store opened in the product gets its first configuration and launch gate", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_store_setup" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_sts");
      const database = (await admin.query("SELECT current_database() db")).rows[0].db;
      // The installation names it after its database (`storeSetupRoleName`); per run here.
      const setupRole = "wp2423_sts_setup_" + context.runId;
      assert.match(
        storeSetupRoleName("bop_rms_pilot"),
        /^bop_rms_pilot_internal_test_store_setup$/u,
      );
      for (const sql of renderStoreSetupRoleSql(setupRole)) await admin.query(sql);
      const now = await dbNow(admin);
      const from = new Date(Date.parse(now) - 2 * 86_400_000).toISOString();
      const at = new Date(Date.parse(now) - 3600_000).toISOString();
      const binding = {
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        validFrom: from,
        validUntil: new Date(Date.parse(now) + 20 * 86_400_000).toISOString(),
      };
      await seedBrand(admin, {
        brandReference: binding.brandReference,
        policyReference: id(300),
        from,
      });
      await admin.query(
        "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'DEMO_01','DEMO Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [binding.storeReference, binding.brandReference, from],
      );
      await prepareEntryOperatingPublication({ admin, role: api, binding, at });
      const ownerRole = await seedBrandRole(admin, {
        id,
        brandReference: binding.brandReference,
        roleId: id(310),
        code: "brand_owner",
        actions: ["organization.manage"],
        from,
      });
      const owner = id(4);
      await seedBrandMember(admin, {
        id,
        base: 400,
        brandReference: binding.brandReference,
        storeReference: binding.storeReference,
        actorReference: owner,
        name: "Sam",
        roles: [ownerRole],
        from,
        enrolledAt: from,
      });
      // The Owner opens the TEST Store (and an unlabelled one) in the product, as the api role.
      const open = (operationReference, displayName, code) =>
        (async () => {
          await admin.query("BEGIN");
          try {
            await admin.query("SET LOCAL ROLE " + api);
            const tx = { query: (sql, values) => admin.query(sql, values ?? []) };
            await recordStoreOpening(tx, {
              command: {
                operationReference,
                code,
                displayName,
                timeZone: "America/Vancouver",
                locale: "en-CA",
              },
              brandReference: binding.brandReference,
              openedFromStoreReference: binding.storeReference,
              actorReference: owner,
              membershipReference: id(400),
              openedAt: now,
            });
            await admin.query("COMMIT");
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
        })();
      await open(store2, "DEMO Store 2 – not production", "DEMO_02");
      await open(store3, "Store Three", "STORE_3");

      let n = 5000;
      const setUp = (target, overrides = {}) =>
        setUpInternalTestStore(admin, {
          environment: "InternalTest",
          database,
          setupRole,
          readRole: api,
          binding,
          sourceStoreReference: binding.storeReference,
          targetStoreReference: target,
          approverActorReference: id(9),
          now: () => new Date().toISOString().replace(/\d{3}Z$/u, "000Z"),
          evidence: {
            setupReference: "01909a2e-2000-7000-8000-000000000001",
            approvedBy: "Owner",
            approval: "TEST store setup for the multi-store pilot",
            reason: "DEC-BRAND-MULTI-STORE-ONE-INSTALLATION 3b acceptance",
            operatorAccount: "acceptance",
          },
          nextReference: () => "01909a2e-3000-7000-8000-" + (++n).toString(16).padStart(12, "0"),
          ...overrides,
        });
      const count = async (store, table) => {
        await admin.query(
          "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
          [binding.brandReference, store],
        );
        return (
          await admin.query(`SELECT count(*)::int n FROM ${table} WHERE store_id=$1`, [store])
        ).rows[0].n;
      };
      // A dry run reads and checks everything, then writes nothing.
      assert.equal((await setUp(store2)).status, "DryRun");
      assert.equal(await count(store2, "rms_store.store_configuration_version"), 0);
      assert.equal(await count(store2, "bop_publishing.live_gate_version"), 0);
      // Never outside InternalTest.
      await assert.rejects(setUp(store2, { dryRun: false, environment: "Pilot" }), {
        reason: "internal-test-only",
      });
      // An unlabelled Store is refused.
      await assert.rejects(setUp(store3, { dryRun: false }), { reason: "store-not-labelled-test" });

      const result = await setUp(store2, { dryRun: false });
      assert.equal(result.status, "SetUp");
      assert.equal(await count(store2, "rms_store.store_configuration_version"), 1);
      const [gate] = (
        await admin.query(
          "SELECT gate_id,state,gate_version::int v FROM bop_publishing.live_gate_version WHERE store_id=$1",
          [store2],
        )
      ).rows;
      assert.deepEqual(gate, { gate_id: "SYNTHETIC-STORE-LIVE-GATE", state: "Approved", v: 1 });
      const [config] = (
        await admin.query(
          "SELECT time_zone,lifecycle,reason_code FROM rms_store.store_configuration_version WHERE store_id=$1",
          [store2],
        )
      ).rows;
      assert.deepEqual(config, {
        time_zone: "America/Vancouver",
        lifecycle: "Published",
        reason_code: "INTERNAL_TEST_STORE_SETUP",
      });
      const audits = (
        await admin.query(
          "SELECT action_code FROM platform_audit.audit_record WHERE store_id=$1 AND reason_code='INTERNAL_TEST_STORE_SETUP' ORDER BY action_code",
          [store2],
        )
      ).rows.map((row) => row.action_code);
      assert.deepEqual(audits, [
        "INTERNAL_TEST_LIVE_GATE_CREATED",
        "INTERNAL_TEST_STORE_CONFIGURATION_PUBLISHED",
        "PUBLISHING_DRAFT_CREATED",
        "PUBLISHING_RELEASE_PUBLISHED",
        "PUBLISHING_REVIEW_APPROVED",
        "PUBLISHING_REVIEW_SUBMITTED",
      ]);
      // The services' api role reads the new Store's operating status in a later transaction.
      await admin.query("RESET bop.brand_id");
      await admin.query("RESET bop.store_id");
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + api);
        const status = await createPostgresPublishedStoreOperatingStatusReader({
          tenantReference: binding.tenantReference,
          brandReference: binding.brandReference,
          storeReference: store2,
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
          requiredValidationCheckCodes: storeConfigurationValidationCheckCodes,
          setupSnapshotReferences: storeConfigurationSetupSnapshotReferences,
          authorize: async () => true,
          hashContent: storeConfigurationContentHash,
          timeZone: "America/Vancouver",
        })({ query: (sql, values) => admin.query(sql, [...values]) }, new Date().toISOString());
        assert.equal(status.businessDate.storeReference, store2);
      } finally {
        await admin.query("ROLLBACK");
      }
      // Set up once.
      await assert.rejects(setUp(store2, { dryRun: false }), { reason: "store-already-set-up" });

      // InternalTest renewal moves the TEST Store's launch gate with the installation's window.
      const to = new Date(Date.parse(binding.validUntil) + 5 * 86_400_000).toISOString();
      const renew = (overrides = {}) =>
        renewInternalTestStore(admin, {
          environment: "InternalTest",
          database,
          setupRole,
          readRole: api,
          binding: { ...binding, storeReference: store2 },
          from: binding.validUntil,
          to,
          now: () => new Date().toISOString().replace(/\d{3}Z$/u, "000Z"),
          evidence: {
            renewalReference: "01909a2e-2000-7000-8000-000000000002",
            approvedBy: "Owner",
            approval: "Renew the TEST store with the installation",
            reason: "acceptance",
            operatorAccount: "acceptance",
          },
          nextReference: () => "01909a2e-3000-7000-8000-" + (++n).toString(16).padStart(12, "0"),
          ...overrides,
        });
      assert.equal((await renew()).status, "DryRun");
      assert.equal((await renew({ dryRun: false })).status, "Renewed");
      const [renewedGate] = (
        await admin.query(
          "SELECT max(v.gate_version)::int v,(SELECT max(valid_until) FROM bop_publishing.live_gate_requirement q WHERE q.store_id=$1) until FROM bop_publishing.live_gate_version v WHERE v.store_id=$1",
          [store2],
        )
      ).rows;
      assert.deepEqual(
        { v: renewedGate.v, until: renewedGate.until.toISOString() },
        { v: 2, until: to },
      );
      assert.equal((await renew({ dryRun: false })).status, "AlreadyRenewed");
      // An unlabelled Store is never renewed this way.
      await assert.rejects(renew({ binding: { ...binding, storeReference: store3 } }), {
        reason: "store-not-labelled-test",
      });
    } finally {
      await admin.end();
    }
  });
});
