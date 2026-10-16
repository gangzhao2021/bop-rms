import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  createInventoryItem,
  transitionInventoryItem,
  createInventoryReservation,
  createPostgresStockReservationStore,
  parseSubmissionInventoryFinalValidation,
} from "../../rms/inventory/src/index.ts";
import {
  createKitchenWorkLifecycleService,
  createPostgresKitchenWorkLifecycleStore,
} from "../../rms/kitchen/src/index.ts";
import {
  listStorePaidOrderBatches,
  createPostgresDiningOrderItemStateReader,
  createPostgresOrderCompensationCandidateReader,
  createPostgresStaffOrderCancellationReader,
} from "../../rms/ordering/src/index.ts";
import {
  createPaymentProviderSnapshot,
  createPostgresCardMachinePaymentStore,
} from "../../rms/payment/src/index.ts";
import { createMerchantOrderStaffCancellation } from "../../../apps/api/src/merchant-order-staff-cancellation.ts";
import {
  createMerchantEndedOrderStockRelease,
  readEarlierOrdersHoldingStock,
} from "../../../apps/api/src/merchant-stock-holding-orders.ts";
import { createMerchantDiningTableClosePlan } from "../../../apps/api/src/merchant-dining-table-close-plan.ts";
import { createPaymentCompensationComposition } from "../../../apps/api/src/payment-compensation-composition.ts";
import { createMerchantCardMachineCancellationRefund } from "../../../apps/api/src/merchant-card-machine-refund.ts";
import { createMerchantOrdinaryRefundRequest } from "../../../apps/api/src/merchant-ordinary-refund-request.ts";
import { createRoundCancellationRefundSource } from "../../../apps/api/src/merchant-round-cancellation-refund.ts";
import { withoutCardMachinePayments } from "../../../tooling/environment/pilot-compensation-candidates.mjs";
import { createInternalCompensationIdentity } from "../../../tooling/environment/pilot-compensation-identity.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";

// The merchant session/permission resolution (Identity, Membership, Permission owners) is replaced by
// an explicit test double: it names the staff member, the selected Store and the current
// `ordering.order.cancel` decision. Everything after it runs the real owner code.
const merchant = vi.hoisted(() => ({
  store: null,
  actor: null,
  tenant: null,
  brand: null,
  allowed: null,
  actions: [],
}));
vi.mock("../../../apps/api/src/merchant-store-scope.ts", () => ({
  createMerchantStoreScope: () => async (_tx, _cookie, action) => {
    merchant.actions.push(action);
    return {
      actorReference: merchant.actor,
      selected: { tenantReference: merchant.tenant },
      context: { brand: { brandReference: merchant.brand }, resolvedAt: new Date().toISOString() },
      store: { storeReference: merchant.store },
      allowed: async () => merchant.allowed(),
    };
  },
}));

