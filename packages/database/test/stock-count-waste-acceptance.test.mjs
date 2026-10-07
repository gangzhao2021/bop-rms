import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresStockCountPorts,
  createStoreReceipt,
  executeStockCountCommand,
  listStockCounts,
  listStoreWaste,
  loadStockCount,
  openStockCountAt,
  parseStoreReceiptLines,
  parseStoreWasteLines,
  postStoreReceipt,
  postStoreWaste,
  reviewStoreWaste,
  StockCountStaleError,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  expiryTracked,
  kilogram,
  litre,
  syntheticInventoryItems,
} from "../test-support/inventory-items.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";

const { Client } = pg;
const id = (n) => "01909a1a-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** WP-2423 / DEC-INV-STOCK-COUNT and DEC-INV-WASTE on the ledger, under the API's row-level security. */
it("counts blind, explains and posts variances, refreshes moved lines, and records and voids waste", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_count_waste" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let sequence = 1000,
      minute = 0;
    const next = () => id(++sequence);
    const clock = () => {
      minute += 1;
      return `2026-10-07T${String(10 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
    };
    const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
    const [owner, counter, manager] = [id(4), id(5), id(6)];
    const [site, back, fridge] = [id(10), id(11), id(12)];
    const role = "wp2423_count_" + context.runId;
    const transaction = (asRole) => async (work) => {
      await admin.query("BEGIN");
      try {
        if (asRole) await admin.query("SET LOCAL ROLE " + role);
        const value = await work(admin);
        await admin.query("COMMIT");
        return value;
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    };
    const setupTx = transaction(false);
    const tx = transaction(true);
    try {
      for (const location of [back, fridge])
        await ensureSyntheticStockPlace(admin, {
          tenantId: scope.tenantReference,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          stockSiteId: site,
          locationId: location,
          at: "2026-10-07T09:00:00.000Z",
        });
      const items = syntheticInventoryItems({ tx: setupTx, scope, actor: owner, next, clock });
      const beans = await items.create("BEANS", kilogram, "NoLot");
      const milk = await items.create("MILK", litre, "NoLot");
      const cream = await items.create("CREAM", litre, "LotExpiryRequired", expiryTracked);
      await setupTx((t) =>
        postStoreReceipt(t, scope, {
          operationReference: next(),
          receipt: createStoreReceipt({
            receiptReference: next(),
            ...scope,
            supplierName: "Roaster",
            supplierDocument: null,
            lines: parseStoreReceiptLines([
              {
                lineReference: next(),
                itemReference: beans,
                locationReference: back,
                lotCode: null,
                expiryDate: null,
                acceptedQuantity: "5",
                rejectedQuantity: "0",
                damagedQuantity: "0",
                discrepancyReason: null,
                unitCostMinor: 2450,
                temperatureCelsius: null,
              },
              {
                lineReference: next(),
                itemReference: cream,
                locationReference: fridge,
                lotCode: "C1",
                expiryDate: "2026-10-12",
                acceptedQuantity: "3",
                rejectedQuantity: "0",
                damagedQuantity: "0",
                discrepancyReason: null,
                unitCostMinor: 410,
                temperatureCelsius: "3.0",
              },
            ]),
            receivedBy: owner,
            receivedAt: clock(),
          }),
          auditReference: next(),
          nextReference: next,
        }),
      );
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      for (const sql of [
        "GRANT USAGE ON SCHEMA rms_inventory,platform_audit,platform_helpers TO ROLE_",
        "GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ROLE_",
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ROLE_",
        // As the pilot API: the first movement of an Item records its movement history.
        "GRANT SELECT,INSERT,UPDATE ON rms_inventory.inventory_item TO ROLE_",
        "GRANT SELECT,INSERT ON rms_inventory.inventory_item_version TO ROLE_",
        "GRANT SELECT ON rms_inventory.inventory_item_operation,rms_inventory.item_stock_exposure,rms_inventory.stock_site,rms_inventory.stock_site_version,rms_inventory.storage_location,rms_inventory.storage_location_version TO ROLE_",
        "GRANT SELECT,INSERT ON rms_inventory.stock_account,rms_inventory.stock_movement,rms_inventory.stock_lot,rms_inventory.stock_count_version,rms_inventory.stock_count_operation,rms_inventory.store_waste,rms_inventory.store_waste_review TO ROLE_",
        "GRANT SELECT,INSERT,UPDATE ON rms_inventory.stock_balance,rms_inventory.stock_count TO ROLE_",
        "GRANT SELECT,INSERT ON platform_audit.audit_record TO ROLE_",
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ROLE_",
      ])
        await admin.query(sql.replaceAll("ROLE_", role));

      const audit =
        (prefix) =>
        async ({ command, before, after }) => ({
          auditId: next(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: command.actorReference },
          actionCode: prefix + command.action.toUpperCase(),
          targetType: "StockCount",
          targetId: (after ?? before)?.countReference ?? command.operationReference,
          afterSummary: { status: after?.status ?? "Posted" },
          reasonCode: "STOCK_COUNT",
          correlationId: command.operationReference,
          occurredAt: command.occurredAt,
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Internal",
          retentionPolicyCode: "AUDIT_STANDARD",
          retentionPolicyVersion: 1,
        });
      const permissions = {
        Create: "inventory.count.manage",
        Cancel: "inventory.count.manage",
        Start: "inventory.count.execute",
        SaveLine: "inventory.count.execute",
        Submit: "inventory.count.execute",
        Refresh: "inventory.count.execute",
        Approve: "inventory.count.approve",
        Reject: "inventory.count.approve",
        ExplainVariance: "inventory.count.approve",
        Post: "inventory.count.approve",
      };
      const count = (actor, action, payload) =>
        tx((t) =>
          executeStockCountCommand(
            {
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              actorReference: actor,
              purpose: "StockCountManagement",
              permission: permissions[action],
              operationReference: next(),
              occurredAt: clock(),
              action,
              payload,
            },
            createPostgresStockCountPorts(t, scope, {
              nextReference: next,
              authorization: {
                authorize: async () => ({ authorized: true, mayViewExpected: true }),
              },
              audit: audit("INVENTORY_COUNT_"),
            }),
          ),
        );
      const create = await count(manager, "Create", {
        stockScope: { scopeType: "Location", scopeReference: back },
        countType: "Cycle",
        expectedQuantityVisibility: "BlindUntilSubmit",
        movementControl: "SnapshotOnly",
        approvalPolicy: "Segregated",
        assigneeReference: counter,
        dueAt: null,
      });
      const countRef = create.count.countReference;
      // The back room holds beans (an account) and milk (no account yet, expected 0); cream is lot-tracked elsewhere.
      const lineOf = (aggregate, item) =>
        aggregate.lines.find((line) => line.itemReference === item);
      assert.deepEqual(
        create.count.lines.map((line) => [line.itemReference, line.expectedQuantity]).sort(),
        [
          [beans, "5"],
          [milk, "0"],
        ].sort(),
      );
      assert.equal(await tx((t) => openStockCountAt(t, scope, back)), countRef);
      let current = create.count;
      const step = async (actor, action, extra = {}) => {
        current = (
          await count(actor, action, {
            countReference: countRef,
            expectedVersion: current.aggregateVersion,
            ...extra,
          })
        ).count;
        return current;
      };
      await assert.rejects(step(manager, "Start"), { code: "STOCK_COUNT_STATE_CONFLICT" });
      await step(counter, "Start");
      await step(counter, "SaveLine", {
        lineReference: lineOf(current, beans).lineReference,
        countedQuantity: "4.5",
        unitCode: "KG",
        varianceReasonCode: null,
      });
      await step(counter, "SaveLine", {
        lineReference: lineOf(current, milk).lineReference,
        countedQuantity: "1",
        unitCode: "L",
        varianceReasonCode: null,
      });
      await step(counter, "Submit");
      await assert.rejects(step(manager, "Approve", { reasonCode: "VARIANCE_APPROVED" }), {
        code: "STOCK_COUNT_INCOMPLETE",
      });
      await assert.rejects(
        step(counter, "ExplainVariance", {
          lineReference: lineOf(current, beans).lineReference,
          varianceReasonCode: "UNRECORDED_WASTE",
        }),
        { code: "STOCK_COUNT_SEGREGATION_REQUIRED" },
      );
      await step(manager, "ExplainVariance", {
        lineReference: lineOf(current, beans).lineReference,
        varianceReasonCode: "UNRECORDED_WASTE",
      });
      await step(manager, "ExplainVariance", {
        lineReference: lineOf(current, milk).lineReference,
        varianceReasonCode: "MISPLACED_STOCK",
      });
      await step(manager, "Approve", { reasonCode: "VARIANCE_APPROVED" });
      const posted = await count(manager, "Post", {
        countReference: countRef,
        expectedVersion: current.aggregateVersion,
      });
      assert.equal(posted.count.status, "Posted");
      assert.deepEqual(
        posted.movements.map((movement) => [movement.itemReference, movement.quantityDelta]).sort(),
        [
          [beans, "-0.5"],
          [milk, "1"],
        ].sort(),
      );
      const balance = async (item, location) =>
        (
          await admin.query(
            `SELECT b.on_hand::text v FROM rms_inventory.stock_account a JOIN rms_inventory.stock_balance b USING (tenant_id,brand_id,store_id,account_id)
             WHERE a.item_id=$1 AND a.location_id=$2`,
            [item, location],
          )
        ).rows[0]?.v;
      assert.equal(await balance(beans, back), "4.5");
      assert.equal(await balance(milk, back), "1");
      assert.equal(await tx((t) => openStockCountAt(t, scope, back)), null);

      // Stock moving after a count blocks posting those lines until they are refreshed and recounted.
      current = (
        await count(manager, "Create", {
          stockScope: { scopeType: "Location", scopeReference: back },
          countType: "Spot",
          expectedQuantityVisibility: "BlindUntilSubmit",
          movementControl: "SnapshotOnly",
          approvalPolicy: "Segregated",
          assigneeReference: counter,
          dueAt: null,
        })
      ).count;
      const second = current.countReference;
      const stepTwo = async (actor, action, extra = {}) => {
        current = (
          await count(actor, action, {
            countReference: second,
            expectedVersion: current.aggregateVersion,
            ...extra,
          })
        ).count;
        return current;
      };
      await stepTwo(counter, "Start");
      for (const [item, quantity, unit] of [
        [beans, "4", "KG"],
        [milk, "1", "L"],
      ])
        await stepTwo(counter, "SaveLine", {
          lineReference: lineOf(current, item).lineReference,
          countedQuantity: quantity,
          unitCode: unit,
          varianceReasonCode: null,
        });
      await stepTwo(counter, "Submit");
      await stepTwo(manager, "ExplainVariance", {
        lineReference: lineOf(current, beans).lineReference,
        varianceReasonCode: "UNEXPLAINED",
      });
      // Meanwhile 0.2 kg of beans is wasted.
      const waste = (actor, lines, wasteReference = next(), operationReference = next()) =>
        tx((t) =>
          postStoreWaste(t, scope, {
            operationReference,
            wasteReference,
            lines: parseStoreWasteLines(lines),
            actorReference: actor,
            occurredAt: clock(),
            auditReference: next(),
            nextReference: next,
          }),
        );
      const wasteLine = (overrides) => ({
        lineReference: next(),
        itemReference: beans,
        locationReference: back,
        lotReference: null,
        quantity: "0.2",
        reasonCode: "SPOILED",
        note: null,
        ...overrides,
      });
      const small = await waste(counter, [wasteLine({})]);
      assert.deepEqual([small.record.valueMinor, small.record.needsReview], [490, false]);
      // As in the API, approval and posting are one transaction: a stale line rolls both back.
      const command = (t, actor, action, payload) =>
        executeStockCountCommand(
          {
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            actorReference: actor,
            purpose: "StockCountManagement",
            permission: permissions[action],
            operationReference: next(),
            occurredAt: clock(),
            action,
            payload,
          },
          createPostgresStockCountPorts(t, scope, {
            nextReference: next,
            authorization: { authorize: async () => ({ authorized: true, mayViewExpected: true }) },
            audit: audit("INVENTORY_COUNT_"),
          }),
        );
      const approveAndPost = (reference, version) =>
        tx(async (t) => {
          const approved = await command(t, manager, "Approve", {
            countReference: reference,
            expectedVersion: version,
            reasonCode: "VARIANCE_APPROVED",
          });
          return command(t, manager, "Post", {
            countReference: reference,
            expectedVersion: approved.count.aggregateVersion,
          });
        });
      const stale = await approveAndPost(second, current.aggregateVersion).catch((error) => error);
      assert.ok(stale instanceof StockCountStaleError);
      assert.deepEqual(stale.lineReferences, [lineOf(current, beans).lineReference]);
      current = await tx((t) => loadStockCount(t, scope, second));
      assert.equal(current.status, "Submitted");
      await stepTwo(manager, "Reject", { reasonCode: "RECOUNT_REQUIRED" });
      await stepTwo(counter, "Refresh");
      assert.deepEqual(
        [lineOf(current, beans).expectedQuantity, lineOf(current, beans).countedQuantity],
        ["4.3", null],
      );
      // The unmoved milk line keeps its count.
      assert.equal(lineOf(current, milk).countedQuantity, "1");
      await stepTwo(counter, "SaveLine", {
        lineReference: lineOf(current, beans).lineReference,
        countedQuantity: "4.3",
        unitCode: "KG",
        varianceReasonCode: null,
      });
      await stepTwo(counter, "Submit");
      const clean = await approveAndPost(second, current.aggregateVersion);
      assert.deepEqual([clean.count.status, clean.movements.length], ["Posted", 0]);
      const third = (
        await count(manager, "Create", {
          stockScope: { scopeType: "Location", scopeReference: fridge },
          countType: "Spot",
          expectedQuantityVisibility: "BlindUntilSubmit",
          movementControl: "SnapshotOnly",
          approvalPolicy: "Segregated",
          assigneeReference: counter,
          dueAt: null,
        })
      ).count;
      current = third;
      const stepThree = async (actor, action, extra = {}) => {
        current = (
          await count(actor, action, {
            countReference: third.countReference,
            expectedVersion: current.aggregateVersion,
            ...extra,
          })
        ).count;
        return current;
      };
      // Cream is lot-tracked: its lot account is on the sheet, with the lot.
      assert.equal(lineOf(current, cream).expectedQuantity, "3");
      assert.notEqual(lineOf(current, cream).lotReference, null);
      await stepThree(counter, "Start");
      await stepThree(counter, "SaveLine", {
        lineReference: lineOf(current, cream).lineReference,
        countedQuantity: "2",
        unitCode: "L",
        varianceReasonCode: null,
      });
      for (const line of current.lines.filter((item) => item.countedQuantity === null))
        await stepThree(counter, "SaveLine", {
          lineReference: line.lineReference,
          countedQuantity: "0",
          unitCode: line.unitCode,
          varianceReasonCode: null,
        });
      await stepThree(counter, "Submit");
      // Cream moves (waste of its lot) after the count: send back, refresh, recount, then post.
      const lot = lineOf(current, cream).lotReference;
      await waste(counter, [
        wasteLine({
          itemReference: cream,
          locationReference: fridge,
          lotReference: lot,
          quantity: "1",
          reasonCode: "EXPIRED",
        }),
      ]);
      await stepThree(manager, "Reject", { reasonCode: "RECOUNT_REQUIRED" });
      assert.equal(current.status, "InProgress");
      await stepThree(counter, "Refresh");
      assert.deepEqual(
        [lineOf(current, cream).expectedQuantity, lineOf(current, cream).countedQuantity],
        ["2", null],
      );
      await assert.rejects(stepThree(counter, "Refresh"), { code: "STOCK_COUNT_STATE_CONFLICT" });
      await stepThree(counter, "SaveLine", {
        lineReference: lineOf(current, cream).lineReference,
        countedQuantity: "2",
        unitCode: "L",
        varianceReasonCode: null,
      });
      await stepThree(counter, "Submit");
      await stepThree(manager, "Approve", { reasonCode: "VARIANCE_APPROVED" });
      const zero = await count(manager, "Post", {
        countReference: third.countReference,
        expectedVersion: current.aggregateVersion,
      });
      assert.deepEqual([zero.count.status, zero.movements.length], ["Posted", 0]);

      // Waste: high value needs an independent review; voiding puts the quantity back.
      assert.equal(await balance(beans, back), "4.3");
      await assert.rejects(waste(counter, [wasteLine({ quantity: "9" })]), {
        code: "STORE_WASTE_NOT_ENOUGH_STOCK",
      });
      await assert.rejects(
        waste(counter, [wasteLine({ itemReference: cream, locationReference: fridge })]),
        { code: "STORE_WASTE_LINE_INVALID" },
      );
      assert.throws(() => parseStoreWasteLines([wasteLine({ reasonCode: "OTHER" })]), {
        code: "STORE_WASTE_LINE_INVALID",
      });
      const bigReference = next(),
        bigOperation = next();
      const big = await waste(
        counter,
        [wasteLine({ quantity: "2", reasonCode: "DROPPED" })],
        bigReference,
        bigOperation,
      );
      assert.deepEqual([big.record.valueMinor, big.record.needsReview], [4900, true]);
      assert.equal(
        (
          await waste(
            counter,
            [wasteLine({ quantity: "2", reasonCode: "DROPPED" })],
            bigReference,
            bigOperation,
          ).catch((e) => e)
        ).code,
        "STORE_WASTE_IDEMPOTENCY_CONFLICT",
      );
      assert.equal(await balance(beans, back), "2.3");
      const review = (actor, decision, reasonCode) =>
        tx((t) =>
          reviewStoreWaste(t, scope, {
            operationReference: next(),
            wasteReference: bigReference,
            decision,
            reasonCode,
            actorReference: actor,
            occurredAt: clock(),
            auditReference: next(),
            nextReference: next,
          }),
        );
      await assert.rejects(review(counter, "Voided", "ENTERED_IN_ERROR"), {
        code: "STORE_WASTE_REVIEWER_NOT_INDEPENDENT",
      });
      const listed = await tx((t) =>
        listStoreWaste(t, scope, { before: null, limit: 10, needsReviewOnly: true }),
      );
      assert.deepEqual(
        listed.records.map((record) => record.wasteReference),
        [bigReference],
      );
      assert.equal(
        (await review(manager, "Voided", "ENTERED_IN_ERROR")).record.review.decision,
        "Voided",
      );
      assert.equal(await balance(beans, back), "4.3");
      await assert.rejects(review(manager, "Accepted", "REVIEWED_OK"), {
        code: "STORE_WASTE_ALREADY_REVIEWED",
      });
      await assert.rejects(
        admin.query("UPDATE rms_inventory.store_waste SET value_minor=0"),
        /append-only/u,
      );
      const page = await tx((t) => listStockCounts(t, scope, { before: null, limit: 10 }));
      assert.deepEqual(
        page.counts.map((item) => item.status),
        ["Posted", "Posted", "Posted"],
      );
    } finally {
      await admin.end();
    }
  });
});
