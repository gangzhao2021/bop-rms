import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { it } from "vitest";
import { recordStoreOpening } from "../../../apps/api/src/merchant-store-opening.ts";
import { brandRoleTemplateActions } from "../../bop/permission/src/index.ts";
import {
  changeKitchenNotPreparedProduct,
  changeKitchenProductSection,
  changeKitchenSections,
  createPostgresKitchenRoutingConfigurationStore,
  loadKitchenNotPreparedProducts,
  loadKitchenProductSections,
  loadKitchenSections,
  rebindKitchenRoutingEvidence,
} from "../../rms/kitchen/src/index.ts";
import {
  createInternalTestKitchenRouting,
  readStoreKitchenRouting,
  readStoreKitchenSetup,
  renderKitchenRoutingRoleSql,
} from "../../../tooling/environment/pilot-internal-test-kitchen-routing.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a3f-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

/**
 * v15 2026-11-01 (coordinator): paid orders at store 2 never reached the kitchen. The kitchen's
 * confirmed-order consumer found no kitchen routing for the Store (the installation's Store got
 * its own at installation; nothing records one for a Store opened in the product), retried, and
 * would be dead-lettered. As the restricted kitchen role, with the read as the services' role
 * (the rendered pilot API grants):
 * 1. before: the kitchen's own routing read for store 2 finds nothing — the v15 failure;
 * 2. `kitchen` gives the TEST Store its own routing: the installation Store's stations and rules
 *    (selector, capabilities) under the Store's own identities, audited by the Kitchen owner and
 *    under the approver with the approval wording; the services' read now routes store 2's items
 *    to store 2's own station; store 1's routing is unchanged;
 * 3. again: the same routing, nothing written;
 * 4. refused: the installation's own Store, a Store not opened in the product, one not TEST.
 *
 * v15 2026-11-01 (coordinator, second round): with the routing in place, store 2's paid order
 * still failed: it was confirmed (01:54Z) before the routing took effect (02:28Z), and the kitchen
 * routes an order by the routing in effect at its confirmation (a routing is never back-dated:
 * effective_from >= recorded_at). So: an order confirmed before the command still finds no
 * routing; one confirmed after finds store 2's. And the command also copies store 1's kitchen
 * sections (store 2's own section identities), each dish's section and the dishes the kitchen does
 * not prepare, read back as the services' role; store 1's setup is unchanged.
 */
