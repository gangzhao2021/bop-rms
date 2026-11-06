import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import {
  merchantOpeningReferences,
  recordMerchantFirstContent,
  recordMerchantOpening,
} from "../../../apps/api/dist/merchant-opening.js";
import { recordStoreOpening } from "../../../apps/api/src/merchant-store-opening.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { parseStoreSetupReferenceVersion } from "../../rms/store/src/contracts/store-setup-reference.ts";
import { createInternalPricingPolicy } from "../../../tooling/environment/pilot-pricing-policy.mjs";
import {
  proveInternalTestMerchant,
  renderStoreSetupRoleSql,
  renewInternalTestStore,
  setUpInternalTestStore,
} from "../../../tooling/environment/pilot-internal-test-store-setup.mjs";
import {
  createInternalTestStoreTax,
  renderStoreTaxRoleSql,
  renewInternalTestStoreTax,
} from "../../../tooling/environment/pilot-internal-test-store-tax.mjs";
import { prepareEntryOperatingPublication } from "../test-support/entry-operating-publication.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPilotApiRole, dbNow, seedBrand } from "../test-support/sole-operator-brand-gate.mjs";
import { seedTaxConfiguration } from "../test-support/tax-configuration-seed.mjs";

const { Client } = pg;
const DAY = 86_400_000;
// The installation's Brand and Store carry synthetic identities, as on v15.
const id = (n) => "01909a4e-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const ref = (n) => "01909a4e-1111-7aaa-8bbb-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 DEC-MULTI-MERCHANT-ONE-INSTALLATION, v15 2026-11-06: a TEST merchant opened from nothing
 * (its own Tenant, Brand and Store, "… – not production") has a synthetic launch gate and DEMO
 * tax evidence ending with the installation, and `pilot-internal-test-store-open.mjs renew`
 * refused it (the renewal guards required a synthetic Brand), so it would stop taking orders at the
 * installation's expiry. As the restricted setup and tax roles, with the proofs and read checks as
 * the services' role holding exactly the rendered pilot API grants:
 * 1. its gate and tax evidence renew (a dry run first, then once, append-only and audited, then
 *    AlreadyRenewed), only for a Store the files say is served;
 * 2. refused: a Store the files do not say is served, a merchant whose Brand is not labelled
 *    TEST, an Owner the opening did not place, a labelled lookalike never opened by the merchant
 *    opening, a Store opened from another Store on the Stores page, a Store not the merchant's.
 */
