import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createInventoryItem,
  transitionInventoryItem,
  createInventoryReservation,
  advanceInventoryReservation,
  createPostgresStockReservationStore,
  parseSubmissionInventoryFinalValidation,
} from "../../rms/inventory/src/index.ts";
import { createPaidWithoutFulfillableInventoryRelease } from "../../../apps/api/src/paid-without-fulfillable-inventory-release.ts";
import { createSubmissionInventoryRelease } from "../../../apps/api/src/submission-inventory-release.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";
const { Client } = pg;
const id = (n) => "0190a7c1-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const at = "2026-09-11T10:00:00.000Z",
  cancelledAt = "2026-09-11T10:02:00.000Z",
  startedAt = "2026-09-11T10:03:00.000Z",
  evaluatedAt = "2026-09-11T10:05:00.000Z",
  now = "2026-09-11T10:06:00.000Z";
const [tenant, brand, store, site, location, item, account, actor, system] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9,
].map(id);
const unit = {
  unitCode: "KG",
  dimension: "Mass",
  displayPrecision: 2,
  ledgerPrecision: 6,
  roundingMode: "HalfEven",
};
const scope = { tenantReference: tenant, brandReference: brand, storeReference: store };
/**
 * WP-2423 Q12: a paid submission Ordering decided it cannot fulfil returns the stock reserved at
 * submission. The release runs as a restricted NOBYPASSRLS role holding the pilot API grants for the
 * tables it touches; setup facts are written by the isolated database owner.
 */
