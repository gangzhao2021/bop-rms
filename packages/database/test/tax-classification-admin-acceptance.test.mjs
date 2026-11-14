import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  MerchantTaxClassificationError,
  createMerchantTaxClassifications,
} from "../../../apps/api/src/merchant-tax-classifications.ts";
import { createMerchantStoreSetup } from "../../../apps/api/src/merchant-store-setup.ts";
import { brandRoleTemplateActions } from "../../bop/permission/src/index.ts";
import { createUnconfiguredStoreSetupDraftContentV2 } from "../../rms/store/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";

const { Client } = pg;
const id = (n) => "01a7e100-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const op = (n) => "0199e8b0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const manage = "catalog.tax-classification.manage";

/**
 * WP-2423 Store setup in product: the Brand Owner adds, renames and retires the Brand's tax
 * classifications through the merchant BFF composition, as a restricted NOBYPASSRLS role holding
 * exactly the rendered pilot API grants (pilot ACL matrix + additions). Every change is one
 * append-only registry version with its audit record and outbox event; retries replay; the Menu
 * Manager and Store Manager are refused without a trace; another Brand is isolated; and Store setup
 * step 5 then offers the Active classifications and saves a fee that is On with one.
 */
it("WP-2423: the Brand Owner manages tax classifications under the pilot API grants", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_tax_classes" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_tc_" + context.runId,
      worker = "wp2423_tc_w_" + context.runId;
    vi.stubEnv("NODE_ENV", "development");
    try {
      for (const name of [api, worker])
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
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL statement_timeout = '20s'");
            const result = await work({
              query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const now = () => new Date().toISOString();
      const scope = { tenantReference: id(3), brandReference: id(1), storeReference: id(2) };
      // The permission catalog v16 Brand Owner template carries the registry's manage name; the
      // Menu Manager template does not (v15 and earlier: nobody held it).
      assert.ok(brandRoleTemplateActions("brand-owner").includes(manage));
      assert.ok(!brandRoleTemplateActions("menu-manager").includes(manage));
      let grantNumber = 0x900;
      /** A Brand-scope role (as provisioned from a Brand template) with exactly these actions. */
      const brandRole = async (session, brandReference, actor, actions) => {
        const membership = (
          await admin.query(
            "SELECT membership_id FROM bop_membership.membership WHERE actor_id=$1 AND brand_id=$2",
            [actor, brandReference],
          )
        ).rows[0].membership_id;
        const from = new Date(Date.now() - 60000).toISOString(),
          until = new Date(Date.now() + 3600000).toISOString(),
          role = id(grantNumber++);
        await admin.query(
          "INSERT INTO bop_permission.role VALUES($1,$2,NULL,$3,'Active',$4,$5,1,$4,$4)",
          [role, brandReference, "synthetic_brand_role_" + grantNumber, from, until],
        );
        await admin.query(
          "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
          [id(grantNumber++), role, membership, actor, brandReference, from, until],
        );
        for (const action of actions) {
          let permission = (
            await admin.query(
              "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
              [action],
            )
          ).rows[0]?.permission_id;
          if (!permission) {
            permission = id(grantNumber++);
            await admin.query(
              "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
              [permission, action, from],
            );
          }
          await admin.query(
            "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
            [id(grantNumber++), role, permission, brandReference, from, until],
          );
        }
        return session;
      };
      const ownerActions = ["catalog.manage", "catalog.tax-classification.read", manage];
      const owner = await brandRole(
        await seedMerchantAcceptanceSession({
          admin,
          runner: transactions,
          scope,
          actor: id(10),
          at: now(),
          extraPermissions: ["organization.manage"],
        }),
        scope.brandReference,
        id(10),
        ownerActions,
      );
      const menuManager = await brandRole(
        await seedMerchantAcceptanceSession({
          admin,
          runner: transactions,
          scope,
          actor: id(11),
          at: now(),
          referencePrefix: "01909a01",
          sessionReferencePrefix: "01909a02",
        }),
        scope.brandReference,
        id(11),
        ["catalog.manage", "catalog.tax-classification.read"],
      );
      const storeManager = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        scope,
        actor: id(12),
        at: now(),
        referencePrefix: "01909a03",
        sessionReferencePrefix: "01909a04",
        extraPermissions: ["organization.store.read", "catalog.product.read"],
      });
      const bff = (session) =>
        createMerchantTaxClassifications({
          persistence: session.persistence,
          authentication: session.authentication,
        });
      const query = (session) =>
        bff(session).query({ sessionCookie: session.sessionCookie, csrf: session.csrf });
      const command = (session, body) =>
        bff(session).command({ sessionCookie: session.sessionCookie, csrf: session.csrf, body });
      const refused = (code) => (error) =>
        error instanceof MerchantTaxClassificationError && error.code === code;
      const counts = async (brand = scope.brandReference) =>
        (
          await admin.query(
            `SELECT
              (SELECT count(*)::int FROM rms_catalog.product_tax_classification_registry_record WHERE brand_id=$1) versions,
              (SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1 AND action_code='CATALOG_TAX_CLASSIFICATION_REGISTRY_RECORDED') audits,
              (SELECT count(*)::int FROM platform_eventing.outbox_event WHERE brand_id=$1 AND event_type='ProductTaxClassificationRegistryVersionRecorded') events`,
            [brand],
          )
        ).rows[0];
      const add = (n, expected, ...names) => ({
        action: "Add",
        operationReference: op(n),
        expectedRegistryVersion: expected,
        classifications: names.map((names) => ({ names })),
      });

      // Before the first classification: an empty list, not an outage.
      const empty = await query(owner);
      assert.equal(empty.registryVersion, 0);
      assert.deepEqual(empty.classifications, []);
      assert.equal(empty.permissions.mayManage, true);
      assert.equal(empty.defaultLocale, "en-CA");

      // Without the pilot api INSERT grant the write cannot happen (it failed so before this WP).
      await admin.query(
        "REVOKE INSERT ON rms_catalog.product_tax_classification_registry_record FROM " + api,
      );
      await assert.rejects(
        command(owner, add(1, 0, { "en-CA": "Prepared food" })),
        refused("Unavailable"),
      );
      assert.deepEqual(await counts(), { versions: 0, audits: 0, events: 0 });
      await admin.query(
        "GRANT INSERT ON rms_catalog.product_tax_classification_registry_record TO " + api,
      );

      // Version 1: two classifications, with audit and outbox event.
      const first = await command(
        owner,
        add(
          1,
          0,
          { "en-CA": "Prepared food", "fr-CA": "Aliments préparés" },
          { "en-CA": "Alcohol" },
        ),
      );
      assert.equal(first.status, "Applied");
      assert.equal(first.view.registryVersion, 1);
      assert.deepEqual(
        first.view.classifications.map((c) => [c.names["en-CA"], c.lifecycle]),
        [
          ["Alcohol", "Active"],
          ["Prepared food", "Active"],
        ],
      );
      assert.deepEqual(await counts(), { versions: 1, audits: 1, events: 1 });
      const codes = (
        await admin.query(
          "SELECT jsonb_path_query_array(snapshot_json,'$.definitions[*].code') codes,actor_id::text actor,data_classification FROM rms_catalog.product_tax_classification_registry_record WHERE brand_id=$1",
          [scope.brandReference],
        )
      ).rows[0];
      assert.deepEqual([...codes.codes].sort(), ["ALCOHOL", "PREPARED_FOOD"]);
      assert.equal(codes.actor, id(10));
      const food = first.view.classifications.find((c) => c.names["en-CA"] === "Prepared food");
      const alcohol = first.view.classifications.find((c) => c.names["en-CA"] === "Alcohol");

      // A retry of the same operation replays; a changed intent under it is a conflict.
      const replay = await command(
        owner,
        add(
          1,
          0,
          { "en-CA": "Prepared food", "fr-CA": "Aliments préparés" },
          { "en-CA": "Alcohol" },
        ),
      );
      assert.equal(replay.status, "Replayed");
      assert.deepEqual(replay.view.classifications, first.view.classifications);
      await assert.rejects(command(owner, add(1, 0, { "en-CA": "Fees" })), refused("Conflict"));
      await assert.rejects(command(owner, add(1, 1, { "en-CA": "Fees" })), refused("Conflict"));
      // A different person's retry of the Owner's operation never replays it as theirs.
      assert.deepEqual(await counts(), { versions: 1, audits: 1, events: 1 });

      // Version 2: rename (same identity and code); version 3: Brand default.
      const renamed = await command(owner, {
        action: "Rename",
        operationReference: op(2),
        expectedRegistryVersion: 1,
        classificationReference: alcohol.classificationReference,
        names: { "en-CA": "Alcoholic drinks", "fr-CA": "Boissons alcoolisées" },
      });
      assert.equal(renamed.view.registryVersion, 2);
      const withDefault = await command(owner, {
        action: "SetDefault",
        operationReference: op(3),
        expectedRegistryVersion: 2,
        classificationReference: food.classificationReference,
      });
      assert.equal(withDefault.view.registryVersion, 3);
      assert.equal(
        withDefault.view.classifications.find((c) => c.isDefault)?.classificationReference,
        food.classificationReference,
      );
      // A stale page (expected version 2) is refused: someone else changed the list.
      await assert.rejects(
        command(owner, {
          action: "Retire",
          operationReference: op(4),
          expectedRegistryVersion: 2,
          classificationReference: alcohol.classificationReference,
        }),
        refused("Conflict"),
      );
      // A name already in use (ignoring case) is refused.
      await assert.rejects(
        command(owner, add(5, 3, { "en-CA": "alcoholic DRINKS" })),
        refused("NameTaken"),
      );

      // Version 4: retire the default; it cannot come back.
      const retired = await command(owner, {
        action: "Retire",
        operationReference: op(6),
        expectedRegistryVersion: 3,
        classificationReference: food.classificationReference,
      });
      assert.equal(retired.view.registryVersion, 4);
      assert.equal(
        retired.view.classifications.find(
          (c) => c.classificationReference === food.classificationReference,
        ).lifecycle,
        "Retired",
      );
      assert.equal(
        retired.view.classifications.some((c) => c.isDefault),
        false,
      );
      for (const body of [
        {
          action: "SetDefault",
          operationReference: op(7),
          expectedRegistryVersion: 4,
          classificationReference: food.classificationReference,
        },
        {
          action: "Rename",
          operationReference: op(8),
          expectedRegistryVersion: 4,
          classificationReference: food.classificationReference,
          names: { "en-CA": "Prepared food again" },
        },
      ])
        await assert.rejects(command(owner, body), refused("Retired"));
      assert.deepEqual(await counts(), { versions: 4, audits: 4, events: 4 });
      const fees = await command(owner, add(9, 4, { "en-CA": "Fees" }));
      assert.equal(fees.view.registryVersion, 5);
      const feeClass = fees.view.classifications.find((c) => c.names["en-CA"] === "Fees");

      // The Menu Manager reads without changing; the Store Manager is refused. No row or audit.
      const menuView = await query(menuManager);
      assert.equal(menuView.permissions.mayManage, false);
      assert.equal(menuView.registryVersion, 5);
      await assert.rejects(
        command(menuManager, add(10, 5, { "en-CA": "Menu manager label" })),
        refused("PermissionDenied"),
      );
      await assert.rejects(query(storeManager), refused("PermissionDenied"));
      await assert.rejects(
        command(storeManager, add(11, 5, { "en-CA": "Store manager label" })),
        refused("PermissionDenied"),
      );
      assert.deepEqual(await counts(), { versions: 5, audits: 5, events: 5 });

      // Another Brand: its own registry, independent versions; RLS shows no row of the first.
      const other = {
        tenantReference: id(0x23),
        brandReference: id(0x21),
        storeReference: id(0x22),
      };
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'SYNTHETIC_OTHER_BRAND','Synthetic Other Brand','en-CA','CAD','Active',1,$2,$2)",
        [other.brandReference, new Date(Date.now() - 60000).toISOString()],
      );
      const otherOwner = await brandRole(
        await seedMerchantAcceptanceSession({
          admin,
          runner: transactions,
          scope: other,
          actor: id(20),
          at: now(),
          referencePrefix: "01909a05",
          sessionReferencePrefix: "01909a06",
        }),
        other.brandReference,
        id(20),
        ownerActions,
      );
      assert.equal((await query(otherOwner)).registryVersion, 0);
      const otherFirst = await command(otherOwner, add(12, 0, { "en-CA": "Prepared food" }));
      assert.equal(otherFirst.view.registryVersion, 1);
      assert.deepEqual(await counts(other.brandReference), { versions: 1, audits: 1, events: 1 });
      assert.equal((await query(owner)).registryVersion, 5);
      {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + api);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [other.tenantReference, other.brandReference],
          );
          const visible = await client.query(
            "SELECT brand_id::text brand,count(*)::int n FROM rms_catalog.product_tax_classification_registry_record GROUP BY brand_id",
          );
          assert.deepEqual(visible.rows, [{ brand: other.brandReference, n: 1 }]);
          await client.query("ROLLBACK");
        } finally {
          await client.end();
        }
      }

      // Store setup step 5: the Active classifications are offered and a fee saves On with one.
      let next = 0x700;
      const setup = createMerchantStoreSetup({
        persistence: owner.persistence,
        authentication: owner.authentication,
        nextReference: () => id(next++),
      });
      const choices = await setup.classifications({
        sessionCookie: owner.sessionCookie,
        expectedStoreReference: scope.storeReference,
      });
      assert.deepEqual(
        choices.choices
          .filter((c) => c.lifecycle === "Active")
          .map((c) => c.localizedNames["en-CA"])
          .sort(),
        ["Alcoholic drinks", "Fees"],
      );
      const save = (
        operationReference,
        taxClassificationReference,
        expectedSetupReference,
        expectedRevision,
      ) =>
        setup.write({
          sessionCookie: owner.sessionCookie,
          csrf: owner.csrf,
          expectedScope: { ...scope, actorReference: id(10) },
          command: {
            command: "SaveDraft",
            operationReference,
            expectedSetupReference,
            expectedRevision,
            content: {
              ...createUnconfiguredStoreSetupDraftContentV2(),
              feeContexts: {
                state: "Configured",
                value: [
                  {
                    chargeType: "ServiceCharge",
                    state: "Enabled",
                    taxClassificationReference,
                    orderTypes: ["DineIn"],
                  },
                  { chargeType: "DeliveryFee", state: "Disabled" },
                  { chargeType: "Tip", state: "Unconfigured" },
                ],
              },
            },
          },
        });
      // A retired classification is refused for a fee that is On.
      await assert.rejects(save(id(0x41), food.classificationReference, null, 0));
      const saved = await save(id(0x40), feeClass.classificationReference, null, 0);
      assert.equal(saved.snapshot.revision, 1);
      const reread = await setup.read({
        sessionCookie: owner.sessionCookie,
        expectedStoreReference: scope.storeReference,
      });
      assert.equal(
        reread.setup.snapshot.content.feeContexts.value[0].taxClassificationReference,
        feeClass.classificationReference,
      );
    } finally {
      vi.unstubAllEnvs();
      await admin.end();
    }
  });
});
