import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { it } from "vitest";
import { createPostgresTransactionCurrentPermissionPolicySource } from "../../bop/permission/src/index.ts";
import { createPostgresCurrentMembershipSource } from "../../bop/membership/src/index.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";
import { createTenantContext } from "../../bop/tenant/src/index.ts";
import { createPostgresWorkflowDefinitionStore } from "../../bop/workflow/src/index.ts";
import { createPostgresCurrentLiveGateSource } from "../../bop/publishing/src/index.ts";
import {
  createPostgresAllergenReviewFactsStore,
  createPostgresCurrentOptionBindingsStore,
  createPostgresMenuReviewOptionSource,
  createPostgresProductOptionSetSource,
} from "../../rms/catalog/src/index.ts";
import { createPostgresSubmissionRecipeDemandSource } from "../../rms/recipe/src/index.ts";
import {
  createPostgresStoreBusinessDateConfigurationSource,
  createPostgresStoreExceptionContentSource,
  createPostgresStorePauseHistorySource,
  createPostgresStorePublicationContentSource,
  createPostgresStoreWeeklyScheduleSource,
} from "../../rms/store/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  merchantFenceKey,
  merchantFences,
  merchantFenceSites,
} from "../test-support/merchant-fences.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const shared = "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))";
const exclusive = "SELECT pg_advisory_xact_lock(hashtextextended($1,0))";
const uuid7 = (n) => "018fd000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const merchant = { tenant: uuid7(1), brand: f.BRAND, store: f.STORE };
const otherBrand = { tenant: uuid7(1), brand: f.OTHER_BRAND, store: f.STORE };
const otherStore = { tenant: uuid7(1), brand: f.BRAND, store: uuid7(9) };
const otherTenant = { tenant: uuid7(2), brand: f.BRAND, store: f.STORE };
const entryOf = (fence) => merchantFences.find((entry) => entry.fence === fence);

/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE. A table lock cannot be mistyped; an advisory fence can: a key
 * that differs between reader and trigger leaves both calls succeeding and the guarantee gone. So
 * for every fence and every table it covers, through the real readers and the real triggers:
 * - what the reader holds stops every write to that table in that scope (55P03);
 * - the same write for another brand or store passes the fence;
 * - no table in the list lacks the trigger, no trigger is missing from the list, and it fires first.
 */
