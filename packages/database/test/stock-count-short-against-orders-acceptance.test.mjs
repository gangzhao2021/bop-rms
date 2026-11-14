import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { canonicalizeRfc8785 } from "../../bop/audit/src/index.ts";
import {
  advanceInventoryReservation,
  createInventoryReservation,
  createPostgresOrderLineConsumptionStore,
  createPostgresStockCountPorts,
  createPostgresStockReservationStore,
  createPostgresSubmissionReservationStore,
  createPostgresSubmissionStockPlanSource,
  executeStockCountCommand,
  listStoreStockShortages,
  listWasteableStock,
  parseStoreWasteLines,
  postStoreWaste,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { grantPilotApiAcl } from "../test-support/pilot-api-acl.mjs";
import { seedSyntheticInventoryItems } from "../test-support/recipe-inventory-observation.mjs";

const { Client } = pg;
const id = (n) => "01909a3d-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = (minute) => `2026-10-07T10:${String(minute).padStart(2, "0")}:00.000Z`;
const sha = (value) =>
  "sha256:" + createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex");

/**
 * WP-2423 (2026-10-18) DEC-INV-COUNT-SHORT, on the real ledger under a NOBYPASSRLS role holding
 * exactly the rendered pilot API grants (synthetic Store, item and orders): a physical count lower
 * than what open orders hold is posted and keeps their reservations; the account is listed short
 * against those orders; no new order or adjustment can take the missing stock (application and
 * ledger trigger), while waste up to on hand is recorded and deepens the shortage (2026-10-18
 * amendment) without touching reservations; the orders can still be made (the part on-hand does not cover is recorded
 * as USED_BEYOND_COUNT, on-hand never negative) or cancelled (released); the ledger balances; and a
 * later count clears the "used beyond the count" notice.
 */
it("posts a count below what open orders hold, keeps them fulfillable and cancellable, and balances the ledger", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_count_short" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_cshort_api_" + context.runId,
      seeder = "wp2423_cshort_seed_" + context.runId;
    let sequence = 1000;
    const next = () => id(++sequence);
    const scope = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      stockSiteReference: id(4),
    };
    const owner = {
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    };
    try {
      for (const role of [api, seeder])
        await admin.query(
          "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      await grantPilotApiAcl(admin, api);
      for (const sql of [
        "GRANT USAGE ON SCHEMA rms_inventory,platform_helpers,platform_audit TO ROLE_",
        "GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ROLE_",
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ROLE_",
        "GRANT SELECT,INSERT,UPDATE ON rms_inventory.inventory_item TO ROLE_",
        "GRANT SELECT,INSERT ON rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation,platform_audit.audit_record TO ROLE_",
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ROLE_",
      ])
        await admin.query(sql.replaceAll("ROLE_", seeder));
      const itemRunner = {
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
      const item = id(10),
        itemOperation = id(11);
      // 1 kg on hand (ledger precision 4).
      const [{ accountReference: account }] = await seedSyntheticInventoryItems({
        admin,
        role: seeder,
        runner: itemRunner,
        id,
        at: at(0),
        scope,
        next,
        items: [{ itemReference: item, operationReference: itemOperation, onHand: "1" }],
      });
      await admin.query("RESET ROLE");
      const location = (
        await admin.query(
          "SELECT location_id::text l FROM rms_inventory.stock_account WHERE account_id=$1",
          [account],
        )
      ).rows[0].l;

      async function asApi(work) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + api);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [scope.tenantReference, scope.brandReference, scope.storeReference],
          );
          const result = await work(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      }
      const runner = (client) => ({ run: async (inner) => inner(client) });
      const noLot = {
        resolveExpiryCutoff: async () => {
          throw new Error("NoLot fixture");
        },
      };
      const cook = id(60),
        counter = id(61),
        manager = id(62);
      const audit = (actor, actionCode, targetType, targetId, correlationId, minute) => ({
        auditId: next(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "User", reference: actor },
        actionCode,
        targetType,
        targetId,
        reasonCode: "SYNTHETIC_TEST",
        correlationId,
        occurredAt: at(minute),
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "SYNTHETIC_AUDIT",
        retentionPolicyVersion: 1,
      });

      // Three Order lines of one round each hold 1/3 kg (0.3333): 0.9999 kg reserved.
      const [lineA, lineB, lineC] = [id(30), id(31), id(32)];
      const demandFor = (submission, lines) => {
        const demand = {
          ...scope,
          submissionReference: submission,
          cartReference: id(20),
          cartVersion: 2,
          quoteReference: id(21),
          demandReference: next(),
          workflowReference: id(22),
          workflowVersion: 1,
          reserveTrigger: "OrderSubmission",
          sourceDigest: "sha256:" + "c".repeat(64),
          contributions: lines.map((line) => ({
            itemReference: item,
            configurationOperationReference: itemOperation,
            unitDimension: "Mass",
            quantityNumerator: "1000000",
            quantityDenominator: "3",
            cartItemReference: line,
          })),
        };
        return { demand, digest: sha(demand) };
      };
      const { demand, digest } = demandFor(id(40), [lineA, lineB, lineC]);
      const plan = await asApi((client) =>
        createPostgresSubmissionStockPlanSource(runner(client), owner, noLot).resolve(
          demand,
          at(0),
        ),
      );
      const writes = plan.allocations.map((allocation) => {
        const reservationReference = next(),
          operationReference = next();
        return {
          operationReference,
          accountReference: allocation.accountReference,
          action: "Reserve",
          expectedLedgerVersion: allocation.expectedLedgerVersion,
          quantity: allocation.quantity,
          movementReference: next(),
          reservation: createInventoryReservation({
            reservationReference,
            unit: allocation.unit,
            quantity: allocation.quantity,
            occurredAt: at(0),
            binding: {
              ...scope,
              locationReference: allocation.locationReference,
              itemReference: allocation.itemReference,
              lotReference: allocation.lotReference,
              submissionReference: demand.submissionReference,
              cartReference: demand.cartReference,
              cartVersion: demand.cartVersion,
              quoteReference: demand.quoteReference,
              demandReference: demand.demandReference,
              demandDigest: digest,
              cartItemReference: allocation.cartItemReference,
            },
          }),
          audit: audit(
            cook,
            "INVENTORY_RESERVATION_RESERVE",
            "InventoryReservation",
            reservationReference,
            operationReference,
            0,
          ),
        };
      });
      const setReference = next(),
        setOperation = next();
      await asApi((client) =>
        createPostgresSubmissionReservationStore(runner(client), owner, {
          authorize: async () => true,
          resolveDemand: async () => demand,
          ...noLot,
        }).commit({
          setReference,
          operationReference: setOperation,
          workflowReference: demand.workflowReference,
          workflowVersion: demand.workflowVersion,
          writes,
          audit: audit(
            cook,
            "INVENTORY_RESERVATION_SET",
            "InventoryReservationSet",
            setReference,
            setOperation,
            0,
          ),
        }),
      );
      const balance = async () =>
        (
          await admin.query(
            "SELECT ledger_version::int v,on_hand::text h,reserved::text r,available::text a FROM rms_inventory.stock_balance WHERE account_id=$1",
            [account],
          )
        ).rows[0];
      assert.deepEqual(await balance(), { v: 5, h: "1", r: "0.9999", a: "0.0001" });

      // The count finds 0.5 kg: it posts (the old reserved<=on_hand table rule refused it).
      const permissions = {
        Create: "inventory.count.manage",
        Start: "inventory.count.execute",
        SaveLine: "inventory.count.execute",
        Submit: "inventory.count.execute",
        Approve: "inventory.count.approve",
        ExplainVariance: "inventory.count.approve",
        Post: "inventory.count.approve",
      };
      let minute = 1;
      const count = (actor, action, payload) =>
        asApi((client) =>
          executeStockCountCommand(
            {
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              actorReference: actor,
              purpose: "StockCountManagement",
              permission: permissions[action],
              operationReference: next(),
              occurredAt: at(minute++),
              action,
              payload,
            },
            createPostgresStockCountPorts(client, owner, {
              nextReference: next,
              authorization: {
                authorize: async () => ({ authorized: true, mayViewExpected: true }),
              },
              audit: async ({ command, before, after }) =>
                audit(
                  command.actorReference,
                  "INVENTORY_COUNT_" + command.action.toUpperCase(),
                  "StockCount",
                  (after ?? before)?.countReference ?? command.operationReference,
                  command.operationReference,
                  minute - 1,
                ),
            }),
          ),
        );
      const countAll = async (counted, reason) => {
        let current = (
          await count(manager, "Create", {
            stockScope: { scopeType: "Location", scopeReference: location },
            countType: "Spot",
            expectedQuantityVisibility: "BlindUntilSubmit",
            movementControl: "SnapshotOnly",
            approvalPolicy: "Segregated",
            assigneeReference: counter,
            dueAt: null,
          })
        ).count;
        const step = async (actor, action, extra = {}) =>
          (current = (
            await count(actor, action, {
              countReference: current.countReference,
              expectedVersion: current.aggregateVersion,
              ...extra,
            })
          ).count);
        await step(counter, "Start");
        const line = current.lines.find((entry) => entry.itemReference === item);
        await step(counter, "SaveLine", {
          lineReference: line.lineReference,
          countedQuantity: counted,
          unitCode: "KG",
          varianceReasonCode: null,
        });
        await step(counter, "Submit");
        if (reason !== null)
          await step(manager, "ExplainVariance", {
            lineReference: line.lineReference,
            varianceReasonCode: reason,
          });
        await step(manager, "Approve", { reasonCode: "VARIANCE_APPROVED" });
        return count(manager, "Post", {
          countReference: current.countReference,
          expectedVersion: current.aggregateVersion,
        });
      };
      const posted = await countAll("0.5", "THEFT_OR_LOSS");
      assert.equal(posted.count.status, "Posted");
      assert.deepEqual(
        posted.movements.map((m) => [m.movementType, m.quantityDelta, m.after.available]),
        [["CountAdjustment", "-0.5", "-0.4999"]],
      );
      assert.deepEqual(await balance(), { v: 6, h: "0.5", r: "0.9999", a: "-0.4999" });

      // The manager's notice: short by 0.4999 kg against the round holding it.
      const shortages = () => asApi((client) => listStoreStockShortages(client, owner));
      assert.deepEqual(await shortages(), [
        {
          accountReference: account,
          itemReference: item,
          locationReference: location,
          lotReference: null,
          unitCode: "KG",
          onHand: "0.5",
          reserved: "0.9999",
          shortQuantity: "0.4999",
          usedBeyondCount: "0",
          holding: [{ submissionReference: id(40), quantity: "0.9999" }],
        },
      ]);

      // No new order can reserve it: the stock plan and the ledger both refuse.
      await assert.rejects(
        asApi((client) =>
          createPostgresSubmissionStockPlanSource(runner(client), owner, noLot).resolve(
            demandFor(id(41), [id(33)]).demand,
            at(minute),
          ),
        ),
        { code: "STOCK_RESERVATION_INSUFFICIENT" },
      );
      // DEC-INV-COUNT-SHORT amendment (2026-10-18): what was thrown away is gone, so waste up to
      // what is on hand is recorded even though open orders hold it (the shortage grows, their
      // reservations are untouched); more than is on hand is refused.
      const waste = (quantity) =>
        asApi((client) =>
          postStoreWaste(client, owner, {
            operationReference: next(),
            wasteReference: next(),
            lines: parseStoreWasteLines([
              {
                lineReference: next(),
                itemReference: item,
                locationReference: location,
                lotReference: null,
                quantity,
                reasonCode: "DROPPED",
                note: null,
              },
            ]),
            actorReference: cook,
            occurredAt: at(minute),
            auditReference: next(),
            nextReference: next,
          }),
        );
      // v15 D1: the waste form lists the held item with what is there and what orders hold.
      assert.deepEqual(
        (await asApi((client) => listWasteableStock(client, owner))).map((row) => [
          row.itemReference,
          row.onHand,
          row.reserved,
          row.available,
        ]),
        [[item, "0.5", "0.9999", "-0.4999"]],
      );
      const reservationsBefore = (
        await admin.query(
          "SELECT count(*)::int n FROM rms_inventory.stock_reservation_version WHERE account_id=$1",
          [account],
        )
      ).rows[0].n;
      await assert.rejects(waste("0.5001"), { code: "STORE_WASTE_NOT_ENOUGH_STOCK" });
      assert.deepEqual(await balance(), { v: 6, h: "0.5", r: "0.9999", a: "-0.4999" });
      const wasted = await waste("0.1");
      assert.equal(wasted.status, "Applied");
      assert.deepEqual(
        wasted.record.lines.map((line) => line.quantity),
        ["0.1"],
      );
      assert.equal(wasted.record.shortfalls, undefined);
      assert.deepEqual(await balance(), { v: 7, h: "0.4", r: "0.9999", a: "-0.5999" });
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_inventory.stock_reservation_version WHERE account_id=$1",
            [account],
          )
        ).rows[0].n,
        reservationsBefore,
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT after_summary_json FROM platform_audit.audit_record WHERE action_code='INVENTORY_WASTE_RECORDED' AND target_id=$1",
            [wasted.record.wasteReference],
          )
        ).rows.map((row) => row.after_summary_json.heldForOpenOrdersLines),
        [1],
      );
      // The notice follows: short by 0.5999 kg, the same round still holding all 0.9999 kg.
      assert.deepEqual(
        (await shortages()).map((s) => [s.onHand, s.reserved, s.shortQuantity, s.holding]),
        [["0.4", "0.9999", "0.5999", [{ submissionReference: id(40), quantity: "0.9999" }]]],
      );
      // The ledger itself refuses any movement but a count or waste that lowers availability below
      // zero, and waste beyond on hand, even written past the application (owner connection, row
      // security bypassed).
      const raw = async (movementType, delta, onHandDelta, reservedDelta) => {
        const b = await balance();
        const after = {
          onHand: String(Number((Number(b.h) + onHandDelta).toFixed(4))),
          reserved: String(Number((Number(b.r) + reservedDelta).toFixed(4))),
        };
        const record = {
          movementReference: next(),
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          itemReference: item,
          movementType,
          quantityDelta: delta,
          unitCode: "KG",
          baseQuantityDelta: delta,
          baseUnitCode: "KG",
          conversionMultiplier: "1",
          sourceScope: { scopeType: "Location", scopeReference: location },
          destinationScope: null,
          lotReference: null,
          expiryDate: null,
          businessSourceType: "SYNTHETIC",
          businessSourceReference: next(),
          reasonCode: "SYNTHETIC_TEST",
          performedBy: cook,
          occurredAt: at(minute),
          before: {
            onHand: b.h,
            reserved: b.r,
            available: b.a,
            inTransit: "0",
            unitCode: "KG",
            ledgerVersion: b.v,
          },
          after: {
            onHand: after.onHand,
            reserved: after.reserved,
            available: String(Number((Number(after.onHand) - Number(after.reserved)).toFixed(4))),
            inTransit: "0",
            unitCode: "KG",
            ledgerVersion: b.v + 1,
          },
          auditReference: next(),
          correctsMovementReference: null,
        };
        await admin.query("BEGIN");
        try {
          await admin.query(
            "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
            [
              scope.tenantReference,
              scope.brandReference,
              scope.storeReference,
              account,
              record.movementReference,
              b.v + 1,
              movementType,
              delta,
              record,
              record.auditReference,
              at(minute),
            ],
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      };
      for (const [type, delta, onHandDelta, reservedDelta] of [
        ["Reserve", "0.0001", 0, 0.0001],
        ["Adjustment", "-0.1", -0.1, 0],
      ])
        await assert.rejects(raw(type, delta, onHandDelta, reservedDelta), {
          code: "23514",
          message: "stock movement would take reserved stock",
        });
      await assert.rejects(raw("Waste", "-0.5", -0.5, 0), { code: "23514" });
      // (A raw Waste within on hand is accepted by the ledger; the statement is rolled back.)
      await raw("Waste", "-0.1", -0.1, 0);
      assert.deepEqual(await balance(), { v: 7, h: "0.4", r: "0.9999", a: "-0.5999" });

      // The kitchen makes line A: 0.4 kg is on hand, nothing is used beyond the count.
      const kitchen = (line, progress, minuteAt) =>
        asApi((client) =>
          createPostgresOrderLineConsumptionStore(runner(client), owner, {
            nextReference: next,
          }).apply({
            submissionReference: demand.submissionReference,
            cartItemReference: line,
            kitchen: progress,
            occurredAt: at(minuteAt),
            actorReference: cook,
            correlationReference: next(),
            audit: {
              reasonCode: "KITCHEN_PROGRESS",
              sourceChannel: "KDS_COMMAND",
              retentionPolicyCode: "SYNTHETIC_AUDIT",
              retentionPolicyVersion: 1,
            },
          }),
        );
      const done = { kind: "Progress", completedQuantity: 1, requiredQuantity: 1 };
      assert.deepEqual(
        (await kitchen(lineA, done, 20)).map((e) => [e.action, e.quantity, e.usedBeyondCount]),
        [
          ["StartProduction", null, undefined],
          ["Consume", "0.3333", undefined],
        ],
      );
      assert.deepEqual(await balance(), { v: 8, h: "0.0667", r: "0.6666", a: "-0.5999" });

      // Line B is cancelled before the kitchen starts it: its stock is released.
      const store = (client) => createPostgresStockReservationStore(runner(client), owner);
      const [held] = await asApi((client) =>
        store(client).loadOrderLine(demand.submissionReference, lineB),
      );
      const operationReference = next();
      const released = await asApi((client) =>
        store(client).commit({
          operationReference,
          accountReference: held.accountReference,
          action: "Release",
          expectedLedgerVersion: 8,
          quantity: "0.3333",
          movementReference: next(),
          reservation: advanceInventoryReservation(held.reservation, {
            reservationReference: held.reservation.reservationReference,
            binding: held.reservation.binding,
            expectedVersion: held.reservation.version,
            action: "Release",
            quantity: "0.3333",
            occurredAt: at(21),
          }),
          audit: audit(
            manager,
            "INVENTORY_RESERVATION_RELEASE",
            "InventoryReservation",
            held.reservation.reservationReference,
            operationReference,
            21,
          ),
        }),
      );
      assert.equal(released.status, "Applied");
      assert.deepEqual(await balance(), { v: 9, h: "0.0667", r: "0.3333", a: "-0.2666" });

      // The kitchen makes line C with more than was counted: 0.2666 kg is recorded as used beyond
      // the count first, then the line's full 0.3333 kg is consumed. On-hand never goes negative.
      assert.deepEqual(
        (await kitchen(lineC, done, 22)).map((e) => [e.action, e.quantity, e.usedBeyondCount]),
        [
          ["StartProduction", null, undefined],
          ["Consume", "0.3333", "0.2666"],
        ],
      );
      assert.deepEqual(await balance(), { v: 11, h: "0", r: "0", a: "0" });
      assert.deepEqual(
        (
          await admin.query(
            "SELECT movement_type t,base_quantity_delta::text d,record_json->>'reasonCode' reason,record_json->>'performedBy' actor FROM rms_inventory.stock_movement WHERE account_id=$1 AND ledger_version=10",
            [account],
          )
        ).rows,
        [{ t: "Adjustment", d: "0.2666", reason: "USED_BEYOND_COUNT", actor: cook }],
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT count(*)::int n,bool_and(actor_reference=$1) by_cook FROM platform_audit.audit_record WHERE action_code='INVENTORY_STOCK_USED_BEYOND_COUNT'",
            [cook],
          )
        ).rows[0],
        { n: 1, by_cook: true },
      );
      // No longer short for orders; the stock used beyond the count stays listed for a recount.
      assert.deepEqual(
        (await shortages()).map((s) => [s.shortQuantity, s.usedBeyondCount, s.holding]),
        [["0", "0.2666", []]],
      );

      // The ledger balances: every on-hand and reserved change is a movement, versions are
      // gapless, and each movement starts where the previous one ended.
      const movements = (
        await admin.query(
          "SELECT ledger_version::int v,movement_type t,base_quantity_delta::numeric d,record_json r FROM rms_inventory.stock_movement WHERE account_id=$1 ORDER BY ledger_version",
          [account],
        )
      ).rows;
      assert.deepEqual(
        movements.map((m) => m.v),
        [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );
      for (let i = 1; i < movements.length; i++)
        assert.deepEqual(movements[i].r.before, movements[i - 1].r.after);
      const micro = (value) => Math.round(Number(value) * 10_000);
      const onHandSum = movements
        .filter((m) => !["Reserve", "Release"].includes(m.t))
        .reduce((sum, m) => sum + micro(m.d), 0);
      const reservedSum = movements
        .filter((m) => ["Reserve", "Release", "Consume"].includes(m.t))
        .reduce((sum, m) => sum + micro(m.d), 0);
      assert.equal(onHandSum, 0);
      assert.equal(reservedSum, 0);

      // Counting the item again (it matches: 0 kg) clears the notice; no movement is needed.
      const recount = await countAll("0", null);
      assert.equal(recount.count.status, "Posted");
      assert.equal(recount.movements.length, 0);
      assert.deepEqual(await shortages(), []);
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      for (const role of [api, seeder]) {
        await admin.query("DROP OWNED BY " + role).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    }
  });
});