it("a TEST Store gets its own kitchen routing, read by the kitchen as the services' role", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_kitchen_route" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      storeOne = id(3),
      owner = id(4),
      approver = id(5);
    const binding = { tenantReference, brandReference, storeReference: storeOne };
    let next = 0x9000;
    const nextReference = () =>
      "01909a3f-1000-7000-8000-" + (next++).toString(16).padStart(12, "0");
    try {
      const apiRole = await createPilotApiRole(admin, context, "wp2423_ktr");
      const role = "wp2423_kitchen_" + context.runId;
      for (const sql of renderKitchenRoutingRoleSql(role)) await admin.query(sql);
      const from = new Date(Date.parse(await dbNow(admin)) - 3 * 3600_000).toISOString();
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
      // Store 1's routing as the installer recorded it (owner fixture, the Kitchen owner's store).
      const installedAt = from;
      await admin.query("BEGIN");
      try {
        await admin.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brandReference, storeOne],
        );
        await createPostgresKitchenRoutingConfigurationStore({
          brandReference,
          storeReference: storeOne,
          sha256,
          authorizeRead: async () => true,
          authorizeWrite: async () => true,
          validateConfiguration: async () => true,
          audit: async (record) => ({
            auditId: id(900),
            brandId: brandReference,
            storeId: storeOne,
            actor: { type: "User", reference: record.actorReference },
            actionCode: "KITCHEN_ROUTING_CONFIGURATION_RECORDED",
            targetType: "KitchenRoutingConfiguration",
            targetId: record.configuration.evidenceReference,
            correlationId: record.operationReference,
            reasonCode: record.reasonCode,
            occurredAt: record.recordedAt,
            sourceChannel: "DEPLOYMENT",
            afterSummary: { version: record.configuration.evidenceVersion },
            dataClassification: "Restricted",
            retentionPolicyCode: "KITCHEN_BUSINESS_RECORD",
            retentionPolicyVersion: 1,
          }),
        }).commit({
          transaction: { query: (sql, values) => admin.query(sql, values) },
          record: {
            operationReference: id(901),
            actorReference: owner,
            purposeCode: "SyntheticConfiguration",
            permissionCode: "synthetic.configure",
            reasonCode: "SYNTHETIC_SETUP",
            recordedAt: installedAt,
            expectedVersion: 0,
            configuration: rebindKitchenRoutingEvidence(
              {
                brandReference,
                storeReference: storeOne,
                evidenceReference: id(902),
                evidenceVersion: 1,
                effectiveAt: installedAt,
                evidenceDigest: sha256("placeholder"),
                candidates: [
                  {
                    stationReference: id(903),
                    stationVersion: 1,
                    stationStatus: "Active",
                    stationCapabilityReferences: [id(904)],
                    routingRuleReference: id(905),
                    routingRuleVersion: 1,
                    routingRuleStatus: "Active",
                    selector: { kind: "AllPreparedItems" },
                    targetStationReference: id(903),
                    routingRuleDigest: sha256("placeholder"),
                  },
                ],
              },
              installedAt,
              sha256,
            ),
          },
        });
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
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
      const storeTwo = "01909a3f-2000-7000-8000-000000000002",
        storeThree = "01909a3f-2000-7000-8000-000000000003";
      await open(storeTwo, "DEMO_02", "DEMO Store 2 – not production");
      await open(storeThree, "DEMO_03", "DEMO Store 3");
      const read = (storeReference, at = new Date().toISOString()) =>
        readStoreKitchenRouting(admin, { role: apiRole, binding, storeReference, at });
      // Store 1 is compared at one instant (the read rebinds its evidence to the instant asked).
      const storeOneAt = new Date().toISOString();
      const run = (storeReference, approval = "Owner approves the TEST kitchen routing") =>
        createInternalTestKitchenRouting(admin, {
          environment: "InternalTest",
          database: context.databaseName,
          role,
          binding,
          storeReference,
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
      const storeOneBefore = await read(storeOne, storeOneAt);
      // Store 1's kitchen setup (owner fixture, the Kitchen owner's functions): two sections, two
      // dishes marked, one dish the kitchen does not prepare.
      const dishes = [id(950), id(951), id(952)];
      const ownerTx = { query: (sql, values) => admin.query(sql, values) };
      const storeOneScope = { tenantReference, brandReference, storeReference: storeOne };
      const setupAt = new Date().toISOString();
      const sections = await changeKitchenSections(ownerTx, storeOneScope, {
        operationReference: id(960),
        expectedVersion: 0,
        sections: [
          { sectionReference: id(961), name: "Wok" },
          { sectionReference: id(962), name: "Noodles" },
        ],
        actorReference: owner,
        observedAt: setupAt,
      });
      for (const [n, section] of [id(961), id(962)].entries())
        await changeKitchenProductSection(ownerTx, storeOneScope, {
          productReference: dishes[n],
          operationReference: id(963 + n),
          expectedVersion: 0,
          sectionReference: section,
          actorReference: owner,
          observedAt: setupAt,
        });
      await changeKitchenNotPreparedProduct(ownerTx, storeOneScope, {
        productReference: dishes[2],
        operationReference: id(966),
        expectedVersion: 0,
        notPrepared: true,
        actorReference: owner,
        observedAt: setupAt,
      });
      const storeOneSetup = async () => ({
        sections: await loadKitchenSections(ownerTx, storeOneScope),
        dishes: [...(await loadKitchenProductSections(ownerTx, storeOneScope, dishes))],
        notPrepared: [...(await loadKitchenNotPreparedProducts(ownerTx, storeOneScope, null))],
      });
      const storeOneSetupBefore = await storeOneSetup();
      assert.equal(sections.version, 1);
      // An order at store 2 confirmed now, before the Store's kitchen is set up.
      const confirmedBefore = new Date().toISOString();
      await sleep(5);

      // 1. Before: no routing for store 2 — the kitchen could not route any item there.
      assert.equal(await read(storeTwo), null);

      // 2. Its own routing; the services' read routes store 2's items to store 2's station.
      const created = await run(storeTwo);
      assert.equal(created.status, "Created");
      const routed = await read(storeTwo);
      assert.equal(routed?.storeReference, storeTwo);
      assert.equal(routed.candidates.length, 1);
      const [candidate] = routed.candidates;
      assert.deepEqual(candidate.selector, { kind: "AllPreparedItems" });
      assert.deepEqual(candidate.stationCapabilityReferences, [id(904)]);
      assert.equal(candidate.stationStatus, "Active");
      assert.notEqual(candidate.stationReference, id(903));
      assert.equal(candidate.targetStationReference, candidate.stationReference);
      assert.deepEqual(await read(storeOne, storeOneAt), storeOneBefore);
      // The order confirmed before the routing existed never routes (the v15 order); one
      // confirmed from now on does.
      assert.equal(await read(storeTwo, confirmedBefore), null);
      assert.equal((await read(storeTwo, new Date().toISOString()))?.storeReference, storeTwo);
      // Store 1's kitchen setup, under store 2's own section identities, read as the services'.
      assert.deepEqual(created.setup.counts, { sections: 2, dishSections: 2, notPrepared: 1 });
      const storeTwoScope = { brandReference, storeReference: storeTwo };
      await admin.query("BEGIN");
      let copied;
      try {
        await admin.query("SET LOCAL ROLE " + apiRole);
        const apiTx = { query: (sql, values) => admin.query(sql, values) };
        copied = {
          sections: await loadKitchenSections(apiTx, storeTwoScope),
          dishes: await loadKitchenProductSections(apiTx, storeTwoScope, dishes),
          notPrepared: await loadKitchenNotPreparedProducts(apiTx, storeTwoScope, null),
        };
      } finally {
        await admin.query("ROLLBACK");
      }
      assert.deepEqual(
        copied.sections.sections.map((section) => section.name),
        ["Wok", "Noodles"],
      );
      const ownSections = copied.sections.sections.map((section) => section.sectionReference);
      assert.ok(ownSections.every((reference) => ![id(961), id(962)].includes(reference)));
      assert.deepEqual(
        dishes.slice(0, 2).map((dish) => copied.dishes.get(dish)?.sectionReference),
        ownSections,
      );
      assert.equal(copied.dishes.has(dishes[2]), false);
      assert.deepEqual([...copied.notPrepared], [[dishes[2], { notPrepared: true, version: 1 }]]);
      assert.deepEqual(
        await readStoreKitchenSetup(admin, { role: apiRole, binding, storeReference: storeTwo }),
        { sections: 2, notPrepared: 1 },
      );
      assert.deepEqual(await storeOneSetup(), storeOneSetupBefore);
      const audits = (
        await admin.query(
          "SELECT action_code,actor_reference::text actor,after_summary_json->>'approval' approval FROM platform_audit.audit_record WHERE store_id=$1 ORDER BY chain_sequence",
          [storeTwo],
        )
      ).rows.filter((row) => row.action_code !== "STORE_OPENED");
      assert.deepEqual(
        audits.map((row) => [row.action_code, row.actor, row.approval]),
        [
          ["KITCHEN_ROUTING_CONFIGURATION_RECORDED", approver, null],
          [
            "INTERNAL_TEST_STORE_KITCHEN_ROUTING",
            approver,
            "Owner approves the TEST kitchen routing",
          ],
        ],
      );

      // 3. Again: the same routing, nothing written.
      const count = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_kitchen.kitchen_routing_configuration) routing,(SELECT count(*)::int FROM platform_audit.audit_record) audits",
          )
        ).rows[0];
      const before = await count();
      assert.equal((await run(storeTwo, "asked again")).status, "AlreadyPresent");
      assert.deepEqual(await count(), before);

      // 4. Refused.
      await assert.rejects(run(storeOne), { reason: "input-invalid" });
      await assert.rejects(run(id(99)), { reason: "store-not-opened-in-product" });
      await assert.rejects(run(storeThree), { reason: "store-not-labelled-test" });
      assert.deepEqual(await count(), before);
    } finally {
      await admin.end();
    }
  });
}, 240_000);
