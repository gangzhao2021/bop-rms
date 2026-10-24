import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  commitOpeningCountChange,
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
  listOpeningCounts,
  postOpeningCount,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";

const { Client } = pg;
const id = (n) => "01909a11-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = (minute) => `2026-10-07T10:${String(minute).padStart(2, "0")}:00.000Z`;

/** WP-2423 / DEC-INV-OPENING: the Store's one audited opening count becomes first ledger movements. */
it("validates, posts once and writes each opening line as the account's first movement", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_opening" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let sequence = 1000;
    const next = () => id(++sequence);
    const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
    const [owner, counter] = [id(4), id(5)];
    const [site, back, fridge] = [id(10), id(11), id(12)];
    try {
      const tx = async (work) => {
        await admin.query("BEGIN");
        try {
          const value = await work(admin);
          await admin.query("COMMIT");
          return value;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      for (const location of [back, fridge])
        await ensureSyntheticStockPlace(admin, {
          tenantId: scope.tenantReference,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          stockSiteId: site,
          locationId: location,
          at: at(0),
        });
      const itemStore = createPostgresInventoryItemStore(
        { run: tx },
        { tenantReference: scope.tenantReference, brandReference: scope.brandReference },
      );
      let minute = 0;
      const itemCommand = (action, payload) =>
        executeInventoryItemCommand(
          {
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            actorReference: owner,
            purpose: "InventoryItemManagement",
            operationReference: next(),
            occurredAt: at(++minute),
            action,
            payload,
          },
          {
            authorization: { authorize: async () => ({ authorized: true }) },
            audit: {
              create: async ({ command, after }) => ({
                auditId: next(),
                brandId: command.brandReference,
                actor: { type: "User", reference: command.actorReference },
                actionCode: "INVENTORY_ITEM_" + command.action.toUpperCase(),
                targetType: "InventoryItem",
                targetId: after.itemReference,
                reasonCode: "SYNTHETIC_CHANGE",
                correlationId: command.operationReference,
                occurredAt: command.occurredAt,
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Internal",
                retentionPolicyCode: "AUDIT_STANDARD",
                retentionPolicyVersion: 1,
              }),
            },
            references: {
              generate: next,
              hashIntent: (value) =>
                "sha256:" + Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64),
              equals: (a, b) => a === b,
            },
            repository: itemStore,
          },
        );
      const item = async (code, unit, lotTrackingMode, extra = {}) => {
        const created = (
          await itemCommand("Create", {
            internalCode: code,
            itemType: "RawMaterial",
            localizedNames: { en: code },
            baseUnit: unit,
            trackingPolicy: {
              stockTrackingEnabled: true,
              lotTrackingMode,
              defaultShelfLifeDays: null,
              expiryWarningDays: null,
              issuePolicy: "FIFO",
              negativeStockPolicy: "Block",
              ...extra,
            },
          })
        ).item;
        await itemCommand("Activate", {
          itemReference: created.itemReference,
          expectedVersion: 1,
          reasonCode: "READY",
        });
        return created.itemReference;
      };
      const litre = {
        unitCode: "L",
        dimension: "Volume",
        displayPrecision: 3,
        ledgerPrecision: 4,
        roundingMode: "HalfEven",
      };
      const kg = {
        unitCode: "KG",
        dimension: "Mass",
        displayPrecision: 3,
        ledgerPrecision: 4,
        roundingMode: "HalfEven",
      };
      const milk = await item("MILK", litre, "LotExpiryRequired", {
        defaultShelfLifeDays: 10,
        expiryWarningDays: 2,
        issuePolicy: "FEFO",
      });
      const beans = await item("BEANS", kg, "NoLot");

      const change = (countReference, changeValue, actor = counter, operation = next()) =>
        tx((t) =>
          commitOpeningCountChange(t, scope, {
            operationReference: operation,
            countReference,
            change: changeValue,
            actorReference: actor,
            occurredAt: at(++minute),
            auditReference: next(),
          }),
        );
      const count = next();
      await change(count, { action: "Create", countReference: count });
      const line = (overrides) => ({
        lineReference: next(),
        itemReference: beans,
        locationReference: back,
        lotCode: null,
        expiryDate: null,
        quantity: "12.5",
        unitCostMinor: 1850,
        ...overrides,
      });
      const save = (version, lines) =>
        change(count, { action: "SaveLines", expectedVersion: version, lines });
      // Lot/expiry rules follow each item's tracking mode, quantities its ledger precision.
      const missingExpiry = line({
        itemReference: milk,
        locationReference: fridge,
        lotCode: "L2410A",
      });
      await assert.rejects(save(1, [missingExpiry]), {
        code: "OPENING_COUNT_LINE_INVALID",
        lineReference: missingExpiry.lineReference,
      });
      await assert.rejects(save(1, [line({ quantity: "1.12345" })]), {
        code: "OPENING_COUNT_LINE_INVALID",
      });
      await assert.rejects(save(1, [line({ lotCode: "X1" })]), {
        code: "OPENING_COUNT_LINE_INVALID",
      });
      const lines = [
        line({}),
        line({
          itemReference: milk,
          locationReference: fridge,
          lotCode: "L2410A",
          expiryDate: "2026-10-15",
          quantity: "8",
          unitCostMinor: 289,
        }),
        line({
          itemReference: milk,
          locationReference: fridge,
          lotCode: "L2410B",
          expiryDate: "2026-10-18",
          quantity: "4",
          unitCostMinor: 289,
        }),
      ];
      await save(1, lines);
      await assert.rejects(change(count, { action: "Post", expectedVersion: 2 }), {
        code: "OPENING_COUNT_INVALID",
      });
      await change(count, { action: "Submit", expectedVersion: 2 });

      const postOperation = next();
      const post = (operation = postOperation) =>
        tx((t) =>
          postOpeningCount(t, scope, {
            operationReference: operation,
            countReference: count,
            change: { action: "Post", expectedVersion: 3 },
            actorReference: owner,
            occurredAt: at(40),
            auditReference: next(),
            nextReference: next,
          }),
        );
      const posted = await post();
      assert.deepEqual(
        { status: posted.status, movements: posted.movements },
        { status: "Applied", movements: 3 },
      );
      assert.equal((await post()).status, "AlreadyApplied");
      await assert.rejects(post(next()), { code: "OPENING_COUNT_ALREADY_POSTED" });
      const another = next();
      await assert.rejects(change(another, { action: "Create", countReference: another }), {
        code: "OPENING_COUNT_ALREADY_POSTED",
      });

      await admin.query(
        "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false),set_config('bop.store_id',$3,false)",
        [scope.tenantReference, scope.brandReference, scope.storeReference],
      );
      const ledger = (
        await admin.query(
          `SELECT a.item_id::text item,a.location_id::text location,l.lot_code,a.expiry_date::text expiry,b.on_hand::text on_hand,
             m.movement_type,m.ledger_version::int version
           FROM rms_inventory.stock_account a JOIN rms_inventory.stock_balance b USING (tenant_id,brand_id,store_id,account_id)
           JOIN rms_inventory.stock_movement m USING (tenant_id,brand_id,store_id,account_id)
           LEFT JOIN rms_inventory.stock_lot l ON l.tenant_id=a.tenant_id AND l.brand_id=a.brand_id AND l.store_id=a.store_id AND l.lot_id=a.lot_id
           ORDER BY l.lot_code NULLS FIRST`,
        )
      ).rows;
      assert.deepEqual(
        ledger.map((row) => [
          row.item === milk ? "MILK" : "BEANS",
          row.lot_code,
          row.expiry,
          Number(row.on_hand),
          row.movement_type,
          row.version,
        ]),
        [
          ["BEANS", null, null, 12.5, "OpeningBalance", 2],
          ["MILK", "L2410A", "2026-10-15", 8, "OpeningBalance", 2],
          ["MILK", "L2410B", "2026-10-18", 4, "OpeningBalance", 2],
        ],
      );
      // The first movement marks the item; its base unit is now fixed.
      await admin.query("SELECT set_config('bop.store_id','',false)");
      assert.equal((await itemStore.load(milk)).hasMovementHistory, true);
      const listed = await tx((t) => listOpeningCounts(t, scope));
      assert.deepEqual(
        { posted: listed.postedCountReference, lifecycle: listed.counts[0].lifecycle },
        { posted: count, lifecycle: "Posted" },
      );
      // An opening balance can only ever be an account's first movement.
      await admin.query("SELECT set_config('bop.store_id',$1,false)", [scope.storeReference]);
      const account = (
        await admin.query(
          "SELECT account_id::text a FROM rms_inventory.stock_account WHERE item_id=$1",
          [beans],
        )
      ).rows[0].a;
      const movement = next(),
        audit = next();
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,3,'OpeningBalance',1,$6,$7,$8)",
          [
            ...Object.values(scope),
            account,
            movement,
            {
              movementReference: movement,
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              itemReference: beans,
              movementType: "OpeningBalance",
              baseQuantityDelta: "1",
              baseUnitCode: "KG",
              sourceScope: null,
              destinationScope: { scopeType: "Location", scopeReference: back },
              lotReference: null,
              expiryDate: null,
              before: {
                onHand: "12.5",
                reserved: "0",
                available: "12.5",
                inTransit: "0",
                unitCode: "KG",
                ledgerVersion: 2,
              },
              after: {
                onHand: "13.5",
                reserved: "0",
                available: "13.5",
                inTransit: "0",
                unitCode: "KG",
                ledgerVersion: 3,
              },
              auditReference: audit,
              occurredAt: at(50),
            },
            audit,
            at(50),
          ],
        ),
        /arithmetic mismatch/u,
      );
    } finally {
      await admin.end().catch(() => undefined);
    }
  });
});
