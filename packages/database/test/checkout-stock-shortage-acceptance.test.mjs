import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { insertRecipeVersion } from "../../rms/recipe/src/infrastructure/persistence/recipe-version-write.ts";
import { createPostgresSubmissionStockPlanSource } from "../../rms/inventory/src/index.ts";
import { findCheckoutStockShortage } from "../../rms/ordering/src/application/checkout-stock-shortage.ts";
import { createCustomerRecipeInventoryCoverage } from "../../../apps/api/src/customer-recipe-inventory-observation.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { grantPilotApiAcl } from "../test-support/pilot-api-acl.mjs";
import { seedSyntheticInventoryItems } from "../test-support/recipe-inventory-observation.mjs";

const { Client } = pg;
const id = (n) => "01902423-5000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-16T09:00:00.000Z";
const later = "2026-10-16T09:05:00.000Z";
const digest = "sha256:" + "d".repeat(64);
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  stockSiteReference: id(4),
};
const milk = id(5),
  milkVersion = id(6);
/** Three synthetic drinks, each made with 2 kg of the same synthetic milk (no real recipe). */
const drinks = {
  flatWhite: {
    code: "FLAT_WHITE",
    sku: id(100),
    product: id(101),
    version: id(102),
    recipe: id(103),
  },
  latte: { code: "LATTE", sku: id(110), product: id(111), version: id(112), recipe: id(113) },
  mocha: { code: "MOCHA", sku: id(120), product: id(121), version: id(122), recipe: id(123) },
};

/**
 * WP-2423 (2026-10-17): before any payment, checkout asks Inventory whether the Store's stock covers
 * the guest's Cart lines together, and Ordering decides which item to name and how many are left.
 * Here the actual Inventory answer (current SKU, Recipe demand and the stock plan the submission's
 * reservation uses) runs as a NOBYPASSRLS role holding exactly the rendered pilot API grants, in
 * read-only transactions, against synthetic Catalog/Recipe/Inventory rows (not a real Store, recipe
 * or receipt). Cases: a guest pickup Cart with the same drink on two lines; two drinks sharing one
 * milk that each fit alone but not together (the case that used to reach the reservation at
 * payment and fail with a generic error); a later dine-in round after an earlier round's
 * reservation; and the staff-entered table round, which asks exactly these questions through the
 * same checkout ports as its table guest. Nothing is reserved, written or charged by any check.
 */
