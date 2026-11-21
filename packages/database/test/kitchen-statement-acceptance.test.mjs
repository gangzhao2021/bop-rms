import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createOneStoreMenuFixture } from "../test-support/one-store-menu-fixture.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";
import {
  loadStoreKitchenStatement,
  recordStoreKitchenStatement,
} from "../../rms/store/src/index.ts";

const { Client } = pg;

/**
 * WP-2423 (M178): the Store's kitchen statement (allergens it handles, equipment it shares) is
 * recorded and read under the restricted NOBYPASSRLS role with the rendered pilot API grants:
 * the latest version is current, a retry records nothing more, history can't change, and another
 * Store reads none of it.
 */
it("WP-2423 (M178): the kitchen's cross-contact statement is versioned, append-only and the Store's own", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_kitchen_stmt" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "wp2423_ks");
    const f = await createOneStoreMenuFixture(admin, context, { role });
    try {
      const scope = {
        tenantReference: f.tenantReference,
        brandReference: f.brandReference,
        storeReference: f.storeReference,
      };
      const record = (operationReference, handledAllergenCodes, sharedEquipment, at) =>
        f.asApi((tx) =>
          recordStoreKitchenStatement(tx, scope, {
            statementReference: f.op(),
            handledAllergenCodes,
            sharedEquipment,
            actorReference: f.owner,
            operationReference,
            recordedAt: at,
          }),
        );
      const read = () => f.asApi((tx) => loadStoreKitchenStatement(tx, scope));
      assert.equal(await read(), null);
      const first = f.op();
      assert.deepEqual(
        await record(first, ["SESAME", "PEANUT"], ["FryerOil", "Woks"], "2026-11-10T20:00:00.000Z"),
        { status: "Applied" },
      );
      assert.deepEqual(
        await record(first, ["PEANUT", "SESAME"], ["Woks", "FryerOil"], "2026-11-10T20:00:00.000Z"),
        { status: "AlreadyApplied" },
      );
      await assert.rejects(
        record(first, ["PEANUT"], [], "2026-11-10T20:00:00.000Z"),
        /STORE_KITCHEN_STATEMENT_CONFLICT/u,
      );
      assert.deepEqual(await read(), {
        handledAllergenCodes: ["PEANUT", "SESAME"],
        sharedEquipment: ["Woks", "FryerOil"],
        recordedAt: "2026-11-10T20:00:00.000Z",
      });
      await record(f.op(), ["PEANUT"], [], "2026-11-10T21:00:00.000Z");
      assert.deepEqual((await read())?.handledAllergenCodes, ["PEANUT"]);
      // Free text is never a piece of equipment.
      await assert.rejects(
        record(f.op(), [], ["Our big wok"], "2026-11-10T22:00:00.000Z"),
        /STORE_KITCHEN_STATEMENT_INVALID/u,
      );
      await assert.rejects(
        admin.query("UPDATE rms_store.store_kitchen_allergen_statement SET shared_equipment='{}'"),
        /append-only kitchen allergen statement/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_store.store_kitchen_allergen_statement"),
        /append-only kitchen allergen statement/u,
      );
      // Another Store of the Brand reads none of this Store's statement.
      const other = "01a3ff00-0000-7000-8000-00000000ffff";
      assert.equal(
        await f.asApi((tx) =>
          loadStoreKitchenStatement(tx, {
            brandReference: f.brandReference,
            storeReference: other,
          }),
        ),
        null,
      );
    } finally {
      await f.close();
      await admin.end();
    }
  });
});
