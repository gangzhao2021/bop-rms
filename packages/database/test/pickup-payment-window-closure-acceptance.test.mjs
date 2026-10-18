import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createInventoryItem,
  transitionInventoryItem,
  createInventoryReservation,
  createPostgresStockReservationStore,
  parseSubmissionInventoryFinalValidation,
} from "../../rms/inventory/src/index.ts";
import {
  createOrderTerminatedPaymentDisposition,
  createPostgresOrderExecutionReader,
  createPostgresOrderInitialExecutionReader,
  createPostgresPaidAcceptanceLapseClosure,
  loadPickupPaymentWindowClosure,
} from "../../rms/ordering/src/index.ts";
import { createPickupPaymentWindowClosure } from "../../../apps/api/src/pickup-payment-window-closure.ts";
import { createPaidWithoutFulfillableInventoryRelease } from "../../../apps/api/src/paid-without-fulfillable-inventory-release.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";
const { Client } = pg;
const id = (n) => "0190a7c2-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const [tenant, brand, store, site, location, item, account, actor, system, provider, slot] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
].map(id);
const unit = {
  unitCode: "KG",
  dimension: "Mass",
  displayPrecision: 2,
  ledgerPrecision: 6,
  roundingMode: "HalfEven",
};
const scope = { tenantReference: tenant, brandReference: brand, storeReference: store };
const minutes = (n) => n * 60_000;
/**
 * WP-2423 Q12: an unpaid pickup Order whose payment window ended is cancelled by the System and its
 * reserved stock returned, in one transaction. The closure runs as a restricted NOBYPASSRLS role
 * holding exactly the rendered pilot API grants (matrix plus approved additions); owner facts are
 * seeded by the isolated database owner.
 */