it("names the short item and how many are left from the Store's real stock, before any payment", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_ck_stock" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_cs_api_" + context.runId,
      seeder = "wp2423_cs_seed_" + context.runId;
    try {
      for (const role of [api, seeder])
        await admin.query(
          "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      await grantPilotApiAcl(admin, api);
      await grantSeeder(admin, seeder);
      for (const drink of Object.values(drinks)) await seedDrink(admin, drink);
      let sequence = 9000;
      // 6 kg of milk on hand: three drinks.
      const [{ accountReference }] = await seedSyntheticInventoryItems({
        admin,
        role: seeder,
        runner: itemRunner(admin),
        id,
        at,
        scope,
        next: () => id(++sequence),
        items: [{ itemReference: milk, operationReference: milkVersion, onHand: "6" }],
      });
      await admin.query("RESET ROLE");
      const before = await ledger(admin, accountReference);
      assert.deepEqual(before, { onHand: "6", reserved: "0", reservations: 0 });

      // The Inventory answer exactly as checkout composes it, as the restricted pilot API role.
      const reads = readOnly(context, api);
      let allowed = true;
      const coverage = createCustomerRecipeInventoryCoverage({
        scope,
        transactions: reads,
        authorize: async () => allowed,
        resolveExpiryCutoff: async () => {
          throw new Error("NoLot fixture");
        },
      });
      let line = 0x500;
      const cartLine = (drink, quantity) => ({
        cartItemReference: id(++line),
        sellableReference: drink.sku,
        quantity,
        optionSelections: [],
      });
      const covers = (lines) =>
        coverage.covers({
          observedAt: later,
          lines: lines.map((entry) => ({
            cartItemReference: entry.cartItemReference,
            sellableReference: entry.sellableReference,
            productVersionReference: Object.values(drinks).find(
              (drink) => drink.sku === entry.sellableReference,
            ).version,
            quantity: entry.quantity,
            selections: [],
          })),
        });

      // Guest pickup: the same drink on two lines (each added on its own) is counted together.
      const first = cartLine(drinks.flatWhite, 2),
        second = cartLine(drinks.flatWhite, 2);
      assert.equal(await covers([first]), true);
      assert.equal(await covers([first, second]), false);
      assert.deepEqual(await findCheckoutStockShortage([first, second], covers), {
        cartItemReference: first.cartItemReference,
        available: 3,
        sharedStock: false,
      });

      // Two drinks sharing the milk: each fits alone, together they don't. The guest is told
      // before payment which one to lower and to how many.
      const latte = cartLine(drinks.latte, 2),
        mocha = cartLine(drinks.mocha, 2);
      assert.equal(await covers([latte]), true);
      assert.equal(await covers([mocha]), true);
      assert.equal(await covers([latte, mocha]), false);
      assert.deepEqual(await findCheckoutStockShortage([latte, mocha], covers), {
        cartItemReference: mocha.cartItemReference,
        available: 1,
        sharedStock: true,
      });
      // The same answer the submission's reservation would give (it used to be the first place
      // the shortage surfaced, as a generic failure once the guest pressed pay).
      const plan = createPostgresSubmissionStockPlanSource(
        reads,
        {
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
        },
        {
          resolveExpiryCutoff: async () => {
            throw new Error("NoLot fixture");
          },
        },
      );
      const demand = (lines) => ({
        ...scope,
        submissionReference: id(0x600),
        cartReference: id(0x601),
        cartVersion: 3,
        quoteReference: id(0x602),
        demandReference: id(0x603),
        workflowReference: id(0x604),
        workflowVersion: 1,
        reserveTrigger: "OrderSubmission",
        sourceDigest: digest,
        contributions: lines.map((entry) => ({
          itemReference: milk,
          configurationOperationReference: milkVersion,
          unitDimension: "Mass",
          // Microunits of the item's unit (kg): 2 kg a drink.
          quantityNumerator: String(2_000_000 * entry.quantity),
          quantityDenominator: "1",
          cartItemReference: entry.cartItemReference,
        })),
      });
      await assert.rejects(plan.resolve(demand([latte, mocha]), later), {
        code: "STOCK_RESERVATION_INSUFFICIENT",
      });
      const fixed = { ...mocha, quantity: 1 };
      assert.equal(await covers([latte, fixed]), true);
      assert.equal((await plan.resolve(demand([latte, fixed]), later)).allocations.length, 2);

      // A later dine-in round: an earlier round of the table holds 4 kg. The milk left (2 kg) makes
      // one more drink, so a round of two mochas is told "only 1".
      await reserve(admin, accountReference, "4");
      const round = cartLine(drinks.mocha, 2);
      assert.equal(await covers([round]), false);
      assert.deepEqual(await findCheckoutStockShortage([round], covers), {
        cartItemReference: round.cartItemReference,
        available: 1,
        sharedStock: false,
      });
      // v15 run of 8f655fc4: Flat White on two lines and a Mocha, with milk left for one drink. One
      // Flat White can be made (it is not sold out); once the guest removes one, they are told the
      // Mocha shares the milk with it.
      const flatOne = cartLine(drinks.flatWhite, 1),
        flatTwo = cartLine(drinks.flatWhite, 1),
        lastMocha = cartLine(drinks.mocha, 1);
      assert.deepEqual(await findCheckoutStockShortage([flatOne, flatTwo, lastMocha], covers), {
        cartItemReference: flatOne.cartItemReference,
        available: 1,
        sharedStock: false,
      });
      assert.deepEqual(await findCheckoutStockShortage([flatOne, lastMocha], covers), {
        cartItemReference: lastMocha.cartItemReference,
        available: 0,
        sharedStock: true,
      });
      // Staff-entered table round (latte + mocha for guests without a phone): the same questions
      // through the same checkout ports as its table guest, so the same answer.
      const staffLatte = cartLine(drinks.latte, 1),
        staffMocha = cartLine(drinks.mocha, 1);
      assert.deepEqual(await findCheckoutStockShortage([staffLatte, staffMocha], covers), {
        cartItemReference: staffMocha.cartItemReference,
        available: 0,
        sharedStock: true,
      });

      // Access is checked for every question; a withdrawn guest gets no stock answer.
      allowed = false;
      await assert.rejects(covers([staffLatte]), {
        code: "CUSTOMER_INVENTORY_OBSERVATION_UNAVAILABLE",
      });

      // Nothing was reserved, moved or charged by any check (only the fixture's own Reserve).
      assert.deepEqual(await ledger(admin, accountReference), {
        onHand: "6",
        reserved: "4",
        reservations: 0,
      });
      const charged = (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_payment.payment_intent) AS intents,(SELECT count(*)::int FROM rms_ordering.order_header) AS orders",
        )
      ).rows[0];
      assert.deepEqual(charged, { intents: 0, orders: 0 });
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.end();
    }
  });
}, 180_000);