it("returns reserved stock for a paid submission that cannot be fulfilled, once, and never after production started", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_pwfo_release" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_pwfo_" + context.runId;
    assert.match(role, /^wp2423_pwfo_[a-f0-9]+$/u);
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      // Mirrors docs/spec/pilot-acl-matrix.json for the pilot API role on these tables only.
      for (const sql of [
        "GRANT USAGE ON SCHEMA rms_inventory,rms_ordering,platform_helpers,platform_audit TO ",
        "GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ",
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ",
        "GRANT SELECT ON rms_ordering.order_payment_disposition_record TO ",
        "GRANT SELECT ON rms_inventory.submission_final_validation TO ",
        "GRANT SELECT,INSERT ON rms_inventory.stock_reservation_set TO ",
        "GRANT SELECT,INSERT,UPDATE ON rms_inventory.stock_account,rms_inventory.stock_balance,rms_inventory.stock_reservation_version,rms_inventory.inventory_item TO ",
        "GRANT SELECT,INSERT ON rms_inventory.stock_movement,rms_inventory.inventory_item_version TO ",
        "GRANT SELECT ON rms_inventory.stock_lot_hold_version,rms_inventory.stock_site_version,rms_inventory.storage_location_version TO ",
        "GRANT SELECT,INSERT ON platform_audit.audit_record TO ",
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ",
      ])
        await admin.query(sql + role);
      async function scoped(work) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL lock_timeout='5s'");
          await client.query("SET LOCAL statement_timeout='10s'");
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, brand, store],
          );
          const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      }
      const owner = (tx) => createPostgresStockReservationStore({ run: (work) => work(tx) }, scope);

      // Item, stock place, one account holding 10 KG on hand.
      await admin.query(
        "INSERT INTO rms_inventory.inventory_item VALUES ($1,$2,$3,'SYNTHETIC','RawMaterial',$4,$5)",
        [tenant, brand, item, at, actor],
      );
      const draft = createInventoryItem({
        tenantReference: tenant,
        brandReference: brand,
        itemReference: item,
        internalCode: "SYNTHETIC",
        itemType: "RawMaterial",
        localizedNames: { en: "Synthetic stock item" },
        baseUnit: unit,
        trackingPolicy: {
          stockTrackingEnabled: true,
          lotTrackingMode: "NoLot",
          defaultShelfLifeDays: null,
          expiryWarningDays: null,
          issuePolicy: "FIFO",
          negativeStockPolicy: "Block",
        },
        occurredAt: at,
        actorReference: actor,
      });
      const active = transitionInventoryItem(draft, "Active", {
        expectedVersion: 1,
        hasOpenWork: false,
        hasNonZeroStock: false,
        occurredAt: at,
        actorReference: actor,
      });
      for (const snapshot of [draft, active])
        await admin.query(
          "INSERT INTO rms_inventory.inventory_item_version VALUES ($1,$2,$3,$4,$5,$6)",
          [tenant, brand, item, snapshot.aggregateVersion, snapshot, at],
        );
      await ensureSyntheticStockPlace(admin, {
        tenantId: tenant,
        brandId: brand,
        storeId: store,
        stockSiteId: site,
        locationId: location,
        at,
      });
      await admin.query(
        "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,2,'KG',6,$8)",
        [tenant, brand, store, site, location, account, item, at],
      );
      await admin.query(
        "INSERT INTO rms_inventory.stock_balance (tenant_id,brand_id,store_id,account_id,ledger_version,on_hand,reserved,in_transit) VALUES ($1,$2,$3,$4,1,0,0,0)",
        [tenant, brand, store, account],
      );
      const balance = (ledgerVersion, onHand, reserved, available) => ({
        ledgerVersion,
        onHand,
        reserved,
        available,
        inTransit: "0",
        unitCode: "KG",
      });
      await scoped((tx) =>
        tx.query(
          "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,2,'Receive','10',$6,$7,$8)",
          [
            tenant,
            brand,
            store,
            account,
            id(20),
            {
              movementReference: id(20),
              tenantReference: tenant,
              brandReference: brand,
              itemReference: item,
              movementType: "Receive",
              quantityDelta: "10",
              unitCode: "KG",
              baseQuantityDelta: "10",
              baseUnitCode: "KG",
              conversionMultiplier: "1",
              sourceScope: { scopeType: "Location", scopeReference: location },
              destinationScope: null,
              lotReference: null,
              expiryDate: null,
              businessSourceType: "SYNTHETIC",
              businessSourceReference: id(21),
              reasonCode: "SYNTHETIC_TEST",
              performedBy: actor,
              occurredAt: at,
              before: balance(1, "0", "0", "0"),
              after: balance(2, "10", "0", "10"),
              auditReference: id(22),
              correctsMovementReference: null,
            },
            id(22),
            at,
          ],
        ),
      );
      const stock = async () =>
        (
          await admin.query(
            'SELECT on_hand::text AS "onHand",reserved::text AS reserved FROM rms_inventory.stock_balance WHERE account_id=$1',
            [account],
          )
        ).rows[0];
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_inventory.stock_reservation_version) AS reservations," +
              "(SELECT count(*)::int FROM rms_inventory.stock_movement) AS movements," +
              "(SELECT count(*)::int FROM platform_audit.audit_record) AS audits",
          )
        ).rows[0];
      assert.deepEqual(await stock(), { onHand: "10", reserved: "0" });

      /** Reserve at submission, record final validation, then Ordering's paid-unfulfillable outcome. */
      async function submitPaidUnfulfillable(n, quantity, reason) {
        const base = n * 100;
        const refs = {
          order: id(base + 1),
          batch: id(base + 2),
          submission: id(base + 3),
          cart: id(base + 4),
          quote: id(base + 5),
          demand: id(base + 6),
          workflow: id(base + 7),
          reservation: id(base + 8),
          disposition: id(base + 50),
          paymentEvent: id(base + 51),
        };
        const audit = (n2, targetType, targetId, actionCode) => ({
          auditId: id(base + n2),
          brandId: brand,
          storeId: store,
          actor: { type: "User", reference: actor },
          actionCode,
          targetType,
          targetId,
          reasonCode: "AUTHORIZED_CHANGE",
          correlationId: id(base + n2 + 1),
          occurredAt: at,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Internal",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        });
        const reservation = createInventoryReservation({
          reservationReference: refs.reservation,
          binding: {
            tenantReference: tenant,
            brandReference: brand,
            storeReference: store,
            stockSiteReference: site,
            locationReference: location,
            itemReference: item,
            lotReference: null,
            submissionReference: refs.submission,
            cartReference: refs.cart,
            cartVersion: 1,
            quoteReference: refs.quote,
            demandReference: refs.demand,
            demandDigest: hash(["demand", n]),
          },
          unit,
          quantity,
          occurredAt: at,
        });
        const result = await scoped(async (tx) => {
          const ledger = await owner(tx).loadAccountLedgerVersion(account);
          const write = {
            operationReference: id(base + 10),
            accountReference: account,
            action: "Reserve",
            expectedLedgerVersion: ledger,
            quantity,
            reservation,
            movementReference: id(base + 11),
            audit: {
              ...audit(
                12,
                "InventoryReservation",
                refs.reservation,
                "INVENTORY_RESERVATION_RESERVE",
              ),
              correlationId: id(base + 10),
            },
          };
          return owner(tx).commitSet({
            setReference: id(base + 20),
            operationReference: id(base + 21),
            workflowReference: refs.workflow,
            workflowVersion: 1,
            writes: [write],
            audit: {
              ...audit(22, "InventoryReservationSet", id(base + 20), "INVENTORY_RESERVATION_SET"),
              correlationId: id(base + 21),
            },
          });
        });
        assert.equal(result.status, "Applied");
        const record = parseSubmissionInventoryFinalValidation({
          schemaVersion: 1,
          validationReference: id(base + 30),
          operationReference: id(base + 31),
          actorReference: result.set.actorReference,
          auditReference: id(base + 32),
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          orderReference: refs.order,
          submissionReference: refs.submission,
          cartReference: refs.cart,
          cartVersion: 1,
          quoteReference: refs.quote,
          demandReference: refs.demand,
          demandDigest: hash(["demand", n]),
          workflowReference: refs.workflow,
          workflowVersionReference: id(base + 33),
          workflowVersion: 1,
          transitionReference: id(base + 34),
          observedAt: at,
          items: [
            {
              itemReference: item,
              currentItemVersion: 2,
              configurationOperationReferences: [id(base + 35)],
              unit,
              quantity,
              stockTrackingEnabled: true,
              disposition: "Reserved",
              deferredActionCode: null,
            },
          ],
          reservationSet: result.set,
        });
        await admin.query(
          "INSERT INTO rms_inventory.submission_final_validation (tenant_id,brand_id,store_id,validation_id,operation_id,actor_id,audit_id,order_id,submission_id,cart_id,cart_version,quote_id,demand_id,demand_digest,workflow_id,workflow_version_id,workflow_version,transition_id,reservation_set_id,observed_at,record_digest,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)",
          [
            tenant,
            brand,
            store,
            record.validationReference,
            record.operationReference,
            record.actorReference,
            record.auditReference,
            record.orderReference,
            record.submissionReference,
            record.cartReference,
            record.cartVersion,
            record.quoteReference,
            record.demandReference,
            record.demandDigest,
            record.workflowReference,
            record.workflowVersionReference,
            record.workflowVersion,
            record.transitionReference,
            result.set.setReference,
            at,
            hash(record),
            record,
          ],
        );
        // Synthetic Ordering source facts; the release only reads them through Ordering's reader.
        await admin.query(
          "INSERT INTO rms_ordering.order_number_allocation " +
            "(order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at," +
            "business_date_configuration_id,business_date_configuration_version,business_date_content_digest," +
            "time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) " +
            "VALUES ($1,$2,$3,'2026-09-11',$4,$5,$6,$7,1,$8,'America/Toronto','00:00',$6,'Exact')",
          [refs.order, brand, store, n, String(n), at, id(40), hash("business-date")],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_header " +
            "(order_id,brand_id,store_id,business_date,order_number,order_type,source_channel," +
            "created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) " +
            "VALUES ($1,$2,$3,'2026-09-11',$4,'Pickup','Web',$5,$5,1,'Submitted','Open','NotReported',$6)",
          [refs.order, brand, store, String(n), actor, at],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_submission_record " +
            "(submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)",
          [
            refs.submission,
            brand,
            store,
            refs.order,
            id(base + 60),
            hash(["intent", n]),
            refs.cart,
            refs.quote,
            at,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_batch " +
            "(order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)",
          [
            refs.batch,
            brand,
            store,
            refs.order,
            refs.submission,
            refs.cart,
            id(base + 61),
            refs.quote,
            actor,
            at,
          ],
        );
        const disposition = {
          dispositionReference: refs.disposition,
          brandReference: brand,
          storeReference: store,
          orderReference: refs.order,
          orderBatchReference: refs.batch,
          submissionReference: refs.submission,
          paymentTransactionReference: id(base + 52),
          paymentIntentReference: id(base + 53),
          paymentAttemptReference: id(base + 54),
          paymentEventReference: refs.paymentEvent,
          sourceVersion: 1,
          sourceCheckpoint: id(base + 55),
          sourceDigest: hash(["source", n]),
          evaluatedAt,
          disposition: "PaidWithoutFulfillableOrder",
          reason,
          kitchenReleaseDisposition: "Blocked",
        };
        await admin.query(
          "INSERT INTO rms_ordering.order_payment_disposition_record " +
            "(disposition_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_transaction_id,payment_intent_id,payment_attempt_id,payment_event_id,source_checkpoint,correlation_id,source_version,source_digest,evaluated_at,disposition,reason,kitchen_release_disposition) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'PaidWithoutFulfillableOrder',$16,'Blocked')",
          [
            refs.disposition,
            brand,
            store,
            refs.order,
            refs.batch,
            refs.submission,
            disposition.paymentTransactionReference,
            disposition.paymentIntentReference,
            disposition.paymentAttemptReference,
            refs.paymentEvent,
            disposition.sourceCheckpoint,
            id(base + 56),
            1,
            disposition.sourceDigest,
            evaluatedAt,
            reason,
          ],
        );
        return { refs, reservation, disposition, set: result.set };
      }
      const capacity = await submitPaidUnfulfillable(1, "2", "CapacityExpired");
      const started = await submitPaidUnfulfillable(2, "3", "OrderNoLongerFulfillable");
      const cancelled = await submitPaidUnfulfillable(3, "1.5", "SubmissionCancelled");
      assert.deepEqual(await stock(), { onHand: "10", reserved: "6.5" });

      // The kitchen started production for one submission before Ordering's decision.
      await scoped(async (tx) => {
        const next = advanceInventoryReservation(started.reservation, {
          reservationReference: started.reservation.reservationReference,
          binding: started.reservation.binding,
          expectedVersion: 1,
          action: "StartProduction",
          quantity: null,
          occurredAt: startedAt,
        });
        const result = await owner(tx).commit({
          operationReference: id(290),
          accountReference: account,
          action: "StartProduction",
          expectedLedgerVersion: await owner(tx).loadAccountLedgerVersion(account),
          quantity: null,
          reservation: next,
          movementReference: null,
          audit: {
            auditId: id(291),
            brandId: brand,
            storeId: store,
            actor: { type: "User", reference: actor },
            actionCode: "INVENTORY_RESERVATION_START_PRODUCTION",
            targetType: "InventoryReservation",
            targetId: next.reservationReference,
            reasonCode: "AUTHORIZED_CHANGE",
            correlationId: id(290),
            occurredAt: startedAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        });
        assert.equal(result.status, "Applied");
      });
      // The cancelled submission's stock was already returned by the dining checkout cancellation.
      const dining = await scoped((tx) =>
        createSubmissionInventoryRelease({
          scope,
          systemActorReference: system,
          reasonCode: "CHECKOUT_DEADLINE_REACHED",
          now: () => now,
        }).release(tx, {
          source: {
            kind: "DiningCancellationInventory/v1",
            reference: id(399),
            submissionReference: cancelled.refs.submission,
            orderReference: cancelled.refs.order,
            occurredAt: cancelledAt,
          },
          releasedAt: cancelledAt,
          authorize: async () => true,
        }),
      );
      assert.deepEqual(dining, { status: "Released", entryCount: 1 });
      assert.deepEqual(await stock(), { onHand: "10", reserved: "5" });

      let allowed = true;
      const authorizations = [];
      const release = (disposition) =>
        scoped((tx) =>
          createPaidWithoutFulfillableInventoryRelease({
            scope,
            systemActorReference: system,
            now: () => now,
            authorize: async (actual, value) => {
              assert.equal(actual, tx);
              authorizations.push(value.dispositionReference);
              return allowed;
            },
          })(tx, disposition),
        );

      // Authority loss and a changed proposal write nothing.
      const before = await counts();
      allowed = false;
      await assert.rejects(release(capacity.disposition));
      allowed = true;
      await assert.rejects(release({ ...capacity.disposition, reason: "SubmissionCancelled" }));
      assert.deepEqual(await counts(), before);
      assert.deepEqual(await stock(), { onHand: "10", reserved: "5" });

      // Ordinary path: the paid but unfulfillable submission returns exactly its reservation.
      assert.deepEqual(await release(capacity.disposition), { status: "Released", entryCount: 1 });
      assert.deepEqual(await stock(), { onHand: "10", reserved: "3" });
      const afterRelease = await counts();
      assert.deepEqual(afterRelease, {
        reservations: before.reservations + 1,
        movements: before.movements + 1,
        audits: before.audits + 1,
      });
      const current = await scoped((tx) =>
        owner(tx).loadCurrent(capacity.reservation.reservationReference),
      );
      assert.equal(current.reservation.remainingQuantity, "0");
      assert.equal(current.reservation.releasedQuantity, "2");
      assert.equal(current.reservation.updatedAt, now);
      const movement = (
        await admin.query(
          "SELECT record_json FROM rms_inventory.stock_movement WHERE movement_id=$1",
          [current.movementReference],
        )
      ).rows[0].record_json;
      assert.equal(movement.movementType, "Release");
      assert.equal(movement.performedBy, system);
      assert.equal(movement.reasonCode, "PAID_WITHOUT_FULFILLABLE_ORDER");
      assert.equal(movement.businessSourceReference, capacity.reservation.reservationReference);
      const auditRow = (
        await admin.query(
          "SELECT actor_type,actor_reference,reason_code,source_channel,action_code FROM platform_audit.audit_record WHERE audit_id=$1",
          [current.auditReference],
        )
      ).rows[0];
      assert.deepEqual(auditRow, {
        actor_type: "System",
        actor_reference: null,
        reason_code: "PAID_WITHOUT_FULFILLABLE_ORDER",
        source_channel: "SYSTEM",
        action_code: "INVENTORY_RESERVATION_RELEASE",
      });

      // Replay (worker restart, next scan) verifies the original release and writes nothing.
      assert.deepEqual(await release(capacity.disposition), {
        status: "AlreadyApplied",
        entryCount: 1,
      });
      assert.deepEqual(await counts(), afterRelease);
      assert.deepEqual(await stock(), { onHand: "10", reserved: "3" });

      // Started production is never released here; it stays for staff.
      assert.deepEqual(await release(started.disposition), {
        status: "NotReleasable",
        reason: "ProductionStarted",
      });
      // Already returned by the dining cancellation: verified no-op, no second release.
      assert.deepEqual(await release(cancelled.disposition), {
        status: "NothingToRelease",
        reason: "AlreadyReleased",
      });
      assert.deepEqual(await counts(), afterRelease);
      assert.deepEqual(await stock(), { onHand: "10", reserved: "3" });
      assert(authorizations.includes(started.refs.disposition));

      // History stays append-only.
      await assert.rejects(
        admin.query("DELETE FROM rms_inventory.stock_movement WHERE movement_id=$1", [
          current.movementReference,
        ]),
      );
      // Another Store sees no disposition and cannot release.
      await assert.rejects(
        scoped((tx) =>
          createPaidWithoutFulfillableInventoryRelease({
            scope: { ...scope, storeReference: id(999) },
            systemActorReference: system,
            now: () => now,
            authorize: async () => true,
          })(tx, { ...capacity.disposition, storeReference: id(999) }),
        ),
      );
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});
