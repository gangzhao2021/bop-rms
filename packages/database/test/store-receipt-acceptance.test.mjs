import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  appendStockMovement,
  createStoreReceipt,
  ensureStockAccount,
  listStoreReceipts,
  openingCountReferences,
  parseStoreReceiptLines,
  postStoreReceipt,
  voidStoreReceipt,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";
import {
  expiryTracked,
  kilogram,
  litre,
  syntheticInventoryItems,
} from "../test-support/inventory-items.mjs";

const { Client } = pg;
const id = (n) => "01909a14-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** WP-2423 / DEC-INV-DIRECT-RECEIPT: Store direct receipts and their voids on the ledger. */
it("posts Store direct receipts as Receive movements and voids them only while the stock is unused", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_receipt" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let sequence = 1000,
      minute = 0;
    const next = () => id(++sequence);
    const clock = () => `2026-10-07T10:${String(++minute).padStart(2, "0")}:00.000Z`;
    const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
    const receiver = id(4);
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
          at: "2026-10-07T09:00:00.000Z",
        });
      const items = syntheticInventoryItems({ tx, scope, actor: receiver, next, clock });
      const milk = await items.create("MILK", litre, "LotExpiryRequired", expiryTracked);
      const beans = await items.create("BEANS", kilogram, "NoLot");
      const line = (overrides) => ({
        lineReference: next(),
        itemReference: beans,
        locationReference: back,
        lotCode: null,
        expiryDate: null,
        acceptedQuantity: "5",
        rejectedQuantity: "0",
        damagedQuantity: "0",
        discrepancyReason: null,
        unitCostMinor: 1850,
        temperatureCelsius: null,
        ...overrides,
      });
      // A rejected or damaged quantity needs its reason; a reason needs such a quantity.
      assert.throws(() => parseStoreReceiptLines([line({ rejectedQuantity: "1" })]), {
        code: "STORE_RECEIPT_LINE_INVALID",
      });
      assert.throws(() => parseStoreReceiptLines([line({ discrepancyReason: "QUALITY" })]), {
        code: "STORE_RECEIPT_LINE_INVALID",
      });
      const receipt = (lines, supplier = "Metro Wholesale") =>
        createStoreReceipt({
          receiptReference: next(),
          ...scope,
          supplierName: supplier,
          supplierDocument: "INV-20391",
          lines: parseStoreReceiptLines(lines),
          receivedBy: receiver,
          receivedAt: clock(),
        });
      const post = (value, operation = next()) =>
        tx((t) =>
          postStoreReceipt(t, scope, {
            operationReference: operation,
            receipt: value,
            auditReference: next(),
            nextReference: next,
          }),
        );
      const first = receipt([
        line({}),
        line({
          itemReference: milk,
          locationReference: fridge,
          lotCode: "L2410A",
          expiryDate: "2026-10-20",
          acceptedQuantity: "6",
          damagedQuantity: "1",
          discrepancyReason: "DAMAGED_IN_TRANSIT",
          unitCostMinor: 289,
          temperatureCelsius: "3.5",
        }),
      ]);
      const operation = next();
      const posted = await post(first, operation);
      assert.deepEqual(
        { status: posted.status, movements: posted.receipt.movements.length },
        { status: "Applied", movements: 2 },
      );
      assert.equal((await post(first, operation)).status, "AlreadyApplied");
      // A lot code is one lot: another receipt cannot give it a different expiry.
      const conflicting = line({
        itemReference: milk,
        locationReference: fridge,
        lotCode: "L2410A",
        expiryDate: "2026-10-25",
        acceptedQuantity: "1",
      });
      await assert.rejects(post(receipt([conflicting])), {
        code: "STORE_RECEIPT_LINE_INVALID",
        lineReference: conflicting.lineReference,
      });
      // Milk must carry its lot and expiry when stocked.
      await assert.rejects(
        post(receipt([line({ itemReference: milk, locationReference: fridge })])),
        {
          code: "STORE_RECEIPT_LINE_INVALID",
        },
      );
      await admin.query(
        "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false),set_config('bop.store_id',$3,false)",
        Object.values(scope),
      );
      const onHand = async (item) =>
        (
          await admin.query(
            "SELECT sum(b.on_hand)::text v FROM rms_inventory.stock_balance b JOIN rms_inventory.stock_account a USING (tenant_id,brand_id,store_id,account_id) WHERE a.item_id=$1",
            [item],
          )
        ).rows[0].v;
      assert.equal(Number(await onHand(beans)), 5);
      assert.equal(Number(await onHand(milk)), 6);

      // Use 3 kg of the received beans; the receipt can no longer be voided.
      await tx(async (t) => {
        const refs = await openingCountReferences(t, scope, [beans]);
        const account = await ensureStockAccount(t, scope, {
          item: refs.items.get(beans),
          location: refs.locations.get(back),
          lotReference: null,
          expiryDate: null,
          occurredAt: clock(),
          nextReference: next,
          open: false,
        });
        await appendStockMovement(t, scope, {
          account,
          item: refs.items.get(beans),
          location: refs.locations.get(back),
          lotReference: null,
          expiryDate: null,
          movementType: "Waste",
          delta: "-3",
          businessSourceType: "SYNTHETIC_TEST",
          businessSourceReference: next(),
          reasonCode: "SYNTHETIC_TEST",
          actorReference: receiver,
          occurredAt: clock(),
          auditReference: next(),
          nextReference: next,
        });
      });
      const voidReceipt = (reference, operationReference = next()) =>
        tx((t) =>
          voidStoreReceipt(t, scope, {
            operationReference,
            receiptReference: reference,
            reasonCode: "ENTERED_IN_ERROR",
            actorReference: receiver,
            occurredAt: clock(),
            auditReference: next(),
            nextReference: next,
          }),
        );
      await assert.rejects(voidReceipt(first.receiptReference), {
        code: "STORE_RECEIPT_STOCK_USED",
        lineReference: first.lines[0].lineReference,
      });
      // A second receipt still untouched is voided with Correction movements.
      const second = receipt([line({ acceptedQuantity: "2.25" })], "Corner grocery");
      await post(second);
      assert.equal(Number(await onHand(beans)), 4.25);
      const voidOperation = next();
      const voided = await voidReceipt(second.receiptReference, voidOperation);
      assert.equal(voided.receipt.voided.reasonCode, "ENTERED_IN_ERROR");
      assert.equal(Number(await onHand(beans)), 2);
      assert.equal(
        (await voidReceipt(second.receiptReference, voidOperation)).status,
        "AlreadyApplied",
      );
      await assert.rejects(voidReceipt(second.receiptReference), {
        code: "STORE_RECEIPT_ALREADY_VOIDED",
      });
      const corrections = (
        await admin.query(
          "SELECT movement_type,base_quantity_delta::text d FROM rms_inventory.stock_movement WHERE record_json->>'businessSourceType'='StoreReceiptVoid'",
        )
      ).rows;
      assert.deepEqual(corrections, [{ movement_type: "Correction", d: "-2.25" }]);
      const listed = await tx((t) => listStoreReceipts(t, scope, { before: null, limit: 10 }));
      assert.deepEqual(
        listed.receipts.map((r) => [r.supplierName, r.voided === null ? "Posted" : "Voided"]),
        [
          ["Corner grocery", "Voided"],
          ["Metro Wholesale", "Posted"],
        ],
      );
      // Rejected and damaged quantities are recorded, never stocked.
      assert.equal(listed.receipts[1].lines[1].damagedQuantity, "1");
    } finally {
      await admin.end().catch(() => undefined);
    }
  });
});
