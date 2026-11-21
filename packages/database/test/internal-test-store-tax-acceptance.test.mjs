import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { recordStoreOpening } from "../../../apps/api/src/merchant-store-opening.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { brandRoleTemplateActions } from "../../bop/permission/src/index.ts";
import {
  calculateTax,
  createPostgresCurrentTaxConfigurationStore,
  currentStoreTaxConfigurationReference,
  resolveTaxConfiguration,
} from "../../rms/pricing/src/index.ts";
import { parseStoreSetupReferenceVersion } from "../../rms/store/src/contracts/store-setup-reference.ts";
import { createInternalPricingPolicy } from "../../../tooling/environment/pilot-pricing-policy.mjs";
import {
  createInternalTestStoreTax,
  renderStoreTaxRoleSql,
  renewInternalTestStoreTax,
} from "../../../tooling/environment/pilot-internal-test-store-tax.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";
import { seedTaxConfiguration } from "../test-support/tax-configuration-seed.mjs";

const { Client } = pg;
// The installation's Brand and Store carry synthetic identities, as on v15.
const synthetic = (n) => "0190fa31-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const id = (n) => "01909a3d-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const DAY = 86_400_000;

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION, coordinator 2026-10-31: a TEST Store opened in
 * the product had no tax configuration and nothing could give it one ("No tax configuration in
 * effect … no order can be priced"). As the restricted tax role, with the read checks as the
 * services' role holding exactly the rendered pilot API grants:
 * 1. a Store opened on the Stores page, its Ontario address set in Store setup, gets its own
 *    Store-scoped synthetic configuration — store 1's rules, rates and tax class — audited under
 *    the approver; Store setup's tax settings then name it, and the services' quote reads it and
 *    taxes a $10.00 Pickup and Dine-in line at $1.30; store 1's configuration is unchanged;
 * 2. a rerun answers AlreadyPresent, writes nothing and names the same creation instant;
 * 3. the Store's `renew` moves its evidence with the installation's window, once;
 * 4. refused: the installation's own Store, a Store not opened in the product, one not labelled
 *    TEST, one without an address, one in another province.
 */
it("a TEST Store gets its own synthetic tax configuration, quoted by the services", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_store_tax" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = synthetic(1),
      brandReference = synthetic(2),
      storeOne = synthetic(3),
      owner = id(4),
      approver = id(5);
    let next = 0x9000;
    const nextReference = () =>
      "01909a3d-1000-7000-8000-" + (next++).toString(16).padStart(12, "0");
    try {
      const apiRole = await createPilotApiRole(admin, context, "wp2423_stx");
      const role = "wp2423_store_tax_" + context.runId;
      for (const sql of renderStoreTaxRoleSql(role)) await admin.query(sql);
      const now = Date.now();
      const iso = (ms) => new Date(Math.floor(ms)).toISOString();
      const from = iso(now - 3 * DAY),
        old = iso(now + 2 * DAY),
        until = iso(now + 25 * DAY);
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      await admin.query(
        "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'DEMO_01','DEMO Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [storeOne, brandReference, from],
      );
      const ownerRole = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(310),
        code: "brand_owner",
        actions: brandRoleTemplateActions("brand-owner"),
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 400,
        brandReference,
        storeReference: storeOne,
        actorReference: owner,
        name: "Sam",
        roles: [ownerRole],
        from,
        enrolledAt: from,
      });
      // Stores opened in the product, as the Brand Owner does on the Stores page.
      const open = async (operation, code, displayName) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + apiRole);
          await admin.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brandReference, storeOne],
          );
          await recordStoreOpening(
            { query: (sql, values) => admin.query(sql, values === undefined ? [] : [...values]) },
            {
              command: {
                operationReference: operation,
                code,
                displayName,
                timeZone: "America/Toronto",
                locale: "en-CA",
              },
              brandReference,
              openedFromStoreReference: storeOne,
              actorReference: owner,
              membershipReference: id(400),
              openedAt: new Date().toISOString(),
            },
          );
          await admin.query("COMMIT");
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const storeTwo = "01909a3d-2000-7000-8000-000000000002",
        storeThree = "01909a3d-2000-7000-8000-000000000003",
        storeFour = "01909a3d-2000-7000-8000-000000000004";
      await open(storeTwo, "DEMO_02", "DEMO Store 2 – not production");
      await open(storeThree, "DEMO_03", "DEMO Store 3 – not production");
      await open(storeFour, "DEMO_04", "DEMO Store 4");
      // The address staff save in Store setup (owner fixture, the Store owner's own tables).
      let address = 0;
      const setAddress = async (store, regionCode) => {
        address += 1;
        const at = new Date().toISOString().replace(/\d{3}Z$/u, "000Z");
        const value = parseStoreSetupReferenceVersion({
          profile: "StoreSetupReferenceVersionV1",
          kind: "Address",
          reference: id(0x500 + address),
          tenantReference,
          brandReference,
          storeReference: store,
          revision: 1,
          authoredByReference: owner,
          previousReference: null,
          content: {
            countryCode: "CA",
            regionCode,
            locality: "Synthetic locality",
            postalCode: "A1A 1A1",
            addressLines: ["1 Synthetic Way"],
          },
          createdAt: at,
          updatedAt: at,
          dataClassification: "Internal",
        });
        const digest = "sha256:" + sha256Hex(canonicalizeRfc8785(value));
        await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        try {
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenantReference, brandReference, store],
          );
          await admin.query(
            "INSERT INTO rms_store.store_setup_reference_version(tenant_id,brand_id,store_id,reference_kind,reference_id,revision,operation_id,actor_id,previous_reference_id,snapshot_json,snapshot_digest,created_at,updated_at,data_classification) VALUES($1,$2,$3,'Address',$4,1,$5,$6,NULL,$7::jsonb,$8,$9,$9,'Internal')",
            [
              tenantReference,
              brandReference,
              store,
              value.reference,
              id(0x600 + address),
              owner,
              JSON.stringify(value),
              digest,
              at,
            ],
          );
          await admin.query(
            "INSERT INTO rms_store.store_setup_reference_operation(operation_id,tenant_id,brand_id,store_id,reference_kind,actor_id,intent_digest,expected_reference_id,expected_revision,outcome,result_reference_id,result_revision,snapshot_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,'Address',$5,$6,NULL,0,'Committed',$7,1,$8,$9,$10,'Internal')",
            [
              id(0x600 + address),
              tenantReference,
              brandReference,
              store,
              owner,
              "sha256:" + "a".repeat(64),
              value.reference,
              digest,
              id(0x700 + address),
              at,
            ],
          );
          await admin.query("COMMIT");
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      await setAddress(storeTwo, "ON");
      await setAddress(storeFour, "ON");

      // The installation's files and store 1's synthetic DEMO configuration.
      const profile = {
        environment: "InternalTest",
        database: context.databaseName,
        createdAt: from,
        binding: {
          tenantReference,
          brandReference,
          storeReference: storeOne,
          validFrom: from,
          validUntil: old,
        },
      };
      const menu = {
        environment: "InternalTest",
        database: context.databaseName,
        skuReference: synthetic(0x0d),
        taxClassificationReference: synthetic(0x100),
      };
      const policyOf = (candidate) =>
        createInternalPricingPolicy({
          loadProfile: async () => candidate,
          loadMenu: async () => menu,
          expectedDatabaseName: context.databaseName,
        });
      const storeOnePolicy = await policyOf(profile);
      await seedTaxConfiguration(admin, storeOnePolicy.taxConfiguration, owner);
      // A served Store's profile as `directory` writes it (the Store's own reference).
      const served = (store) => ({
        ...profile,
        binding: { ...profile.binding, storeReference: store },
      });
      const run = (storeProfile, approval = "Owner approves the TEST tax configuration") =>
        createInternalTestStoreTax(admin, {
          environment: "InternalTest",
          database: context.databaseName,
          role,
          readRole: apiRole,
          installationProfile: profile,
          installationMenu: menu,
          storeProfile,
          menu,
          approverActorReference: approver,
          now: () => new Date().toISOString(),
          evidence: {
            operationReference: nextReference(),
            approvedBy: "Owner",
            approval,
            reason: "Multi-store live check",
          },
          nextReference,
        });
      const owned = async (store, sql, values) => {
        await admin.query(
          "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false),set_config('bop.store_id',$3,false)",
          [tenantReference, brandReference, store],
        );
        return (await admin.query(sql, values)).rows;
      };
      const taxRows = (store) =>
        owned(
          store,
          `SELECT b.tax_configuration_id::text root,b.aggregate_version,b.current_version_id::text head,
             (SELECT jsonb_agg(v.tax_configuration_version_id::text ORDER BY v.version_number) FROM rms_pricing.tax_configuration_version v WHERE v.tax_configuration_id=b.tax_configuration_id) versions,
             (SELECT jsonb_agg(jsonb_build_array(r.tax_configuration_rule_id::text,r.order_type,trim_scale(r.tax_rate)::text) ORDER BY 1) FROM rms_pricing.tax_configuration_rule r WHERE r.tax_configuration_id=b.tax_configuration_id) rules
           FROM rms_pricing.tax_configuration b WHERE b.store_id=$1 ORDER BY 1`,
          [store],
        );
      const storeOneBefore = await taxRows(storeOne);
      // As the services' role, in the Store's scope.
      const asServices = async (store, work) => {
        await admin.query("RESET ROLE");
        await admin.query("BEGIN READ ONLY");
        try {
          await admin.query("SET LOCAL ROLE " + apiRole);
          return await work({ query: (sql, values = []) => admin.query(sql, [...values]) }, store);
        } finally {
          await admin.query("ROLLBACK");
        }
      };
      const quoted = (policy, store) =>
        asServices(store, async (tx) => {
          const at = new Date().toISOString();
          const governing = await currentStoreTaxConfigurationReference(
            tx,
            { brandReference, storeReference: store },
            at,
          );
          const snapshot = await createPostgresCurrentTaxConfigurationStore(
            { run: (work) => work(tx) },
            { brandReference, storeReference: store },
            policy.currencyMetadata,
            {
              load: async () => ({
                registrationEvidence: policy.taxConfiguration.registrationEvidence,
                professionalEvidence: policy.taxConfiguration.professionalEvidence,
              }),
            },
          ).load({
            configurationReference: policy.taxConfiguration.configurationReference,
            observedAt: at,
          });
          assert.ok(snapshot, "the services read the Store's tax configuration");
          const taxes = ["Pickup", "DineIn"].map((orderType) => {
            const [rule] = resolveTaxConfiguration(snapshot, {
              brandReference,
              storeReference: store,
              jurisdictionCode: "CA-ON",
              currencyCode: "CAD",
              taxClassificationReference: menu.taxClassificationReference,
              orderType,
              chargeType: "Sellable",
              evaluatedAt: at,
            }).rules;
            const result = calculateTax({
              calculationReference: nextReference(),
              taxableReference: nextReference(),
              inputAmount: { amountMinor: 1000n, currencyCode: "CAD" },
              currencyMetadata: policy.currencyMetadata,
              resolvedRule: rule.resolvedRule,
            });
            return [orderType, result.taxAmount.amountMinor, result.grossAmount.amountMinor];
          });
          return { governing: governing?.configurationReference ?? null, taxes };
        });

      // Before: the services find no tax configuration governing store 2 (v15: "No tax
      // configuration in effect … no order can be priced").
      assert.equal(
        await asServices(storeTwo, async (tx) =>
          currentStoreTaxConfigurationReference(
            tx,
            { brandReference, storeReference: storeTwo },
            new Date().toISOString(),
          ),
        ),
        null,
      );
      // 4. Refusals first: nothing is written for any of them.
      await assert.rejects(run(profile), { reason: "input-invalid" });
      await assert.rejects(run(served(id(99))), { reason: "store-not-opened-in-product" });
      await assert.rejects(run(served(storeFour)), { reason: "store-not-labelled-test" });
      await assert.rejects(run(served(storeThree)), {
        reason: "store-address-not-set-in-store-setup",
      });
      await setAddress(storeThree, "QC");
      await assert.rejects(run(served(storeThree)), { reason: "store-province-differs" });
      for (const store of [storeTwo, storeThree, storeFour])
        assert.deepEqual(await taxRows(store), []);

      // 1. Created for store 2, audited under the approver; the services quote with it.
      const created = await run(served(storeTwo));
      assert.equal(created.status, "Created");
      assert.equal(created.versionNumber, 1);
      assert.deepEqual(created.profile.storeTaxConfiguration, { createdAt: created.createdAt });
      const storeTwoPolicy = await policyOf(created.profile);
      assert.equal(
        created.configurationReference,
        storeTwoPolicy.taxConfiguration.configurationReference,
      );
      assert.notEqual(
        created.configurationReference,
        storeOnePolicy.taxConfiguration.configurationReference,
      );
      assert.match(created.configurationReference, /^[0-9a-f]{8}-0000-7000-8000-/u);
      assert.deepEqual(await quoted(storeTwoPolicy, storeTwo), {
        governing: created.configurationReference,
        taxes: [
          ["Pickup", 130n, 1130n],
          ["DineIn", 130n, 1130n],
        ],
      });
      // Store 1 keeps its own configuration, unchanged, and still quotes with it.
      assert.deepEqual(await taxRows(storeOne), storeOneBefore);
      assert.equal(
        (await quoted(storeOnePolicy, storeOne)).governing,
        storeOnePolicy.taxConfiguration.configurationReference,
      );
      assert.deepEqual(
        await owned(
          storeTwo,
          "SELECT action_code,actor_reference::text actor,after_summary_json->>'approval' approval,after_summary_json->>'synthetic' synthetic FROM platform_audit.audit_record WHERE store_id=$1 AND action_code='INTERNAL_TEST_STORE_TAX_CREATED'",
          [storeTwo],
        ),
        [
          {
            action_code: "INTERNAL_TEST_STORE_TAX_CREATED",
            actor: approver,
            approval: "Owner approves the TEST tax configuration",
            synthetic: "true",
          },
        ],
      );

      // 2. Again: the same configuration, nothing written, the same creation instant.
      const count = async () =>
        (
          await owned(
            storeTwo,
            `SELECT (SELECT count(*)::int FROM rms_pricing.tax_configuration_version WHERE store_id=$1) versions,
                    (SELECT count(*)::int FROM platform_audit.audit_record WHERE store_id=$1) audits`,
            [storeTwo],
          )
        )[0];
      const before = await count();
      const again = await run(created.profile, "asked again");
      assert.equal(again.status, "AlreadyPresent");
      assert.equal(again.createdAt, created.createdAt);
      assert.equal(again.profile, created.profile);
      assert.deepEqual(await count(), before);
      // A lost profile write is repaired from the database: the same instant.
      assert.deepEqual((await run(served(storeTwo))).profile, created.profile);

      // 3. The Store's renewal moves its evidence with the installation's window, once.
      const renew = (candidate, dryRun = false) =>
        renewInternalTestStoreTax(admin, {
          database: context.databaseName,
          role,
          readRole: apiRole,
          profile: candidate,
          menu,
          from: old,
          to: until,
          now: () => new Date().toISOString(),
          evidence: {
            renewalReference: nextReference(),
            approvedBy: "Owner",
            approval: "Owner approves the renewal",
            reason: "Renewal",
            operatorAccount: "uid:test",
          },
          dryRun,
          nextReference,
        });
      await admin.query("RESET ROLE");
      assert.equal((await renew(profile)).status, "None");
      const renewed = await renew(created.profile);
      assert.equal(renewed.status, "Renewed");
      assert.equal(renewed.taxConfigurationVersion.versionNumber, 2);
      const renewedProfile = {
        ...created.profile,
        binding: { ...created.profile.binding, validUntil: until },
        taxConfigurationVersion: renewed.taxConfigurationVersion,
      };
      const renewedPolicy = await policyOf(renewedProfile);
      assert.equal(renewedPolicy.taxConfiguration.registrationEvidence.validUntil, until);
      assert.deepEqual((await quoted(renewedPolicy, storeTwo)).taxes, [
        ["Pickup", 130n, 1130n],
        ["DineIn", 130n, 1130n],
      ]);
      assert.equal((await renew(renewedProfile)).status, "AlreadyRenewed");
      assert.deepEqual(await taxRows(storeOne), storeOneBefore);
    } finally {
      await admin.end();
    }
  });
}, 240_000);
