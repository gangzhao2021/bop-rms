import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { canonicalizeRfc8785 } from "../../bop/audit/src/index.ts";
import {
  createInventoryReservation,
  createPostgresOrderLineConsumptionStore,
  createPostgresSubmissionReservationStore,
  createPostgresSubmissionStockPlanSource,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedSyntheticInventoryItems } from "../test-support/recipe-inventory-observation.mjs";

const { Client } = pg;
const id = (n) => "01909a01-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-07T10:00:00.000Z";
const sha = (value) =>
  "sha256:" + createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex");

/** WP-2423: per-Order-line demand reserves each line on its own, rounded per line. */
it("reserves each Order line separately with sequential ledger versions and exact line totals", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_res_line" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_line_" + context.runId;
    let sequence = 1000;
    const next = () => id(++sequence);
    const scope = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      stockSiteReference: id(4),
    };
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_inventory,platform_helpers,platform_audit TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON rms_inventory.stock_account,rms_inventory.stock_balance,rms_inventory.stock_movement,rms_inventory.stock_reservation_version,rms_inventory.stock_reservation_set TO " +
          role,
      );
      await admin.query("GRANT SELECT ON rms_inventory.stock_lot_hold_version TO " + role);
      await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_inventory.inventory_item TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
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
        operation = id(11);
      const [{ accountReference }] = await seedSyntheticInventoryItems({
        admin,
        role,
        runner: itemRunner,
        id,
        at,
        scope,
        next,
        items: [{ itemReference: item, operationReference: operation, onHand: "1" }],
      });
      await admin.query("RESET ROLE");

      async function scoped(work) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [scope.tenantReference, scope.brandReference, scope.storeReference],
          );
          const result = await work({ run: async (inner) => inner(client) });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      }
      const third = (line) => ({
        itemReference: item,
        configurationOperationReference: operation,
        unitDimension: "Mass",
        quantityNumerator: "1000000",
        quantityDenominator: "3",
        cartItemReference: line,
      });
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
          contributions: lines.map(third),
        };
        return { demand, digest: sha(demand) };
      };
      const lineA = id(30),
        lineB = id(31);
      const sourceScope = {
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      };
      const noLot = {
        resolveExpiryCutoff: async () => {
          throw new Error("NoLot fixture");
        },
      };

      // Each line rounds 1/3 kg to 0.3333 at ledger precision 4; the item total is 0.6666,
      // not the aggregate rounding 0.6667, so reserved == validated == later consumed.
      const { demand, digest } = demandFor(id(40), [lineB, lineA]);
      const plan = await scoped((runner) =>
        createPostgresSubmissionStockPlanSource(runner, sourceScope, noLot).resolve(demand, at),
      );
      assert.deepEqual(
        plan.allocations.map((a) => [a.cartItemReference, a.quantity, a.expectedLedgerVersion]),
        [
          [lineA, "0.3333", 2],
          [lineB, "0.3333", 3],
        ],
      );
      assert.equal(plan.requirements.length, 1);
      assert.equal(plan.requirements[0].quantity, "0.6666");

      const actor = id(50);
      const audit = (actionCode, targetType, targetId, correlationId) => ({
        auditId: next(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "User", reference: actor },
        actionCode,
        targetType,
        targetId,
        reasonCode: "SYNTHETIC_TEST",
        correlationId,
        occurredAt: at,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Internal",
        retentionPolicyCode: "SYNTHETIC_AUDIT",
        retentionPolicyVersion: 1,
      });
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
            occurredAt: at,
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
            "INVENTORY_RESERVATION_RESERVE",
            "InventoryReservation",
            reservationReference,
            operationReference,
          ),
        };
      });
      const setReference = next(),
        setOperation = next();
      const commit = (candidateWrites) =>
        scoped((runner) =>
          createPostgresSubmissionReservationStore(runner, sourceScope, {
            authorize: async () => true,
            resolveDemand: async () => demand,
            ...noLot,
          }).commit({
            setReference,
            operationReference: setOperation,
            workflowReference: demand.workflowReference,
            workflowVersion: demand.workflowVersion,
            writes: candidateWrites,
            audit: audit(
              "INVENTORY_RESERVATION_SET",
              "InventoryReservationSet",
              setReference,
              setOperation,
            ),
          }),
        );
      // A write that moves a line's quantity onto the other line no longer matches the plan.
      await assert.rejects(
        commit([
          writes[0],
          {
            ...writes[1],
            reservation: createInventoryReservation({
              reservationReference: writes[1].reservation.reservationReference,
              unit: writes[1].reservation.unit,
              quantity: writes[1].quantity,
              occurredAt: at,
              binding: { ...writes[1].reservation.binding, cartItemReference: lineA },
            }),
          },
        ]),
      );
      const saved = await commit(writes);
      assert.equal(saved.status, "Applied");
      assert.deepEqual(
        saved.set.entries.map((e) => [
          e.reservation.schemaVersion,
          e.reservation.binding.cartItemReference,
          e.reservation.originalQuantity,
        ]),
        [
          [2, lineA, "0.3333"],
          [2, lineB, "0.3333"],
        ],
      );
      assert.equal((await commit(writes)).status, "AlreadyApplied");
      const balance = (
        await admin.query(
          "SELECT ledger_version::int v,on_hand::text h,reserved::text r FROM rms_inventory.stock_balance WHERE account_id=$1",
          [accountReference],
        )
      ).rows[0];
      assert.deepEqual(balance, { v: 4, h: "1", r: "0.6666" });

      // Insufficient across lines: 0.3334 kg left cannot hold two more 0.3333 lines.
      const short = demandFor(id(41), [id(32), id(33)]);
      await assert.rejects(
        scoped((runner) =>
          createPostgresSubmissionStockPlanSource(runner, sourceScope, noLot).resolve(
            short.demand,
            at,
          ),
        ),
        { code: "STOCK_RESERVATION_INSUFFICIENT" },
      );

      // Kitchen progress consumes each line on its own, audited to the named Kitchen Actor.
      const cook = id(60);
      const consume = (line, kitchen, minute) =>
        scoped((runner) =>
          createPostgresOrderLineConsumptionStore(runner, sourceScope, {
            nextReference: next,
          }).apply({
            submissionReference: demand.submissionReference,
            cartItemReference: line,
            kitchen,
            occurredAt: `2026-10-07T10:${String(minute).padStart(2, "0")}:00.000Z`,
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
      const stock = async () =>
        (
          await admin.query(
            "SELECT on_hand::text h,reserved::text r FROM rms_inventory.stock_balance WHERE account_id=$1",
            [accountReference],
          )
        ).rows[0];
      assert.deepEqual(
        (await consume(lineA, { kind: "Start" }, 1)).map((e) => e.action),
        ["StartProduction"],
      );
      assert.deepEqual(await stock(), { h: "1", r: "0.6666" });
      assert.deepEqual(
        (
          await consume(lineA, { kind: "Progress", completedQuantity: 1, requiredQuantity: 1 }, 2)
        ).map((e) => [e.action, e.quantity]),
        [["Consume", "0.3333"]],
      );
      assert.deepEqual(await stock(), { h: "0.6667", r: "0.3333" });
      assert.deepEqual(
        await consume(lineA, { kind: "Progress", completedQuantity: 1, requiredQuantity: 1 }, 3),
        [],
        "a replayed completion does not deduct twice",
      );
      assert.deepEqual(
        (
          await consume(lineB, { kind: "Progress", completedQuantity: 1, requiredQuantity: 1 }, 4)
        ).map((e) => [e.action, e.quantity]),
        [
          ["StartProduction", null],
          ["Consume", "0.3333"],
        ],
      );
      assert.deepEqual(await stock(), { h: "0.3334", r: "0" });
      const audits = (
        await admin.query(
          "SELECT action_code a,count(*)::int n,bool_and(actor_reference=$1) by_cook FROM platform_audit.audit_record WHERE action_code IN ('INVENTORY_RESERVATION_START_PRODUCTION','INVENTORY_RESERVATION_CONSUME') GROUP BY 1 ORDER BY 1",
          [cook],
        )
      ).rows;
      assert.deepEqual(audits, [
        { a: "INVENTORY_RESERVATION_CONSUME", n: 2, by_cook: true },
        { a: "INVENTORY_RESERVATION_START_PRODUCTION", n: 2, by_cook: true },
      ]);

      // The database itself refuses schema 2 without an Order line and duplicate line reservations.
      await assert.rejects(
        admin.query(
          "UPDATE rms_inventory.stock_reservation_version SET snapshot_json=snapshot_json #- '{binding,cartItemReference}' WHERE version=1",
        ),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(DISTINCT reservation_id)::int n FROM rms_inventory.stock_reservation_version WHERE snapshot_json->>'schemaVersion'='2'",
          )
        ).rows[0].n,
        2,
      );
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
});