async function grantSeeder(admin, role) {
  await admin.query(
    "GRANT USAGE ON SCHEMA rms_inventory,platform_helpers,platform_audit TO " + role,
  );
  await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
  await admin.query(
    "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT ON rms_inventory.stock_account,rms_inventory.stock_balance,rms_inventory.stock_movement,rms_inventory.stock_lot_hold_version TO " +
      role,
  );
  await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_inventory.inventory_item TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation,platform_audit.audit_record TO " +
      role,
  );
  await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
}

/** The seeding role's Inventory Item commands on the owner connection (fixture setup only). */
function itemRunner(admin) {
  return {
    async run(work) {
      await admin.query("BEGIN");
      try {
        await admin.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true)",
          [scope.tenantReference, scope.brandReference],
        );
        const value = await work({ query: (sql, values) => admin.query(sql, [...values]) });
        await admin.query("COMMIT");
        return value;
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    },
  };
}

/** Repeatable Read, read-only transaction as the restricted role (as the customer runtime reads). */
function readOnly(context, role) {
  return {
    async run(work) {
      const client = new Client(context.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query("SET LOCAL ROLE " + role);
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [scope.tenantReference, scope.brandReference, scope.storeReference],
        );
        const value = await work({ query: (sql, values) => client.query(sql, [...values]) });
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    },
  };
}

async function ledger(admin, account) {
  const balance = (
    await admin.query(
      "SELECT on_hand::numeric::text AS on_hand,reserved::numeric::text AS reserved FROM rms_inventory.stock_balance WHERE account_id=$1",
      [account],
    )
  ).rows[0];
  const reservations = (
    await admin.query("SELECT count(*)::int AS n FROM rms_inventory.stock_reservation_version")
  ).rows[0].n;
  const trim = (value) => String(Number(value));
  return { onHand: trim(balance.on_hand), reserved: trim(balance.reserved), reservations };
}

/** An earlier round's hold on the milk (a synthetic Reserve movement on the ledger). */
async function reserve(admin, account, quantity) {
  const row = (
    await admin.query(
      "SELECT a.location_id::text AS location,b.ledger_version::int AS version,b.on_hand::numeric::text AS on_hand,b.reserved::numeric::text AS reserved FROM rms_inventory.stock_account a JOIN rms_inventory.stock_balance b USING (tenant_id,brand_id,store_id,account_id) WHERE a.account_id=$1",
      [account],
    )
  ).rows[0];
  const onHand = Number(row.on_hand),
    reserved = Number(row.reserved) + Number(quantity);
  const balance = (h, r, v) => ({
    onHand: String(h),
    reserved: String(r),
    available: String(h - r),
    inTransit: "0",
    unitCode: "KG",
    ledgerVersion: v,
  });
  const movement = id(0x700),
    audit = id(0x701);
  const record = {
    movementReference: movement,
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    itemReference: milk,
    movementType: "Reserve",
    quantityDelta: quantity,
    unitCode: "KG",
    baseQuantityDelta: quantity,
    baseUnitCode: "KG",
    conversionMultiplier: "1",
    sourceScope: null,
    destinationScope: { scopeType: "Location", scopeReference: row.location },
    lotReference: null,
    expiryDate: null,
    businessSourceType: "SYNTHETIC_RESERVE",
    businessSourceReference: id(0x702),
    reasonCode: "SYNTHETIC_TEST",
    performedBy: id(9),
    occurredAt: at,
    before: balance(onHand, Number(row.reserved), row.version),
    after: balance(onHand, reserved, row.version + 1),
    auditReference: audit,
    correctsMovementReference: null,
  };
  await admin.query("BEGIN");
  try {
    await admin.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [scope.tenantReference, scope.brandReference, scope.storeReference],
    );
    await admin.query(
      "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,'Reserve',$7,$8,$9,$10)",
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        account,
        movement,
        row.version + 1,
        quantity,
        record,
        audit,
        at,
      ],
    );
    await appendAuditRecordInTransaction(
      { query: (sql, values) => admin.query(sql, [...values]) },
      {
        auditId: audit,
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "User", reference: id(9) },
        actionCode: "INVENTORY_RESERVE",
        targetType: "StockMovement",
        targetId: movement,
        reasonCode: "SYNTHETIC_TEST",
        correlationId: id(0x703),
        occurredAt: at,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "SYNTHETIC_AUDIT",
        retentionPolicyVersion: 1,
      },
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

