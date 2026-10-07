import {
  appendAuditRecordInTransaction,
  verifySystemAuditOperationBinding,
} from "../../bop/audit/src/index.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createInventoryItem,
  transitionInventoryItem,
  createInventoryReservation,
  advanceInventoryReservation,
  createPostgresStockReservationStore,
  createPostgresStockCandidateSource,
  parseInventoryReservationSet,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";
const { Client } = pg;
const id = (n) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z";
it("commits reservation movement and Audit atomically and recovers original operations", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_res_store" }, async (context) => {
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
        "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON rms_inventory.stock_account,rms_inventory.stock_balance,rms_inventory.stock_movement,rms_inventory.stock_reservation_version TO " +
          role,
      );
      // DEC-INV-LOCATIONS: opening an account checks the registered active location.
      await admin.query(
        "GRANT SELECT ON rms_inventory.stock_site_version,rms_inventory.storage_location_version TO " +
          role,
      );
      await admin.query("GRANT SELECT ON rms_inventory.stock_lot_hold_version TO " + role);
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
          lotTrackingMode: "NoLot",
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
      await ensureSyntheticStockPlace(admin, {
        tenantId: id(1),
        brandId: id(2),
        storeId: id(3),
        stockSiteId: id(4),
        locationId: id(5),
        at,
      });
      await scoped(async (client) => {
        await client.query(
          "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,lot_id,expiry_date,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,NULL,NULL,'KG',6,$8)",
          [id(1), id(2), id(3), id(4), id(5), id(7), id(6), at],
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
      function append(client, n, type, delta, before, after, extra = {}, account = id(7)) {
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
          lotReference: null,
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
            account,
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
        lotReference: null,
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
                  if (sql.startsWith("INSERT INTO rms_inventory.stock_reservation_version")) {
                    wrote = true;
                    options.onWrite?.();
                  }
                  if (
                    options.failSet &&
                    sql.startsWith("INSERT INTO rms_inventory.stock_reservation_set")
                  )
                    throw new Error("synthetic set failure");
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
      const reserve = input(70, "Reserve", reservation, "6", 2);
      await assert.rejects(adapter().commit(reserve), {
        code: "STOCK_RESERVATION_ITEM_INELIGIBLE",
      });
      await lifecycle("Active");
      const wrongUnit = { ...reservation, unit: { ...reservation.unit, displayPrecision: 1 } };
      await assert.rejects(adapter().commit(input(86, "Reserve", wrongUnit, "6", 2)), {
        code: "STOCK_RESERVATION_ITEM_INELIGIBLE",
      });

      await assert.rejects(adapter({ loseAck: true }).commit(reserve), {
        code: "STOCK_RESERVATION_UNAVAILABLE",
      });
      const recovered = await adapter().commit({
        ...reserve,
        movementReference: id(999),
        audit: { ...reserve.audit, auditId: id(998) },
      });
      assert.equal(recovered.status, "AlreadyApplied");
      assert.equal(recovered.movementReference, reserve.movementReference);
      assert.equal(recovered.auditReference, reserve.audit.auditId);
      assert.deepEqual(recovered.reservation, reservation);
      assert.deepEqual(
        (await adapter().loadCurrent(reservation.reservationReference)).reservation,
        reservation,
      );
      assert.equal(await adapter().loadCurrent(id(99000)), null);
      const rollbackObservation = new Error("synthetic observation rollback");
      await assert.rejects(
        scoped(async (client) => {
          const runner = {
            run: async (work) =>
              work({
                query: (sql, values) => client.query(sql, [...values]),
              }),
          };
          const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
          await append(
            client,
            9001,
            "Reserve",
            "4",
            balance(3, "10", "6", "4"),
            balance(4, "10", "10", "0"),
          );
          const source = createPostgresStockCandidateSource(runner, scope);
          const lookup = { itemReference: id(6), stockSiteReference: id(4), observedAt: at };
          assert.deepEqual(await source.list(lookup), []);
          const account = await source.loadAccount({ ...lookup, accountReference: id(7) });
          assert(account, "fully reserved account must remain observable");
          assert.equal(Number(account.available), 0);
          assert.equal(account.ledgerVersion, 4);
          assert.equal(account.holdStatus, "Available");
          assert.equal(account.expiryDate, null);
          assert.equal(await source.loadAccount({ ...lookup, accountReference: id(99000) }), null);
          assert.equal(
            await source.loadAccount({
              ...lookup,
              stockSiteReference: id(99001),
              accountReference: id(7),
            }),
            null,
          );
          assert.equal(
            await createPostgresStockCandidateSource(runner, {
              ...scope,
              storeReference: id(99002),
            }).loadAccount({ ...lookup, accountReference: id(7) }),
            null,
          );
          throw rollbackObservation;
        }),
        (error) => error === rollbackObservation,
      );
      assert.deepEqual(
        (await adapter().loadCurrent(reservation.reservationReference)).reservation,
        reservation,
      );

      await assert.rejects(adapter().commit({ ...reserve, quantity: "5" }), {
        code: "STOCK_RESERVATION_IDEMPOTENCY_CONFLICT",
      });
      await assert.rejects(
        adapter().commit({
          ...reserve,
          audit: { ...reserve.audit, actor: { type: "User", reference: id(99) } },
        }),
        { code: "STOCK_RESERVATION_IDEMPOTENCY_CONFLICT" },
      );
      await lifecycle("Inactive");
      assert.equal((await adapter().commit(reserve)).status, "AlreadyApplied");
      const release = advanceInventoryReservation(reservation, {
        reservationReference: reservation.reservationReference,
        binding,
        expectedVersion: 1,
        action: "Release",
        quantity: "2",
        occurredAt: at,
      });
      const releaseInput = input(71, "Release", release, "2", 3);
      await assert.rejects(adapter({ failAudit: true }).commit(releaseInput), {
        code: "STOCK_RESERVATION_UNAVAILABLE",
      });
      assert.equal(await adapter().resolveOperation(id(71)), null);
      assert.equal(
        (await adapter().loadCurrent(reservation.reservationReference)).reservation.version,
        1,
      );
      const afterFailure = await scoped((client) =>
        client.query("SELECT reserved::text,ledger_version::text FROM rms_inventory.stock_balance"),
      );
      assert.deepEqual(afterFailure.rows, [{ reserved: "6", ledger_version: "3" }]);
      const systemInput = {
        ...releaseInput,
        audit: {
          ...releaseInput.audit,
          actor: { type: "System" },
          reasonCode: "CHECKOUT_DEADLINE_REACHED",
          sourceChannel: "SYSTEM",
        },
      };
      await assert.rejects(adapter().commit(systemInput), {
        code: "STOCK_RESERVATION_UNAVAILABLE",
      });
      const rollbackSystem = new Error("synthetic system release rollback");
      await assert.rejects(
        scoped(async (client) => {
          const tx = { query: (sql, values) => client.query(sql, [...values]) };
          let allowed = true,
            checks = 0;
          const systemStore = createPostgresStockReservationStore(
            { run: (work) => work(tx) },
            { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
            {
              systemActorReference: id(900),
              authorize: async (actual, request) => {
                checks++;
                assert.equal(actual, tx);
                assert.equal(request.operationReference, systemInput.operationReference);
                assert.equal(request.accountReference, id(7));
                assert.deepEqual(request.reservation, release);
                return allowed;
              },
            },
          );
          assert.equal((await systemStore.commit(systemInput)).status, "Applied");
          assert.equal(checks, 2);
          const movement = (
            await client.query(
              "SELECT record_json FROM rms_inventory.stock_movement WHERE movement_id=$1",
              [systemInput.movementReference],
            )
          ).rows[0].record_json;
          assert.equal(movement.performedBy, id(900));
          assert.equal((await systemStore.commit(systemInput)).status, "AlreadyApplied");
          assert.equal(checks, 4);
          allowed = false;
          await assert.rejects(systemStore.commit(systemInput), {
            code: "STOCK_RESERVATION_UNAVAILABLE",
          });
          assert.equal(checks, 5);
          allowed = true;
          const verified = await systemStore.verifySystemRelease(systemInput.operationReference);
          assert.deepEqual(verified.reservation, release);
          assert.equal(verified.movementReference, systemInput.movementReference);
          assert.equal(await systemStore.verifySystemRelease(id(12001)), null);
          assert.equal(
            await verifySystemAuditOperationBinding(
              tx,
              {
                auditId: systemInput.audit.auditId,
                brandId: id(2),
                storeId: id(3),
                actionCode: "INVENTORY_RESERVATION_RELEASE",
                targetType: "InventoryReservation",
                targetId: release.reservationReference,
                correlationId: id(12002),
                reasonCode: "CHECKOUT_DEADLINE_REACHED",
                occurredAt: at,
                sourceChannel: "SYSTEM",
              },
              async () => true,
            ),
            false,
          );
          const wrongPrincipal = createPostgresStockReservationStore(
            { run: (work) => work(tx) },
            { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
            { systemActorReference: id(12003), authorize: async () => true },
          );
          await assert.rejects(wrongPrincipal.verifySystemRelease(systemInput.operationReference), {
            code: "STOCK_RESERVATION_UNAVAILABLE",
          });
          allowed = false;
          await assert.rejects(systemStore.verifySystemRelease(systemInput.operationReference), {
            code: "STOCK_RESERVATION_UNAVAILABLE",
          });

          throw rollbackSystem;
        }),
        (error) => error === rollbackSystem,
      );
      assert.equal(await adapter().resolveOperation(id(71)), null);
      assert.equal(
        (await adapter().loadCurrent(reservation.reservationReference)).reservation.version,
        1,
      );
      const competing = await Promise.allSettled([
        adapter().commit(releaseInput),
        adapter().commit(input(72, "Release", release, "2", 3)),
      ]);
      assert.equal(competing.filter((entry) => entry.status === "fulfilled").length, 1);
      const winner = competing[0].status === "fulfilled" ? id(71) : id(72);
      assert.deepEqual(
        (await adapter().loadCurrent(reservation.reservationReference)).reservation,
        release,
      );
      const started = advanceInventoryReservation(release, {
        reservationReference: reservation.reservationReference,
        binding,
        expectedVersion: 2,
        action: "StartProduction",
        quantity: null,
        occurredAt: at,
      });
      await assert.rejects(adapter().commit(input(73, "StartProduction", started, null, 4)), {
        code: "STOCK_RESERVATION_ITEM_INELIGIBLE",
      });
      await lifecycle("Active");
      await adapter().commit(input(73, "StartProduction", started, null, 4));
      const productionObservation = await adapter().loadCurrent(reservation.reservationReference);
      assert.deepEqual(productionObservation.reservation, started);
      assert.equal(productionObservation.movementReference, null);
      const illegalRelease = {
        ...started,
        version: 4,
        remainingQuantity: "3",
        releasedQuantity: "3",
      };
      await assert.rejects(adapter().commit(input(74, "Release", illegalRelease, "1", 4)), {
        code: "INVENTORY_RESERVATION_RELEASE_DENIED",
      });
      const consumed = advanceInventoryReservation(started, {
        reservationReference: reservation.reservationReference,
        binding,
        expectedVersion: 3,
        action: "Consume",
        quantity: "4",
        occurredAt: at,
      });
      // WP-2423: stock already in production is still recorded as consumed after the Item is
      // deactivated; only starting production is gated by the Item lifecycle (asserted above).
      await lifecycle("Inactive");
      await adapter().commit(input(75, "Consume", consumed, "4", 4));
      await lifecycle("Active");
      assert.deepEqual(
        (await adapter().loadCurrent(reservation.reservationReference)).reservation,
        consumed,
      );
      assert.equal((await adapter().resolveOperation(id(70))).reservation.version, 1);
      assert.equal((await adapter().resolveOperation(winner)).reservation.version, 2);
      const disabled = createInventoryItem({
        ...item,
        itemReference: id(96),
        internalCode: "SYNTHETIC_DISABLED",
        trackingPolicy: { ...item.trackingPolicy, stockTrackingEnabled: false },
        occurredAt: at,
        actorReference: id(9),
      });
      await admin.query(
        "INSERT INTO rms_inventory.inventory_item VALUES ($1,$2,$3,'SYNTHETIC_DISABLED','RawMaterial',$4,$5)",
        [id(1), id(2), id(96), at, id(9)],
      );
      await admin.query(
        "INSERT INTO rms_inventory.inventory_item_version VALUES ($1,$2,$3,1,$4,$5)",
        [id(1), id(2), id(96), disabled, at],
      );
      const disabledActive = transitionInventoryItem(disabled, "Active", {
        expectedVersion: 1,
        hasOpenWork: false,
        hasNonZeroStock: false,
        occurredAt: at,
        actorReference: id(9),
      });
      await admin.query(
        "INSERT INTO rms_inventory.inventory_item_version VALUES ($1,$2,$3,2,$4,$5)",
        [id(1), id(2), id(96), disabledActive, at],
      );
      await admin.query(
        "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,2,'KG',6,$8)",
        [id(1), id(2), id(3), id(4), id(5), id(97), id(96), at],
      );
      await admin.query(
        "INSERT INTO rms_inventory.stock_balance (tenant_id,brand_id,store_id,account_id,ledger_version,on_hand,reserved,in_transit) VALUES ($1,$2,$3,$4,1,0,0,0)",
        [id(1), id(2), id(3), id(97)],
      );
      const disabledReservation = createInventoryReservation({
        reservationReference: id(98),
        binding: { ...binding, itemReference: id(96), demandReference: id(95) },
        unit,
        quantity: "1",
        occurredAt: at,
      });
      await assert.rejects(
        adapter().commit({
          ...input(87, "Reserve", disabledReservation, "1", 1),
          accountReference: id(97),
        }),
        { code: "STOCK_RESERVATION_ITEM_INELIGIBLE" },
      );
      const counts = await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_inventory.stock_reservation_version) AS versions,(SELECT count(*)::int FROM rms_inventory.stock_movement) AS movements,(SELECT count(*)::int FROM platform_audit.audit_record) AS audits",
      );
      assert.deepEqual(counts.rows, [{ versions: 4, movements: 4, audits: 4 }]);
      await ensureSyntheticStockPlace(admin, {
        tenantId: id(1),
        brandId: id(2),
        storeId: id(3),
        stockSiteId: id(4),
        locationId: id(701),
        at,
      });
      await admin.query(
        "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at) SELECT $1::platform_helpers.uuid_v7,$2::platform_helpers.uuid_v7,$3::platform_helpers.uuid_v7,$4::platform_helpers.uuid_v7,$5::platform_helpers.uuid_v7,$6::platform_helpers.uuid_v7,$7::platform_helpers.uuid_v7,max(version),'KG',6,$8::timestamptz FROM rms_inventory.inventory_item_version WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$7",
        [id(1), id(2), id(3), id(4), id(701), id(700), id(6), at],
      );
      await admin.query(
        "INSERT INTO rms_inventory.stock_balance (tenant_id,brand_id,store_id,account_id,ledger_version,on_hand,reserved,in_transit) VALUES ($1,$2,$3,$4,1,0,0,0)",
        [id(1), id(2), id(3), id(700)],
      );
      const firstBefore = (
        await admin.query(
          "SELECT ledger_version::int AS version,reserved::text AS reserved FROM rms_inventory.stock_balance WHERE account_id=$1",
          [id(7)],
        )
      ).rows[0];
      const makeReservation = (n, location) =>
        createInventoryReservation({
          reservationReference: id(n),
          binding: { ...binding, locationReference: location, demandReference: id(705) },
          unit,
          quantity: "1",
          occurredAt: at,
        });
      const first = input(720, "Reserve", makeReservation(710, id(5)), "1", firstBefore.version);
      const second = {
        ...input(721, "Reserve", makeReservation(711, id(701)), "1", 1),
        accountReference: id(700),
      };
      let batchWrites = 0;
      await assert.rejects(adapter({ onWrite: () => batchWrites++ }).reserveAll([second, first]), {
        code: "STOCK_RESERVATION_INSUFFICIENT",
      });
      assert.equal(batchWrites, 1);
      assert.equal(await adapter().resolveOperation(id(720)), null);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT ledger_version::int AS version,reserved::text AS reserved FROM rms_inventory.stock_balance WHERE account_id=$1",
            [id(7)],
          )
        ).rows[0],
        firstBefore,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int AS count FROM platform_audit.audit_record"))
          .rows[0].count,
        4,
      );
      await scoped((client) =>
        append(
          client,
          730,
          "Receive",
          "2",
          balance(1, "0", "0", "0"),
          balance(2, "2", "0", "2"),
          { sourceScope: { scopeType: "Location", scopeReference: id(701) } },
          id(700),
        ),
      );
      const readySecond = { ...second, expectedLedgerVersion: 2 };
      await assert.rejects(adapter({ loseAck: true }).reserveAll([readySecond, first]), {
        code: "STOCK_RESERVATION_UNAVAILABLE",
      });
      const batchRecovered = await adapter().reserveAll([readySecond, first]);
      assert.deepEqual(
        batchRecovered.map((r) => r.status),
        ["AlreadyApplied", "AlreadyApplied"],
      );
      assert.equal(batchRecovered[0].reservation.reservationReference, id(711));
      assert.equal(batchRecovered[1].reservation.reservationReference, id(710));
      const mixed = {
        ...input(741, "Reserve", makeReservation(740, id(701)), "1", 3),
        accountReference: id(700),
      };
      await assert.rejects(adapter().reserveAll([first, mixed]), {
        code: "STOCK_RESERVATION_CONFLICT",
      });
      assert.equal(await adapter().resolveOperation(id(741)), null);
      assert.equal(
        (
          await admin.query(
            "SELECT reserved::text AS reserved FROM rms_inventory.stock_balance WHERE account_id=$1",
            [id(700)],
          )
        ).rows[0].reserved,
        "1",
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON rms_inventory.stock_reservation_set TO " +
          role,
      );
      const reservationSet = parseInventoryReservationSet({
        schemaVersion: 1,
        setReference: id(800),
        operationReference: id(801),
        actorReference: id(9),
        auditReference: id(802),
        workflowReference: id(803),
        workflowVersion: 1,
        requestDigest: "sha256:" + "c".repeat(64),
        entries: batchRecovered.map((r, i) => ({
          accountReference: i === 0 ? id(700) : id(7),
          operationReference: i === 0 ? id(721) : id(720),
          movementReference: r.movementReference,
          auditReference: r.auditReference,
          reservation: r.reservation,
        })),
      });
      async function insertSet(client, set) {
        const b = set.entries[0].reservation.binding;
        return client.query(
          "INSERT INTO rms_inventory.stock_reservation_set (tenant_id,brand_id,store_id,set_id,operation_id,actor_id,audit_id,workflow_id,workflow_version,request_digest,submission_id,cart_id,cart_version,quote_id,demand_id,demand_digest,created_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",
          [
            b.tenantReference,
            b.brandReference,
            b.storeReference,
            set.setReference,
            set.operationReference,
            set.actorReference,
            set.auditReference,
            set.workflowReference,
            set.workflowVersion,
            set.requestDigest,
            b.submissionReference,
            b.cartReference,
            b.cartVersion,
            b.quoteReference,
            b.demandReference,
            b.demandDigest,
            at,
            set,
          ],
        );
      }
      await assert.rejects(
        scoped((client) =>
          insertSet(client, {
            ...reservationSet,
            entries: [
              { ...reservationSet.entries[0], movementReference: id(899) },
              reservationSet.entries[1],
            ],
          }),
        ),
        { code: "23514" },
      );
      await scoped(async (client) => {
        await appendAuditRecordInTransaction(
          { query: (sql, values) => client.query(sql, [...values]) },
          {
            ...first.audit,
            auditId: id(802),
            actionCode: "INVENTORY_RESERVATION_SET",
            targetType: "InventoryReservationSet",
            targetId: id(800),
            correlationId: id(801),
          },
        );
        await insertSet(client, reservationSet);
      });
      assert.deepEqual(
        (
          await admin.query(
            "SELECT record_json FROM rms_inventory.stock_reservation_set WHERE set_id=$1",
            [id(800)],
          )
        ).rows[0].record_json,
        reservationSet,
      );
      await assert.rejects(
        admin.query("UPDATE rms_inventory.stock_reservation_set SET workflow_version=2"),
        { code: "55000" },
      );
      await assert.rejects(admin.query("DELETE FROM rms_inventory.stock_reservation_set"), {
        code: "55000",
      });
      await scoped(
        async (client) =>
          assert.equal(
            (await client.query("SELECT * FROM rms_inventory.stock_reservation_set")).rowCount,
            0,
          ),
        [id(1), id(2), id(99)],
      );
      const completeWrites = [];
      for (const [account, location, n] of [
        [7, 5, 910],
        [700, 701, 920],
      ]) {
        const ledger = (
          await admin.query(
            "SELECT ledger_version::text AS version FROM rms_inventory.stock_balance WHERE account_id=$1",
            [id(account)],
          )
        ).rows[0];
        const reservation = createInventoryReservation({
          reservationReference: id(n),
          binding: { ...binding, locationReference: id(location), demandReference: id(900) },
          unit,
          quantity: "0.1",
          occurredAt: at,
        });
        completeWrites.push({
          ...input(n + 1, "Reserve", reservation, "0.1", Number(ledger.version)),
          accountReference: id(account),
        });
      }
      const setWrite = {
        setReference: id(930),
        operationReference: id(931),
        workflowReference: id(803),
        workflowVersion: 1,
        writes: completeWrites,
        audit: {
          ...first.audit,
          auditId: id(932),
          actionCode: "INVENTORY_RESERVATION_SET",
          targetType: "InventoryReservationSet",
          targetId: id(930),
          correlationId: id(931),
        },
      };
      const setCounts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_inventory.stock_reservation_version) AS reservations, " +
              "(SELECT count(*)::int FROM rms_inventory.stock_movement) AS movements, " +
              "(SELECT count(*)::int FROM platform_audit.audit_record) AS audits, " +
              "(SELECT count(*)::int FROM rms_inventory.stock_reservation_set) AS sets",
          )
        ).rows[0];
      const setBalances = async () =>
        (
          await admin.query(
            "SELECT account_id, ledger_version::text, on_hand::text, reserved::text, available::text " +
              "FROM rms_inventory.stock_balance WHERE account_id=ANY($1::uuid[]) ORDER BY account_id",
            [[id(7), id(700)]],
          )
        ).rows;
      const beforeBalances = await setBalances();
      const beforeSet = await setCounts();
      let setChildren = 0;
      await assert.rejects(
        adapter({ failSet: true, onWrite: () => setChildren++ }).commitSet(setWrite),
        { code: "STOCK_RESERVATION_UNAVAILABLE" },
      );
      assert.equal(setChildren, 2);
      assert.deepEqual(await setCounts(), beforeSet);
      assert.deepEqual(await setBalances(), beforeBalances);
      assert.equal(await adapter().resolveOperation(id(911)), null);
      await assert.rejects(adapter({ loseAck: true }).commitSet(setWrite), {
        code: "STOCK_RESERVATION_UNAVAILABLE",
      });
      const recoveredSet = await adapter().commitSet({
        ...setWrite,
        audit: { ...setWrite.audit, auditId: id(933) },
        writes: [...completeWrites].reverse().map((w, i) => ({
          ...w,
          movementReference: id(940 + i),
          audit: { ...w.audit, auditId: id(950 + i) },
        })),
      });
      assert.equal(recoveredSet.status, "AlreadyApplied");
      assert.equal(recoveredSet.set.auditReference, id(932));
      assert.equal(recoveredSet.set.entries.length, 2);
      assert.equal(
        recoveredSet.set.entries[0].movementReference,
        completeWrites[0].movementReference,
      );
      assert.deepEqual(await setCounts(), {
        reservations: beforeSet.reservations + 2,
        movements: beforeSet.movements + 2,
        audits: beforeSet.audits + 3,
        sets: beforeSet.sets + 1,
      });
      await assert.rejects(adapter().commitSet({ ...setWrite, writes: [completeWrites[0]] }), {
        code: "STOCK_RESERVATION_IDEMPOTENCY_CONFLICT",
      });
      await assert.rejects(adapter().commitSet({ ...setWrite, workflowVersion: 2 }), {
        code: "STOCK_RESERVATION_IDEMPOTENCY_CONFLICT",
      });
      await assert.rejects(
        adapter().commitSet({
          ...setWrite,
          setReference: id(960),
          operationReference: id(961),
          audit: { ...setWrite.audit, auditId: id(962), targetId: id(960), correlationId: id(961) },
        }),
        { code: "STOCK_RESERVATION_CONFLICT" },
      );
      await assert.rejects(
        adapter().commitSet({
          ...setWrite,
          audit: { ...setWrite.audit, actor: { type: "User", reference: id(963) } },
          writes: completeWrites.map((w) => ({
            ...w,
            audit: { ...w.audit, actor: { type: "User", reference: id(963) } },
          })),
        }),
        { code: "STOCK_RESERVATION_IDEMPOTENCY_CONFLICT" },
      );
      const releaseWrites = [];
      for (const [index, entry] of reservationSet.entries.entries()) {
        const ledger = (
          await admin.query(
            "SELECT ledger_version::int AS version FROM rms_inventory.stock_balance WHERE account_id=$1",
            [entry.accountReference],
          )
        ).rows[0];
        const next = advanceInventoryReservation(entry.reservation, {
          reservationReference: entry.reservation.reservationReference,
          binding: entry.reservation.binding,
          expectedVersion: 1,
          action: "Release",
          quantity: entry.reservation.remainingQuantity,
          occurredAt: at,
        });
        const write = input(
          11000 + index,
          "Release",
          next,
          entry.reservation.remainingQuantity,
          ledger.version,
        );
        releaseWrites.push({
          ...write,
          accountReference: entry.accountReference,
          audit: {
            ...write.audit,
            actor: { type: "System" },
            reasonCode: "CHECKOUT_DEADLINE_REACHED",
            sourceChannel: "SYSTEM",
          },
        });
      }
      for (const write of releaseWrites)
        assert.equal(
          await adapter().loadAccountLedgerVersion(write.accountReference),
          write.expectedLedgerVersion,
        );
      assert.equal(await adapter().loadAccountLedgerVersion(id(12999)), null);
      const releaseRequest = { set: reservationSet, writes: releaseWrites };
      let children = 0;
      const releasing = (options = {}) =>
        createPostgresStockReservationStore(
          {
            run: async (work) => {
              const result = await scoped(async (client) =>
                work({
                  query: async (sql, values) => {
                    if (sql.startsWith("INSERT INTO rms_inventory.stock_reservation_version")) {
                      children++;
                      if (options.failSecond && children === 2)
                        throw new Error("synthetic second release failure");
                    }
                    return client.query(sql, [...values]);
                  },
                }),
              );
              if (options.loseAck) throw new Error("synthetic release response loss");
              return result;
            },
          },
          { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
          { systemActorReference: id(900), authorize: async () => true },
        );
      const source = async (tx, set) => {
        const stored = (
          await tx.query(
            "SELECT record_json FROM rms_inventory.stock_reservation_set WHERE set_id=$1",
            [set.setReference],
          )
        ).rows[0];
        assert.deepEqual(stored.record_json, set);
        return true;
      };
      const releaseBefore = await setCounts(),
        balancesBeforeRelease = await setBalances();
      await assert.rejects(
        releasing().releaseSet({ ...releaseRequest, writes: [releaseWrites[0]] }, source),
        { code: "STOCK_RESERVATION_UNAVAILABLE" },
      );
      await assert.rejects(
        releasing().releaseSet(releaseRequest, async () => false),
        { code: "STOCK_RESERVATION_UNAVAILABLE" },
      );
      await assert.rejects(releasing({ failSecond: true }).releaseSet(releaseRequest, source), {
        code: "STOCK_RESERVATION_UNAVAILABLE",
      });
      assert.equal(children, 2);
      assert.deepEqual(await setCounts(), releaseBefore);
      assert.deepEqual(await setBalances(), balancesBeforeRelease);
      for (const write of releaseWrites)
        assert.equal(await adapter().resolveOperation(write.operationReference), null);
      await assert.rejects(releasing({ loseAck: true }).releaseSet(releaseRequest, source), {
        code: "STOCK_RESERVATION_UNAVAILABLE",
      });
      const recoveredRelease = await releasing().releaseSet(
        { ...releaseRequest, writes: [...releaseWrites].reverse() },
        source,
      );
      assert.equal(recoveredRelease.status, "AlreadyApplied");
      assert.equal(recoveredRelease.entries.length, 2);
      for (const entry of recoveredRelease.entries)
        assert.equal(entry.reservation.remainingQuantity, "0");
      assert.deepEqual(await setCounts(), {
        ...releaseBefore,
        reservations: releaseBefore.reservations + 2,
        movements: releaseBefore.movements + 2,
        audits: releaseBefore.audits + 2,
      });
      await assert.rejects(
        releasing().releaseSet(releaseRequest, async () => false),
        { code: "STOCK_RESERVATION_UNAVAILABLE" },
      );
      const mixedRelease = {
        ...releaseRequest,
        writes: [
          {
            ...releaseWrites[0],
            operationReference: id(11999),
            audit: { ...releaseWrites[0].audit, correlationId: id(11999) },
          },
          releaseWrites[1],
        ],
      };
      await assert.rejects(releasing().releaseSet(mixedRelease, source), {
        code: "STOCK_RESERVATION_CONFLICT",
      });
      for (const scope of [
        { tenantReference: id(90), brandReference: id(2), storeReference: id(3) },
        { tenantReference: id(1), brandReference: id(90), storeReference: id(3) },
        { tenantReference: id(1), brandReference: id(2), storeReference: id(90) },
      ]) {
        assert.equal(await adapter({}, scope).resolveOperation(id(70)), null);
        assert.equal(await adapter({}, scope).loadCurrent(reservation.reservationReference), null);
      }
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});
