import assert from "node:assert/strict";
import pg from "pg";
import { createHash } from "node:crypto";
import { it } from "vitest";
import {
  createPostgresLotHoldStore,
  createPostgresStockCandidateSource,
  executeLotHold,
  createInventoryItem,
  transitionInventoryItem,
  createInventoryReservation,
  advanceInventoryReservation,
  createPostgresStockReservationStore,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z";
it("persists Lot Hold and gates reservations against current quarantine", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_lot_hold" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_stock_" + context.runId;
    assert.match(role, /^wp2402_stock_[a-f0-9]+$/u);
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
        "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON rms_inventory.stock_account,rms_inventory.stock_balance,rms_inventory.stock_movement,rms_inventory.stock_reservation_version,rms_inventory.stock_lot_hold_version TO " +
          role,
      );
      await admin.query("GRANT SELECT,UPDATE ON rms_inventory.inventory_item TO " + role);
      await admin.query("GRANT SELECT,INSERT ON rms_inventory.inventory_item_version TO " + role);
      await admin.query(
        "INSERT INTO rms_inventory.inventory_item VALUES ($1,$2,$3,'SYNTHETIC','RawMaterial',$4,$5)",
        [id(1), id(2), id(6), at, id(9)],
      );
      const item = createInventoryItem({
        tenantReference: id(1),
        brandReference: id(2),
        itemReference: id(6),
        internalCode: "SYNTHETIC",
        itemType: "RawMaterial",
        localizedNames: { en: "Synthetic stock item" },
        baseUnit: {
          unitCode: "KG",
          dimension: "Mass",
          displayPrecision: 2,
          ledgerPrecision: 6,
          roundingMode: "HalfEven",
        },
        trackingPolicy: {
          stockTrackingEnabled: true,
          lotTrackingMode: "LotRequired",
          defaultShelfLifeDays: null,
          expiryWarningDays: null,
          issuePolicy: "FIFO",
          negativeStockPolicy: "Block",
        },
        occurredAt: at,
        actorReference: id(9),
      });
      await admin.query(
        "INSERT INTO rms_inventory.inventory_item_version VALUES ($1,$2,$3,1,$4,$5)",
        [id(1), id(2), id(6), item, at],
      );
      async function lifecycle(target) {
        const row = await admin.query(
          "SELECT snapshot_json FROM rms_inventory.inventory_item_version WHERE item_id=$1 ORDER BY version DESC LIMIT 1",
          [id(6)],
        );
        const current = row.rows[0].snapshot_json;
        const next = transitionInventoryItem(current, target, {
          expectedVersion: current.aggregateVersion,
          hasOpenWork: false,
          hasNonZeroStock: false,
          occurredAt: at,
          actorReference: id(9),
        });
        await admin.query(
          "INSERT INTO rms_inventory.inventory_item_version VALUES ($1,$2,$3,$4,$5,$6)",
          [id(1), id(2), id(6), next.aggregateVersion, next, at],
        );
      }
      async function scoped(work, scope = [id(1), id(2), id(3)]) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL lock_timeout='5s'");
          await client.query("SET LOCAL statement_timeout='5s'");
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            scope,
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
      await scoped(async (client) => {
        await client.query(
          "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,lot_id,expiry_date,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$9,NULL,'KG',6,$8)",
          [id(1), id(2), id(3), id(4), id(5), id(7), id(6), at, id(10)],
        );
        await client.query(
          "INSERT INTO rms_inventory.stock_balance (tenant_id,brand_id,store_id,account_id,ledger_version,on_hand,reserved,in_transit) VALUES ($1,$2,$3,$4,1,0,0,0)",
          [id(1), id(2), id(3), id(7)],
        );
      });
      const balance = (ledgerVersion, onHand, reserved, available) => ({
        ledgerVersion,
        onHand,
        reserved,
        available,
        inTransit: "0",
        unitCode: "KG",
      });
      function append(client, n, type, delta, before, after, extra = {}) {
        const record = {
          movementReference: id(n),
          tenantReference: id(1),
          brandReference: id(2),
          itemReference: id(6),
          movementType: type,
          quantityDelta: delta,
          unitCode: "KG",
          baseQuantityDelta: delta,
          baseUnitCode: "KG",
          conversionMultiplier: "1",
          sourceScope: { scopeType: "Location", scopeReference: id(5) },
          destinationScope: null,
          lotReference: id(10),
          expiryDate: null,
          businessSourceType: "SYNTHETIC",
          businessSourceReference: id(8),
          reasonCode: "SYNTHETIC_TEST",
          performedBy: id(9),
          occurredAt: at,
          before,
          after,
          auditReference: id(n + 100),
          correctsMovementReference: null,
          ...extra,
        };
        return client.query(
          "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            id(1),
            id(2),
            id(3),
            id(7),
            id(n),
            after.ledgerVersion,
            type,
            delta,
            record,
            id(n + 100),
            at,
          ],
        );
      }

      await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      const binding = {
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        stockSiteReference: id(4),
        locationReference: id(5),
        itemReference: id(6),
        lotReference: id(10),
        submissionReference: id(50),
        cartReference: id(51),
        cartVersion: 1,
        quoteReference: id(52),
        demandReference: id(53),
        demandDigest: "sha256:" + "a".repeat(64),
      };
      const unit = {
        unitCode: "KG",
        dimension: "Mass",
        displayPrecision: 2,
        ledgerPrecision: 6,
        roundingMode: "HalfEven",
      };
      const reservation = createInventoryReservation({
        reservationReference: id(60),
        binding,
        unit,
        quantity: "6",
        occurredAt: at,
      });
      await scoped((client) =>
        append(client, 20, "Receive", "10", balance(1, "0", "0", "0"), balance(2, "10", "0", "10")),
      );
      function adapter(
        options = {},
        scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
      ) {
        const runner = {
          async run(work) {
            let wrote = false;
            const result = await scoped((client) =>
              work({
                async query(sql, values) {
                  if (sql.startsWith("INSERT INTO rms_inventory.stock_reservation_version"))
                    wrote = true;
                  if (options.failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                    throw new Error("synthetic Audit failure");
                  return client.query(sql, [...values]);
                },
              }),
            );
            if (options.loseAck && wrote) throw new Error("synthetic response loss");
            return result;
          },
        };
        return createPostgresStockReservationStore(runner, scope);
      }
      function input(n, action, next, quantity, expectedLedgerVersion) {
        return {
          operationReference: id(n),
          accountReference: id(7),
          action,
          expectedLedgerVersion,
          quantity,
          reservation: next,
          movementReference: action === "StartProduction" ? null : id(n + 100),
          audit: {
            auditId: id(n + 200),
            brandId: id(2),
            storeId: id(3),
            actor: { type: "User", reference: id(9) },
            actionCode:
              "INVENTORY_RESERVATION_" +
              (action === "StartProduction" ? "START_PRODUCTION" : action.toUpperCase()),
            targetType: "InventoryReservation",
            targetId: next.reservationReference,
            reasonCode: "AUTHORIZED_CHANGE",
            correlationId: id(n),
            occurredAt: at,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "SYNTHETIC_AUDIT",
            retentionPolicyVersion: 1,
          },
        };
      }

      await lifecycle("Active");
      let sequence = 500;
      function holdPorts(options = {}) {
        const runner = {
          async run(work) {
            let wrote = false;
            const result = await scoped((client) =>
              work({
                async query(sql, values) {
                  if (sql.startsWith("INSERT INTO rms_inventory.stock_lot_hold_version"))
                    wrote = true;
                  if (options.failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                    throw new Error("synthetic Audit failure");
                  return client.query(sql, [...values]);
                },
              }),
            );
            if (options.loseAck && wrote) throw new Error("synthetic response loss");
            return result;
          },
        };
        return {
          ...createPostgresLotHoldStore(runner, {
            tenantReference: id(1),
            brandReference: id(2),
            storeReference: id(3),
            ...options.scope,
          }),
          authorization: {
            async authorize() {
              return { authorized: true, mayManageHold: true };
            },
          },
          compliance: {
            async resolveDecision(command) {
              return {
                tenantReference: id(1),
                brandReference: id(2),
                stockScope: command.payload.stockScope,
                locationReference: id(5),
                lotReference: id(10),
                decisionReference: command.payload.complianceDecisionReference,
                decision:
                  command.action === "Quarantine" ? "QuarantineApproved" : "ReleaseApproved",
                status: "Active",
                effectiveAt: at,
              };
            },
          },
          references: {
            generate: () => id(sequence++),
            hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
            equals: (a, b) => a === b,
          },
          audit: {
            async create({ command, after }) {
              if (options.beforeAudit) await options.beforeAudit();
              return {
                ...input(900, "Reserve", reservation, "6", 2).audit,
                auditId: id(sequence++),
                actionCode: "INVENTORY_LOT_" + command.action.toUpperCase(),
                targetType: "LotHold",
                targetId: after.holdReference,
                correlationId: command.operationReference,
                reasonCode: command.payload.reasonCode,
              };
            },
          },
        };
      }
      function command(n, action, expectedVersion) {
        return {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(9),
          purpose: "LotHoldManagement",
          permission: "inventory.manage",
          operationReference: id(n),
          occurredAt: at,
          action,
          payload: {
            stockScope: { scopeType: "Location", scopeReference: id(5) },
            locationReference: id(5),
            itemReference: id(6),
            lotReference: id(10),
            expectedVersion,
            reasonCode: "SYNTHETIC_TEST",
            complianceDecisionReference: id(n + 1000),
          },
        };
      }
      const quarantine = command(300, "Quarantine", 0);
      await assert.rejects(executeLotHold(quarantine, holdPorts({ loseAck: true })), {
        code: "LOT_HOLD_DEPENDENCY_UNAVAILABLE",
      });
      const original = await executeLotHold(quarantine, holdPorts());
      assert.equal(original.outcome, "AlreadyApplied");
      assert.equal(original.hold.status, "Quarantined");
      const observedAccount = await createPostgresStockCandidateSource(
        {
          run: (work) =>
            scoped((client) =>
              work({
                query: (sql, values) => client.query(sql, [...values]),
              }),
            ),
        },
        { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
      ).loadAccount({
        itemReference: id(6),
        stockSiteReference: id(4),
        accountReference: id(7),
        observedAt: at,
      });
      assert.equal(observedAccount.holdStatus, "Quarantined");
      assert.equal(observedAccount.holdVersion, original.hold.aggregateVersion);
      assert.equal(observedAccount.lotReference, id(10));

      const reserve = input(70, "Reserve", reservation, "6", 2);
      await assert.rejects(adapter().commit(reserve), {
        code: "STOCK_RESERVATION_ITEM_INELIGIBLE",
      });
      const releaseHold = command(301, "Release", 1);
      await assert.rejects(executeLotHold(releaseHold, holdPorts({ failAudit: true })), {
        code: "LOT_HOLD_DEPENDENCY_UNAVAILABLE",
      });
      assert.equal(await holdPorts().repository.resolveOperation(id(301)), null);
      assert.equal((await holdPorts().snapshot.inspect(releaseHold)).holdStatus, "Quarantined");
      await executeLotHold(releaseHold, holdPorts());
      await adapter().commit(reserve);
      await executeLotHold(command(302, "Quarantine", 2), holdPorts());
      const released = advanceInventoryReservation(reservation, {
        reservationReference: reservation.reservationReference,
        binding,
        expectedVersion: 1,
        action: "Release",
        quantity: "2",
        occurredAt: at,
      });
      await adapter().commit(input(71, "Release", released, "2", 3));
      const started = advanceInventoryReservation(released, {
        reservationReference: reservation.reservationReference,
        binding,
        expectedVersion: 2,
        action: "StartProduction",
        quantity: null,
        occurredAt: at,
      });
      await assert.rejects(adapter().commit(input(72, "StartProduction", started, null, 4)), {
        code: "STOCK_RESERVATION_ITEM_INELIGIBLE",
      });
      const consumed = advanceInventoryReservation(released, {
        reservationReference: reservation.reservationReference,
        binding,
        expectedVersion: 2,
        action: "Consume",
        quantity: "4",
        occurredAt: at,
      });
      await assert.rejects(adapter().commit(input(73, "Consume", consumed, "4", 4)), {
        code: "STOCK_RESERVATION_ITEM_INELIGIBLE",
      });
      await executeLotHold(command(303, "Release", 3), holdPorts());
      await adapter().commit(input(72, "StartProduction", started, null, 4));

      // Both callers build the same next command before either commits.
      let ready = 0;
      let releaseBarrier;
      const barrier = new Promise((resolve) => {
        releaseBarrier = resolve;
      });
      const beforeAudit = async () => {
        ready++;
        if (ready === 2) releaseBarrier();
        await barrier;
      };
      const concurrentCommand = command(304, "Quarantine", 4);
      const concurrent = await Promise.all([
        executeLotHold(concurrentCommand, holdPorts({ beforeAudit })),
        executeLotHold(concurrentCommand, holdPorts({ beforeAudit })),
      ]);
      assert.deepEqual(concurrent.map((result) => result.outcome).sort(), [
        "AlreadyApplied",
        "Applied",
      ]);
      assert.equal(concurrent[0].audit.auditId, concurrent[1].audit.auditId);
      assert.equal(concurrent[0].hold.holdReference, concurrent[1].hold.holdReference);
      await assert.rejects(
        executeLotHold({ ...concurrentCommand, actorReference: id(99) }, holdPorts()),
        {
          code: "LOT_HOLD_IDEMPOTENCY_CONFLICT",
        },
      );
      for (const scope of [
        { tenantReference: id(90) },
        { brandReference: id(90) },
        { storeReference: id(90) },
      ]) {
        assert.equal(await holdPorts({ scope }).repository.resolveOperation(id(304)), null);
      }
      const counts = await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_inventory.stock_lot_hold_version) AS holds,(SELECT count(*)::int FROM platform_audit.audit_record) AS audits",
      );
      assert.deepEqual(counts.rows, [{ holds: 5, audits: 8 }]);
      assert.equal(
        (await executeLotHold(quarantine, holdPorts())).audit.auditId,
        original.audit.auditId,
      );
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});