const { Client } = pg;
const id = (n) => "0190a7c4-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const sha = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
const [tenant, brand, store, site, location, item, account, staff, cook, otherStore, provider] = [
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
let references = 0x9000;
/** Fresh UUIDv7 whose timestamp prefix is the current instant. */
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (references++).toString(16).padStart(12, "0");

/**
 * WP-2423 Q6 step 1: a store manager cancels a paid, accepted Order (pickup) or Batch (dine-in)
 * before the kitchen starts it. Kitchen work, the Ordering cancellation (and pickup termination)
 * and the stock reserved at submission change in one transaction, or nothing changes. The command
 * runs as a restricted NOBYPASSRLS role holding exactly the rendered pilot API grants (matrix plus
 * approved additions); owner facts are seeded by the isolated database owner.
 */
it("staff cancel a paid order or batch before the kitchen starts it, atomically, once, and never after preparation started", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_staff_cancel" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_soc_" + context.runId,
      other = "wp2423_soc_w_" + context.runId;
    assert.match(role, /^wp2423_soc_[a-f0-9]+$/u);
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

      /** One restricted-role transaction on its own connection; optional pause before COMMIT. */
      function transactions({ guc = true, beforeCommit = null } = {}) {
        return {
          async run(work) {
            const client = new Client(context.clientConfig);
            await client.connect();
            try {
              await client.query("BEGIN");
              await client.query("SET LOCAL ROLE " + role);
              await client.query("SET LOCAL lock_timeout='10s'");
              await client.query("SET LOCAL statement_timeout='20s'");
              if (guc)
                await client.query(
                  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
                  [tenant, brand, store],
                );
              const tx = {
                query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
              };
              const result = await work(tx);
              if (beforeCommit) await beforeCommit();
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
      }
      const scoped = (work) => transactions().run(work);

      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (offset) => new Date(base + offset).toISOString();
      const baseTime = time;
      const businessDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(
        new Date(time(-minutes(40))),
      );
      const owner = (tx) => createPostgresStockReservationStore({ run: (work) => work(tx) }, scope);

      // Item, stock place, one account holding 20 KG on hand.
      await admin.query(
        "INSERT INTO rms_inventory.inventory_item VALUES ($1,$2,$3,'SYNTHETIC','RawMaterial',$4,$5)",
        [tenant, brand, item, time(-minutes(90)), staff],
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
        occurredAt: time(-minutes(90)),
        actorReference: staff,
      });
      const active = transitionInventoryItem(draft, "Active", {
        expectedVersion: 1,
        hasOpenWork: false,
        hasNonZeroStock: false,
        occurredAt: time(-minutes(90)),
        actorReference: staff,
      });
      for (const snapshot of [draft, active])
        await admin.query(
          "INSERT INTO rms_inventory.inventory_item_version VALUES ($1,$2,$3,$4,$5,$6)",
          [tenant, brand, item, snapshot.aggregateVersion, snapshot, time(-minutes(90))],
        );
      await ensureSyntheticStockPlace(admin, {
        tenantId: tenant,
        brandId: brand,
        storeId: store,
        stockSiteId: site,
        locationId: location,
        at: time(-minutes(90)),
      });
      await admin.query(
        "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,2,'KG',6,$8)",
        [tenant, brand, store, site, location, account, item, time(-minutes(90))],
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
          "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,2,'Receive','20',$6,$7,$8)",
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
              quantityDelta: "20",
              unitCode: "KG",
              baseQuantityDelta: "20",
              baseUnitCode: "KG",
              conversionMultiplier: "1",
              sourceScope: { scopeType: "Location", scopeReference: location },
              destinationScope: null,
              lotReference: null,
              expiryDate: null,
              businessSourceType: "SYNTHETIC",
              businessSourceReference: id(21),
              reasonCode: "SYNTHETIC_TEST",
              performedBy: staff,
              occurredAt: time(-minutes(90)),
              before: balance(1, "0", "0", "0"),
              after: balance(2, "20", "0", "20"),
              auditReference: id(22),
              correctsMovementReference: null,
            },
            id(22),
            time(-minutes(90)),
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
            "SELECT (SELECT count(*)::int FROM rms_ordering.order_staff_cancellation) AS staff," +
              "(SELECT count(*)::int FROM rms_ordering.order_termination_record) AS terminations," +
              "(SELECT count(*)::int FROM rms_ordering.order_revision) AS revisions," +
              "(SELECT count(*)::int FROM platform_audit.audit_record) AS audits," +
              "(SELECT count(*)::int FROM platform_eventing.outbox_event) AS events," +
              "(SELECT count(*)::int FROM rms_kitchen.kitchen_work_cancellation) AS kitchen," +
              "(SELECT count(*)::int FROM rms_kitchen.kitchen_work_lifecycle_operation) AS lifecycle," +
              "(SELECT count(*)::int FROM rms_inventory.stock_reservation_version) AS reservations," +
              "(SELECT count(*)::int FROM rms_inventory.stock_movement) AS movements",
          )
        ).rows[0];
      const itemStatuses = async (ticket) =>
        (
          await admin.query(
            "SELECT status FROM rms_kitchen.kitchen_work_item WHERE kitchen_ticket_id=$1 ORDER BY kitchen_work_item_id",
            [ticket],
          )
        ).rows.map((row) => row.status);

      /** Stock reserved at submission plus the inventory final validation for one Batch. */
      async function reserve(n, refs, orderReference, quantity, at, parts = null) {
        // Per-line (schema 2) reservations: each Order line of the Batch reserves on the same
        // stock account, as a multi-unit round does (v15 DEMO-02 round 6).
        const lines = parts ?? [{ quantity, cartItem: null }];
        const reservationOf = (k, partQuantity, cartItem) =>
          createInventoryReservation({
            reservationReference: k === 0 ? refs.reservation : id(n + 60 + k),
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
            occurredAt: at,
          });
        const audit = (k, targetType, targetId, actionCode, correlationId) => ({
          auditId: id(n + k),
          brandId: brand,
          storeId: store,
          actor: { type: "User", reference: staff },
          actionCode,
          targetType,
          targetId,
          reasonCode: "AUTHORIZED_CHANGE",
          correlationId,
          occurredAt: at,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Internal",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        });
        const result = await scoped(async (tx) =>
          owner(tx).commitSet({
            setReference: id(n + 20),
            operationReference: id(n + 21),
            workflowReference: refs.workflow,
            workflowVersion: 1,
            writes: await (async () => {
              const ledger = await owner(tx).loadAccountLedgerVersion(account);
              return lines.map((line, k) => {
                const reservation = reservationOf(k, line.quantity, line.cartItem);
                return {
                  operationReference: id(n + 30 + 3 * k),
                  accountReference: account,
                  action: "Reserve",
                  expectedLedgerVersion: ledger + k,
                  quantity: line.quantity,
                  reservation,
                  movementReference: id(n + 31 + 3 * k),
                  audit: audit(
                    32 + 3 * k,
                    "InventoryReservation",
                    reservation.reservationReference,
                    "INVENTORY_RESERVATION_RESERVE",
                    id(n + 30 + 3 * k),
                  ),
                };
              });
            })(),
            audit: audit(
              22,
              "InventoryReservationSet",
              id(n + 20),
              "INVENTORY_RESERVATION_SET",
              id(n + 21),
            ),
          }),
        );
        assert.equal(result.status, "Applied");
        const record = parseSubmissionInventoryFinalValidation({
          schemaVersion: 1,
          validationReference: id(n + 40),
          operationReference: id(n + 41),
          actorReference: result.set.actorReference,
          auditReference: id(n + 42),
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          orderReference,
          submissionReference: refs.submission,
          cartReference: refs.cart,
          cartVersion: 1,
          quoteReference: refs.quote,
          demandReference: refs.demand,
          demandDigest: hash(["demand", n]),
          workflowReference: refs.workflow,
          workflowVersionReference: id(n + 43),
          workflowVersion: 1,
          transitionReference: id(n + 44),
          observedAt: at,
          items: [
            {
              itemReference: item,
              currentItemVersion: 2,
              configurationOperationReferences: [id(n + 45)],
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
      }

      /**
       * One paid Order: per Batch the submitted items, stock reserved at submission, acceptance,
       * Payment's captured terminal fact (amount incl. tip), Ordering's Confirmed payment
       * disposition and the kitchen ticket with one queued work item per order item.
       */
      async function seedOrder(
        n,
        {
          type = "Pickup",
          batches = [2],
          quantity = "1",
          cardMachine = false,
          // WP-2423 Q7: paid, but Ordering found it could not be fulfilled (never accepted).
          unfulfillable = false,
          // DEC-TABLE-CLOSE-GUESTS-LEFT: paid, recorded as waiting for acceptance, never accepted.
          awaiting = false,
          // Later submission times (stock ledger movements must stay in time order).
          shift = 0,
          // Per Batch index: per-line reservation quantities on the one stock account.
          lineParts = {},
        },
      ) {
        const time = (offset) => baseTime(offset + shift);
        const order = {
          order: id(n + 1),
          guest: id(n + 2),
          session: id(n + 3),
          type,
          batches: [],
        };
        await admin.query(
          "INSERT INTO rms_ordering.order_number_allocation " +
            "(order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at," +
            "business_date_configuration_id,business_date_configuration_version,business_date_content_digest," +
            "time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,'America/Toronto','00:00',$7,'Exact')",
          [
            order.order,
            brand,
            store,
            businessDate,
            n / 1000,
            String(n / 1000),
            time(-minutes(40)),
            id(50),
            hash("bd"),
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_header " +
            "(order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id," +
            "created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6,'Web',$7,$8,$8,1,'Submitted','Open','NotReported',$9)",
          [
            order.order,
            brand,
            store,
            businessDate,
            String(n / 1000),
            type,
            type === "DineIn" ? order.session : null,
            order.guest,
            time(-minutes(40)),
          ],
        );
        let previous = null,
          version = 0;
        for (const [k, itemCount] of batches.entries()) {
          const b = n + 100 * (k + 1);
          const submittedAt = time(-minutes(40 - 10 * k)),
            paidAt = time(-minutes(39 - 10 * k)),
            acceptedAt = time(-minutes(38 - 10 * k)),
            kitchenAt = time(-minutes(37 - 10 * k));
          const refs = {
            batch: id(b + 1),
            submission: id(b + 2),
            cart: id(b + 3),
            quote: id(b + 4),
            demand: id(b + 5),
            workflow: id(b + 6),
            reservation: id(b + 7),
            items: Array.from({ length: itemCount }, (_, j) => id(b + 50 + j)),
            ticket: id(b + 60),
            workItems: Array.from({ length: itemCount }, (_, j) => id(b + 70 + j)),
            intent: id(b + 80),
            attempt: id(b + 81),
            transaction: id(b + 82),
            event: id(b + 83),
            disposition: id(b + 84),
            confirmation: id(b + 85),
            confirmedEvent: id(b + 86),
            observation: id(b + 87),
            webhook: id(b + 88),
            acceptance: id(b + 89),
            paymentOperation: id(b + 90),
            correlation: id(b + 91),
            orderAllocationMinor: 1200 + 100 * k,
            tipMinor: 180,
          };
          refs.totalMinor = refs.orderAllocationMinor + refs.tipMinor;
          await admin.query(
            "INSERT INTO rms_ordering.order_submission_record " +
              "(submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at,submission_kind) " +
              "VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10)",
            [
              refs.submission,
              brand,
              store,
              order.order,
              order.guest,
              hash(["intent", b]),
              refs.cart,
              refs.quote,
              submittedAt,
              k === 0 ? "Initial" : "Additional",
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
              order.order,
              refs.submission,
              refs.cart,
              id(b + 8),
              refs.quote,
              order.guest,
              submittedAt,
            ],
          );
          for (const [j, orderItem] of refs.items.entries())
            await admin.query(
              "INSERT INTO rms_ordering.order_item (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)",
              [
                orderItem,
                brand,
                store,
                order.order,
                refs.batch,
                id(b + 40 + j),
                hash(["catalog", b, j]),
                hash(["quote", b, j]),
                { catalog: { synthetic: true }, pricing: { synthetic: true } },
                submittedAt,
              ],
            );
          if (k === 0)
            await admin.query(
              "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Initial',1,0,NULL,$1,$5)",
              [refs.submission, brand, store, order.order, submittedAt],
            );
          else {
            await admin.query(
              "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'AdditionalBatch',$5,$6,$7,NULL,$8)",
              [
                refs.submission,
                brand,
                store,
                order.order,
                version + 1,
                version,
                previous,
                submittedAt,
              ],
            );
            await admin.query(
              "INSERT INTO rms_ordering.additional_dining_batch_record (submission_id,brand_id,store_id,order_id,order_batch_id,batch_sequence,snapshot_json) VALUES ($1,$2,$3,$4,$5,$6,$7)",
              [refs.submission, brand, store, order.order, refs.batch, k + 1, { synthetic: true }],
            );
          }
          version += 1;
          previous = refs.submission;
          await reserve(
            b,
            refs,
            order.order,
            quantity,
            submittedAt,
            lineParts[k]?.map((part, j) => ({ quantity: part, cartItem: id(b + 40 + j) })) ?? null,
          );

          // WP-2423 Q7: a counter order paid on the Store's card machine (recorded by staff).
          if (cardMachine)
            await admin.query(
              "INSERT INTO rms_payment.card_machine_payment (tenant_id,brand_id,store_id,card_machine_payment_id,payment_intent_id,payment_attempt_id,payment_operation_id,operation_id,intent_digest,order_id,order_batch_id,submission_id,preparation_json,order_allocation_minor,tip_minor,total_minor,currency_code,payment_environment,slip_reference,recording_reason,taken_at,recorded_at,actor_id,event_id,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,'CAD','Test','AUTH 0001','AtCounter',$17,$17,$18,$19,$20)",
              [
                tenant,
                brand,
                store,
                refs.transaction,
                refs.intent,
                refs.attempt,
                refs.paymentOperation,
                id(b + 99),
                hash(["card-machine", b]),
                order.order,
                refs.batch,
                refs.submission,
                JSON.stringify({
                  preparationReference: id(b + 92),
                  orderReference: order.order,
                  orderBatchReference: refs.batch,
                  submissionReference: refs.submission,
                  sourceCartReference: refs.cart,
                  sourceCartVersion: 1,
                  brandReference: brand,
                  storeReference: store,
                  guestSessionReference: order.guest,
                  quoteReference: refs.quote,
                  capacityAllocationReference: id(b + 93),
                  readiness: "PaymentPending",
                  transactionBoundary: "OrderSubmissionPaymentPreparation",
                  orderAllocation: {
                    amountMinor: String(refs.orderAllocationMinor),
                    currencyCode: "CAD",
                  },
                  tip: { amountMinor: String(refs.tipMinor), currencyCode: "CAD" },
                  total: { amountMinor: String(refs.totalMinor), currencyCode: "CAD" },
                  committedAt: submittedAt,
                  capacityExpiresAt: time(-minutes(10 - 10 * k)),
                  sourceDigest: hash(["preparation", b]),
                }),
                refs.orderAllocationMinor,
                refs.tipMinor,
                refs.totalMinor,
                paidAt,
                staff,
                refs.event,
                id(b + 79),
              ],
            );
          // Payment: the intent (allocation plus tip), the attempt, the captured Provider
          // observation and the verified terminal fact.
          else {
            await admin.query(
              "INSERT INTO rms_payment.payment_intent (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,creation_status,prepared_at,capacity_expires_at,created_at) " +
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,$15,$16,$17,'CAD','OnlineCard','Automatic',1,'ProviderCreatePending',$18,$19,$18)",
              [
                refs.intent,
                brand,
                store,
                refs.paymentOperation,
                order.order,
                refs.batch,
                refs.submission,
                order.guest,
                refs.cart,
                refs.quote,
                id(b + 92),
                id(b + 93),
                hash(["payment-intent", b]),
                hash(["preparation", b]),
                refs.orderAllocationMinor,
                refs.tipMinor,
                refs.totalMinor,
                submittedAt,
                time(-minutes(10 - 10 * k)),
              ],
            );
            await admin.query(
              "INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,provider_environment,provider_idempotency_digest,created_at) VALUES ($1,$2,$3,$4,1,'Stripe','Test',$5,$6)",
              [refs.attempt, brand, store, refs.intent, hash(["idempotency", b]), submittedAt],
            );
            await admin.query(
              "INSERT INTO rms_payment.payment_intent_operation_record (payment_operation_id,brand_id,store_id,payment_intent_id,guest_session_id,intent_digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
              [
                refs.paymentOperation,
                brand,
                store,
                refs.intent,
                order.guest,
                hash(["payment-intent", b]),
                submittedAt,
              ],
            );
            await admin.query(
              "INSERT INTO rms_payment.payment_provider_observation (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,observation_kind,normalized_status,provider_intent_reference,provider_transaction_reference,requested_minor,authorized_minor,captured_minor,refunded_minor,currency_code,evidence_digest,provider_observed_at,recorded_at) VALUES ($1,$2,$3,$4,$5,'Snapshot','Captured',$6,$7,$8,$8,$8,0,'CAD',$9,$10,$10)",
              [
                refs.observation,
                brand,
                store,
                refs.intent,
                refs.attempt,
                "pi_SYNTHETIC_" + b,
                "ch_SYNTHETIC_" + b,
                refs.totalMinor,
                hash(["observation", b]),
                paidAt,
              ],
            );
            await admin.query(
              "INSERT INTO rms_payment.provider_webhook_record (webhook_receipt_id,brand_id,store_id,provider,provider_environment,provider_account_id,provider_event_id,provider_event_type,provider_created_at,received_at,signature_timestamp,evidence_digest,accepted_at,raw_evidence_expires_at,dedupe_expires_at) VALUES ($1,$2,$3,'Stripe','Test',$4,$5,'payment_intent.succeeded',$6,$6,$6,$7,$6,$6::timestamptz+interval '30 days',$6::timestamptz+interval '90 days')",
              [
                refs.webhook,
                brand,
                store,
                provider,
                "evt_SYNTHETIC" + String(b).padStart(8, "0"),
                paidAt,
                hash(["webhook", b]),
              ],
            );
            await admin.query(
              "INSERT INTO rms_payment.payment_terminal_fact (payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,provider_intent_reference,provider_observation_id,authoritative_source,terminal_outcome,amount_minor,currency_code,failure_reason,retry_disposition,occurred_at,recorded_at,evidence_digest,event_id,causation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Test',$10,$11,'VerifiedWebhook','Succeeded',$12,'CAD',NULL,NULL,$13,$13,$14,$15,$7)",
              [
                refs.transaction,
                brand,
                store,
                refs.intent,
                refs.attempt,
                order.order,
                refs.webhook,
                "evt_SYNTHETIC" + String(b).padStart(8, "0"),
                provider,
                "pi_SYNTHETIC_" + b,
                refs.observation,
                refs.totalMinor,
                paidAt,
                hash(["terminal", b]),
                refs.event,
              ],
            );
          }
          if (awaiting) {
            await admin.query(
              "INSERT INTO rms_ordering.order_payment_acceptance_wait (wait_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_event_id,source_digest,evaluated_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
              [
                refs.disposition,
                brand,
                store,
                order.order,
                refs.batch,
                refs.submission,
                refs.event,
                hash(["wait", b]),
                paidAt,
                {
                  disposition: "AwaitingAcceptance",
                  reason: "OrderAcceptancePending",
                  dispositionReference: refs.disposition,
                  brandReference: brand,
                  storeReference: store,
                  orderReference: order.order,
                  orderBatchReference: refs.batch,
                  submissionReference: refs.submission,
                  paymentTransactionReference: refs.transaction,
                  paymentIntentReference: refs.intent,
                  paymentAttemptReference: refs.attempt,
                  paymentEventReference: refs.event,
                  sourceVersion: version,
                  sourceCheckpoint: refs.submission,
                  sourceDigest: hash(["wait-source", b]),
                  evaluatedAt: paidAt,
                },
              ],
            );
            order.batches.push(refs);
            continue;
          }
          if (unfulfillable) {
            await admin.query(
              "INSERT INTO rms_ordering.order_payment_disposition_record (disposition_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_transaction_id,payment_intent_id,payment_attempt_id,payment_event_id,source_checkpoint,correlation_id,source_version,source_digest,evaluated_at,disposition,reason,kitchen_release_disposition) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'PaidWithoutFulfillableOrder','CapacityExpired','Blocked')",
              [
                refs.disposition,
                brand,
                store,
                order.order,
                refs.batch,
                refs.submission,
                refs.transaction,
                refs.intent,
                refs.attempt,
                refs.event,
                refs.submission,
                refs.correlation,
                version,
                hash(["disposition", b]),
                acceptedAt,
              ],
            );
            order.batches.push(refs);
            continue;
          }
          // Ordering: the store accepted the Batch, then recorded the paid outcome Confirmed.
          await admin.query(
            "INSERT INTO rms_ordering.order_acceptance_record (acceptance_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,accepted_order_version,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,accepted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'User',$9,'OrderAcceptance','order.accept','SYNTHETIC_TEST',$10,$11,$12,$13)",
            [
              refs.acceptance,
              id(b + 94),
              brand,
              store,
              order.order,
              refs.batch,
              version,
              version + 1,
              staff,
              id(b + 95),
              id(b + 96),
              hash(["acceptance", b]),
              acceptedAt,
            ],
          );
          await admin.query(
            "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Acceptance',$5,$6,$7,NULL,$8)",
            [
              refs.acceptance,
              brand,
              store,
              order.order,
              version + 1,
              version,
              previous,
              acceptedAt,
            ],
          );
          version += 1;
          previous = refs.acceptance;
          await admin.query(
            "INSERT INTO rms_ordering.order_payment_disposition_record (disposition_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_transaction_id,payment_intent_id,payment_attempt_id,payment_event_id,source_checkpoint,correlation_id,source_version,source_digest,evaluated_at,disposition,confirmation_id,source_snapshot_digest,confirmed_at,order_confirmed_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Confirmed',$16,$17,$15,$18)",
            [
              refs.disposition,
              brand,
              store,
              order.order,
              refs.batch,
              refs.submission,
              refs.transaction,
              refs.intent,
              refs.attempt,
              refs.event,
              refs.acceptance,
              refs.correlation,
              version,
              hash(["disposition", b]),
              acceptedAt,
              refs.confirmation,
              hash(["snapshot", b]),
              refs.confirmedEvent,
            ],
          );

          // Kitchen: the ticket created from the confirmed Batch, one queued work item per item.
          await admin.query(
            "INSERT INTO rms_kitchen.kitchen_ticket (kitchen_ticket_id,brand_id,store_id,order_id,order_batch_id,confirmation_id,consumer_name,consumer_version,source_event_id,source_aggregate_version,source_snapshot_digest,confirmed_at,correlation_id,semantic_event_binding_digest,source_evidence_id,source_evidence_version,source_evidence_digest,source_evidence_captured_at,work_plan_id,work_plan_version,work_plan_digest,work_plan_generated_at,aggregate_version,status,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'kitchen.confirmed-order:v1',1,$7,$8,$9,$10,$11,$12,$13,1,$14,$10,$16,1,$17,$15,1,'Open','System','System',$15,$15)",
            [
              refs.ticket,
              brand,
              store,
              order.order,
              refs.batch,
              refs.confirmation,
              refs.confirmedEvent,
              version,
              hash(["snapshot", b]),
              acceptedAt,
              refs.correlation,
              hash(["binding", b]),
              id(b + 97),
              hash(["evidence", b]),
              kitchenAt,
              id(b + 98),
              hash(["plan", b]),
            ],
          );
          for (const [j, workItem] of refs.workItems.entries())
            await admin.query(
              "INSERT INTO rms_kitchen.kitchen_work_item (kitchen_work_item_id,brand_id,store_id,kitchen_ticket_id,order_id,order_batch_id,order_item_id,source_evidence_id,work_plan_id,source_item_ordinal,split_ordinal,version,status,required_quantity,completed_quantity,product_id,product_version_id,sku_id,menu_version_id,localized_display_names_json,selected_options_json,source_line_digest,station_id,routing_rule_id,routing_rule_version,routing_rule_digest,preparation_id,preparation_version,preparation_digest,preparation_instructions_json,execution_snapshot_digest,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,1,'Queued',1,0,$11,$12,$13,$14,$15::jsonb,'[]'::jsonb,$16,$17,$18,1,$19,$20,1,$21,$22::jsonb,$23,'System','System',$24,$24)",
              [
                workItem,
                brand,
                store,
                refs.ticket,
                order.order,
                refs.batch,
                refs.items[j],
                id(b + 97),
                id(b + 98),
                j + 1,
                id(700),
                id(701),
                id(702),
                id(703),
                JSON.stringify({ "en-CA": "Synthetic item " + (j + 1) }),
                hash(["line", b, j]),
                id(704),
                id(705),
                hash(["routing", b]),
                id(706),
                hash(["preparation-step", b]),
                JSON.stringify(["Synthetic preparation"]),
                hash(["execution", b, j]),
                kitchenAt,
              ],
            );
          order.batches.push(refs);
        }
        order.version = version;
        return order;
      }

      /** The kitchen's own lifecycle owner path (KDS): accept and start one work item. */
      function kitchen(order, k = 0, { beforeCommit = null } = {}) {
        const refs = order.batches[k];
        let active = null;
        const now = () => new Date().toISOString();
        const references = {
          next: fresh,
          derive(purpose, identity) {
            const digest = createHash("sha256")
              .update(purpose + identity)
              .digest("hex");
            return (
              "0190abcd-" +
              digest.slice(0, 4) +
              "-7" +
              digest.slice(4, 7) +
              "-8" +
              digest.slice(7, 10) +
              "-" +
              digest.slice(10, 22)
            );
          },
        };
        const runner = transactions({ beforeCommit });
        const repository = createPostgresKitchenWorkLifecycleStore({
          brandReference: brand,
          storeReference: store,
          references,
          digests: { sha256: sha },
          authorize: async () => true,
          validateCurrentSource: async () => true,
        });
        const service = createKitchenWorkLifecycleService({
          trustedContext: {
            resolveAuthority: async () => ({
              actorReference: active.actorReference,
              brandReference: brand,
              storeReference: store,
              observedAt: now(),
            }),
          },
          correlationContext: { resolve: async () => ({ correlationReference: refs.correlation }) },
          authorization: { authorize: async () => true },
          transactions: { withTransaction: (work) => runner.run(work) },
          tenantContext: { install: async () => undefined },
          idempotency: {
            acquireFence: async ({ transaction, idempotencyKey }) => {
              await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
                brand + ":" + store + ":" + idempotencyKey,
              ]);
            },
          },
          repository,
          references,
          digests: { sha256: sha },
          clock: { now },
          admission: {
            resolve: async ({ command, acceptedOperationReference }) => ({
              decisionReference: fresh(),
              decisionVersion: 1,
              decisionDigest: sha("synthetic admission"),
              producerContractVersion: 1,
              actorReference: command.actorReference,
              brandReference: brand,
              storeReference: store,
              ticketReference: command.ticketReference,
              workItemReference: command.workItemReference,
              acceptedOperationReference,
              ticketVersion: BigInt(command.expectedTicketVersion),
              workItemVersion: BigInt(command.expectedWorkItemVersion),
              action: "StartKitchenWorkItem",
              purpose: "KitchenWorkExecution",
              outcome: "Allowed",
              evaluatedAt: now(),
              validUntil: new Date(Date.now() + minutes(60)).toISOString(),
            }),
          },
          expo: {
            resolve: async () => ({
              decisionReference: fresh(),
              decisionVersion: 1,
              decisionDigest: sha("synthetic Expo"),
              producerContractVersion: 1,
              brandReference: brand,
              storeReference: store,
              purpose: "KitchenReadiness",
              mode: "Disabled",
              evaluatedAt: now(),
              validUntil: new Date(Date.now() + minutes(60)).toISOString(),
            }),
          },
        });
        async function command(action, j) {
          const versions = (
            await admin.query(
              "SELECT t.aggregate_version::text AS ticket,w.version::text AS item FROM rms_kitchen.kitchen_ticket t JOIN rms_kitchen.kitchen_work_item w ON w.kitchen_ticket_id=t.kitchen_ticket_id WHERE w.kitchen_work_item_id=$1",
              [refs.workItems[j]],
            )
          ).rows[0];
          active = {
            action,
            idempotencyKey: "staff-cancel-" + refs.workItems[j] + "-" + action,
            actorReference: cook,
            brandReference: brand,
            storeReference: store,
            ticketReference: refs.ticket,
            workItemReference: refs.workItems[j],
            orderItemReference: refs.items[j],
            expectedTicketVersion: versions.ticket,
            expectedWorkItemVersion: versions.item,
            correlationReference: refs.correlation,
          };
          return service.execute(active);
        }
        return {
          accept: (j) => command("AcceptKitchenWorkItem", j),
          start: (j) => command("StartKitchenWorkItem", j),
        };
      }

      // The staff command, composed exactly as the merchant API composes it.
      merchant.tenant = tenant;
      merchant.brand = brand;
      merchant.store = store;
      merchant.actor = staff;
      merchant.allowed = () => true;
      function staffCancellation({ beforeCommit = null } = {}) {
        return createMerchantOrderStaffCancellation({
          persistence: {
            transactions: transactions({ guc: false, beforeCommit }),
            now: () => new Date(Math.floor(Date.now())).toISOString(),
          },
          authentication: { authorize: async () => ({ sessionReference: id(12) }) },
          installContext: async (tx, selected) => {
            await tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [selected.tenantReference, selected.brandReference, selected.storeReference],
            );
          },
          nextReference: fresh,
          resolveRefundConfiguration: async () => ({
            providerAccountReference: provider,
            environment: "Test",
          }),
        });
      }
      const cancel = (order, k, overrides = {}, options = {}) =>
        staffCancellation(options)({
          sessionCookie: "synthetic-session",
          csrf: "synthetic-csrf",
          command: {
            orderReference: order.order,
            orderBatchReference: order.batches[k].batch,
            expectedOrderVersion: order.version,
            operationReference: fresh(),
            reasonCode: "SOLD_OUT",
            ...overrides,
          },
        });
      /** Wait until another connection is blocked on a row or advisory lock. */
      async function blocked() {
        for (let attempt = 0; attempt < 200; attempt++) {
          const waiting = (
            await admin.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
            )
          ).rows[0].n;
          if (waiting > 0) return;
          await delay(25);
        }
        throw new Error("expected a blocked transaction");
      }

      const pickup = await seedOrder(1000, { batches: [2], quantity: "2" });
      const started = await seedOrder(2000, { batches: [2], quantity: "1" });
      const raceStart = await seedOrder(3000, { batches: [1], quantity: "1" });
      const raceCancel = await seedOrder(4000, { batches: [1], quantity: "1" });
      // WP-2423 Q7: counter pickup Orders paid on the Store's card machine; one expired unaccepted.
      const counter = await seedOrder(6000, { batches: [1], quantity: "1", cardMachine: true });
      const expired = await seedOrder(7000, {
        batches: [1],
        quantity: "1",
        cardMachine: true,
        unfulfillable: true,
      });
      // DEC-TABLE-CLOSE-GUESTS-LEFT (scenario at the end): rounds paid, never accepted.
      const leftCard = await seedOrder(9000, {
        type: "DineIn",
        batches: [1],
        quantity: "1",
        cardMachine: true,
        awaiting: true,
      });
      // TEST-ONLY fixture: the machine payment was already refunded in full on the machine.
      await admin.query(
        "INSERT INTO rms_payment.card_machine_refund (tenant_id,brand_id,store_id,card_machine_refund_id,card_machine_payment_id,order_id,operation_id,intent_digest,source_kind,source_id,amount_minor,currency_code,slip_reference,refunded_at,recorded_at,actor_id,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'UnfulfillableOrder',$9,$10,'CAD',NULL,$11,$11,$12,$13)",
        [
          tenant,
          brand,
          store,
          id(9901),
          leftCard.batches[0].transaction,
          leftCard.order,
          id(9902),
          hash(["fixture-refund"]),
          id(9903),
          leftCard.batches[0].totalMinor,
          time(-minutes(5)),
          staff,
          id(9904),
        ],
      );
      const waitingPickup = await seedOrder(11000, { batches: [1], quantity: "1", awaiting: true });
      // v15 DEMO-02 round 16: an accepted round paid on the card machine, refunded there in full.
      const acceptedCard = await seedOrder(13000, {
        type: "DineIn",
        batches: [1],
        quantity: "1",
        cardMachine: true,
      });
      // TEST-ONLY fixture: the machine payment was refunded in full on the machine already.
      await admin.query(
        "INSERT INTO rms_payment.card_machine_refund (tenant_id,brand_id,store_id,card_machine_refund_id,card_machine_payment_id,order_id,operation_id,intent_digest,source_kind,source_id,amount_minor,currency_code,slip_reference,refunded_at,recorded_at,actor_id,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'UnfulfillableOrder',$9,$10,'CAD',NULL,$11,$11,$12,$13)",
        [
          tenant,
          brand,
          store,
          id(13901),
          acceptedCard.batches[0].transaction,
          acceptedCard.order,
          id(13902),
          hash(["fixture-refund", 13000]),
          id(13903),
          acceptedCard.batches[0].totalMinor,
          time(-minutes(5)),
          staff,
          id(13904),
        ],
      );
      // v15 DEMO-02 round 6: a multi-unit round holds several reservations on one stock account;
      // whole-round cancellation must release all of them in one transaction.
      const dineIn = await seedOrder(5000, {
        type: "DineIn",
        batches: [1, 2],
        quantity: "1.5",
        lineParts: { 1: ["0.5", "1"] },
      });
      const left = await seedOrder(8000, {
        type: "DineIn",
        batches: [1, 1],
        quantity: "1",
        awaiting: true,
        shift: minutes(15),
      });
      // ── WP-2423 (2026-10-16 v15 stock leak): Orders of earlier business days still holding
      // stock are found from Inventory's reservations, as the api role, the next business day.
      // TEST-ONLY legacy fixture: an Order that ended (System termination written by the database
      // owner) while its stock stayed reserved — the v15 orders that ended before consumption.
      // After the last seeded round (stock ledger movements stay in time order).
      const legacy = await seedOrder(15000, { batches: [1], quantity: "1", shift: minutes(26) });
      await admin.query(
        "INSERT INTO rms_ordering.order_termination_record (termination_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,terminated_order_version,expected_source_checkpoint,previous_phase,phase,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,terminated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Accepted','Cancelled','System',NULL,'SyntheticLegacy','order.synthetic','SYNTHETIC_TEST',$10,$11,$12,$13)",
        [
          id(15901),
          id(15902),
          brand,
          store,
          legacy.order,
          legacy.batches[0].batch,
          legacy.version,
          legacy.version + 1,
          legacy.batches[0].submission,
          id(15903),
          id(15904),
          hash(["legacy-termination"]),
          time(-minutes(5)),
        ],
      );
      assert.deepEqual(await stock(), { onHand: "20", reserved: "16" });
      const nextDay = new Date(Date.parse(businessDate + "T12:00:00.000Z") + minutes(24 * 60))
        .toISOString()
        .slice(0, 10);
      const tomorrow = () => ({
        businessDate: nextDay,
        startsAt: new Date(Date.now() + minutes(1)).toISOString(),
      });
      const holding = async () =>
        new Map(
          // The Orders read passes its authorized scope, which also carries the Session (v15
          // 2026-10-16: an exact three-key Inventory scope check emptied the list).
          (
            await scoped((tx) =>
              readEarlierOrdersHoldingStock(
                tx,
                { ...scope, sessionReference: "01a10000-0000-7000-8000-000000000001" },
                tomorrow(),
              ),
            )
          ).map((entry) => [entry.orderBatchReference, entry]),
        );
      let held = await holding();
      assert.equal(held.get(pickup.batches[0].batch)?.state, "Open");
      assert.equal(held.get(pickup.batches[0].batch)?.productionStarted, false);
      assert.equal(held.get(legacy.batches[0].batch)?.state, "Ended");
      assert.equal(held.get(legacy.batches[0].batch)?.orderNumber, "15");
      // Today (its own business day) nothing is "from an earlier day".
      assert.equal(
        (
          await scoped((tx) =>
            readEarlierOrdersHoldingStock(tx, scope, {
              businessDate,
              startsAt: time(-minutes(60)),
            }),
          )
        ).length,
        0,
      );
      const stockRelease = createMerchantEndedOrderStockRelease({
        persistence: {
          transactions: transactions({ guc: false }),
          now: () => new Date(Math.floor(Date.now())).toISOString(),
        },
        authentication: { authorize: async () => ({ sessionReference: id(12) }) },
        installContext: async (tx, selected) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [selected.tenantReference, selected.brandReference, selected.storeReference],
          );
        },
        today: async () => tomorrow(),
        nextReference: fresh,
      });
      const releaseStock = (order, operationReference = fresh()) =>
        stockRelease({
          sessionCookie: "synthetic-session",
          csrf: "synthetic-csrf",
          command: {
            orderReference: order.order,
            orderBatchReference: order.batches[0].batch,
            operationReference,
          },
        });
      let heldCounts = await counts();
      // A live Order is never released here (staff cancel it, which refunds the guest).
      await assert.rejects(releaseStock(pickup), { code: "ENDED_ORDER_STOCK_NOT_RELEASABLE" });
      merchant.allowed = () => false;
      await assert.rejects(releaseStock(legacy), { code: "ENDED_ORDER_STOCK_PERMISSION_DENIED" });
      merchant.allowed = () => true;
      assert.deepEqual(await counts(), heldCounts);
      const releaseOperation = fresh();
      assert.deepEqual(await releaseStock(legacy, releaseOperation), {
        status: "Released",
        entryCount: 1,
      });
      assert.deepEqual(await stock(), { onHand: "20", reserved: "15" });
      const releaseAudit = (
        await admin.query(
          "SELECT action_code,actor_type,actor_reference AS actor,reason_code,target_id::text AS target FROM platform_audit.audit_record WHERE audit_id=$1",
          [releaseOperation],
        )
      ).rows;
      assert.equal(releaseAudit.length, 1);
      assert.equal(releaseAudit[0].action_code, "ENDED_ORDER_STOCK_RELEASED");
      assert.equal(releaseAudit[0].reason_code, "ORDER_ENDED_STOCK_LEFT");
      assert.equal(releaseAudit[0].target, legacy.order);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='INVENTORY_RESERVATION_RELEASE' AND reason_code='ORDER_ENDED_STOCK_LEFT'",
          )
        ).rows[0].n,
        1,
      );
      // Replay of the same staff request: nothing written again.
      heldCounts = await counts();
      assert.equal((await releaseStock(legacy, releaseOperation)).status, "AlreadyReleased");
      assert.deepEqual(await counts(), heldCounts);
      held = await holding();
      assert.equal(held.has(legacy.batches[0].batch), false);
      assert.equal(held.get(pickup.batches[0].batch)?.state, "Open");
      assert.deepEqual(await stock(), { onHand: "20", reserved: "15" });

      // The kitchen accepted the first item of the pickup Order (still Queued, not started).
      assert.equal((await kitchen(pickup).accept(0)).outcome, "Accepted");
      assert.deepEqual(await itemStatuses(pickup.batches[0].ticket), ["Queued", "Queued"]);

      // ── Authority: a withdrawn permission, another Store's selection, or permission lost
      // during the command writes nothing.
      let before = await counts();
      merchant.allowed = () => false;
      await assert.rejects(cancel(pickup, 0), { code: "ORDER_CANCELLATION_PERMISSION_DENIED" });
      // WP-2423: allowed when resolved at the start, withdrawn before the commit: the whole
      // cancellation (kitchen, Ordering, stock) rolls back.
      let calls = 0;
      merchant.allowed = () => ++calls <= 1;
      await assert.rejects(cancel(pickup, 0), { code: "ORDER_CANCELLATION_PERMISSION_DENIED" });
      assert.equal(calls, 2);
      merchant.allowed = () => true;
      merchant.store = otherStore;
      await assert.rejects(cancel(pickup, 0), { code: "ORDER_CANCELLATION_NOT_FOUND" });
      merchant.store = store;
      assert.deepEqual(await counts(), before);
      assert.ok(merchant.actions.every((action) => action === "ordering.order.cancel"));
      // A stale order version is refused before anything is written.
      await assert.rejects(cancel(pickup, 0, { expectedOrderVersion: pickup.version - 1 }), {
        code: "ORDER_CANCELLATION_VERSION_CONFLICT",
      });
      assert.deepEqual(await counts(), before);

      // ── Scenario 1: paid, accepted, Confirmed pickup Order with two queued kitchen items.
      const operationReference = fresh();
      // WP-2423 resolution budget: the staff member is resolved in full (the double's `allowed`,
      // ~30 statements on the real scope) once at the start and once before the commit; before,
      // every Ordering, Kitchen, Payment and Inventory owner check resolved them again.
      const resolutions = () => {
        let n = 0;
        merchant.allowed = () => (++n, true);
        return () => n;
      };
      const cancelResolutions = resolutions();
      const cancelled = await cancel(pickup, 0, { operationReference });
      assert.equal(cancelResolutions(), 2);
      merchant.allowed = () => true;
      assert.equal(cancelled.status, "Cancelled");
      assert.equal(cancelled.refundStatus, "Pending");
      assert.equal(cancelled.orderReference, pickup.order);
      assert.equal(cancelled.orderBatchReference, pickup.batches[0].batch);
      let after = await counts();
      assert.deepEqual(after, {
        ...before,
        staff: before.staff + 1,
        terminations: before.terminations + 1,
        revisions: before.revisions + 1,
        kitchen: before.kitchen + 2,
        events: before.events + 1,
        reservations: before.reservations + 1,
        movements: before.movements + 1,
        audits: after.audits,
      });
      const staffRow = (
        await admin.query(
          "SELECT cancellation_id::text AS id,operation_id::text AS operation,order_type,expected_order_version,cancelled_order_version,previous_phase,actor_id::text AS actor,permission_code,reason_code,payment_disposition_id::text AS disposition,payment_transaction_id::text AS transaction,payment_event_id::text AS event,order_item_ids::text[] AS items,cancelled_at FROM rms_ordering.order_staff_cancellation WHERE order_id=$1",
          [pickup.order],
        )
      ).rows;
      assert.equal(staffRow.length, 1);
      assert.deepEqual(
        { ...staffRow[0], id: undefined, cancelled_at: undefined },
        {
          id: undefined,
          operation: operationReference,
          order_type: "Pickup",
          expected_order_version: 2,
          cancelled_order_version: 3,
          previous_phase: "Accepted",
          actor: staff,
          permission_code: "ordering.order.cancel",
          reason_code: "SOLD_OUT",
          disposition: pickup.batches[0].disposition,
          transaction: pickup.batches[0].transaction,
          event: pickup.batches[0].event,
          items: [...pickup.batches[0].items].sort(),
          cancelled_at: undefined,
        },
      );
      assert.equal(staffRow[0].cancelled_at.toISOString(), cancelled.cancelledAt);
      const termination = (
        await admin.query(
          "SELECT termination_id::text AS id,previous_phase,phase,actor_type,actor_id::text AS actor,reason_code,purpose_code,permission_code,expected_order_version,terminated_order_version FROM rms_ordering.order_termination_record WHERE order_id=$1",
          [pickup.order],
        )
      ).rows;
      assert.deepEqual(termination, [
        {
          id: staffRow[0].id,
          previous_phase: "Accepted",
          phase: "Cancelled",
          actor_type: "User",
          actor: staff,
          reason_code: "SOLD_OUT",
          purpose_code: "StaffOrderCancellation",
          permission_code: "ordering.order.cancel",
          expected_order_version: 2,
          terminated_order_version: 3,
        },
      ]);
      const revision = (
        await admin.query(
          "SELECT revision_id::text AS id,kind,version FROM rms_ordering.order_revision WHERE order_id=$1 ORDER BY version DESC LIMIT 1",
          [pickup.order],
        )
      ).rows[0];
      assert.deepEqual(revision, { id: staffRow[0].id, kind: "Termination", version: 3 });
      const audits = async (since) =>
        (
          await admin.query(
            "SELECT action_code,actor_type,actor_reference::text AS actor FROM platform_audit.audit_record WHERE occurred_at>=$1 ORDER BY action_code",
            [since],
          )
        ).rows;
      const commandAudits = await audits(cancelled.cancelledAt);
      for (const action of [
        "ORDER_CANCELLED_BY_STAFF",
        "ORDER_TERMINATED",
        "KITCHEN_WORK_CANCELLED",
        "INVENTORY_RESERVATION_RELEASE",
      ])
        assert.equal(
          commandAudits.filter((row) => row.action_code === action).length,
          1,
          action + " audit",
        );
      assert.equal(after.audits, before.audits + commandAudits.length);
      for (const row of commandAudits.filter(
        (row) => row.action_code !== "INVENTORY_RESERVATION_RELEASE",
      ))
        assert.deepEqual([row.actor_type, row.actor], ["User", staff], row.action_code);
      assert.deepEqual(await itemStatuses(pickup.batches[0].ticket), ["Cancelled", "Cancelled"]);
      const kitchenRows = (
        await admin.query(
          "SELECT before_status,actor_id::text AS actor,reason_code,order_cancellation_id::text AS cancellation FROM rms_kitchen.kitchen_work_cancellation WHERE kitchen_ticket_id=$1 ORDER BY kitchen_work_item_id",
          [pickup.batches[0].ticket],
        )
      ).rows;
      assert.deepEqual(
        kitchenRows,
        ["Queued", "Queued"].map((status) => ({
          before_status: status,
          actor: staff,
          reason_code: "ORDER_CANCELLED_BEFORE_PREPARATION",
          cancellation: staffRow[0].id,
        })),
      );
      const event = (
        await admin.query(
          "SELECT aggregate_type,aggregate_id::text AS aggregate,producer_module FROM platform_eventing.outbox_event WHERE event_type='KitchenWorkCancelled'",
        )
      ).rows;
      assert.deepEqual(event, [
        {
          aggregate_type: "KitchenTicket",
          aggregate: pickup.batches[0].ticket,
          producer_module: "@rms/kitchen",
        },
      ]);
      const releases = (
        await admin.query(
          "SELECT record_json FROM rms_inventory.stock_movement WHERE movement_type='Release' AND record_json->>'reasonCode'<>'ORDER_ENDED_STOCK_LEFT'",
        )
      ).rows.map((row) => row.record_json);
      assert.equal(releases.length, 1);
      assert.equal(releases[0].performedBy, staff);
      assert.equal(releases[0].reasonCode, "STAFF_CANCELLED_BEFORE_PREPARATION");
      assert.deepEqual(await stock(), { onHand: "20", reserved: "13" });

      // Payment's compensation source: the CancelledByStaff disposition, discovered only by the
      // refund workload (includeStaffCancellations).
      const source = await scoped((tx) =>
        createPostgresStaffOrderCancellationReader({
          brandReference: brand,
          storeReference: store,
        }).loadCompensationByPaymentEvent({
          transaction: tx,
          paymentEventReference: pickup.batches[0].event,
        }),
      );
      assert.equal(source.disposition, "PaidWithoutFulfillableOrder");
      assert.equal(source.reason, "CancelledByStaff");
      assert.equal(source.kitchenReleaseDisposition, "Blocked");
      assert.equal(source.orderReference, pickup.order);
      assert.equal(source.orderBatchReference, pickup.batches[0].batch);
      assert.equal(source.paymentTransactionReference, pickup.batches[0].transaction);
      assert.equal(source.paymentIntentReference, pickup.batches[0].intent);
      assert.equal(source.paymentAttemptReference, pickup.batches[0].attempt);
      assert.equal(source.paymentEventReference, pickup.batches[0].event);
      assert.equal(source.dispositionReference, staffRow[0].id);
      // The pilot refund workload discovers through the same filter: payments taken on the
      // Store's card machine (the expired counter Order seeded above) are never Provider refunds.
      const discover = (includeStaffCancellations) =>
        scoped(async (tx) =>
          withoutCardMachinePayments(
            tx,
            { brandReference: brand, storeReference: store },
            await createPostgresOrderCompensationCandidateReader({
              scope: { brandReference: brand, storeReference: store },
              includeStaffCancellations,
              authorize: async (_tx, input) =>
                input.purpose === "DiscoverPaidWithoutFulfillableOrder",
            })(tx, { afterDispositionReference: null, limit: 100 }),
            async () => true,
          ),
        );
      assert.deepEqual((await discover(true)).candidates, [source]);
      assert.deepEqual((await discover(false)).candidates, []);

      // ── Scenario 4: replay of the same command writes nothing; another cancellation of the
      // cancelled Order is refused.
      before = await counts();
      const replay = await cancel(pickup, 0, { operationReference });
      assert.deepEqual(replay, { ...cancelled, status: "AlreadyCancelled" });
      await assert.rejects(cancel(pickup, 0, { expectedOrderVersion: 3 }), {
        code: "ORDER_CANCELLATION_NOT_CANCELLABLE",
      });
      await assert.rejects(cancel(pickup, 0, { operationReference, reasonCode: "STORE_ERROR" }), {
        code: "ORDER_CANCELLATION_NOT_CANCELLABLE",
      });
      assert.deepEqual(await counts(), before);
      assert.deepEqual(await stock(), { onHand: "20", reserved: "13" });

      // ── Scenario 2: one item already started (In Progress): refused, nothing written.
      const startedKitchen = kitchen(started);
      assert.equal((await startedKitchen.accept(0)).outcome, "Accepted");
      assert.equal((await startedKitchen.start(0)).outcome, "Started");
      assert.deepEqual(await itemStatuses(started.batches[0].ticket), ["In Progress", "Queued"]);
      before = await counts();
      await assert.rejects(cancel(started, 0), { code: "ORDER_CANCELLATION_PREPARATION_STARTED" });
      assert.deepEqual(await counts(), before);
      assert.deepEqual(await itemStatuses(started.batches[0].ticket), ["In Progress", "Queued"]);
      assert.deepEqual(await stock(), { onHand: "20", reserved: "13" });

      // ── Scenario 3a: the kitchen starts first and holds its row locks; the cancellation waits,
      // then sees the started item and is refused.
      {
        const lane = kitchen(raceStart);
        assert.equal((await lane.accept(0)).outcome, "Accepted");
        let release, reached;
        const gate = new Promise((resolve) => (release = resolve));
        const holding = new Promise((resolve) => (reached = resolve));
        const racing = kitchen(raceStart, 0, {
          beforeCommit: () => {
            reached();
            return gate;
          },
        });
        const start = racing.start(0);
        await holding;
        const refused = cancel(raceStart, 0).then(
          () => "Cancelled",
          (error) => error.code,
        );
        await blocked();
        release();
        assert.equal((await start).outcome, "Started");
        assert.equal(await refused, "ORDER_CANCELLATION_PREPARATION_STARTED");
        assert.deepEqual(await itemStatuses(raceStart.batches[0].ticket), ["In Progress"]);
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM rms_ordering.order_staff_cancellation WHERE order_id=$1",
              [raceStart.order],
            )
          ).rows[0].n,
          0,
        );
      }
      // ── Scenario 3b: the cancellation holds the locks first; the kitchen's start waits, then
      // finds the item cancelled and is refused.
      {
        const lane = kitchen(raceCancel);
        assert.equal((await lane.accept(0)).outcome, "Accepted");
        let release, reached;
        const gate = new Promise((resolve) => (release = resolve));
        const holding = new Promise((resolve) => (reached = resolve));
        const winner = cancel(
          raceCancel,
          0,
          {},
          {
            beforeCommit: () => {
              reached();
              return gate;
            },
          },
        );
        await holding;
        const start = lane.start(0).then(
          (result) => result.outcome,
          () => "Refused",
        );
        await blocked();
        release();
        assert.equal((await winner).status, "Cancelled");
        assert.equal(await start, "Refused");
        assert.deepEqual(await itemStatuses(raceCancel.batches[0].ticket), ["Cancelled"]);
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM rms_kitchen.kitchen_work_lifecycle_operation WHERE kitchen_ticket_id=$1 AND action_code='KITCHEN_WORK_ITEM_STARTED'",
              [raceCancel.batches[0].ticket],
            )
          ).rows[0].n,
          0,
        );
      }
      assert.deepEqual(await stock(), { onHand: "20", reserved: "12" });

      // ── Scenario 6: dine-in Order with an initial and an additional Batch; staff cancel the
      // additional Batch only. The Order stays open; the first Batch is unaffected.
      before = await counts();
      const batchCancelled = await cancel(dineIn, 1, { reasonCode: "CUSTOMER_REQUEST" });
      assert.equal(batchCancelled.status, "Cancelled");
      after = await counts();
      assert.equal(after.staff, before.staff + 1);
      assert.equal(after.terminations, before.terminations);
      assert.equal(after.revisions, before.revisions + 1);
      assert.equal(after.kitchen, before.kitchen + 2);
      const dineRevision = (
        await admin.query(
          "SELECT r.kind,r.version,c.order_type,c.order_batch_id::text AS batch FROM rms_ordering.order_revision r JOIN rms_ordering.order_staff_cancellation c ON c.cancellation_id=r.revision_id WHERE r.order_id=$1",
          [dineIn.order],
        )
      ).rows;
      assert.deepEqual(dineRevision, [
        {
          kind: "StaffBatchCancellation",
          version: 5,
          order_type: "DineIn",
          batch: dineIn.batches[1].batch,
        },
      ]);
      assert.deepEqual(await itemStatuses(dineIn.batches[0].ticket), ["Queued"]);
      assert.deepEqual(await itemStatuses(dineIn.batches[1].ticket), ["Cancelled", "Cancelled"]);
      assert.deepEqual(await stock(), { onHand: "20", reserved: "10.5" });
      const diningState = await scoped((tx) =>
        createPostgresDiningOrderItemStateReader({
          brandReference: brand,
          storeReference: store,
          authorize: async () => true,
        }).load({
          transaction: tx,
          brandReference: brand,
          storeReference: store,
          orderReference: dineIn.order,
          diningSessionReference: dineIn.session,
          guestSessionReference: dineIn.guest,
          observedAt: new Date().toISOString(),
        }),
      );
      assert.equal(diningState.orderVersion, 5);
      const [first, second] = diningState.batches;
      assert.equal(first.orderBatchReference, dineIn.batches[0].batch);
      assert.equal(second.orderBatchReference, dineIn.batches[1].batch);
      assert.equal(first.staffCancellation ?? null, null);
      assert.notEqual(second.staffCancellation ?? null, null);
      // The remaining Batch can still be cancelled on its own at the new version.
      dineIn.version = 5;
      assert.equal((await cancel(dineIn, 0)).status, "Cancelled");
      assert.deepEqual(await itemStatuses(dineIn.batches[0].ticket), ["Cancelled"]);
      assert.deepEqual(await stock(), { onHand: "20", reserved: "9" });

      // ── Scenario 7: the refund workload opens one compensation case for the staff-cancelled
      // payment attempt and refunds the whole capture including tip, through Payment's runtime
      // (lease, retrieve before refund, a lost refund response resolved by query only). The
      // Provider is simulated (InternalTest); its refund response is lost after the effect.
      {
        vi.stubEnv("NODE_ENV", "development");
        vi.stubEnv("BOP_PILOT_ENVIRONMENT", undefined);
        try {
          const paid = pickup.batches[0];
          const captured = { amountMinor: BigInt(paid.totalMinor), currencyCode: "CAD" };
          const now = () => new Date().toISOString();
          let refunded = 0n,
            refundCalls = 0;
          const snapshot = (request) =>
            createPaymentProviderSnapshot({
              kind: "Snapshot",
              context: request.context,
              providerIntentReference: "pi_SYNTHETIC_" + 1100,
              providerTransactionReference: "ch_SYNTHETIC_" + 1100,
              paymentMethod: "OnlineCard",
              captureMode: "Automatic",
              status: "Captured",
              requestedAmount: captured,
              authorizedAmount: captured,
              capturedAmount: captured,
              refundedAmount: { amountMinor: refunded, currencyCode: "CAD" },
              observedAt: now(),
              evidenceDigest: sha("synthetic staff refund observation:" + refunded),
            });
          const identity = createInternalCompensationIdentity(source, now);
          const runtime = await createPaymentCompensationComposition({
            disposition: source,
            tenantReference: tenant,
            transactions: transactions(),
            scope: {
              brandReference: brand,
              storeReference: store,
              providerAccountReference: provider,
              environment: "Test",
            },
            clock: { now },
            references: identity.references,
            audit: identity.audit,
            provider: {
              retrieveIntent: async (request) => snapshot(request),
              refundPayment: async (request) => {
                assert.equal(request.amount.amountMinor, captured.amountMinor);
                refundCalls++;
                refunded = request.amount.amountMinor;
                throw new Error("synthetic refund response lost after effect");
              },
            },
            authorize: async () => true,
            otherRefunds: async () => ({ confirmedMinor: 0n, pendingMinor: 0n, version: 1 }),
            lease: { leaseDurationMs: 30000, newFenceReference: fresh },
            newObservationReference: fresh,
            operations: { authorize: async () => true, validateEvidence: async () => false },
            authorizeOperations: async () => false,
          });
          // The lost refund response is resolved by retrieving the Provider's state (no second refund).
          let outcome = await runtime.execute(source);
          if (outcome.status === "AwaitingProviderConfirmation")
            outcome = await runtime.execute(source);
          assert.equal(outcome.status, "AwaitingOperationsReconciliation");
          assert.equal((await runtime.execute(source)).status, "AwaitingOperationsReconciliation");
          assert.equal(refundCalls, 1);
          assert.equal(captured.amountMinor, 1380n); // 1200 order allocation + 180 tip
          const cases = (
            await admin.query(
              "SELECT DISTINCT case_id::text AS id FROM rms_payment.payment_compensation_case_history WHERE payment_attempt_id=$1",
              [paid.attempt],
            )
          ).rows;
          assert.deepEqual(cases, [{ id: identity.identities.case }]);
          const refund = (
            await admin.query(
              "SELECT record_json AS record FROM rms_payment.payment_compensation_refund WHERE payment_attempt_id=$1",
              [paid.attempt],
            )
          ).rows;
          assert.equal(refund.length, 1);
          assert.equal(String(refund[0].record.fact.amount.amountMinor), "1380");
          // The staff command's replay now reports the refund as completed.
          const settled = await cancel(pickup, 0, { operationReference });
          assert.equal(settled.status, "AlreadyCancelled");
          assert.equal(settled.refundStatus, "Refunded");
        } finally {
          vi.unstubAllEnvs();
        }
      }

      // ── WP-2423 Q7 (DEC-COUNTER-PAYMENT-RECORD decision 4): a counter Order paid on the Store's
      // own card machine is cancelled the same way; its refund is made on that machine and
      // recorded by staff, never sent to the Provider.
      const cardTotal = String(counter.batches[0].totalMinor);
      const cardCancelled = await cancel(counter, 0);
      assert.equal(cardCancelled.status, "Cancelled");
      assert.equal(cardCancelled.refundMethod, "CardMachine");
      assert.equal(cardCancelled.refundStatus, "Pending");
      assert.equal(cardCancelled.refundAmountMinor, cardTotal);
      // Ordering offers it to compensation like any staff cancellation; the refund workload's
      // discovery leaves the card-machine payment out (no Provider refund, no case).
      const cardSource = await scoped((tx) =>
        createPostgresStaffOrderCancellationReader({
          brandReference: brand,
          storeReference: store,
        }).loadCompensationByPaymentEvent({
          transaction: tx,
          paymentEventReference: counter.batches[0].event,
        }),
      );
      assert.equal(cardSource.paymentIntentReference, counter.batches[0].intent);
      const page = await scoped(async (tx) =>
        withoutCardMachinePayments(
          tx,
          { brandReference: brand, storeReference: store },
          await createPostgresOrderCompensationCandidateReader({
            scope: { brandReference: brand, storeReference: store },
            includeStaffCancellations: true,
            authorize: async (_tx, input) =>
              input.purpose === "DiscoverPaidWithoutFulfillableOrder",
          })(tx, { afterDispositionReference: null, limit: 100 }),
          async () => true,
        ),
      );
      assert.equal(
        page.candidates.some((candidate) =>
          [counter.batches[0].intent, expired.batches[0].intent].includes(
            candidate.paymentIntentReference,
          ),
        ),
        false,
      );
      const refundOnMachine = createMerchantCardMachineCancellationRefund({
        persistence: {
          transactions: transactions({ guc: false }),
          now: () => new Date(Math.floor(Date.now())).toISOString(),
        },
        authentication: { authorize: async () => ({ sessionReference: id(12) }) },
        nextReference: fresh,
      });
      const refundOperation = fresh();
      const refundInput = (overrides = {}) => ({
        sessionCookie: "synthetic-session",
        csrf: "synthetic-csrf",
        command: {
          operationReference: refundOperation,
          orderReference: counter.order,
          orderBatchReference: counter.batches[0].batch,
          slipReference: "REFUND 7731",
          refundedAt: null,
          ...overrides,
        },
      });
      merchant.allowed = () => false;
      await assert.rejects(refundOnMachine(refundInput()), {
        code: "CARD_MACHINE_REFUND_PERMISSION_DENIED",
      });
      merchant.allowed = () => true;
      await assert.rejects(refundOnMachine(refundInput({ slipReference: "1234567890123456" })), {
        code: "CARD_MACHINE_REFUND_INPUT_INVALID",
      });
      // Only a cancelled card-machine Batch is refunded here (the Stripe-paid pickup is not).
      await assert.rejects(
        refundOnMachine(
          refundInput({
            operationReference: fresh(),
            orderReference: pickup.order,
            orderBatchReference: pickup.batches[0].batch,
          }),
        ),
        { code: "CARD_MACHINE_REFUND_NOT_FOUND" },
      );
      let refundResolutions = 0;
      merchant.allowed = () => (++refundResolutions, true);
      const machineRefund = await refundOnMachine(refundInput());
      assert.equal(refundResolutions, 2);
      merchant.allowed = () => true;
      assert.equal(machineRefund.status, "Recorded");
      assert.equal(machineRefund.amountMinor, cardTotal);
      assert.equal((await refundOnMachine(refundInput())).status, "AlreadyRecorded");
      await assert.rejects(refundOnMachine(refundInput({ operationReference: fresh() })), {
        code: "CARD_MACHINE_REFUND_NOTHING_OWED",
      });
      const cardReplay = await cancel(counter, 0, {
        operationReference: (
          await admin.query(
            "SELECT operation_id::text AS op FROM rms_ordering.order_staff_cancellation WHERE order_id=$1",
            [counter.order],
          )
        ).rows[0].op,
      });
      assert.equal(cardReplay.status, "AlreadyCancelled");
      assert.equal(cardReplay.refundStatus, "Refunded");
      assert.equal(cardReplay.refundMethod, "CardMachine");
      assert.equal(cardReplay.refundAmountMinor, cardTotal);
      const machineDay = await scoped((tx) =>
        createPostgresCardMachinePaymentStore({
          scope: { tenantReference: tenant, brandReference: brand, storeReference: store },
          authorize: async () => true,
        }).summarize(tx, {
          from: time(-minutes(120)),
          to: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      // Includes the table rounds paid on the machine and refunded there (fixtures).
      assert.equal(machineDay.paymentCount, 4);
      assert.equal(
        machineDay.takenMinor,
        BigInt(cardTotal) +
          BigInt(expired.batches[0].totalMinor) +
          BigInt(leftCard.batches[0].totalMinor) +
          BigInt(acceptedCard.batches[0].totalMinor),
      );
      assert.equal(machineDay.refundCount, 3);
      assert.equal(
        machineDay.refundedMinor,
        BigInt(cardTotal) +
          BigInt(leftCard.batches[0].totalMinor) +
          BigInt(acceptedCard.batches[0].totalMinor),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='PAYMENT_CARD_MACHINE_REFUND_RECORDED'",
          )
        ).rows[0].n,
        1,
      );
      // A paid counter Order that expired before it was accepted is owed in full too.
      const expiredRefund = await refundOnMachine(
        refundInput({
          operationReference: fresh(),
          orderReference: expired.order,
          orderBatchReference: expired.batches[0].batch,
          slipReference: null,
        }),
      );
      assert.equal(expiredRefund.status, "Recorded");
      assert.equal(expiredRefund.amountMinor, String(expired.batches[0].totalMinor));
      assert.equal(
        (
          await admin.query(
            "SELECT source_kind FROM rms_payment.card_machine_refund WHERE order_id=$1",
            [expired.order],
          )
        ).rows[0].source_kind,
        "UnfulfillableOrder",
      );
      await assert.rejects(
        refundOnMachine(
          refundInput({
            operationReference: fresh(),
            orderReference: expired.order,
            orderBatchReference: expired.batches[0].batch,
          }),
        ),
        { code: "CARD_MACHINE_REFUND_NOTHING_OWED" },
      );
      await scoped(async (tx) => {
        await assert.rejects(tx.query("DELETE FROM rms_payment.card_machine_refund", []));
      });

      // ── DEC-TABLE-CLOSE-GUESTS-LEFT: a manager closing a table whose guests left cancels the
      // rounds they paid for that were never accepted (never reached the kitchen), with the reason
      // GUEST_LEFT. Online: Payment refunds the whole payment (compensation candidate). Already
      // refunded in full (here a card-machine refund recorded as fixture): closed, nothing owed, no
      // compensation. The waiting payment is settled; the round can never be accepted afterwards.
      // What the close dialog shows before confirming: both rounds paid online, never sent to the
      // kitchen, each refunding its whole payment (tip included).
      const closePlan = (order) =>
        createMerchantDiningTableClosePlan({
          persistence: {
            transactions: transactions({ guc: false }),
            now: () => new Date(Math.floor(Date.now())).toISOString(),
          },
          authentication: { authorize: async () => ({ sessionReference: id(12) }) },
          resolveRefundConfiguration: async () => ({
            providerAccountReference: provider,
            environment: "Test",
          }),
        })({
          sessionCookie: "synthetic-session",
          csrf: "synthetic-csrf",
          query: { orderReference: order.order, diningSessionReference: order.session },
        });
      const planBefore = await closePlan(left);
      assert.equal(planBefore.orderVersion, 2);
      assert.deepEqual(
        planBefore.rounds.map((round) => [round.sequence, round.state, round.refund]),
        [
          [1, "PaidNotSent", { method: "Online", amountMinor: String(left.batches[0].totalMinor) }],
          [2, "PaidNotSent", { method: "Online", amountMinor: String(left.batches[1].totalMinor) }],
        ],
      );
      assert.deepEqual(planBefore.totals, {
        onlineMinor: String(left.batches[0].totalMinor + left.batches[1].totalMinor),
        cardMachineMinor: "0",
      });
      // The card round already refunded on the machine: closing it refunds nothing more.
      assert.deepEqual(
        (await closePlan(leftCard)).rounds.map((round) => [round.state, round.refund]),
        [["AlreadyRefunded", { method: "CardMachine", amountMinor: "0" }]],
      );
      const stockBeforeLeft = await stock();
      before = await counts();
      // A second round of the same table (first round still waiting) at the Order's version.
      const leftOnline = await cancel(left, 1, { reasonCode: "GUEST_LEFT" });
      assert.equal(leftOnline.status, "Cancelled");
      assert.equal(leftOnline.refundMethod, "Online");
      assert.equal(leftOnline.refundStatus, "Pending");
      const leftRow = (
        await admin.query(
          "SELECT cancellation_id::text AS id,previous_phase,refund_disposition,reason_code,payment_disposition_id::text AS disposition,expected_order_version,cancelled_order_version FROM rms_ordering.order_staff_cancellation WHERE order_batch_id=$1",
          [left.batches[1].batch],
        )
      ).rows;
      assert.deepEqual(
        leftRow.map((row) => ({ ...row, id: undefined })),
        [
          {
            id: undefined,
            previous_phase: "Submitted",
            refund_disposition: "Refund",
            reason_code: "GUEST_LEFT",
            disposition: left.batches[1].disposition,
            expected_order_version: 2,
            cancelled_order_version: 3,
          },
        ],
      );
      after = await counts();
      assert.equal(after.staff, before.staff + 1);
      assert.equal(after.revisions, before.revisions + 1);
      assert.equal(after.kitchen, before.kitchen, "no kitchen work existed for the round");
      assert.equal(after.reservations, before.reservations + 1);
      // The round's reserved stock is released.
      assert.equal(
        Number((await stock()).reserved),
        Number(stockBeforeLeft.reserved) - 1,
        "reserved stock of the cancelled round returns",
      );
      // Ordering now reads the round Cancelled without any acceptance.
      const leftState = await scoped((tx) =>
        createPostgresDiningOrderItemStateReader({
          brandReference: brand,
          storeReference: store,
          authorize: async () => true,
        }).load({
          transaction: tx,
          brandReference: brand,
          storeReference: store,
          orderReference: left.order,
          diningSessionReference: left.session,
          guestSessionReference: left.guest,
          observedAt: new Date().toISOString(),
        }),
      );
      const leftBatch = leftState.batches.find(
        (entry) => entry.orderBatchReference === left.batches[1].batch,
      );
      assert.equal(leftBatch.acceptance, null);
      assert.equal(leftBatch.staffCancellation.previousPhase, "Submitted");
      // The cancelled round no longer waits for acceptance (Orders stops offering Accept); the
      // other round of the table still does.
      const waiting = await scoped((tx) =>
        listStorePaidOrderBatches(tx, { brandReference: brand, storeReference: store }, [
          left.order,
        ]),
      );
      assert.equal(waiting.awaitingAcceptance.has(left.batches[1].batch), false);
      assert.equal(waiting.awaitingAcceptance.has(left.batches[0].batch), true);
      // Payment refunds it in full: the staff cancellation is a compensation candidate.
      const leftDiscover = await scoped(async (tx) =>
        withoutCardMachinePayments(
          tx,
          { brandReference: brand, storeReference: store },
          await createPostgresOrderCompensationCandidateReader({
            scope: { brandReference: brand, storeReference: store },
            includeStaffCancellations: true,
            authorize: async (_tx, input) =>
              input.purpose === "DiscoverPaidWithoutFulfillableOrder",
          })(tx, { afterDispositionReference: null, limit: 100 }),
          async () => true,
        ),
      );
      assert.ok(
        leftDiscover.candidates.some(
          (candidate) =>
            candidate.dispositionReference === leftRow[0].id &&
            candidate.reason === "CancelledByStaff" &&
            candidate.paymentIntentReference === left.batches[1].intent,
        ),
      );
      // The cancelled round can never be accepted afterwards (Ordering's guard).
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_ordering.order_acceptance_record (acceptance_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,accepted_order_version,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,accepted_at) VALUES ($1,$2,$3,$4,$5,$6,3,4,'User',$7,'OrderAcceptance','order.accept','SYNTHETIC_TEST',$8,$9,$10,now())",
          [
            id(9910),
            id(9911),
            brand,
            store,
            left.order,
            left.batches[1].batch,
            staff,
            id(9912),
            id(9913),
            hash(["late-accept"]),
          ],
        ),
      );
      // The remaining first round (the Order's version moved) and the already refunded card round.
      const leftFirst = await cancel(left, 0, {
        reasonCode: "GUEST_LEFT",
        expectedOrderVersion: 3,
      });
      assert.equal(leftFirst.status, "Cancelled");
      const leftCardResult = await cancel(leftCard, 0, {
        reasonCode: "GUEST_LEFT",
        expectedOrderVersion: 1,
      });
      assert.equal(leftCardResult.status, "Cancelled");
      assert.equal(leftCardResult.refundMethod, "CardMachine");
      assert.equal(leftCardResult.refundStatus, "Refunded");
      const cardLeftRow = (
        await admin.query(
          "SELECT cancellation_id::text AS id,previous_phase,refund_disposition,expected_order_version FROM rms_ordering.order_staff_cancellation WHERE order_batch_id=$1",
          [leftCard.batches[0].batch],
        )
      ).rows[0];
      assert.deepEqual(
        { ...cardLeftRow, id: undefined },
        {
          id: undefined,
          previous_phase: "Submitted",
          refund_disposition: "AlreadyRefunded",
          expected_order_version: 1,
        },
      );
      // Nothing more is owed: no compensation candidate, and the card machine owes nothing.
      const cardDiscover = await scoped(async (tx) =>
        createPostgresOrderCompensationCandidateReader({
          scope: { brandReference: brand, storeReference: store },
          includeStaffCancellations: true,
          authorize: async (_tx, input) => input.purpose === "DiscoverPaidWithoutFulfillableOrder",
        })(tx, { afterDispositionReference: null, limit: 100 }),
      );
      assert.ok(
        !cardDiscover.candidates.some(
          (candidate) => candidate.dispositionReference === cardLeftRow.id,
        ),
      );
      // After closing out: nothing left at the card round; the online rounds wait for their refund
      // (Payment's compensation), which keeps the table open until it is made.
      assert.deepEqual((await closePlan(leftCard)).rounds, []);
      const planAfter = await closePlan(left);
      assert.deepEqual(
        planAfter.rounds.map((round) => [round.sequence, round.state]),
        [
          [1, "Refunding"],
          [2, "Refunding"],
        ],
      );
      assert.deepEqual(planAfter.totals, { onlineMinor: "0", cardMachineMinor: "0" });
      // v15 DEMO-02 round 16: an accepted round already refunded in full on the card machine shows
      // nothing left to refund; closing it out cancels it with nothing owed (no 0.00 machine refund
      // to record, which the database refuses) and it no longer keeps the table open.
      assert.deepEqual(
        (await closePlan(acceptedCard)).rounds.map((round) => [round.state, round.refund]),
        [["NotStarted", { method: "CardMachine", amountMinor: "0" }]],
      );
      const stockBeforeAccepted = Number((await stock()).reserved);
      const acceptedResult = await cancel(acceptedCard, 0, { reasonCode: "GUEST_LEFT" });
      assert.equal(acceptedResult.status, "Cancelled");
      assert.equal(acceptedResult.refundMethod, "CardMachine");
      assert.equal(acceptedResult.refundStatus, "Refunded");
      assert.equal(acceptedResult.refundAmountMinor, String(acceptedCard.batches[0].totalMinor));
      assert.deepEqual(
        (
          await admin.query(
            "SELECT previous_phase,refund_disposition FROM rms_ordering.order_staff_cancellation WHERE order_batch_id=$1",
            [acceptedCard.batches[0].batch],
          )
        ).rows,
        [{ previous_phase: "Accepted", refund_disposition: "AlreadyRefunded" }],
      );
      assert.equal(Number((await stock()).reserved), stockBeforeAccepted - 1);
      assert.deepEqual((await closePlan(acceptedCard)).rounds, []);

      // A pickup can never be cancelled as a never-accepted round, and a round without a recorded
      // payment is not eligible either (it is cancelled by the System when its payment time ends).
      await assert.rejects(cancel(waitingPickup, 0, { reasonCode: "GUEST_LEFT" }), {
        code: "ORDER_CANCELLATION_NOT_CANCELLABLE",
      });
      // The audit names the reason and that the round was never accepted.
      const leftAudit = (
        await admin.query(
          "SELECT reason_code,after_summary_json AS after_summary FROM platform_audit.audit_record WHERE action_code='ORDER_CANCELLED_BY_STAFF' AND target_id=$1",
          [left.batches[1].batch],
        )
      ).rows[0];
      assert.equal(leftAudit.reason_code, "GUEST_LEFT");
      assert.deepEqual(leftAudit.after_summary, {
        phase: "Cancelled",
        previousPhase: "Submitted",
        refund: "Refund",
      });

      // ── Double-refund guard (v15 order 7): a round its cancellation refunds whole (online by
      // compensation, or on the card machine) offers no unit to an ordinary item refund, and the
      // server refuses such a request. Read as the API role.
      const refundedByCancellation = (order, k) =>
        scoped((tx) =>
          createRoundCancellationRefundSource(
            tx,
            { brandReference: brand, storeReference: store },
            order.order,
          )({
            orderBatchReference: order.batches[k].batch,
            paymentEventReference: order.batches[k].event,
          }),
        );
      for (const [order, k] of [
        [pickup, 0], // staff cancelled, refunded online by compensation
        [dineIn, 1], // one round of a table cancelled by staff
        [counter, 0], // paid on the card machine, cancelled by staff
        [left, 0], // guests left: never-accepted rounds cancelled with refund
        [left, 1],
        [leftCard, 0], // guests left, already refunded on the machine
        [acceptedCard, 0], // accepted, refunded in full on the machine, then cancelled
        [expired, 0], // paid, but Ordering found it could no longer be fulfilled
      ])
        assert.equal(await refundedByCancellation(order, k), true);
      // Paid rounds the store did not cancel stay refundable item by item.
      assert.equal(await refundedByCancellation(started, 0), false);
      assert.equal(await refundedByCancellation(raceStart, 0), false);
      merchant.allowed = () => true;
      const refundRequest = createMerchantOrdinaryRefundRequest({
        persistence: { transactions: transactions({ guc: false }) },
        authentication: { authorize: async () => ({ sessionReference: id(12) }) },
        resolveConfiguration: async () => ({
          providerAccountReference: provider,
          environment: "Test",
          roleMapping: { Manager: ["STORE_MANAGER"], Owner: ["OWNER"], Finance: [] },
        }),
        newAuditReference: fresh,
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const itemRefund = (order, k) => ({
        sessionCookie: "synthetic-session",
        csrf: "synthetic-csrf",
        command: {
          orderReference: order.order,
          requestReference: fresh(),
          operationReference: fresh(),
          expectedClaimVersion: 0,
          reasonCode: "QUALITY_ISSUE",
          items: [
            {
              orderBatchReference: order.batches[k].batch,
              orderItemReference: order.batches[k].items[0],
              quantity: 1,
            },
          ],
        },
      });
      const requestsBefore = (
        await admin.query("SELECT count(*)::int AS n FROM rms_payment.ordinary_refund_request")
      ).rows[0].n;
      for (const [order, k] of [
        [pickup, 0],
        [dineIn, 1],
        [counter, 0],
        [left, 1],
      ]) {
        await assert.rejects(refundRequest.preview(itemRefund(order, k)), {
          message: "ORDINARY_REFUND_ROUND_REFUNDED_BY_CANCELLATION",
        });
        await assert.rejects(refundRequest(itemRefund(order, k)), {
          message: "ORDINARY_REFUND_ROUND_REFUNDED_BY_CANCELLATION",
        });
      }
      // A round not cancelled passes this guard (and is then decided by the ordinary checks).
      await assert.rejects(refundRequest.preview(itemRefund(started, 0)), (error) => {
        assert.notEqual(error.message, "ORDINARY_REFUND_ROUND_REFUNDED_BY_CANCELLATION");
        return true;
      });
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_payment.ordinary_refund_request"))
          .rows[0].n,
        requestsBefore,
      );

      // WP-2423 (2026-10-16): a staff cancellation of an earlier day's live Order returns its
      // stock, so it is no longer listed as holding stock.
      assert.equal((await holding()).has(pickup.batches[0].batch), false);

      // History stays append-only for the API role.
      await scoped(async (tx) => {
        await assert.rejects(
          tx.query(
            "UPDATE rms_ordering.order_staff_cancellation SET reason_code='STORE_ERROR'",
            [],
          ),
        );
      });
      await scoped(async (tx) => {
        await assert.rejects(tx.query("DELETE FROM rms_kitchen.kitchen_work_cancellation", []));
      });
    } finally {
      for (const name of [role, other]) {
        await admin.query("DROP OWNED BY " + name);
        await admin.query("DROP ROLE " + name);
      }
      await admin.end();
    }
  });
});
