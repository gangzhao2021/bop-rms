import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  createPostgresDiningBatchCancellationCandidates,
  createPostgresDiningCheckoutExpiryCandidates,
  createPostgresOrderRoundStaffHoldStore,
  listStoreUnpaidGuestDiningRounds,
  orderCancelledEventMatchesRecord,
} from "../../rms/ordering/src/index.ts";
import {
  createPaymentIntentCreationService,
  createPaymentProviderSnapshot,
  createPostgresPaymentIntentCreationStore,
  listStoreOrderBatchesPaidOnline,
  PaymentIntentCreationError,
} from "../../rms/payment/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { applyWorkflowRelease } from "../../../tooling/environment/workflow-release-install.mjs";
import { createInternalBatchCancellation } from "../../../tooling/environment/pilot-batch-cancellation.mjs";
import { createInternalBatchCancellationDispatcher } from "../../../tooling/environment/pilot-batch-cancellation-dispatcher.mjs";
import { createInternalOpenPaymentResolution } from "../../../tooling/environment/pilot-open-payment-resolution.mjs";
import { createDiningCheckoutExpiryRecorder } from "../../../apps/api/src/dining-checkout-expiry-recorder.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createInventoryItem,
  createInventoryReservation,
  createPostgresStockReservationStore,
  parseSubmissionInventoryFinalValidation,
  transitionInventoryItem,
} from "../../rms/inventory/src/index.ts";
import { seedJourneyPayment } from "../test-support/dine-in-journey-seed.mjs";

const { Client } = pg;
const id = (n) => "01a1ab00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = (c) => "sha256:" + c.repeat(64);
const digest = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const minutes = (n) => n * 60_000;
const [tenant, brand, store, session, table, provider, systemActor, operator, approver, evidence] =
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(id);
const scope = { tenantReference: tenant, brandReference: brand, storeReference: store };

/**
 * WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT; v15 DEMO-02 round 1). A guest started
 * paying online for a dine-in round and left; the round was stranded (no pay link, never cancelled,
 * stock held, table not closable). Here, as the restricted NOBYPASSRLS role holding exactly the
 * rendered pilot API grants, with the Platform Workflow release installed by its operator tool:
 * 1. the guest comes back to the SAME payment (resume: no new attempt, no tip from the request) and
 *    finishes it;
 * 2. a manager cancels an unpaid round before its deadline: refused while the online attempt is
 *    open; after Payment cancelled the never-confirmed attempt with the Provider the round is
 *    cancelled (STAFF_CANCELLED_UNPAID, OrderCancelled, audit naming the manager), once;
 * 3. a round the guest paid is never cancelled by staff;
 * 4. a payment that succeeded at the Provider but whose answer never arrived is recorded as paid at
 *    the deadline and the round is not cancelled.
 * The deadline cancellation of a never-finished payment (PAYMENT_NOT_COMPLETED, stock returned) runs
 * in the dine-in journey acceptance. Test-only: owner facts are seeded by the database owner (seed
 * triggers and foreign keys skipped; the role's writes run every trigger, including 2000_069), the
 * Provider is an in-memory stand-in with the simulator's semantics, and Guest authorization of the
 * payment owner is a stand-in for the round's own guest.
 */