it("a TEST merchant's Store renews its launch gate and tax evidence with the installation", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_mrenew" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let n = 0x9000;
    const nextReference = () => ref(++n);
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_mrn");
      const database = context.databaseName;
      const setupRole = "wp2423_mrn_setup_" + context.runId,
        taxRole = "wp2423_mrn_tax_" + context.runId;
      for (const sql of renderStoreSetupRoleSql(setupRole)) await admin.query(sql);
      for (const sql of renderStoreTaxRoleSql(taxRole)) await admin.query(sql);
      const now = await dbNow(admin);
      const from = new Date(Date.parse(now) - 2 * DAY).toISOString();
      const old = new Date(Date.parse(now) + 20 * DAY).toISOString();
      const until = new Date(Date.parse(now) + 25 * DAY).toISOString();
      const binding = {
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        validFrom: from,
        validUntil: old,
      };
      // The installation's Store, its published configuration and synthetic DEMO tax.
      await seedBrand(admin, {
        brandReference: binding.brandReference,
        policyReference: id(300),
        from,
      });
      await admin.query(
        "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'DEMO_01','DEMO Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [binding.storeReference, binding.brandReference, from],
      );
      await prepareEntryOperatingPublication({
        admin,
        role: api,
        binding,
        at: new Date(Date.parse(now) - 3600_000).toISOString(),
      });
      const profile = {
        environment: "InternalTest",
        database,
        createdAt: from,
        binding,
      };
      const menu = {
        environment: "InternalTest",
        database,
        skuReference: id(0x0d),
        taxClassificationReference: id(0x100),
      };
      const policyOf = (candidate, candidateMenu = menu) =>
        createInternalPricingPolicy({
          loadProfile: async () => candidate,
          loadMenu: async () => candidateMenu,
          expectedDatabaseName: database,
        });
      await seedTaxConfiguration(admin, (await policyOf(profile)).taxConfiguration, id(4));

      // Two merchants opened from nothing, as `store-open merchant` does (the services' role).
      const open = async (operationReference, brandName, storeName, code) => {
        const command = {
          operationReference,
          ownerActorReference: ref(0x10 + code.length),
          brandCode: code,
          brandName,
          storeCode: "MAIN",
          storeName,
          timeZone: "America/Toronto",
          locale: "en-CA",
        };
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + api);
          const at = new Date().toISOString();
          await recordMerchantOpening(admin, {
            command,
            openedByActorReference: ref(0x20),
            sourceChannel: "DEPLOYMENT",
            openedAt: at,
          });
          await recordMerchantFirstContent(admin, { command, openedAt: at });
          await admin.query("COMMIT");
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
        return {
          ...merchantOpeningReferences(operationReference),
          owner: command.ownerActorReference,
        };
      };
      const tea = await open(
        ref(0x30),
        "Half Sugar Tea TEST - not production",
        "Half Sugar Tea TEST Main - not production",
        "TEAT",
      );
      const gold = await open(
        ref(0x31),
        "Golden Dragon",
        "Golden Dragon Main - not production",
        "GOLD",
      );
      const merchantBinding = (m) => ({
        tenantReference: m.tenantReference,
        brandReference: m.brandReference,
        storeReference: m.storeReference,
        validFrom: from,
        validUntil: old,
      });
      // Its address, as staff save it in Store setup (the Store owner's own tables).
      const setAddress = async (m, k) => {
        const at = new Date().toISOString().replace(/\d{3}Z$/u, "000Z");
        const value = parseStoreSetupReferenceVersion({
          profile: "StoreSetupReferenceVersionV1",
          kind: "Address",
          reference: ref(0x500 + k),
          tenantReference: m.tenantReference,
          brandReference: m.brandReference,
          storeReference: m.storeReference,
          revision: 1,
          authoredByReference: ref(0x14),
          previousReference: null,
          content: {
            countryCode: "CA",
            regionCode: "ON",
            locality: "Synthetic locality",
            postalCode: "A1A 1A1",
            addressLines: ["1 Synthetic Way"],
          },
          createdAt: at,
          updatedAt: at,
          dataClassification: "Internal",
        });
        const digest = "sha256:" + sha256Hex(canonicalizeRfc8785(value));
        await admin.query("BEGIN");
        try {
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [m.tenantReference, m.brandReference, m.storeReference],
          );
          await admin.query(
            "INSERT INTO rms_store.store_setup_reference_version(tenant_id,brand_id,store_id,reference_kind,reference_id,revision,operation_id,actor_id,previous_reference_id,snapshot_json,snapshot_digest,created_at,updated_at,data_classification) VALUES($1,$2,$3,'Address',$4,1,$5,$6,NULL,$7::jsonb,$8,$9,$9,'Internal')",
            [
              m.tenantReference,
              m.brandReference,
              m.storeReference,
              value.reference,
              ref(0x600 + k),
              ref(0x14),
              JSON.stringify(value),
              digest,
              at,
            ],
          );
          await admin.query(
            "INSERT INTO rms_store.store_setup_reference_operation(operation_id,tenant_id,brand_id,store_id,reference_kind,actor_id,intent_digest,expected_reference_id,expected_revision,outcome,result_reference_id,result_revision,snapshot_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,'Address',$5,$6,NULL,0,'Committed',$7,1,$8,$9,$10,'Internal')",
            [
              ref(0x600 + k),
              m.tenantReference,
              m.brandReference,
              m.storeReference,
              ref(0x14),
              "sha256:" + "a".repeat(64),
              value.reference,
              digest,
              ref(0x700 + k),
              at,
            ],
          );
          await admin.query("COMMIT");
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const evidence = (key) => ({
        [key]: nextReference(),
        approvedBy: "Owner",
        approval: "TEST ONLY: renew the TEST merchants with the installation",
        reason: "acceptance",
        operatorAccount: "acceptance",
      });
      // Each merchant's first configuration, launch gate and own synthetic tax (store-open setup/tax).
      const prepared = {};
      for (const [k, m] of [
        [1, tea],
        [2, gold],
      ]) {
        const set = await setUpInternalTestStore(admin, {
          environment: "InternalTest",
          database,
          setupRole,
          readRole: api,
          binding,
          merchant: { tenantReference: m.tenantReference, brandReference: m.brandReference },
          sourceStoreReference: binding.storeReference,
          targetStoreReference: m.storeReference,
          approverActorReference: ref(0x20),
          now: () => new Date().toISOString().replace(/\d{3}Z$/u, "000Z"),
          evidence: evidence("setupReference"),
          dryRun: false,
          nextReference,
        });
        assert.equal(set.status, "SetUp");
        await setAddress(m, k);
        const storeMenu = { ...menu, taxClassificationReference: m.taxClassificationReference };
        const created = await createInternalTestStoreTax(admin, {
          environment: "InternalTest",
          database,
          role: taxRole,
          readRole: api,
          installationProfile: profile,
          installationMenu: menu,
          storeProfile: { ...profile, binding: merchantBinding(m) },
          menu: storeMenu,
          approverActorReference: ref(0x20),
          now: () => new Date().toISOString(),
          evidence: evidence("operationReference"),
          nextReference,
        });
        assert.equal(created.status, "Created");
        prepared[m.storeReference] = { profile: created.profile, menu: storeMenu };
      }

      const renewStore = (m, extra = {}) =>
        renewInternalTestStore(admin, {
          environment: "InternalTest",
          database,
          setupRole,
          readRole: api,
          binding: merchantBinding(m),
          from: old,
          to: until,
          now: () => new Date().toISOString().replace(/\d{3}Z$/u, "000Z"),
          evidence: evidence("renewalReference"),
          dryRun: true,
          nextReference,
          servedTestMerchant: true,
          ownerActorReference: m.owner,
          ...extra,
        });
      const renewTax = (m, extra = {}) =>
        renewInternalTestStoreTax(admin, {
          database,
          role: taxRole,
          readRole: api,
          ...prepared[m.storeReference],
          from: old,
          to: until,
          now: () => new Date().toISOString(),
          evidence: evidence("renewalReference"),
          dryRun: true,
          nextReference,
          servedTestMerchant: true,
          ownerActorReference: m.owner,
          ...extra,
        });
      const facts = async (m) => {
        await admin.query(
          "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
          [m.brandReference, m.storeReference],
        );
        const one = async (sql) => (await admin.query(sql, [m.storeReference])).rows[0];
        const gate = await one(
          "SELECT max(gate_version)::int v,(SELECT max(valid_until) FROM bop_publishing.live_gate_requirement WHERE store_id=$1) until FROM bop_publishing.live_gate_version WHERE store_id=$1",
        );
        const tax = await one(
          "SELECT v.version_number::int n,v.registration_evidence_valid_until r,v.professional_evidence_valid_until p FROM rms_pricing.tax_configuration t JOIN rms_pricing.tax_configuration_version v ON v.tax_configuration_version_id=t.current_version_id WHERE t.store_id=$1",
        );
        const audits = await one(
          "SELECT count(*)::int n FROM platform_audit.audit_record WHERE store_id=$1 AND action_code='INTERNAL_TEST_VALIDITY_EXTENDED'",
        );
        await admin.query("RESET bop.brand_id");
        await admin.query("RESET bop.store_id");
        return {
          gate: [gate.v, gate.until.toISOString()],
          tax: [tax.n, tax.r.toISOString(), tax.p.toISOString()],
          audits: audits.n,
        };
      };
      const before = await facts(tea);
      assert.deepEqual(before, { gate: [1, old], tax: [1, old, old], audits: 0 });

      // Only a Store the files say is served is renewed this way.
      await assert.rejects(renewStore(tea, { servedTestMerchant: false }), {
        reason: "merchant-not-served",
      });
      await assert.rejects(renewTax(tea, { servedTestMerchant: false }), {
        reason: "merchant-not-served",
      });
      // A merchant whose Brand is not labelled TEST is never renewed, gate or tax.
      await assert.rejects(renewStore(gold), { reason: "merchant-not-labelled-test" });
      await assert.rejects(renewTax(gold), { reason: "merchant-not-labelled-test" });
      // The proof itself: the installation's Store named under a TEST merchant's Brand is not that merchant's.
      await admin.query("BEGIN");
      try {
        await assert.rejects(
          proveInternalTestMerchant(admin, {
            readRole: api,
            brandReference: tea.brandReference,
            storeReference: binding.storeReference,
            ownerActorReference: tea.owner,
          }),
          { reason: "merchant-not-labelled-test" },
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      // Someone the opening did not place there (another staff file entry) is not its Owner.
      await assert.rejects(renewStore(tea, { ownerActorReference: ref(0x99) }), {
        reason: "merchant-owner-not-placed-by-opening",
      });
      await assert.rejects(renewTax(tea, { ownerActorReference: ref(0x99) }), {
        reason: "merchant-owner-not-placed-by-opening",
      });
      // Labelled but not opened by the TEST tooling: a lookalike written without the merchant
      // opening (no opening audit pair), and a Store the Owner opened from another Store on the
      // Stores page (the product's own opening, not the merchant opening).
      const fake = {
        tenantReference: ref(0x40),
        brandReference: ref(0x41),
        storeReference: ref(0x42),
        owner: tea.owner,
      };
      await admin.query(
        "INSERT INTO bop_tenant.brand(brand_id,code,display_name,default_locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,'FAKE','Lookalike TEST - not production','en-CA','CAD','Active',1,$2,$2)",
        [fake.brandReference, from],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store(store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'MAIN','Lookalike TEST Main - not production','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [fake.storeReference, fake.brandReference, from],
      );
      await admin.query(
        "INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,NULL,1,$5,$5)",
        [ref(0x43), fake.owner, fake.brandReference, ref(0x44), from],
      );
      await admin.query(
        "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,NULL,1,$6,$6)",
        [ref(0x45), ref(0x43), fake.owner, fake.brandReference, fake.storeReference, from],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store_opening(opening_id,brand_id,store_id,opened_from_store_id,actor_id,membership_id,store_assignment_id,code,display_name,time_zone,locale,intent_digest,audit_id,opened_at) VALUES ($1,$2,$1,NULL,$3,$4,$5,'MAIN','Lookalike TEST Main - not production','America/Toronto','en-CA',$6,$7,$8)",
        [
          fake.storeReference,
          fake.brandReference,
          fake.owner,
          ref(0x43),
          ref(0x45),
          "sha256:" + "b".repeat(64),
          ref(0x46),
          from,
        ],
      );
      await assert.rejects(renewStore(fake), { reason: "merchant-not-opened-by-test-tooling" });
      const second = {
        ...tea,
        storeReference: ref(0x50),
      };
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + api);
        await admin.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [tea.brandReference, tea.storeReference],
        );
        await recordStoreOpening(
          { query: (sql, values) => admin.query(sql, values === undefined ? [] : [...values]) },
          {
            command: {
              operationReference: second.storeReference,
              code: "SECOND",
              displayName: "Half Sugar Tea TEST Second - not production",
              timeZone: "America/Toronto",
              locale: "en-CA",
            },
            brandReference: tea.brandReference,
            openedFromStoreReference: tea.storeReference,
            actorReference: tea.owner,
            membershipReference: tea.membershipReference,
            openedAt: new Date().toISOString(),
          },
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      await admin.query("BEGIN");
      try {
        await assert.rejects(
          proveInternalTestMerchant(admin, {
            readRole: api,
            brandReference: second.brandReference,
            storeReference: second.storeReference,
            ownerActorReference: tea.owner,
          }),
          { reason: "merchant-not-opened-by-test-tooling" },
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      assert.deepEqual(await facts(tea), before);

      // Dry runs show the renewal and keep nothing.
      assert.equal((await renewStore(tea)).status, "DryRun");
      assert.equal((await renewTax(tea)).status, "DryRun");
      assert.deepEqual(await facts(tea), before);

      // The renewal: a new gate version and a new tax version, each audited; then nothing more.
      const store = await renewStore(tea, { dryRun: false });
      assert.deepEqual([store.status, store.testMerchant], ["Renewed", true]);
      const tax = await renewTax(tea, { dryRun: false });
      assert.equal(tax.status, "Renewed");
      assert.equal(tax.taxConfigurationVersion.versionNumber, 2);
      assert.deepEqual(await facts(tea), {
        gate: [2, until],
        tax: [2, until, until],
        audits: 2,
      });
      assert.equal((await renewStore(tea, { dryRun: false })).status, "AlreadyRenewed");
      assert.equal(
        (
          await renewTax(tea, {
            dryRun: false,
            profile: {
              ...prepared[tea.storeReference].profile,
              taxConfigurationVersion: tax.taxConfigurationVersion,
            },
          })
        ).status,
        "AlreadyRenewed",
      );
      // The unlabelled merchant is exactly as it was.
      assert.deepEqual(await facts(gold), { gate: [1, old], tax: [1, old, old], audits: 0 });
    } finally {
      await admin.end();
      vi.unstubAllEnvs();
    }
  });
});