it("closes unpaid pickup orders after the payment window, returns their stock once, and leaves paid, open and dine-in orders", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_pickup_window" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_ppw_" + context.runId,
      other = "wp2423_ppw_w_" + context.runId;
    assert.match(role, /^wp2423_ppw_[a-f0-9]+$/u);
    try {
      for (const name of [role, other])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker: other }));
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
      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (offset) => new Date(base + offset).toISOString();
      const createdAt = time(-minutes(38)),
        businessDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(
          new Date(createdAt),
        );
      const owner = (tx) => createPostgresStockReservationStore({ run: (work) => work(tx) }, scope);

      // Item, stock place, one account holding 10 KG on hand.
      await admin.query(
        "INSERT INTO rms_inventory.inventory_item VALUES ($1,$2,$3,'SYNTHETIC','RawMaterial',$4,$5)",
        [tenant, brand, item, time(-minutes(60)), actor],
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
        occurredAt: time(-minutes(60)),
        actorReference: actor,
      });
      const active = transitionInventoryItem(draft, "Active", {
        expectedVersion: 1,
        hasOpenWork: false,
        hasNonZeroStock: false,
        occurredAt: time(-minutes(60)),
        actorReference: actor,
      });
      for (const snapshot of [draft, active])
        await admin.query(
          "INSERT INTO rms_inventory.inventory_item_version VALUES ($1,$2,$3,$4,$5,$6)",
          [tenant, brand, item, snapshot.aggregateVersion, snapshot, time(-minutes(60))],
        );
      await ensureSyntheticStockPlace(admin, {
        tenantId: tenant,
        brandId: brand,
        storeId: store,
        stockSiteId: site,
        locationId: location,
        at: time(-minutes(60)),
      });
      await admin.query(
        "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,2,'KG',6,$8)",
        [tenant, brand, store, site, location, account, item, time(-minutes(60))],
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
              occurredAt: time(-minutes(60)),
              before: balance(1, "0", "0", "0"),
              after: balance(2, "10", "0", "10"),
              auditReference: id(22),
              correctsMovementReference: null,
            },
            id(22),
            time(-minutes(60)),
          ],
        ),
      );
      // Fulfillment's ASAP pickup slot, published before any order.
      await admin.query(
        "INSERT INTO rms_fulfillment.capacity_slot (brand_id,store_id,slot_id,fulfillment_type,starts_at,ends_at,time_zone,business_date) VALUES ($1,$2,$3,'Pickup',$4,$5,'UTC',$6)",
        [brand, store, slot, time(-minutes(60)), time(minutes(120)), businessDate],
      );
      await admin.query(
        "INSERT INTO rms_fulfillment.capacity_slot_configuration (brand_id,store_id,slot_id,config_version,capacity_limit,published_at) VALUES ($1,$2,$3,1,10,$4)",
        [brand, store, slot, time(-minutes(120))],
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
              "(SELECT count(*)::int FROM rms_ordering.order_termination_record) AS terminations," +
              "(SELECT count(*)::int FROM rms_ordering.order_revision) AS revisions," +
              "(SELECT count(*)::int FROM platform_audit.audit_record) AS audits",
          )
        ).rows[0];

      /** One submitted Order: stock reserved at submission, Ordering facts and (pickup) Fulfillment's window. */
      async function submit(
        n,
        {
          quantity,
          requestedAgo = 35,
          type = "Pickup",
          paid = null,
          intent = false,
          // Per-line (schema 2) quantities on the one stock account, as a multi-unit order holds.
          lines = null,
        },
      ) {
        assert.ok(lines === null || lines.length <= 2);
        const base100 = n * 100;
        const refs = {
          order: id(base100 + 1),
          batch: id(base100 + 2),
          submission: id(base100 + 3),
          cart: id(base100 + 4),
          quote: id(base100 + 5),
          demand: id(base100 + 6),
          workflow: id(base100 + 7),
          reservation: id(base100 + 8),
          commitment: id(base100 + 9),
          payment: id(base100 + 10),
          guest: id(base100 + 11),
          session: id(base100 + 12),
        };
        const audit = (k, targetType, targetId, actionCode) => ({
          auditId: id(base100 + k),
          brandId: brand,
          storeId: store,
          actor: { type: "User", reference: actor },
          actionCode,
          targetType,
          targetId,
          reasonCode: "AUTHORIZED_CHANGE",
          correlationId: id(base100 + k + 1),
          occurredAt: createdAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Internal",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        });
        const reservationOf = (k, partQuantity, cartItem) =>
          createInventoryReservation({
            reservationReference: k === 0 ? refs.reservation : id(base100 + 51),
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
              ...(cartItem === null ? {} : { cartItemReference: cartItem }),
            },
            unit,
            quantity: partQuantity,
            occurredAt: createdAt,
          });
        const parts = (lines ?? [quantity]).map((part, k) => ({
          quantity: part,
          reservation: reservationOf(k, part, lines === null ? null : id(base100 + 90 + k)),
        }));
        const result = await scoped(async (tx) =>
          owner(tx).commitSet({
            setReference: id(base100 + 20),
            operationReference: id(base100 + 21),
            workflowReference: refs.workflow,
            workflowVersion: 1,
            writes: await (async () => {
              const ledger = await owner(tx).loadAccountLedgerVersion(account);
              return parts.map(({ quantity: part, reservation }, k) => ({
                operationReference: id(base100 + (k === 0 ? 30 : 52)),
                accountReference: account,
                action: "Reserve",
                expectedLedgerVersion: ledger + k,
                quantity: part,
                reservation,
                movementReference: id(base100 + (k === 0 ? 31 : 53)),
                audit: {
                  ...audit(
                    k === 0 ? 32 : 54,
                    "InventoryReservation",
                    reservation.reservationReference,
                    "INVENTORY_RESERVATION_RESERVE",
                  ),
                  correlationId: id(base100 + (k === 0 ? 30 : 52)),
                },
              }));
            })(),
            audit: {
              ...audit(
                22,
                "InventoryReservationSet",
                id(base100 + 20),
                "INVENTORY_RESERVATION_SET",
              ),
              correlationId: id(base100 + 21),
            },
          }),
        );
        assert.equal(result.status, "Applied");
        const record = parseSubmissionInventoryFinalValidation({
          schemaVersion: 1,
          validationReference: id(base100 + 40),
          operationReference: id(base100 + 41),
          actorReference: result.set.actorReference,
          auditReference: id(base100 + 42),
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
          workflowVersionReference: id(base100 + 43),
          workflowVersion: 1,
          transitionReference: id(base100 + 44),
          observedAt: createdAt,
          items: [
            {
              itemReference: item,
              currentItemVersion: 2,
              configurationOperationReferences: [id(base100 + 45)],
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
            createdAt,
            hash(record),
            record,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_number_allocation " +
            "(order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at," +
            "business_date_configuration_id,business_date_configuration_version,business_date_content_digest," +
            "time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,'America/Toronto','00:00',$7,'Exact')",
          [refs.order, brand, store, businessDate, n, String(n), createdAt, id(50), hash("bd")],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_header " +
            "(order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id," +
            "created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6,'Web',$7,$8,$8,1,'Submitted','Open','NotReported',$9)",
          [
            refs.order,
            brand,
            store,
            businessDate,
            String(n),
            type,
            type === "DineIn" ? refs.session : null,
            actor,
            createdAt,
          ],
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
            refs.guest,
            hash(["intent", n]),
            refs.cart,
            refs.quote,
            createdAt,
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
            id(base100 + 60),
            refs.quote,
            actor,
            createdAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Initial',1,0,NULL,$1,$5)",
          [refs.submission, brand, store, refs.order, createdAt],
        );
        const preparedAt = time(-minutes(40)),
          validUntil = time(minutes(10));
        const link = {
          owner: type === "DineIn" ? "Dining" : "Fulfillment",
          commitmentReference: refs.commitment,
          commitmentVersion: 1,
          ownerContextReference: type === "DineIn" ? refs.session : id(base100 + 61),
          ownerIntentDigest: hash(["intent", n]),
          ownerSnapshotDigest: hash(["snapshot", n]),
          brandReference: brand,
          storeReference: store,
          orderReference: refs.order,
          orderBatchReference: refs.batch,
          submissionReference: refs.submission,
          cartReference: refs.cart,
          cartVersion: 1,
          quoteReference: refs.quote,
          guestSessionReference: refs.guest,
          paymentOperationReference: refs.payment,
          preparedAt,
          validUntil,
        };
        await admin.query(
          "INSERT INTO rms_ordering.order_capacity_link (brand_id,store_id,submission_id,order_id,order_batch_id,commitment_id,payment_operation_id,created_at,link_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            brand,
            store,
            refs.submission,
            refs.order,
            refs.batch,
            refs.commitment,
            refs.payment,
            createdAt,
            link,
          ],
        );
        if (type === "Pickup") {
          const commitment = [
            brand,
            store,
            refs.commitment,
            slot,
            refs.guest,
            refs.cart,
            refs.quote,
            refs.submission,
            refs.order,
            refs.batch,
            id(base100 + 61),
            refs.payment,
            hash(["units", n]),
            hash(["intent", n]),
            preparedAt,
            validUntil,
          ];
          await admin.query(
            "INSERT INTO rms_fulfillment.capacity_asap_commitment (brand_id,store_id,allocation_id,version,state,slot_id,config_version,guest_session_id,cart_id,cart_version,quote_id,submission_id,order_id,order_batch_id,fulfillment_id,payment_operation_id,capacity_units,units_rule_version,units_input_digest,intent_digest,prepared_at,preparation_valid_until) " +
              "VALUES ($1,$2,$3,1,'Prepared',$4,1,$5,$6,1,$7,$8,$9,$10,$11,$12,1,1,$13,$14,$15,$16)",
            commitment,
          );
          // Payment requested `requestedAgo` minutes ago; the window is that request + 30 minutes.
          const requested = time(-minutes(requestedAgo));
          await admin.query(
            "INSERT INTO rms_fulfillment.capacity_asap_commitment (brand_id,store_id,allocation_id,version,state,slot_id,config_version,guest_session_id,cart_id,cart_version,quote_id,submission_id,order_id,order_batch_id,fulfillment_id,payment_operation_id,capacity_units,units_rule_version,units_input_digest,intent_digest,prepared_at,preparation_valid_until,ordering_linked_at,payment_requested_at,capacity_expires_at) " +
              "VALUES ($1,$2,$3,2,'PaymentPending',$4,1,$5,$6,1,$7,$8,$9,$10,$11,$12,1,1,$13,$14,$15,$16,$17,$17,$18)",
            [...commitment, requested, new Date(Date.parse(requested) + minutes(30)).toISOString()],
          );
          if (intent) {
            // Checkout created the Payment intent and a Provider snapshot asking the customer to
            // act, but payment was never confirmed (no terminal), as in the pilot.
            const [intentId, attempt, observation] = [90, 91, 92].map((k) => id(base100 + k));
            const total = 1130;
            await admin.query(
              "INSERT INTO rms_payment.payment_intent (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,creation_status,prepared_at,capacity_expires_at,created_at) " +
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,$15,0,$15,'CAD','OnlineCard','Automatic',1,'ProviderCreatePending',$16,$17,$16)",
              [
                intentId,
                brand,
                store,
                refs.payment,
                refs.order,
                refs.batch,
                refs.submission,
                refs.guest,
                refs.cart,
                refs.quote,
                id(base100 + 93),
                refs.commitment,
                hash(["payment-intent", n]),
                hash(["preparation", n]),
                total,
                requested,
                new Date(Date.parse(requested) + minutes(30)).toISOString(),
              ],
            );
            await admin.query(
              "INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,provider_environment,provider_idempotency_digest,created_at) VALUES ($1,$2,$3,$4,1,'Stripe','Test',$5,$6)",
              [attempt, brand, store, intentId, hash(["idempotency", n]), requested],
            );
            await admin.query(
              "INSERT INTO rms_payment.payment_intent_operation_record (payment_operation_id,brand_id,store_id,payment_intent_id,guest_session_id,intent_digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
              [
                refs.payment,
                brand,
                store,
                intentId,
                refs.guest,
                hash(["payment-intent", n]),
                requested,
              ],
            );
            await admin.query(
              "INSERT INTO rms_payment.payment_provider_observation (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,observation_kind,normalized_status,provider_intent_reference,requested_minor,authorized_minor,captured_minor,refunded_minor,currency_code,evidence_digest,provider_observed_at,recorded_at) VALUES ($1,$2,$3,$4,$5,'Snapshot','RequiresCustomerAction','pi_DEMOsynthetic0001',$6,0,0,0,'CAD',$7,$8,$8)",
              [
                observation,
                brand,
                store,
                intentId,
                attempt,
                total,
                hash(["observation", n]),
                requested,
              ],
            );
          }
        }
        if (paid === "Wait")
          await admin.query(
            "INSERT INTO rms_ordering.order_payment_acceptance_wait (wait_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_event_id,source_digest,evaluated_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            [
              id(base100 + 70),
              brand,
              store,
              refs.order,
              refs.batch,
              refs.submission,
              id(base100 + 71),
              hash(["wait", n]),
              createdAt,
              { synthetic: true },
            ],
          );
        if (paid === "Disposition")
          await disposition(refs, {
            dispositionReference: id(base100 + 80),
            paymentEventReference: id(base100 + 81),
            reason: "CapacityExpired",
            sourceCheckpoint: refs.submission,
            sourceVersion: 1,
            evaluatedAt: createdAt,
          });
        return { refs, link };
      }
      /** Ordering's recorded paid-outcome disposition (PaidWithoutFulfillableOrder). */
      async function disposition(refs, values) {
        const record = {
          dispositionReference: values.dispositionReference,
          brandReference: brand,
          storeReference: store,
          orderReference: refs.order,
          orderBatchReference: refs.batch,
          submissionReference: refs.submission,
          paymentTransactionReference: values.paymentTransactionReference ?? id(9001),
          paymentIntentReference: values.paymentIntentReference ?? id(9002),
          paymentAttemptReference: values.paymentAttemptReference ?? id(9003),
          paymentEventReference: values.paymentEventReference,
          sourceVersion: values.sourceVersion,
          sourceCheckpoint: values.sourceCheckpoint,
          sourceDigest: values.sourceDigest ?? hash(["source", values.dispositionReference]),
          evaluatedAt: values.evaluatedAt,
          disposition: "PaidWithoutFulfillableOrder",
          reason: values.reason,
          kitchenReleaseDisposition: "Blocked",
        };
        await admin.query(
          "INSERT INTO rms_ordering.order_payment_disposition_record " +
            "(disposition_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_transaction_id,payment_intent_id,payment_attempt_id,payment_event_id,source_checkpoint,correlation_id,source_version,source_digest,evaluated_at,disposition,reason,kitchen_release_disposition) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'PaidWithoutFulfillableOrder',$16,'Blocked')",
          [
            record.dispositionReference,
            brand,
            store,
            refs.order,
            refs.batch,
            refs.submission,
            record.paymentTransactionReference,
            record.paymentIntentReference,
            record.paymentAttemptReference,
            record.paymentEventReference,
            record.sourceCheckpoint,
            id(9004),
            record.sourceVersion,
            record.sourceDigest,
            record.evaluatedAt,
            record.reason,
          ],
        );
        return record;
      }
      // Two lines of one order reserve on the same stock account (released in one transaction).
      const expired = await submit(1, { quantity: "2", lines: ["1.25", "0.75"] });
      const open = await submit(2, { quantity: "1", requestedAgo: 10 });
      const waiting = await submit(3, { quantity: "1.5", paid: "Wait" });
      const settled = await submit(4, { quantity: "0.5", paid: "Disposition" });
      const dineIn = await submit(5, { quantity: "1", type: "DineIn" });
      const abandoned = await submit(6, { quantity: "1", intent: true });
      assert.deepEqual(await stock(), { onHand: "10", reserved: "7" });

      let allowed = true;
      let references = 0x7000;
      const closure = createPickupPaymentWindowClosure({
        scope: { ...scope, providerAccountReference: provider, environment: "Test" },
        systemActorReference: system,
        transactions: { run: scoped },
        now: () => new Date().toISOString(),
        newReference: () =>
          // Fresh UUIDv7 with the current instant as its timestamp prefix.
          Date.now()
            .toString(16)
            .padStart(12, "0")
            .replace(/^(.{8})(.{4})$/u, "$1-$2") +
          "-7000-8000-" +
          (references++).toString(16).padStart(12, "0"),
        authorize: async () => allowed,
        authorizeDiscovery: async () => allowed,
      });
      const discover = async () =>
        (
          await closure.discover({ observedAt: new Date().toISOString(), after: null, limit: 10 })
        ).map((candidate) => candidate.orderReference);
      // Only pickups with no recorded payment are candidates; dine-in has its own expiry.
      assert.deepEqual(await discover(), [
        expired.refs.order,
        open.refs.order,
        abandoned.refs.order,
      ]);

      // Authority loss writes nothing.
      const before = await counts();
      allowed = false;
      await assert.rejects(closure.close({ link: expired.link }));
      allowed = true;
      assert.deepEqual(await counts(), before);

      // Payment still possible within the window: not closed.
      const notDue = await closure.close({ link: open.link });
      assert.equal(notDue.status, "NotDue");
      assert.deepEqual(await counts(), before);

      // A recorded payment (waiting for acceptance, or an outcome) belongs to the paid-outcome path.
      for (const paid of [waiting, settled])
        assert.deepEqual(await closure.close({ link: paid.link }), {
          status: "NotEligible",
          reason: "PaymentRecorded",
        });
      assert.deepEqual(await counts(), before);

      // Ordinary path: closed by the System and its stock returned in the same transaction.
      const closed = await closure.close({ link: expired.link });
      assert.equal(closed.status, "Closed");
      assert.equal(closed.paymentEvidence, "NoPaymentStarted");
      assert.deepEqual(closed.inventory, { status: "Released", entryCount: 2 });
      assert.deepEqual(await stock(), { onHand: "10", reserved: "5" });
      const after = await counts();
      assert.deepEqual(after, {
        reservations: before.reservations + 2,
        movements: before.movements + 2,
        terminations: before.terminations + 1,
        revisions: before.revisions + 1,
        audits: before.audits + 3,
      });
      const termination = (
        await admin.query(
          "SELECT termination_id::text AS id,previous_phase,phase,actor_type,actor_id,reason_code,purpose_code,expected_order_version,terminated_order_version,terminated_at FROM rms_ordering.order_termination_record WHERE order_id=$1",
          [expired.refs.order],
        )
      ).rows[0];
      assert.equal(termination.previous_phase, "Submitted");
      assert.equal(termination.phase, "Cancelled");
      assert.equal(termination.actor_type, "System");
      assert.equal(termination.actor_id, null);
      assert.equal(termination.reason_code, "PAYMENT_WINDOW_EXPIRED");
      assert.equal(termination.purpose_code, "PickupPaymentWindowClosure");
      assert.equal(termination.expected_order_version, 1);
      assert.equal(termination.terminated_order_version, 2);
      const orderAudit = (
        await admin.query(
          "SELECT actor_type,actor_reference,reason_code,source_channel,data_classification FROM platform_audit.audit_record WHERE target_id=$1 AND action_code='ORDER_TERMINATED'",
          [expired.refs.order],
        )
      ).rows;
      assert.deepEqual(orderAudit, [
        {
          actor_type: "System",
          actor_reference: null,
          reason_code: "PAYMENT_WINDOW_EXPIRED",
          source_channel: "SYSTEM",
          data_classification: "Restricted",
        },
      ]);
      const movement = (
        await admin.query(
          "SELECT record_json FROM rms_inventory.stock_movement WHERE movement_type='Release' ORDER BY ledger_version",
          [],
        )
      ).rows.map((row) => row.record_json);
      // Both lines' releases on the one account follow each other in the ledger.
      assert.equal(movement.length, 2);
      assert.equal(movement[1].before.ledgerVersion, movement[0].after.ledgerVersion);
      for (const released of movement) {
        assert.equal(released.performedBy, system);
        assert.equal(released.reasonCode, "PAYMENT_WINDOW_EXPIRED");
        assert.equal(released.occurredAt, termination.terminated_at.toISOString());
      }
      const releaseAudit = (
        await admin.query(
          "SELECT actor_type,reason_code,source_channel FROM platform_audit.audit_record WHERE action_code='INVENTORY_RESERVATION_RELEASE'",
          [],
        )
      ).rows;
      assert.deepEqual(releaseAudit, [
        { actor_type: "System", reason_code: "PAYMENT_WINDOW_EXPIRED", source_channel: "SYSTEM" },
        { actor_type: "System", reason_code: "PAYMENT_WINDOW_EXPIRED", source_channel: "SYSTEM" },
      ]);

      // Staff and customer reads see a cancelled order, no longer awaiting payment.
      const reads = await scoped(async (tx) => ({
        execution: await createPostgresOrderExecutionReader({
          brandReference: brand,
          storeReference: store,
          sha256: (value) => "sha256:" + sha256Hex(value),
          authorize: async () => true,
        }).loadByBatch({
          transaction: tx,
          orderReference: expired.refs.order,
          orderBatchReference: expired.refs.batch,
        }),
        customer: await loadPickupPaymentWindowClosure(tx, scope, expired.refs.order),
        open: await loadPickupPaymentWindowClosure(tx, scope, open.refs.order),
      }));
      assert.equal(reads.execution.phase, "Cancelled");
      assert.equal(reads.execution.version, 2);
      assert.deepEqual(reads.customer, { closedAt: termination.terminated_at.toISOString() });
      assert.equal(reads.open, null);

      // Replay (next scan, worker restart) verifies the original closure and release, writes nothing.
      const replay = await closure.close({ link: expired.link });
      assert.equal(replay.status, "AlreadyClosed");
      assert.deepEqual(replay.inventory, { status: "AlreadyApplied", entryCount: 2 });
      assert.deepEqual(await counts(), after);
      assert.deepEqual(await discover(), [open.refs.order, abandoned.refs.order]);
      assert.deepEqual(await stock(), { onHand: "10", reserved: "5" });

      // A payment captured after the closure: Ordering classifies it SubmissionCancelled (refunded
      // by compensation) and the paid-outcome stock release finds the stock already returned.
      const late = await scoped(async (tx) => {
        const execution = await createPostgresOrderInitialExecutionReader({
          brandReference: brand,
          storeReference: store,
          authorize: async () => true,
        }).loadByBatch({
          transaction: tx,
          orderReference: expired.refs.order,
          orderBatchReference: expired.refs.batch,
        });
        const observedAt = new Date().toISOString();
        const total = { amountMinor: 1250n, currencyCode: "CAD" };
        return createOrderTerminatedPaymentDisposition({
          execution,
          preparation: {
            preparationReference: id(9010),
            orderReference: expired.refs.order,
            orderBatchReference: expired.refs.batch,
            submissionReference: expired.refs.submission,
            sourceCartReference: expired.refs.cart,
            sourceCartVersion: 1,
            brandReference: brand,
            storeReference: store,
            guestSessionReference: expired.refs.guest,
            quoteReference: expired.refs.quote,
            capacityAllocationReference: expired.refs.commitment,
            readiness: "PaymentPending",
            transactionBoundary: "OrderSubmissionPaymentPreparation",
            orderAllocation: total,
            tip: { amountMinor: 0n, currencyCode: "CAD" },
            total,
            committedAt: time(-minutes(35)),
            capacityExpiresAt: time(-minutes(5)),
            sourceDigest: hash("preparation"),
          },
          paymentEvent: {
            eventId: id(9020),
            eventType: "PaymentSucceeded",
            schemaVersion: 1,
            occurredAt: observedAt,
            producerModule: "@rms/payment",
            tenantId: brand,
            storeId: store,
            aggregateType: "PaymentIntent",
            aggregateId: id(9021),
            aggregateVersion: 2n,
            correlationId: id(9022),
            causationId: id(9023),
            actor: { type: "System" },
            payload: {
              paymentTransactionReference: id(9024),
              paymentIntentReference: id(9021),
              paymentAttemptReference: id(9025),
              orderReference: expired.refs.order,
              amountMinor: "1250",
              currencyCode: "CAD",
              evidenceKind: "Captured",
              terminalOccurredAt: observedAt,
            },
            redactionClassification: "payment",
            replayMetadata: { replaySafe: true },
          },
          observedAt,
          dispositionReference: id(9030),
          sha256: (value) => "sha256:" + sha256Hex(value),
        });
      });
      assert.equal(late.disposition, "PaidWithoutFulfillableOrder");
      assert.equal(late.reason, "SubmissionCancelled");
      await disposition(expired.refs, late);
      const lateRelease = await scoped((tx) =>
        createPaidWithoutFulfillableInventoryRelease({
          scope,
          systemActorReference: system,
          now: () => new Date().toISOString(),
          authorize: async () => true,
        })(tx, late),
      );
      assert.deepEqual(lateRelease, { status: "NothingToRelease", reason: "AlreadyReleased" });
      assert.deepEqual(await stock(), { onHand: "10", reserved: "5" });
      assert.equal((await counts()).movements, after.movements);

      // Payment intent created at checkout but never confirmed (Provider still asks the customer to
      // act, no terminal): read through Payment's own stores, then closed and its stock returned.
      const unconfirmed = await closure.close({ link: abandoned.link });
      assert.equal(unconfirmed.status, "Closed");
      assert.equal(unconfirmed.paymentEvidence, "PaymentUnresolved");
      assert.deepEqual(unconfirmed.inventory, { status: "Released", entryCount: 1 });
      assert.deepEqual(await stock(), { onHand: "10", reserved: "4" });
      assert.deepEqual(await discover(), [open.refs.order]);

      // History stays append-only; another Store cannot see or close the Order.
      await scoped(async (tx) => {
        assert.equal(
          (await tx.query("DELETE FROM rms_ordering.order_termination_record", [])).rowCount,
          0,
        );
      });
      await assert.rejects(
        createPickupPaymentWindowClosure({
          scope: {
            ...scope,
            storeReference: id(999),
            providerAccountReference: provider,
            environment: "Test",
          },
          systemActorReference: system,
          transactions: { run: scoped },
          now: () => new Date().toISOString(),
          newReference: () => id(998),
          authorize: async () => true,
          authorizeDiscovery: async () => true,
        }).close({ link: open.link }),
      );
      assert.equal(dineIn.link.owner, "Dining");

      // WP-2423 item 5 (Q1/Q9-G1): a paid pickup the Store did not accept in time (Ordering recorded
      // PaidWithoutFulfillableOrder / CapacityExpired; Payment refunds it) is also ended as an
      // Order — a System termination bound to that disposition, with revision and Audit.
      const lapse = createPostgresPaidAcceptanceLapseClosure({
        brandReference: brand,
        storeReference: store,
        authorize: async () => allowed,
      });
      const settledEvent = id(481);
      const lapseInput = (paymentEventReference) => ({
        paymentEventReference,
        closedAt: new Date().toISOString(),
        terminationReference: id(0x7a00 + references++),
        auditReference: id(0x7b00 + references++),
      });
      const beforeLapse = await counts();
      allowed = false;
      await assert.rejects(scoped((tx) => lapse.close(tx, lapseInput(settledEvent))));
      allowed = true;
      assert.deepEqual(await counts(), beforeLapse);
      const lapsed = await scoped((tx) => lapse.close(tx, lapseInput(settledEvent)));
      assert.equal(lapsed.status, "Closed");
      assert.deepEqual(await counts(), {
        ...beforeLapse,
        terminations: beforeLapse.terminations + 1,
        revisions: beforeLapse.revisions + 1,
        audits: beforeLapse.audits + 1,
      });
      const lapseRow = (
        await admin.query(
          "SELECT previous_phase,phase,actor_type,actor_id,reason_code,purpose_code,permission_code,expected_order_version,terminated_order_version FROM rms_ordering.order_termination_record WHERE order_id=$1",
          [settled.refs.order],
        )
      ).rows;
      assert.deepEqual(lapseRow, [
        {
          previous_phase: "Submitted",
          phase: "Cancelled",
          actor_type: "System",
          actor_id: null,
          reason_code: "ACCEPTANCE_WINDOW_EXPIRED",
          purpose_code: "PaidOrderAcceptanceLapseClosure",
          permission_code: "order.acceptance-window.close",
          expected_order_version: 1,
          terminated_order_version: 2,
        },
      ]);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT actor_type,reason_code,source_channel FROM platform_audit.audit_record WHERE target_id=$1 AND action_code='ORDER_TERMINATED'",
            [settled.refs.order],
          )
        ).rows,
        [
          {
            actor_type: "System",
            reason_code: "ACCEPTANCE_WINDOW_EXPIRED",
            source_channel: "SYSTEM",
          },
        ],
      );
      const lapsedExecution = await scoped((tx) =>
        createPostgresOrderExecutionReader({
          brandReference: brand,
          storeReference: store,
          sha256: (value) => "sha256:" + sha256Hex(value),
          authorize: async () => true,
        }).loadByBatch({
          transaction: tx,
          orderReference: settled.refs.order,
          orderBatchReference: settled.refs.batch,
        }),
      );
      assert.equal(lapsedExecution.phase, "Cancelled");
      // The customer page still reads it as "not accepted in time · refunded", not "not paid".
      assert.equal(
        await scoped((tx) => loadPickupPaymentWindowClosure(tx, scope, settled.refs.order)),
        null,
      );
      // Replay (every inventory rescan) verifies and writes nothing.
      const lapseAgain = await scoped((tx) => lapse.close(tx, lapseInput(settledEvent)));
      assert.equal(lapseAgain.status, "AlreadyClosed");
      assert.equal(lapseAgain.record.terminationReference, lapsed.record.terminationReference);
      assert.deepEqual(await counts(), {
        ...beforeLapse,
        terminations: beforeLapse.terminations + 1,
        revisions: beforeLapse.revisions + 1,
        audits: beforeLapse.audits + 1,
      });
      // Another reason (a payment after the System closed it), or a dine-in round, is not this.
      assert.deepEqual(
        await scoped((tx) => lapse.close(tx, lapseInput(late.paymentEventReference))),
        {
          status: "NotEligible",
          reason: "NotAcceptanceLapse",
        },
      );
      await disposition(dineIn.refs, {
        dispositionReference: id(580),
        paymentEventReference: id(581),
        paymentTransactionReference: id(582),
        reason: "CapacityExpired",
        sourceCheckpoint: dineIn.refs.submission,
        sourceVersion: 1,
        evaluatedAt: createdAt,
      });
      assert.deepEqual(await scoped((tx) => lapse.close(tx, lapseInput(id(581)))), {
        status: "NotEligible",
        reason: "NotAcceptanceLapse",
      });
      // Another Store cannot close it.
      await assert.rejects(
        scoped((tx) =>
          createPostgresPaidAcceptanceLapseClosure({
            brandReference: brand,
            storeReference: id(999),
            authorize: async () => true,
          }).close(tx, lapseInput(settledEvent)),
        ),
      );
    } finally {
      for (const name of [role, other]) {
        await admin.query("DROP OWNED BY " + name);
        await admin.query("DROP ROLE " + name);
      }
      await admin.end();
    }
  });
});