/** One synthetic SKU whose published Recipe takes 2 kg of the shared milk per drink. */
async function seedDrink(admin, drink) {
  const q = (sql, values) => admin.query(sql, values);
  const brand = scope.brandReference;
  await q(
    "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'PreparedFood','Active',1,$4,$5,$4)",
    [drink.product, brand, "SYN_" + drink.code, at, id(9)],
  );
  await q(
    "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)",
    [drink.version, drink.product, brand, JSON.stringify({ "en-CA": "Synthetic drink" }), at],
  );
  await q(
    "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,'Active',$6::jsonb,'[]'::jsonb,$7,'EACH',1,$8,$9)",
    [
      drink.sku,
      drink.product,
      brand,
      drink.version,
      "SYN_" + drink.code,
      JSON.stringify({ "en-CA": "Synthetic drink" }),
      digest,
      at,
      id(9),
    ],
  );
  const version = id(Number.parseInt(drink.recipe.slice(-4), 16) + 0x1000);
  const snapshot = {
    recipeReference: drink.recipe,
    versionReference: version,
    brandReference: brand,
    stableCode: "SYN_RECIPE_" + drink.code,
    aggregateVersion: 2,
    versionNumber: 1,
    snapshotDigest: digest,
    lifecycle: "Published",
    displayNameCode: "SYN_RECIPE_" + drink.code,
    yieldQuantityMicrounits: "1000000",
    yieldUnitCode: "EACH",
    yieldDimension: "Count",
    ingredients: [
      {
        requirementReference: id(Number.parseInt(drink.recipe.slice(-4), 16) + 0x2000),
        sourceKind: "InventoryItem",
        sourceReference: milk,
        sourceVersionReference: milkVersion,
        quantityMicrounits: "2000000",
        unitDimension: "Mass",
        conversionNumerator: "1",
        conversionDenominator: "1",
        lossBasisPoints: 0,
        unitCostMinorNumerator: "1",
        unitCostDenominator: "1",
        allergens: [],
      },
    ],
    preparationVersionReference: id(Number.parseInt(drink.recipe.slice(-4), 16) + 0x3000),
    steps: [
      {
        stepReference: id(Number.parseInt(drink.recipe.slice(-4), 16) + 0x4000),
        sequenceGroup: 0,
        instructionCode: "PREPARE",
        durationSeconds: 60,
        capabilityCode: "PREP",
      },
    ],
    substitutionPolicyReference: null,
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    invalidationReasonCode: null,
    createdAt: at,
  };
  await q(
    "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,$4,$5,$4)",
    [drink.recipe, brand, snapshot.stableCode, at, id(9)],
  );
  let evidence = Number.parseInt(drink.recipe.slice(-4), 16) + 0x5000;
  await q("BEGIN");
  try {
    await insertRecipeVersion(
      { query: (sql, values) => admin.query(sql, [...values]) },
      snapshot,
      () => id(++evidence),
    );
    await q(
      "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=2 WHERE recipe_id=$2",
      [version, drink.recipe],
    );
    await q(
      "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id(Number.parseInt(drink.recipe.slice(-4), 16) + 0x6000),
        version,
        drink.recipe,
        brand,
        drink.sku,
        scope.storeReference,
        at,
      ],
    );
    await q("COMMIT");
  } catch (error) {
    await q("ROLLBACK");
    throw error;
  }
}