it("every fence stops writers of its own scope, and only those", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_fences" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const opened = new Set();
    const connect = async () => {
      const client = new Client(context.clientConfig);
      await client.connect();
      opened.add(client);
      return client;
    };
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_mf");

      // The list and the database agree, both ways.
      const triggers = (
        await admin.query(
          `SELECT n.nspname AS schema,c.relname AS table_name,t.tgname AS name,
             encode(t.tgargs,'escape') AS args,t.tgtype::int AS type,
             (SELECT min(o.tgname) FROM pg_trigger o WHERE o.tgrelid=t.tgrelid AND NOT o.tgisinternal
               AND (o.tgtype::int & 1)=1 AND (o.tgtype::int & 2)=2) AS first_before_row
           FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE t.tgname='a0_merchant_fence' AND NOT t.tgisinternal ORDER BY 1,2`,
        )
      ).rows;
      const listed = merchantFences.flatMap((entry) =>
        entry.tables.map((table) => entry.schema + "." + table),
      );
      assert.deepEqual(
        triggers.map((row) => row.schema + "." + row.table_name).sort(),
        [...listed].sort(),
        "every fenced table has the trigger, and no trigger is unlisted",
      );
      for (const entry of merchantFences)
        for (const table of entry.tables) {
          const row = triggers.find((t) => t.schema === entry.schema && t.table_name === table);
          // ROW (1), BEFORE (2), INSERT (4), DELETE (8), UPDATE (16).
          assert.equal(row.type & 0b11111, 0b11111, table + " fires before every row write");
          assert.equal(row.first_before_row, "a0_merchant_fence", table + " fires its fence first");
          if (!entry.bounded)
            assert.equal(row.args.split("\\000")[0], entry.fence, table + " trigger key");
        }

      // Every site uses a known fence, in the mode the record says.
      const seenFences = new Set();
      for (const [file, expected] of Object.entries(merchantFenceSites)) {
        const source = await readFile(path.join(root, file), "utf8");
        assert.ok(!/LOCK TABLE/u.test(source), file + " has no table lock left");
        for (const [fence, mode] of Object.entries(expected)) {
          const lockCall = (name) =>
            new RegExp(
              name + String.raw`\(hashtextextended\(\$1,0\)\)",\s*\[\s*"` + fence + ":",
              "u",
            );
          if (mode === "S")
            assert.match(source, lockCall("pg_advisory_xact_lock_shared"), file + " " + fence);
          else if (mode === "X")
            assert.match(source, lockCall("pg_advisory_xact_lock"), file + " " + fence);
          else assert.ok(source.includes('"' + fence + ":"), file + " " + fence);
          seenFences.add(fence);
        }
      }
      for (const entry of merchantFences)
        assert.ok(seenFences.has(entry.fence), entry.fence + " has a reader");
      const persistence = [];
      for (const owner of ["bop", "rms"]) {
        const base = path.join(root, "packages", owner);
        for (const name of await readdir(base)) {
          const dir = path.join(base, name, "src/infrastructure/persistence");
          const files = await readdir(dir).catch(() => []);
          for (const file of files)
            if (file.endsWith(".ts")) persistence.push(path.join(dir, file));
        }
      }
      for (const file of persistence) {
        const source = await readFile(file, "utf8");
        for (const match of source.matchAll(/"([A-Z][A-Za-z]*Fence):"/gu))
          assert.ok(entryOf(match[1]), match[1] + " in " + file + " is not a known fence");
      }

      /** The real reader, on a real connection: its fences are really held; other SQL answers empty. */
      const hold = async (read) => {
        const client = await connect();
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        const keys = [];
        const tx = {
          query: async (sql, values = []) => {
            if (sql.includes("pg_advisory_xact_lock")) {
              keys.push(values[0]);
              return client.query(sql, [...values]);
            }
            if (sql.includes("transaction_isolation"))
              return { rows: [{ isolation: "read committed" }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
          },
        };
        await read(tx).catch(() => undefined);
        return {
          keys,
          release: async () => {
            await client.query("ROLLBACK");
            opened.delete(client);
            await client.end();
          },
        };
      };
      const probe = await connect();
      /** A write to the table in this scope, with a short wait: what did the fence say? */
      const write = async (entry, table, scope, timeout = "100ms") => {
        const { rows } = await admin.query(
          "SELECT has_table_privilege($1,$2,'INSERT') AS allowed",
          [role, entry.schema + "." + table],
        );
        await probe.query("BEGIN");
        try {
          if (rows[0].allowed) await probe.query("SET LOCAL ROLE " + role);
          await probe.query("SET LOCAL lock_timeout='" + timeout + "'");
          const columns =
            entry.scope === "brand"
              ? ["brand_id"]
              : entry.scope === "store"
                ? ["brand_id", "store_id"]
                : ["tenant_id", "brand_id"];
          const values =
            entry.scope === "brand"
              ? [scope.brand]
              : entry.scope === "store"
                ? [scope.brand, scope.store]
                : [scope.tenant, scope.brand];
          await probe.query(
            `INSERT INTO ${entry.schema}.${table}(${columns.join(",")}) VALUES(${values
              .map((_, index) => "$" + (index + 1))
              .join(",")})`,
            values,
          );
          return "written";
        } catch (error) {
          return error.code;
        } finally {
          await probe.query("ROLLBACK");
        }
      };
      const others = (entry) =>
        entry.scope === "brand"
          ? [otherBrand]
          : entry.scope === "store"
            ? [otherBrand, otherStore]
            : [otherTenant, otherBrand];
      const proves = async (label, read, fences, excludes = []) => {
        const held = await hold(read);
        try {
          for (const fence of fences) {
            const entry = entryOf(fence);
            assert.ok(
              held.keys.includes(merchantFenceKey(entry, merchant)),
              label + " holds " + merchantFenceKey(entry, merchant) + "; it took " + held.keys,
            );
            for (const table of entry.tables) {
              assert.equal(await write(entry, table, merchant), "55P03", label + " stops " + table);
              for (const other of others(entry))
                assert.notEqual(
                  await write(entry, table, other),
                  "55P03",
                  label + " must not stop " + table + " elsewhere",
                );
            }
          }
          for (const fence of excludes) {
            const entry = entryOf(fence);
            assert.ok(!held.keys.includes(merchantFenceKey(entry, merchant)), label + " " + fence);
            for (const table of entry.tables)
              assert.notEqual(await write(entry, table, merchant), "55P03", label + " " + table);
          }
        } finally {
          await held.release();
        }
      };
      const allowed = async () => true;
      const at = f.AT;

      await proves(
        "the menu review",
        (tx) =>
          createPostgresMenuReviewOptionSource({ brandReference: f.BRAND, authorize: allowed })(
            tx,
            {
              sellableReference: uuid7(10),
              productVersionReference: uuid7(11),
              channelCodes: ["CUSTOMER_PWA"],
              observedAt: at,
            },
          ),
        ["CatalogOptionContentFence", "CatalogProductBindingFence"],
      );
      // A dish save validates against option content and never meets a binding reader.
      await proves(
        "a dish save's option check",
        (tx) =>
          createPostgresProductOptionSetSource({
            brandReference: f.BRAND,
            authorize: allowed,
            transaction: tx,
          }).resolveVersion({
            brandReference: f.BRAND,
            optionSetReference: uuid7(12),
            optionSetVersionReference: uuid7(13),
          }),
        ["CatalogOptionContentFence"],
        ["CatalogProductBindingFence"],
      );
      await proves(
        "the allergen review",
        (tx) =>
          createPostgresAllergenReviewFactsStore({ brandReference: f.BRAND, authorize: allowed })(
            tx,
            {
              registryVersionReference: uuid7(14),
              evidenceReferences: [uuid7(15)],
              defaultLocale: "en-CA",
              observedAt: at,
            },
          ),
        ["CatalogAllergenRegistryFence", "CatalogAllergenEvidenceFence"],
      );
      await proves(
        "a guest's business date",
        (tx) =>
          createPostgresStoreBusinessDateConfigurationSource({
            brandReference: f.BRAND,
            storeReference: f.STORE,
            timeZone: "America/Toronto",
            authorize: allowed,
            publicationProof: async () => null,
          })(tx, at),
        ["StoreAuthoringFence", "StoreConfigurationFence"],
        // A review snapshot, the public profile and pause state are other facts: no conflict.
        ["StoreReviewSnapshotFence", "StorePublicProfileFence", "StorePublicProfileTimingFence"],
      );
      const configured = {
        brandReference: f.BRAND,
        storeReference: f.STORE,
        configurationReference: uuid7(16),
        authorize: allowed,
      };
      await proves(
        "the publication content",
        (tx) =>
          createPostgresStorePublicationContentSource({ ...configured, hashContent: () => "" })(
            tx,
            at,
          ),
        ["StoreConfigurationFence"],
      );
      await proves(
        "the weekly schedule",
        (tx) =>
          createPostgresStoreWeeklyScheduleSource({ ...configured, verifyContent: allowed })(
            tx,
            at,
          ),
        ["StoreConfigurationFence"],
      );
      await proves(
        "the exceptions",
        (tx) =>
          createPostgresStoreExceptionContentSource({ ...configured, verifyContent: allowed })(
            tx,
            at,
          ),
        ["StoreConfigurationFence"],
      );
      await proves(
        "the pause history",
        (tx) =>
          createPostgresStorePauseHistorySource({
            brandReference: f.BRAND,
            storeReference: f.STORE,
            authorize: allowed,
            verifyOperation: allowed,
          })(tx, at),
        ["StoreServicePauseFence"],
      );
      await proves(
        "the launch gate",
        (tx) =>
          createPostgresCurrentLiveGateSource({
            tenantReference: merchant.tenant,
            brandReference: f.BRAND,
            storeReference: f.STORE,
            decisionEvidenceReference: uuid7(17),
            requiredRequirementCodes: ["SYNTHETIC_READY"],
            authorize: allowed,
          })(tx, at),
        ["LiveGateFence"],
      );
      await proves(
        "the workflow definition",
        (tx) =>
          createPostgresWorkflowDefinitionStore(
            { run: (work) => work(tx) },
            {
              tenantReference: merchant.tenant,
              brandReference: f.BRAND,
              storeReference: f.STORE,
            },
          ).resolveCurrent({
            purposeCode: "SyntheticPurpose",
            applicabilityCode: "SyntheticApplicability",
            observedAt: at,
          }),
        ["WorkflowDefinitionFence"],
      );
      await proves(
        "a staff member's permissions",
        (tx) =>
          createPostgresTransactionCurrentPermissionPolicySource(tx).authorizeActionsWithRoles({
            tenantContext: createTenantContext(f.actor, f.brand, f.store, at),
            membership: f.membership,
            storeAssignment: f.storeAssignment,
            actions: [f.ACTION],
          }),
        ["PermissionPolicyFence"],
      );
      await proves(
        "a staff member's memberships",
        (tx) =>
          createPostgresCurrentMembershipSource(
            tx,
            createTenantContext(f.actor, f.brand, f.store, at),
          ).findMemberships(f.ACTOR, f.BRAND),
        ["MembershipFence"],
      );
      await proves(
        "an order's recipe",
        (tx) =>
          createPostgresSubmissionRecipeDemandSource({ run: (work) => work(tx) }, f.BRAND).resolve({
            storeReference: f.STORE,
            skuReference: uuid7(18),
            occurredAt: at,
            saleUnitCode: "EACH",
            unitQuantity: "1",
            saleQuantity: 1,
            selections: [],
          }),
        ["RecipeCatalogReferenceV1"],
      );
      // A guest's option quote and cart hold no Catalog fence at all.
      const guest = await hold((tx) =>
        createPostgresCurrentOptionBindingsStore(
          { run: (work) => work(tx) },
          { brandReference: f.BRAND },
        ).load({
          sellableReference: uuid7(19),
          productVersionReference: uuid7(20),
          channelCode: "CUSTOMER_PWA",
          observedAt: at,
        }),
      );
      assert.deepEqual(guest.keys, []);
      await guest.release();

      // The trigger's write path: what a writer holds stops a reader of that scope; DELETE and
      // UPDATE go through it too, and the row is really removed (RETURN OLD).
      const functions = [
        ["rms_catalog.take_brand_fence", "'ProbeFence'", ["brand_id"]],
        ["rms_store.take_store_fence", "'ProbeFence'", ["brand_id", "store_id"]],
        ["bop_workflow.take_workflow_fence", "'ProbeFence'", ["tenant_id", "brand_id"]],
        ["bop_publishing.take_live_gate_fence", "'ProbeFence'", ["brand_id", "store_id"]],
        ["bop_permission.take_brand_fence", "'ProbeFence'", ["brand_id"]],
        ["bop_membership.take_brand_fence", "'ProbeFence'", ["brand_id"]],
        ["rms_recipe.take_brand_fence", "'ProbeFence'", ["brand_id"]],
        ["rms_recipe.take_recipe_reference_fence", "", ["brand_id"]],
      ];
      let tableNumber = 0;
      for (const [fn, args, columns] of functions) {
        const table = "probe_" + (tableNumber += 1);
        await admin.query(
          `CREATE TEMP TABLE ${table}(id int,${columns.map((c) => c + " uuid").join(",")})`,
        );
        await admin.query(
          `CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}(${args})`,
        );
        const insert = `INSERT INTO ${table}(id,${columns.join(",")}) VALUES(1,${columns
          .map((_, index) => "$" + (index + 1))
          .join(",")})`;
        const values = columns.map(() => uuid7(30));
        await admin.query(insert, values);
        await admin.query(`UPDATE ${table} SET id=2 WHERE id=1`);
        assert.equal(
          (await admin.query(`SELECT count(*)::int n FROM ${table} WHERE id=2`)).rows[0].n,
          1,
        );
        await admin.query(`DELETE FROM ${table} WHERE id=2`);
        assert.equal(
          (await admin.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
          0,
          fn + " removes the row it is asked to delete",
        );
      }

      // A recipe save beside a review: it waits briefly and gives way; a guest never queues behind
      // it for more than that; a store's rushed pause keeps the normal wait.
      const recipe = entryOf("RecipeCatalogReferenceV1");
      const reviewing = await hold((tx) =>
        createPostgresSubmissionRecipeDemandSource({ run: (work) => work(tx) }, f.BRAND).resolve({
          storeReference: f.STORE,
          skuReference: uuid7(18),
          occurredAt: at,
          saleUnitCode: "EACH",
          unitQuantity: "1",
          saleQuantity: 1,
          selections: [],
        }),
      );
      const started = Date.now();
      const saving = write(recipe, "recipe", merchant, "2s");
      let queued = false;
      for (let attempt = 0; attempt < 200 && !queued; attempt += 1) {
        queued =
          (
            await admin.query(
              "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
            )
          ).rows[0].n > 0;
        if (!queued) await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.ok(queued, "the recipe save queues behind the review");
      const guestStarted = Date.now();
      const guestOrder = await hold((tx) =>
        createPostgresSubmissionRecipeDemandSource({ run: (work) => work(tx) }, f.BRAND).resolve({
          storeReference: f.STORE,
          skuReference: uuid7(18),
          occurredAt: at,
          saleUnitCode: "EACH",
          unitQuantity: "1",
          saleQuantity: 1,
          selections: [],
        }),
      );
      const guestWaited = Date.now() - guestStarted;
      assert.ok(guestWaited < 500, "the guest waited " + guestWaited + " ms");
      assert.equal(await saving, "55P03", "the save gave way for its route to try again");
      assert.ok(Date.now() - started < 1500);
      await guestOrder.release();
      await reviewing.release();

      // After a wait that ends in time the transaction's own timeout is back.
      const bounded = await connect();
      await bounded.query("BEGIN");
      await bounded.query("SET LOCAL lock_timeout='2s'");
      await bounded.query("CREATE TEMP TABLE probe_timeout(brand_id uuid) ON COMMIT DROP");
      await bounded.query(
        "CREATE TRIGGER a0_merchant_fence BEFORE INSERT ON probe_timeout FOR EACH ROW EXECUTE FUNCTION rms_recipe.take_recipe_reference_fence()",
      );
      const holder = await connect();
      await holder.query("BEGIN");
      await holder.query(shared, ["RecipeCatalogReferenceV1:" + uuid7(40)]);
      const writing = bounded.query("INSERT INTO probe_timeout VALUES($1)", [uuid7(40)]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await holder.query("ROLLBACK");
      await writing;
      assert.equal((await bounded.query("SHOW lock_timeout")).rows[0].lock_timeout, "2s");
      await bounded.query("ROLLBACK");

      // An exclusive site stops readers of its scope, as the table lock did.
      const writer = await connect();
      await writer.query("BEGIN");
      await writer.query(exclusive, ["StoreServicePauseFence:" + f.BRAND + ":" + f.STORE]);
      await assert.rejects(
        (async () => {
          const reader = await connect();
          await reader.query("BEGIN");
          await reader.query("SET LOCAL lock_timeout='100ms'");
          try {
            await reader.query(shared, ["StoreServicePauseFence:" + f.BRAND + ":" + f.STORE]);
          } finally {
            await reader.query("ROLLBACK").catch(() => undefined);
          }
        })(),
        { code: "55P03" },
      );
      await writer.query("ROLLBACK");
    } finally {
      for (const client of opened) await client.end().catch(() => undefined);
      await admin.end();
    }
  });
});