it("lets a guest finish an abandoned payment, staff cancel an unpaid round, and records late success", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_abandoned" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_abp_" + context.runId,
      worker = "wp2423_abp_w_" + context.runId;
    assert.match(role, /^wp2423_abp_[a-f0-9]+$/u);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BOP_PILOT_ENVIRONMENT", undefined);
    try {
      for (const name of [role, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));
      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (offset) => new Date(base + offset).toISOString();
      const now = () => new Date().toISOString();
      let sequence = 0x9000;
      const fresh = () =>
        Date.now()
          .toString(16)
          .padStart(12, "0")
          .replace(/^(.{8})(.{4})$/u, "$1-$2") +
        "-7000-8000-" +
        (sequence++).toString(16).padStart(12, "0");

      // ── Platform Workflow release for unpaid-round cancellation (operator tool, as on the pilot).
      const releaseAt = base - minutes(200);
      const hex = releaseAt.toString(16).padStart(12, "0");
      await admin.query("BEGIN");
      const release = await applyWorkflowRelease(
        admin,
        {
          release: "UnpaidDineInBatchCancellation",
          tenantReference: tenant,
          brandReference: brand,
          operatorReference: operator,
          approvedByReference: approver,
          approvalEvidenceReference: evidence,
          operationReference: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000001`,
        },
        () => releaseAt + 1000,
      );
      await admin.query("COMMIT");
      assert.equal(release.status, "Applied");

      /** One guest round (its own Order) whose payment was requested at `requestedAt`. */
      async function guestRound(n, requestedAt) {
        const k = n * 0x100;
        const refs = {
          order: id(k + 1),
          batch: id(k + 2),
          submission: id(k + 3),
          item: id(k + 4),
          guest: id(k + 5),
          operation: id(k + 6),
          commitment: id(k + 7),
          cart: id(k + 9),
          quote: id(k + 10),
        };
        const preparedAt = new Date(Date.parse(requestedAt) - 3000).toISOString(),
          validUntil = new Date(Date.parse(preparedAt) + minutes(5)).toISOString(),
          expiresAt = new Date(Date.parse(requestedAt) + minutes(30)).toISOString();
        const q = (sql, values) => admin.query(sql, values);
        await q(
          "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES ($1,$2,$3,'2026-10-16',$4,'DineIn','Qr',$5,$6,$6,1,'Submitted','Open','NotReported',$7)",
          [refs.order, brand, store, String(n), session, refs.guest, preparedAt],
        );
        await q(
          "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)",
          [
            refs.submission,
            brand,
            store,
            refs.order,
            refs.guest,
            sha("1"),
            refs.cart,
            refs.quote,
            preparedAt,
          ],
        );
        await q(
          "INSERT INTO rms_ordering.order_batch (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)",
          [
            refs.batch,
            brand,
            store,
            refs.order,
            refs.submission,
            refs.cart,
            id(k + 11),
            refs.quote,
            refs.guest,
            preparedAt,
          ],
        );
        await q(
          "INSERT INTO rms_ordering.order_item (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7,$8,$9)",
          [
            refs.item,
            brand,
            store,
            refs.order,
            refs.batch,
            id(k + 12),
            sha("2"),
            { catalog: {}, pricing: {} },
            preparedAt,
          ],
        );
        await q(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Initial',1,0,NULL,$1,$5)",
          [refs.submission, brand, store, refs.order, preparedAt],
        );
        await q(
          "INSERT INTO rms_ordering.checkout_session_allocation (brand_id,store_id,create_operation_id,guest_session_id,cart_id,cart_version,quote_id,quote_version,checkout_session_id,submission_id,payment_operation_id,allocated_at) VALUES ($1,$2,$3,$4,$5,1,$6,1,$7,$8,$9,$10)",
          [
            brand,
            store,
            id(k + 20),
            refs.guest,
            refs.cart,
            refs.quote,
            id(k + 21),
            refs.submission,
            refs.operation,
            preparedAt,
          ],
        );
        await q(
          "INSERT INTO rms_ordering.order_capacity_link (brand_id,store_id,submission_id,order_id,order_batch_id,commitment_id,payment_operation_id,created_at,link_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            brand,
            store,
            refs.submission,
            refs.order,
            refs.batch,
            refs.commitment,
            refs.operation,
            requestedAt,
            {
              owner: "Dining",
              commitmentReference: refs.commitment,
              commitmentVersion: 1,
              ownerContextReference: session,
              ownerIntentDigest: sha("a"),
              ownerSnapshotDigest: sha("b"),
              brandReference: brand,
              storeReference: store,
              orderReference: refs.order,
              orderBatchReference: refs.batch,
              submissionReference: refs.submission,
              cartReference: refs.cart,
              cartVersion: 1,
              quoteReference: refs.quote,
              guestSessionReference: refs.guest,
              paymentOperationReference: refs.operation,
              preparedAt,
              validUntil,
            },
          ],
        );
        // Dining's commitment: prepared, then sealed when payment was requested (window: 30 min).
        const commitment = {
          commitmentReference: refs.commitment,
          brandReference: brand,
          storeReference: store,
          diningSessionReference: session,
          tableReference: table,
          participantReference: id(k + 22),
          guestSessionReference: refs.guest,
          cartReference: refs.cart,
          quoteReference: refs.quote,
          submissionReference: refs.submission,
          orderReference: refs.order,
          orderBatchReference: refs.batch,
          paymentOperationReference: refs.operation,
          sessionVersion: 1,
          tableAssignmentVersion: 1,
          participantVersion: 1,
          cartVersion: 1,
          intentHash: "c".repeat(64),
          preparedAt,
          preparationValidUntil: validUntil,
        };
        for (const [version, state, at, sealed] of [
          [1, "Prepared", preparedAt, false],
          [2, "PaymentPending", requestedAt, true],
        ])
          await q(
            "INSERT INTO rms_dining.dining_checkout_commitment (tenant_id,brand_id,store_id,commitment_id,session_id,submission_id,payment_operation_id,version,previous_version,state,recorded_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
            [
              tenant,
              brand,
              store,
              refs.commitment,
              session,
              refs.submission,
              refs.operation,
              version,
              version === 1 ? null : 1,
              state,
              at,
              {
                ...commitment,
                state,
                orderingLinkedAt: sealed ? preparedAt : null,
                paymentRequestedAt: sealed ? requestedAt : null,
                capacityExpiresAt: sealed ? expiresAt : null,
              },
            ],
          );
        return { refs, requestedAt, expiresAt };
      }
      /** The round's online payment: "Open" (started, never confirmed), "Succeeded", or
       * "CreateUnknown" (the Provider create's answer was lost). */
      const attemptOf = (n) => id(0x7000 + n * 0x10 + 2);
      const payment = async (round, outcome, n, idempotencyDigest) => {
        const k = 0x7000 + n * 0x10;
        const refs = {
          paymentIntent: id(k + 1),
          attempt: id(k + 2),
          observation: id(k + 3),
          webhook: id(k + 4),
          transaction: id(k + 5),
          paymentEvent: id(k + 6),
          projection: id(k + 7),
          preparation: id(k + 8),
          commitment: round.refs.commitment,
          paymentOperation: round.refs.operation,
          providerIntent: "pi_SYNTHETICABANDONED" + n.toString(16),
          providerEvent: "evt_SYNTHETICABANDONED" + n.toString(16),
        };
        await seedJourneyPayment(admin, {
          scope: { brandReference: brand, storeReference: store },
          providerAccountReference: provider,
          round: {
            f: {
              request: {
                record: {
                  order: { orderReference: round.refs.order },
                  guestSessionReference: round.refs.guest,
                },
              },
            },
            batch: {
              orderBatchReference: round.refs.batch,
              submissionReference: round.refs.submission,
              sourceCartReference: round.refs.cart,
              sourceCartVersion: 1,
              quoteReference: round.refs.quote,
            },
          },
          refs,
          outcome,
          requestedAt: round.requestedAt,
          occurredAt: new Date(Date.parse(round.requestedAt) + 1000).toISOString(),
          totalMinor: 1689,
          idempotencyDigest,
        });
        return refs;
      };

      await admin.query("SET session_replication_role = replica");
      let resumed, staffRound, paidRound, lateRound, unknownRound, legacyRound, recentRound, pay;
      // WP-2423 item 8 ⑤: a guest round with no payment that waits for staff (as a pay-later
      // round held before the kitchen); its payment window ended long ago.
      let heldRound;
      try {
        resumed = await guestRound(1, time(-minutes(5)));
        staffRound = await guestRound(2, time(-minutes(6)));
        paidRound = await guestRound(3, time(-minutes(7)));
        lateRound = await guestRound(4, time(-minutes(40)));
        // Rounds whose Provider create answer was lost: one with the attempt-derived key (Payment
        // can ask again), one older without it, one whose window only just ended.
        unknownRound = await guestRound(5, time(-minutes(41)));
        legacyRound = await guestRound(6, time(-minutes(42)));
        recentRound = await guestRound(7, time(-minutes(31)));
        heldRound = await guestRound(8, time(-minutes(45)));
        pay = {
          resumed: await payment(resumed, "Open", 1),
          staff: await payment(staffRound, "Open", 2),
          paid: await payment(paidRound, "Succeeded", 3),
          late: await payment(lateRound, "Open", 4),
          unknown: await payment(
            unknownRound,
            "CreateUnknown",
            5,
            digest("create-intent:" + attemptOf(5)),
          ),
          legacy: await payment(legacyRound, "CreateUnknown", 6),
          recent: await payment(recentRound, "CreateUnknown", 7),
        };
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      /** One restricted-role transaction, one query at a time (application rule). */
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            await client.query("SET LOCAL lock_timeout='10s'");
            await client.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [tenant, brand, store],
            );
            let inFlight = 0;
            const result = await work({
              query: async (sql, values) => {
                assert.equal(inFlight, 0, "one query at a time");
                inFlight += 1;
                try {
                  return await client.query(sql, values === undefined ? [] : [...values]);
                } finally {
                  inFlight -= 1;
                }
              },
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const holds = createPostgresOrderRoundStaffHoldStore({
        brandReference: brand,
        storeReference: store,
        authorize: async () => true,
      });
      await transactions.run((tx) =>
        holds.hold({
          transaction: tx,
          holdReference: id(0x8f1),
          orderReference: heldRound.refs.order,
          orderBatchReference: heldRound.refs.batch,
          submissionReference: heldRound.refs.submission,
          guestSessionReference: heldRound.refs.guest,
          reason: "PhoneRapid",
          observedAt: time(-minutes(44)),
        }),
      );
      const one = async (sql, values = []) => (await admin.query(sql, values)).rows;

      // ── Stock: one tracked item with 10 KG on hand; the staff round reserved 1 KG at submission
      // (Inventory owner store under the restricted role) and Inventory recorded its final
      // validation, as every submitted round has.
      const stockHash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
      const [site, location, item, account, actor] = [0x40, 0x41, 0x42, 0x43, 0x44].map(id);
      const unit = {
        unitCode: "KG",
        dimension: "Mass",
        displayPrecision: 2,
        ledgerPrecision: 6,
        roundingMode: "HalfEven",
      };
      const stockAt = new Date(Date.parse(staffRound.requestedAt) - 4000).toISOString();
      await admin.query(
        "INSERT INTO rms_inventory.inventory_item VALUES ($1,$2,$3,'SYNTHETIC','RawMaterial',$4,$5)",
        [tenant, brand, item, stockAt, actor],
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
        occurredAt: stockAt,
        actorReference: actor,
      });
      const activeItem = transitionInventoryItem(draft, "Active", {
        expectedVersion: 1,
        hasOpenWork: false,
        hasNonZeroStock: false,
        occurredAt: stockAt,
        actorReference: actor,
      });
      for (const snapshot of [draft, activeItem])
        await admin.query(
          "INSERT INTO rms_inventory.inventory_item_version VALUES ($1,$2,$3,$4,$5,$6)",
          [tenant, brand, item, snapshot.aggregateVersion, snapshot, stockAt],
        );
      await ensureSyntheticStockPlace(admin, {
        tenantId: tenant,
        brandId: brand,
        storeId: store,
        stockSiteId: site,
        locationId: location,
        at: stockAt,
      });
      await admin.query(
        "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,2,'KG',6,$8)",
        [tenant, brand, store, site, location, account, item, stockAt],
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
      await transactions.run((tx) =>
        tx.query(
          "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,2,'Receive','10',$6,$7,$8)",
          [
            tenant,
            brand,
            store,
            account,
            id(0x45),
            {
              movementReference: id(0x45),
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
              businessSourceReference: id(0x46),
              reasonCode: "SYNTHETIC_TEST",
              performedBy: actor,
              occurredAt: stockAt,
              before: balance(1, "0", "0", "0"),
              after: balance(2, "10", "0", "10"),
              auditReference: id(0x47),
              correctsMovementReference: null,
            },
            id(0x47),
            stockAt,
          ],
        ),
      );
      const reservedStock = async () =>
        (
          await one(
            'SELECT on_hand::text AS "onHand",reserved::text AS reserved FROM rms_inventory.stock_balance WHERE account_id=$1',
            [account],
          )
        )[0];
      {
        const quantity = "1";
        const stockAudit = (n, targetType, targetId, actionCode) => ({
          auditId: id(0x4800 + n),
          brandId: brand,
          storeId: store,
          actor: { type: "User", reference: actor },
          actionCode,
          targetType,
          targetId,
          reasonCode: "AUTHORIZED_CHANGE",
          correlationId: id(0x4900 + n),
          occurredAt: stockAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Internal",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        });
        const demand = id(0x4a),
          workflow = id(0x4b),
          reservationReference = id(0x4c);
        const reservation = createInventoryReservation({
          reservationReference,
          binding: {
            tenantReference: tenant,
            brandReference: brand,
            storeReference: store,
            stockSiteReference: site,
            locationReference: location,
            itemReference: item,
            lotReference: null,
            submissionReference: staffRound.refs.submission,
            cartReference: staffRound.refs.cart,
            cartVersion: 1,
            quoteReference: staffRound.refs.quote,
            demandReference: demand,
            demandDigest: stockHash(["demand", 2]),
          },
          unit,
          quantity,
          occurredAt: stockAt,
        });
        const owner = (tx) =>
          createPostgresStockReservationStore({ run: (work) => work(tx) }, scope);
        const reserved = await transactions.run(async (tx) =>
          owner(tx).commitSet({
            setReference: id(0x4d),
            operationReference: id(0x4e),
            workflowReference: workflow,
            workflowVersion: 1,
            writes: [
              {
                operationReference: id(0x4f),
                accountReference: account,
                action: "Reserve",
                expectedLedgerVersion: await owner(tx).loadAccountLedgerVersion(account),
                quantity,
                reservation,
                movementReference: id(0x50),
                audit: {
                  ...stockAudit(
                    1,
                    "InventoryReservation",
                    reservationReference,
                    "INVENTORY_RESERVATION_RESERVE",
                  ),
                  correlationId: id(0x4f),
                },
              },
            ],
            audit: {
              ...stockAudit(2, "InventoryReservationSet", id(0x4d), "INVENTORY_RESERVATION_SET"),
              correlationId: id(0x4e),
            },
          }),
        );
        assert.equal(reserved.status, "Applied");
        const record = parseSubmissionInventoryFinalValidation({
          schemaVersion: 1,
          validationReference: id(0x51),
          operationReference: id(0x52),
          actorReference: reserved.set.actorReference,
          auditReference: id(0x53),
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          orderReference: staffRound.refs.order,
          submissionReference: staffRound.refs.submission,
          cartReference: staffRound.refs.cart,
          cartVersion: 1,
          quoteReference: staffRound.refs.quote,
          demandReference: demand,
          demandDigest: stockHash(["demand", 2]),
          workflowReference: workflow,
          workflowVersionReference: id(0x54),
          workflowVersion: 1,
          transitionReference: id(0x55),
          observedAt: stockAt,
          items: [
            {
              itemReference: item,
              currentItemVersion: 2,
              configurationOperationReferences: [id(0x56)],
              unit,
              quantity,
              stockTrackingEnabled: true,
              disposition: "Reserved",
              deferredActionCode: null,
            },
          ],
          reservationSet: reserved.set,
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
            reserved.set.setReference,
            stockAt,
            stockHash(record),
            record,
          ],
        );
      }
      assert.deepEqual(await reservedStock(), { onHand: "10", reserved: "1" });

      // ── Test-only Provider with the simulator's semantics: an intent answers RequiresCustomerAction
      // until the guest confirms it (Captured) or Payment cancels it (Cancelled, idempotent).
      const lostCreates = [pay.unknown, pay.legacy, pay.recent];
      const intents = new Map(
        Object.values(pay)
          .filter((refs) => !lostCreates.includes(refs))
          .map((refs) => [
            refs.providerIntent,
            { status: refs === pay.paid ? "Captured" : "RequiresCustomerAction", at: null },
          ]),
      );
      const providerCalls = [];
      const snapshot = (request, reference) => {
        const entry = intents.get(reference);
        const captured = entry.status === "Captured";
        return createPaymentProviderSnapshot({
          kind: "Snapshot",
          context: request.context,
          providerIntentReference: reference,
          providerTransactionReference: captured ? "ch_" + reference.slice(3) : null,
          paymentMethod: "OnlineCard",
          captureMode: "Automatic",
          status: entry.status,
          requestedAmount: { amountMinor: 1689n, currencyCode: "CAD" },
          authorizedAmount: { amountMinor: captured ? 1689n : 0n, currencyCode: "CAD" },
          capturedAmount: { amountMinor: captured ? 1689n : 0n, currencyCode: "CAD" },
          refundedAmount: { amountMinor: 0n, currencyCode: "CAD" },
          observedAt: entry.status === "Cancelled" ? entry.at : now(),
          evidenceDigest: digest(reference + ":" + entry.status + ":" + String(entry.at)),
        });
      };
      const simulatedProvider = async () => ({
        adapter: {
          // The same create again (same idempotency key) answers the intent it made, or makes it
          // now, unconfirmed (the simulator's and Stripe's idempotent create).
          createIntent: async (request) => {
            providerCalls.push(["create", request.idempotencyKey]);
            const refs = lostCreates.find(
              (entry) => request.idempotencyKey === "create-intent:" + entry.attempt,
            );
            assert.ok(refs, "only a lost create is repeated");
            assert.equal(request.context.paymentAttemptReference, refs.attempt);
            assert.equal(request.context.operationReference, refs.paymentOperation);
            assert.equal(request.amount.amountMinor, 1689n);
            if (!intents.has(refs.providerIntent))
              intents.set(refs.providerIntent, { status: "RequiresCustomerAction", at: null });
            return snapshot(request, refs.providerIntent);
          },
          retrieveIntent: async (request) => {
            providerCalls.push(["retrieve", request.providerIntentReference]);
            return snapshot(request, request.providerIntentReference);
          },
          cancelIntent: async (request) => {
            providerCalls.push(["cancel", request.idempotencyKey]);
            const entry = intents.get(request.providerIntentReference);
            if (entry.status === "RequiresCustomerAction")
              intents.set(request.providerIntentReference, { status: "Cancelled", at: now() });
            return snapshot(request, request.providerIntentReference);
          },
        },
        readTerminalOccurrence: async (request) => {
          const entry = intents.get(request.providerIntentReference);
          return { status: entry.status, occurredAt: entry.at };
        },
        close: () => undefined,
      });
      const confirmAtProvider = (refs, at) =>
        intents.set(refs.providerIntent, { status: "Captured", at });
      const resources = {
        scope: { brandReference: brand, storeReference: store },
        now,
        transactions,
        publicProfile: { binding: { tenantReference: tenant, validUntil: time(minutes(600)) } },
        credentials: { reference: fresh },
      };
      const resolution = createInternalOpenPaymentResolution(resources, {
        createSimulatedProvider: simulatedProvider,
        providerAccountReference: provider,
      });
      const terminal = (refs) =>
        one(
          "SELECT terminal_outcome AS outcome,failure_reason AS reason FROM rms_payment.payment_terminal_fact WHERE payment_intent_id=$1",
          [refs.paymentIntent],
        );
      const attempts = (refs) =>
        one(
          "SELECT count(*)::int AS n FROM rms_payment.payment_attempt WHERE payment_intent_id=$1",
          [refs.paymentIntent],
        );

      // ── 1. The guest who started paying comes back (reload / another tab): the same payment.
      const resumeService = (guestSessionReference) =>
        createPaymentIntentCreationService({
          providerEnvironment: "Test",
          clock: { now },
          killSwitch: { evaluate: async () => assert.fail("resume never re-admits the Provider") },
          authorization: {
            authorize: async () => ({
              action: "CreatePaymentIntent",
              guestSessionReference,
              brandReference: brand,
              storeReference: store,
            }),
          },
          ordering: { preparePayment: async () => assert.fail("resume never prepares an order") },
          audit: { create: async () => assert.fail("resume writes no audit") },
          references: {
            generate: fresh,
            hash: digest,
            equals: (a, b) => a === b,
            providerIdempotencyKey: () => assert.fail("resume opens no attempt"),
          },
          repository: createPostgresPaymentIntentCreationStore(
            transactions,
            { brandReference: brand, storeReference: store },
            { now, generateObservationReference: fresh },
          ),
          provider: { createIntent: async () => assert.fail("resume calls no Provider") },
        });
      const resumeCommand = {
        paymentOperationReference: resumed.refs.operation,
        submissionReference: resumed.refs.submission,
        requestedAt: now(),
      };
      const back = await resumeService(resumed.refs.guest).resume(resumeCommand);
      assert.equal(back.status, "AlreadyCreated");
      assert.equal(back.record.intent.paymentIntentReference, pay.resumed.paymentIntent);
      assert.equal(back.record.attempt.paymentAttemptReference, pay.resumed.attempt);
      assert.equal(back.record.providerOutcome.providerIntentReference, pay.resumed.providerIntent);
      assert.deepEqual(await attempts(pay.resumed), [{ n: 1 }]);
      // Another guest's session cannot pick up this payment.
      await assert.rejects(
        resumeService(id(0x999)).resume(resumeCommand),
        (error) =>
          error instanceof PaymentIntentCreationError &&
          error.code === "PAYMENT_INTENT_IDEMPOTENCY_CONFLICT",
      );
      // The guest confirms the same Provider intent; Payment records it as paid.
      confirmAtProvider(pay.resumed, now());
      assert.deepEqual(await resolution.resolve(resumed.refs.operation), { status: "Paid" });
      assert.deepEqual(await terminal(pay.resumed), [{ outcome: "Succeeded", reason: null }]);
      assert.deepEqual(await attempts(pay.resumed), [{ n: 1 }]);

      // ── Tables page: the party's unpaid guest rounds (one read for every open session).
      const unpaid = () =>
        transactions.run((tx) =>
          listStoreUnpaidGuestDiningRounds(tx, { brandReference: brand, storeReference: store }, [
            session,
          ]),
        );
      const listed = await unpaid();
      assert.deepEqual(
        listed.map((round) => [round.orderBatchReference, round.roundNumber, round.payBy]),
        [
          resumed,
          staffRound,
          paidRound,
          lateRound,
          unknownRound,
          legacyRound,
          recentRound,
          heldRound,
        ].map((round) => [round.refs.batch, 1, round.expiresAt]),
      );

      // ── 2. A manager cancels an unpaid round before its deadline.
      const cancellation = await createInternalBatchCancellation(resources, {
        loadWorkflow: async () => ({
          environment: "InternalTest",
          database: context.clientConfig.database,
          scope,
          definition: release.plan.published,
        }),
        expectedDatabaseName: context.clientConfig.database,
        systemActorReference: systemActor,
        providerAccountReference: provider,
      });
      const manager = id(0x500);
      const staffCancel = (round, operationReference, extra = {}) =>
        transactions.run((tx) =>
          cancellation.cancelUnpaidForStaff(tx, {
            operationReference,
            orderReference: round.refs.order,
            orderBatchReference: round.refs.batch,
            actorReference: manager,
            authorize: async () => true,
            ...extra,
          }),
        );
      const counts = async () =>
        (
          await one(
            "SELECT (SELECT count(*)::int FROM rms_ordering.order_batch_checkout_cancellation) AS cancellations,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='OrderCancelled') AS events",
          )
        )[0];
      const before = await counts();
      // While the guest's online attempt is open the round is not cancelled (money may move).
      assert.deepEqual(await staffCancel(staffRound, id(0x601)), {
        status: "NotEligible",
        reason: "PaymentInProgress",
      });
      // The command first ends the guest's unfinished payment with the Provider.
      assert.deepEqual(await resolution.resolve(staffRound.refs.operation), {
        status: "Failed",
        notCompleted: true,
      });
      assert.deepEqual(
        providerCalls.filter(
          ([, ref]) => ref.includes(pay.staff.attempt) || ref === pay.staff.providerIntent,
        ),
        [
          ["retrieve", pay.staff.providerIntent],
          ["cancel", "cancel-abandoned:" + pay.staff.attempt],
        ],
      );
      assert.deepEqual(await terminal(pay.staff), [{ outcome: "Failed", reason: "Cancelled" }]);
      const created = await staffCancel(staffRound, id(0x602));
      assert.equal(created.status, "Created");
      assert.equal(created.record.reasonCode, "STAFF_CANCELLED_UNPAID");
      assert.equal(created.record.expiryRecordReference, null);
      // Its reserved stock returned in the same transaction.
      assert.deepEqual(await reservedStock(), { onHand: "10", reserved: "0" });
      assert.deepEqual(await counts(), {
        cancellations: before.cancellations + 1,
        events: before.events + 1,
      });
      const audit = await one(
        "SELECT actor_type,actor_reference::text AS actor,reason_code,source_channel FROM platform_audit.audit_record WHERE action_code='ORDERING_BATCH_CHECKOUT_CANCELLED' AND target_id=$1",
        [staffRound.refs.batch],
      );
      assert.deepEqual(audit, [
        {
          actor_type: "User",
          actor: manager,
          reason_code: "STAFF_CANCELLED_UNPAID",
          source_channel: "MERCHANT_WEB",
        },
      ]);
      const event = await one(
        "SELECT actor_type,payload_json AS payload FROM platform_eventing.outbox_event WHERE event_type='OrderCancelled' AND aggregate_id=$1",
        [staffRound.refs.order],
      );
      assert.equal(event.length, 1);
      assert.equal(event[0].payload.reasonCode, "STAFF_CANCELLED_UNPAID");
      assert.equal(
        await transactions.run((tx) =>
          orderCancelledEventMatchesRecord(tx, scope, {
            aggregateId: staffRound.refs.order,
            aggregateVersion: 2n,
            payload: event[0].payload,
          }),
        ),
        true,
      );
      // The same command again: the original outcome, nothing written.
      assert.equal((await staffCancel(staffRound, id(0x602))).status, "Existing");
      assert.deepEqual(await counts(), {
        cancellations: before.cancellations + 1,
        events: before.events + 1,
      });
      // A different command for the cancelled round finds nothing left to cancel.
      await assert.rejects(staffCancel(staffRound, id(0x603)));
      // The guest's payment page now reads it as not completed (no "Finish paying"), from
      // Payment's own facts, without asking the Provider again.
      const callsBefore = providerCalls.length;
      assert.deepEqual(await resolution.resolve(staffRound.refs.operation), {
        status: "Failed",
        notCompleted: true,
      });
      assert.equal(providerCalls.length, callsBefore);

      // ── 3. A round the guest paid is never cancelled by staff.
      assert.deepEqual(await resolution.resolve(paidRound.refs.operation), { status: "Paid" });
      assert.deepEqual(await staffCancel(paidRound, id(0x604)), {
        status: "NotEligible",
        reason: "Paid",
      });
      // The database refuses a staff cancellation of a round Ordering recorded as paid.
      await admin.query("SET session_replication_role = replica");
      await admin.query(
        "INSERT INTO rms_ordering.order_payment_acceptance_wait (wait_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_event_id,source_digest,evaluated_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id(0x605),
          brand,
          store,
          paidRound.refs.order,
          paidRound.refs.batch,
          paidRound.refs.submission,
          pay.paid.paymentEvent,
          sha("4"),
          time(-minutes(6)),
          { synthetic: true },
        ],
      );
      await admin.query("SET session_replication_role = origin");
      await assert.rejects(
        transactions.run((tx) =>
          tx.query(
            "INSERT INTO rms_ordering.order_batch_checkout_cancellation (cancellation_id,operation_id,tenant_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_operation_id,expiry_record_id,expiry_evidence_digest,expected_order_version,cancelled_order_version,expected_source_checkpoint,workflow_version_id,transition_id,order_item_ids,cancelled_at,phase,reason_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,1,2,$8,$10,$11,$12,$13,'Cancelled','STAFF_CANCELLED_UNPAID')",
            [
              id(0x606),
              id(0x607),
              tenant,
              brand,
              store,
              paidRound.refs.order,
              paidRound.refs.batch,
              paidRound.refs.submission,
              paidRound.refs.operation,
              id(900),
              id(901),
              [paidRound.refs.item],
              now(),
            ],
          ),
        ),
        /cancellation payment conflict/u,
      );
      // A staff cancellation never carries expiry evidence (and the System's always does).
      await assert.rejects(
        transactions.run((tx) =>
          tx.query(
            "INSERT INTO rms_ordering.order_batch_checkout_cancellation (cancellation_id,operation_id,tenant_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_operation_id,expiry_record_id,expiry_evidence_digest,expected_order_version,cancelled_order_version,expected_source_checkpoint,workflow_version_id,transition_id,order_item_ids,cancelled_at,phase,reason_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,1,2,$8,$10,$11,$12,$13,'Cancelled','PAYMENT_NOT_STARTED')",
            [
              id(0x608),
              id(0x609),
              tenant,
              brand,
              store,
              lateRound.refs.order,
              lateRound.refs.batch,
              lateRound.refs.submission,
              lateRound.refs.operation,
              id(900),
              id(901),
              [lateRound.refs.item],
              now(),
            ],
          ),
        ),
        /invalid cancellation expiry evidence|order_batch_checkout_cancellation_expiry_evidence/u,
      );

      // ── 4. Deadline: the guest's payment succeeded at the Provider just before it, but no answer
      // arrived. The System asks the Provider, records it as paid and does not cancel the round.
      const paidAt = new Date(Date.parse(lateRound.expiresAt) - minutes(1)).toISOString();
      confirmAtProvider(pay.late, paidAt);
      const recorder = createDiningCheckoutExpiryRecorder({
        scope: { ...scope, providerAccountReference: provider, environment: "Test" },
        transactions,
        authorize: async () => true,
        now,
        newReference: fresh,
      });
      const lateCandidate = async () =>
        (
          await transactions.run((tx) =>
            createPostgresDiningCheckoutExpiryCandidates({
              brandReference: brand,
              storeReference: store,
              authorize: async () => true,
            }).discover(tx, { observedAt: now(), after: null, limit: 10 }),
          )
        ).find((candidate) => candidate.orderBatchReference === lateRound.refs.batch);
      const recorded = await recorder.record(await lateCandidate());
      assert.equal(recorded.record.status, "AwaitingPaymentResolution");
      const dispatcher = await createInternalBatchCancellationDispatcher(resources, {
        loadWorkflow: async () => ({
          environment: "InternalTest",
          database: context.clientConfig.database,
          scope,
          definition: release.plan.published,
        }),
        expectedDatabaseName: context.clientConfig.database,
        systemActorReference: systemActor,
        providerAccountReference: provider,
        createSimulatedProvider: simulatedProvider,
      });
      const beforeLate = await counts();
      assert.equal(await dispatcher.runOnce(), 0);
      assert.deepEqual(await terminal(pay.late), [{ outcome: "Succeeded", reason: null }]);
      assert.equal(
        providerCalls.some(([kind, ref]) => kind === "cancel" && ref.includes(pay.late.attempt)),
        false,
      );
      // The next sweep records the payment as made before the deadline; nothing is cancelled.
      const paid = await recorder.record(await lateCandidate());
      assert.equal(paid.record.status, "PaidBeforeDeadline");
      assert.equal(await dispatcher.runOnce(), 0);
      assert.deepEqual(await counts(), beforeLate);
      const discovered = await transactions.run((tx) =>
        createPostgresDiningBatchCancellationCandidates({
          ...scope,
          authorize: async () => true,
        }).discover(tx, { observedAt: now(), after: null, limit: 10 }),
      );
      assert.equal(
        discovered.some((entry) => entry.orderBatchReference === lateRound.refs.batch),
        false,
      );

      // ── 5. The Provider create's answer was lost (timeout): no card form was ever shown, but the
      // Provider may hold an intent. Inventory recorded these rounds as untracked (nothing set aside).
      await admin.query("SET session_replication_role = replica");
      try {
        for (const [n, round] of [
          [5, unknownRound],
          [6, legacyRound],
          // WP-2423 item 8 ⑤: the held round's items are untracked too.
          [8, heldRound],
        ]) {
          const k = 0x5000 + n * 0x10;
          const v = parseSubmissionInventoryFinalValidation({
            schemaVersion: 1,
            validationReference: id(k + 1),
            operationReference: id(k + 2),
            actorReference: round.refs.guest,
            auditReference: id(k + 3),
            tenantReference: tenant,
            brandReference: brand,
            storeReference: store,
            orderReference: round.refs.order,
            submissionReference: round.refs.submission,
            cartReference: round.refs.cart,
            cartVersion: 1,
            quoteReference: round.refs.quote,
            demandReference: id(k + 4),
            demandDigest: stockHash(["demand", n]),
            workflowReference: id(k + 5),
            workflowVersionReference: id(k + 6),
            workflowVersion: 1,
            transitionReference: id(k + 7),
            observedAt: new Date(Date.parse(round.requestedAt) - 2000).toISOString(),
            items: [
              {
                itemReference: id(k + 8),
                currentItemVersion: 1,
                configurationOperationReferences: [id(k + 9)],
                unit: {
                  ...unit,
                  unitCode: "EA",
                  dimension: "Count",
                  displayPrecision: 0,
                  ledgerPrecision: 0,
                },
                quantity: "1",
                stockTrackingEnabled: false,
                disposition: "NotTracked",
                deferredActionCode: null,
              },
            ],
            reservationSet: null,
          });
          await admin.query(
            "INSERT INTO rms_inventory.submission_final_validation (tenant_id,brand_id,store_id,validation_id,operation_id,actor_id,audit_id,order_id,submission_id,cart_id,cart_version,quote_id,demand_id,demand_digest,workflow_id,workflow_version_id,workflow_version,transition_id,reservation_set_id,observed_at,record_digest,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NULL,$19,$20,$21)",
            [
              tenant,
              brand,
              store,
              v.validationReference,
              v.operationReference,
              v.actorReference,
              v.auditReference,
              v.orderReference,
              v.submissionReference,
              v.cartReference,
              v.cartVersion,
              v.quoteReference,
              v.demandReference,
              v.demandDigest,
              v.workflowReference,
              v.workflowVersionReference,
              v.workflowVersion,
              v.transitionReference,
              v.observedAt,
              stockHash(v),
              v,
            ],
          );
        }
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const candidateOf = async (round) =>
        (
          await transactions.run((tx) =>
            createPostgresDiningCheckoutExpiryCandidates({
              brandReference: brand,
              storeReference: store,
              authorize: async () => true,
            }).discover(tx, { observedAt: now(), after: null, limit: 20 }),
          )
        ).find((candidate) => candidate.orderBatchReference === round.refs.batch);
      for (const round of [unknownRound, legacyRound])
        assert.equal(
          (await recorder.record(await candidateOf(round))).record.status,
          "AwaitingPaymentResolution",
        );
      const createCalls = (refs) =>
        providerCalls.filter(([kind, key]) => kind === "create" && key.includes(refs.attempt));
      // The cancellation sweep asks the Provider again with the same create (attempt-derived key):
      // the intent it holds is cancelled as never confirmed and recorded as not completed.
      const beforeUnknown = await counts();
      assert.equal(await dispatcher.runOnce(), 0);
      assert.deepEqual(createCalls(pay.unknown), [
        ["create", "create-intent:" + pay.unknown.attempt],
      ]);
      assert.ok(
        providerCalls.some(
          ([kind, key]) => kind === "cancel" && key === "cancel-abandoned:" + pay.unknown.attempt,
        ),
      );
      assert.deepEqual(await terminal(pay.unknown), [{ outcome: "Failed", reason: "Cancelled" }]);
      // An older attempt whose key can't be re-derived (digest differs) is never asked about with a
      // guessed key: it keeps waiting, nothing recorded, nothing cancelled.
      assert.deepEqual(createCalls(pay.legacy), []);
      assert.deepEqual(await terminal(pay.legacy), []);
      assert.deepEqual(await counts(), beforeUnknown);
      // Next sweep: PaymentFailed evidence, the round is cancelled as not completed (nobody paid).
      assert.equal(
        (await recorder.record(await candidateOf(unknownRound))).record.status,
        "PaymentFailed",
      );
      assert.equal(await dispatcher.runOnce(), 1);
      assert.deepEqual(
        await one(
          "SELECT reason_code FROM rms_ordering.order_batch_checkout_cancellation WHERE order_batch_id=$1",
          [unknownRound.refs.batch],
        ),
        [{ reason_code: "PAYMENT_NOT_COMPLETED" }],
      );
      // Still unresolved: the round goes to staff. Without the manager's confirmation, or before
      // the grace after the deadline has passed, it is refused as before; a paid round never.
      assert.deepEqual(await staffCancel(legacyRound, id(0x701)), {
        status: "NotEligible",
        reason: "PaymentInProgress",
      });
      assert.deepEqual(await staffCancel(recentRound, id(0x702), { paymentUnconfirmed: true }), {
        status: "NotEligible",
        reason: "PaymentInProgress",
      });
      assert.deepEqual(await staffCancel(paidRound, id(0x703), { paymentUnconfirmed: true }), {
        status: "NotEligible",
        reason: "Paid",
      });
      const beforeLegacy = await counts();
      const unconfirmed = await staffCancel(legacyRound, id(0x704), { paymentUnconfirmed: true });
      assert.equal(unconfirmed.status, "Created");
      assert.equal(unconfirmed.record.reasonCode, "STAFF_CANCELLED_UNPAID");
      assert.deepEqual(await counts(), {
        cancellations: beforeLegacy.cancellations + 1,
        events: beforeLegacy.events + 1,
      });
      assert.deepEqual(
        await one(
          "SELECT actor_reference::text AS actor,reason_code,after_summary_json AS after FROM platform_audit.audit_record WHERE action_code='ORDERING_BATCH_CHECKOUT_CANCELLED' AND target_id=$1",
          [legacyRound.refs.batch],
        ),
        [
          {
            actor: manager,
            reason_code: "STAFF_CANCELLED_UNPAID",
            after: { providerPaymentUnconfirmed: true },
          },
        ],
      );
      assert.equal(
        (await staffCancel(legacyRound, id(0x704), { paymentUnconfirmed: true })).status,
        "Existing",
      );
      // Tables reads Payment's own terminal facts: a payment that just arrived (Ordering has not
      // recorded it yet) is not offered for cancellation as unpaid.
      assert.deepEqual(
        [
          ...(await transactions.run((tx) =>
            listStoreOrderBatchesPaidOnline(tx, { brandReference: brand, storeReference: store }, [
              paidRound.refs.batch,
              recentRound.refs.batch,
              unknownRound.refs.batch,
            ]),
          )),
        ],
        [paidRound.refs.batch],
      );

      // Tables: the staff-cancelled round no longer waits (the paid ones leave once Ordering
      // records their payment through the worker's consumer).
      assert.equal(
        (await unpaid()).some((round) => round.orderBatchReference === staffRound.refs.batch),
        false,
      );
      assert.equal(
        (await unpaid()).some((round) => round.orderBatchReference === paidRound.refs.batch),
        false,
      );

      // ── WP-2423 item 8 ⑤ decision 7: the round waiting for staff was never cancelled by time
      // (the dispatcher ran past its deadline above), and staff cancel it only with its release.
      const heldCancellations = async () =>
        (
          await one(
            "SELECT count(*)::int AS n FROM rms_ordering.order_batch_checkout_cancellation WHERE order_batch_id=$1",
            [heldRound.refs.batch],
          )
        )[0].n;
      assert.equal(await heldCancellations(), 0);
      // Its payment window ended 15 minutes ago, yet the expiry scan never offers it.
      assert.equal(await candidateOf(heldRound), undefined);
      await assert.rejects(staffCancel(heldRound, id(0x8f2)));
      assert.equal(await heldCancellations(), 0);
      const cancelledHeld = await transactions.run(async (tx) => {
        await holds.release({
          transaction: tx,
          operationReference: id(0x8f3),
          orderReference: heldRound.refs.order,
          orderBatchReference: heldRound.refs.batch,
          outcome: "Cancelled",
          actorReference: manager,
          observedAt: now(),
        });
        return cancellation.cancelUnpaidForStaff(tx, {
          operationReference: id(0x8f3),
          orderReference: heldRound.refs.order,
          orderBatchReference: heldRound.refs.batch,
          actorReference: manager,
          authorize: async () => true,
        });
      });
      assert.equal(cancelledHeld.status, "Created");
      assert.equal(cancelledHeld.record.reasonCode, "STAFF_CANCELLED_UNPAID");
      assert.deepEqual(
        await one(
          "SELECT outcome,actor_id FROM rms_ordering.order_round_staff_hold_release WHERE order_batch_id=$1",
          [heldRound.refs.batch],
        ),
        [{ outcome: "Cancelled", actor_id: manager }],
      );
    } finally {
      vi.unstubAllEnvs();
      for (const name of [role, worker]) {
        await admin.query("DROP OWNED BY " + name);
        await admin.query("DROP ROLE " + name);
      }
      await admin.end();
    }
  });
});
