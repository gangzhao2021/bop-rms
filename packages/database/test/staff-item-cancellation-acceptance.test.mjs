import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
  parseKitchenItemReadyEnvelope,
} from "../../rms/kitchen/src/index.ts";
import {
  createOrderFulfillmentCompletionRecord,
  createPostgresOrderExecutionReader,
  createPostgresOrderFulfillmentCompletionStore,
  createPostgresOrderFulfillmentSourceStore,
  createPostgresOrderKitchenSourceStore,
  createPostgresOrderPaymentDispositionReader,
  createPostgresStaffOrderCancellationReader,
  parseFulfillmentCompletedEnvelope,
} from "../../rms/ordering/src/index.ts";
import {
  createFulfillmentReadinessService,
  createPickupCredentialProvider,
  createPickupFulfillmentService,
  createPostgresFulfillmentReadinessStore,
  createPostgresPickupFulfillmentStore,
  createPostgresPickupProofIssuer,
  createPostgresPickupProofStore,
  validatePickupProof,
} from "../../rms/fulfillment/src/index.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import { createMerchantPickupHandoff } from "../../../apps/api/src/merchant-pickup-handoff.ts";
import { createPickupReadinessCurrentSource } from "../../../tooling/environment/pilot-pickup-readiness.mjs";
import {
  createPaymentProviderSnapshot,
  createPostgresOrdinaryRefundRequestRuntime,
} from "../../rms/payment/src/index.ts";
import { readOrderCreationHistory } from "../../rms/ordering/src/infrastructure/persistence/order-creation-query-store.ts";
import { orderCreatedSourceInput } from "../../rms/ordering/src/application/order-created-source.ts";
import { createPostgresOrdinaryRefundEscalationSource } from "../../rms/payment/src/infrastructure/persistence/ordinary-refund-request-store.ts";
import { createPostgresOrdinaryRefundCaptureSource } from "../../rms/payment/src/infrastructure/persistence/ordinary-refund-capture-source.ts";
import { createPostgresOrdinaryRefundPricingSource } from "../../rms/payment/src/infrastructure/ordinary-refund-pricing-source.ts";
import { createStripeOrdinaryRefundAdapter } from "../../rms/payment/src/infrastructure/stripe/stripe-ordinary-refund-adapter.ts";
import { createMerchantOrderStaffCancellation } from "../../../apps/api/src/merchant-order-staff-cancellation.ts";
import { createMerchantOrderItemStaffCancellation } from "../../../apps/api/src/merchant-order-item-staff-cancellation.ts";
import { createPaymentCompensationComposition } from "../../../apps/api/src/payment-compensation-composition.ts";
import { createInternalCompensationIdentity } from "../../../tooling/environment/pilot-compensation-identity.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { snapshotBegin, snapshotQuery } from "../test-support/snapshot-read-runner.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";
import { seedOrdinaryRefundStorePublication } from "../test-support/ordinary-refund-store-publication.mjs";
import { seedStaffItemCancellationQuote } from "../test-support/staff-item-cancellation-pricing.mjs";

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
      context: { brand: { brandReference: merchant.brand } },
      store: { storeReference: merchant.store },
      allowed: async () => merchant.allowed(),
    };
  },
}));

const { Client } = pg;
const id = (n) => "0190a7c5-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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

// Two lines per pickup Order (synthetic test-only prices and 13% exclusive tax):
// line A 4 × CAD 20.00 = 80.00 + 10.40 tax = 90.40; line B 2 × CAD 10.00 = 20.00 + 2.60 = 22.60.
// Tip CAD 3.00. Captured CAD 116.00. DEC-TIP-REFUND-PROPORTIONAL (Owner, 2026-10-17): a cancelled
// line returns its share of the tip by the ordinary refund allocation (by net: A 2.40, B 0.60).
const LINES = [
  { unitAmountMinor: 2000, quantity: 4, stock: "2" },
  { unitAmountMinor: 1000, quantity: 2, stock: "1" },
];
const LINE_A_MINOR = 9040n,
  LINE_B_MINOR = 2260n,
  TIP_MINOR = 300n,
  CAPTURED_MINOR = LINE_A_MINOR + LINE_B_MINOR + TIP_MINOR,
  LINE_A_TIP_MINOR = 240n,
  LINE_B_TIP_MINOR = 60n,
  LINE_A_REFUND_MINOR = LINE_A_MINOR + LINE_A_TIP_MINOR,
  LINE_B_REFUND_MINOR = LINE_B_MINOR + LINE_B_TIP_MINOR;

/**
 * WP-2423 Q6 step 2a: a store manager cancels some item lines of a paid, accepted pickup Order
 * before the kitchen starts them. Kitchen work of those lines, the Ordering item cancellation and
 * revision, the Payment Cancellation refund claim with its prepared operation, and the per-line
 * stock reservations change in one transaction, or nothing changes; the refund of exactly those
 * lines' net + tax is then dispatched through the ordinary refund pipeline to a simulated Stripe.
 * Cancelling the last remaining line ends the Order through the whole staff cancellation (step 1),
 * whose compensation refunds what remains of the capture, tip included. The command runs as a
 * restricted NOBYPASSRLS role holding exactly the rendered pilot API grants; owner facts (Order,
 * Pricing quote, Payment capture, Kitchen ticket, stock) are seeded by the isolated database owner.
 */
it("staff cancel item lines of a paid order before the kitchen starts them, refund exactly those lines, once, and end the order on the last line", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_item_cancel" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_sic_" + context.runId,
      other = "wp2423_sic_w_" + context.runId;
    assert.match(role, /^wp2423_sic_[a-f0-9]+$/u);
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
          async run(work, snapshot = false) {
            const client = new Client(context.clientConfig);
            await client.connect();
            try {
              await client.query(snapshot ? snapshotBegin : "BEGIN");
              await client.query("SET LOCAL ROLE " + role);
              await client.query("SET LOCAL lock_timeout='10s'");
              await client.query("SET LOCAL statement_timeout='20s'");
              if (guc)
                await client.query(
                  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
                  [tenant, brand, store],
                );
              const send = (sql, values) =>
                client.query(sql, values === undefined ? [] : [...values]);
              const tx = { query: snapshot ? snapshotQuery(send) : send };
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
          /** WP-2423: polled merchant reads (the pickup queue) run as the pilot's snapshot read. */
          runSnapshot(work) {
            return this.run(work, true);
          },
        };
      }
      const scoped = (work) => transactions().run(work);
      /** Owner-seeding transaction (isolated database owner) with the Store scope installed. */
      const ownerRunner = {
        async run(work) {
          await admin.query("BEGIN");
          try {
            await admin.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [tenant, brand, store],
            );
            const result = await work({
              query: (sql, values) => admin.query(sql, values === undefined ? [] : [...values]),
            });
            await admin.query("COMMIT");
            return result;
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
        },
      };

      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (offset) => new Date(base + offset).toISOString();
      const businessDateOf = (at) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(at));
      const owner = (tx) => createPostgresStockReservationStore({ run: (work) => work(tx) }, scope);

      // Item, stock place, one account holding 50 KG on hand.
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
          "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,2,'Receive','50',$6,$7,$8)",
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
              quantityDelta: "50",
              unitCode: "KG",
              baseQuantityDelta: "50",
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
              after: balance(2, "50", "0", "50"),
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
      /** Latest remaining quantity of each reservation, by reservation reference. */
      const reservations = async (refs) =>
        Object.fromEntries(
          (
            await admin.query(
              "SELECT DISTINCT ON (reservation_id) reservation_id::text AS id,snapshot_json->>'remainingQuantity' AS remaining FROM rms_inventory.stock_reservation_version WHERE reservation_id=ANY($1::uuid[]) ORDER BY reservation_id,version DESC",
              [refs],
            )
          ).rows.map((row) => [row.id, row.remaining]),
        );
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_ordering.order_item_staff_cancellation) AS items," +
              "(SELECT count(*)::int FROM rms_ordering.order_staff_cancellation) AS staff," +
              "(SELECT count(*)::int FROM rms_ordering.order_termination_record) AS terminations," +
              "(SELECT count(*)::int FROM rms_ordering.order_revision) AS revisions," +
              "(SELECT count(*)::int FROM platform_audit.audit_record) AS audits," +
              "(SELECT count(*)::int FROM platform_eventing.outbox_event) AS events," +
              "(SELECT count(*)::int FROM rms_kitchen.kitchen_work_cancellation) AS kitchen," +
              "(SELECT count(*)::int FROM rms_inventory.stock_reservation_version) AS reservations," +
              "(SELECT count(*)::int FROM rms_inventory.stock_movement) AS movements," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_request) AS requests," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_operation) AS operations," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_dispatch) AS dispatches," +
              "(SELECT count(*)::int FROM rms_payment.ordinary_refund_observation) AS observations," +
              "(SELECT count(*)::int FROM rms_fulfillment.fulfillment_item_cancellation) AS fulfillment",
          )
        ).rows[0];
      const itemStatuses = async (ticket) =>
        (
          await admin.query(
            "SELECT status FROM rms_kitchen.kitchen_work_item WHERE kitchen_ticket_id=$1 ORDER BY source_item_ordinal",
            [ticket],
          )
        ).rows.map((row) => row.status);

      /** Stock reserved at submission plus the inventory final validation for one Batch. */
      async function reserve(n, refs, orderReference, at, perLine) {
        const binding = {
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
        };
        // Per-line (schema 2): one reservation per Order line, bound to its cart line. Legacy
        // (schema 1): one submission-wide reservation.
        const parts = perLine
          ? LINES.map((line, j) => ({
              reservation: refs.reservations[j],
              quantity: line.stock,
              binding: { ...binding, cartItemReference: refs.cartLines[j] },
            }))
          : [{ reservation: refs.reservations[0], quantity: "3", binding }];
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
        const result = await scoped(async (tx) => {
          const version = await owner(tx).loadAccountLedgerVersion(account);
          return owner(tx).commitSet({
            setReference: id(n + 20),
            operationReference: id(n + 21),
            workflowReference: refs.workflow,
            workflowVersion: 1,
            writes: parts.map((part, j) => ({
              operationReference: id(n + 30 + 3 * j),
              accountReference: account,
              action: "Reserve",
              expectedLedgerVersion: version + j,
              quantity: part.quantity,
              reservation: createInventoryReservation({
                reservationReference: part.reservation,
                binding: part.binding,
                unit,
                quantity: part.quantity,
                occurredAt: at,
              }),
              movementReference: id(n + 31 + 3 * j),
              audit: audit(
                32 + 3 * j,
                "InventoryReservation",
                part.reservation,
                "INVENTORY_RESERVATION_RESERVE",
                id(n + 30 + 3 * j),
              ),
            })),
            audit: audit(
              22,
              "InventoryReservationSet",
              id(n + 20),
              "INVENTORY_RESERVATION_SET",
              id(n + 21),
            ),
          });
        });
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
              quantity: "3",
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

      const submittedAt = time(-minutes(40)),
        paidAt = time(-minutes(39)),
        acceptedAt = time(-minutes(38)),
        kitchenAt = time(-minutes(37));
      const businessDate = businessDateOf(submittedAt);
      // The local midnight that starts the business date (America/Toronto, day start 00:00).
      const businessDayBoundary = [4, 5]
        .map((hour) => new Date(businessDate + "T0" + hour + ":00:00.000Z"))
        .find(
          (at) =>
            businessDateOf(at) === businessDate &&
            businessDateOf(new Date(at.getTime() - 1)) !== businessDate,
        )
        .toISOString();

      /**
       * One paid pickup Order with one Batch of two lines: the persisted Pricing quote and the
       * Ordering line snapshots that captured it, stock reserved per line at submission,
       * acceptance, Payment's captured terminal fact (quote total plus tip), Ordering's Confirmed
       * payment disposition and the kitchen ticket with one queued work item per line.
       */
      async function seedOrder(n, { perLine = true } = {}) {
        const b = n + 100;
        const order = { order: id(n + 1), guest: id(n + 2), version: 0 };
        const refs = {
          batch: id(b + 1),
          submission: id(b + 2),
          cart: id(b + 3),
          quote: id(b + 4),
          demand: id(b + 5),
          workflow: id(b + 6),
          reservations: [id(b + 7), id(b + 8)],
          checkout: id(b + 9),
          cartLines: [id(b + 40), id(b + 41)],
          items: [id(b + 50), id(b + 51)],
          ticket: id(b + 60),
          workItems: [id(b + 70), id(b + 71)],
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
          providerIntent: "pi_SYNTHETIC" + b,
          tipMinor: TIP_MINOR,
        };
        order.batch = refs;
        await admin.query(
          "INSERT INTO rms_ordering.order_number_allocation " +
            "(order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at," +
            "business_date_configuration_id,business_date_configuration_version,business_date_content_digest," +
            "time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,'America/Toronto','00:00',$10,'Exact')",
          [
            order.order,
            brand,
            store,
            businessDate,
            n / 1000,
            String(n / 1000),
            submittedAt,
            id(50),
            hash("bd"),
            businessDayBoundary,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_header " +
            "(order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id," +
            "created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) " +
            "VALUES ($1,$2,$3,$4,$5,'Pickup','Web',NULL,$6,$6,1,'Submitted','Open','NotReported',$7)",
          [order.order, brand, store, businessDate, String(n / 1000), order.guest, submittedAt],
        );
        // Pricing: the quote the customer accepted, persisted by its owner store.
        const inputDigest = hash(["quote-input", b]);
        const { quote, snapshots } = await seedStaffItemCancellationQuote({
          runner: ownerRunner,
          scope,
          orderBatchReference: refs.batch,
          quoteReference: refs.quote,
          cartReference: refs.cart,
          cartVersion: 1,
          inputDigest,
          quotedAt: time(-minutes(42)),
          capturedAt: submittedAt,
          addedAt: time(-minutes(45)),
          actorReference: order.guest,
          nextReference: fresh,
          lines: LINES.map((line, j) => ({
            ...line,
            cartLineReference: refs.cartLines[j],
            orderItemReference: refs.items[j],
            sellableReference: id(800 + j),
            priceEntryReference: id(b + 92 + j),
          })),
        });
        assert.deepEqual(
          quote.lines.map((line) => line.total.amountMinor),
          [LINE_A_MINOR, LINE_B_MINOR],
        );
        refs.orderAllocationMinor = quote.total.amountMinor;
        refs.totalMinor = refs.orderAllocationMinor + refs.tipMinor;
        assert.equal(refs.totalMinor, CAPTURED_MINOR);
        await admin.query(
          "INSERT INTO rms_ordering.order_submission_record " +
            "(submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at,submission_kind) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'Initial')",
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
            refs.checkout,
            refs.quote,
            order.guest,
            submittedAt,
          ],
        );
        for (const [j, orderItem] of refs.items.entries())
          await admin.query(
            "INSERT INTO rms_ordering.order_item (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)",
            [
              orderItem,
              brand,
              store,
              order.order,
              refs.batch,
              refs.cartLines[j],
              LINES[j].quantity,
              JSON.parse(snapshots[j]).catalog.snapshotDigest,
              JSON.parse(snapshots[j]).pricing.quoteInputDigest,
              snapshots[j],
              submittedAt,
              j + 1,
            ],
          );
        await admin.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Initial',1,0,NULL,$1,$5)",
          [refs.submission, brand, store, order.order, submittedAt],
        );
        await reserve(b, refs, order.order, submittedAt, perLine);

        // Payment: the intent (quote total plus tip), the attempt, the captured Provider
        // observation and the verified terminal fact.
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
            id(b + 95),
            id(b + 96),
            hash(["payment-intent", b]),
            hash(["preparation", b]),
            refs.orderAllocationMinor,
            refs.tipMinor,
            refs.totalMinor,
            submittedAt,
            time(-minutes(10)),
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
            refs.providerIntent,
            "ch_SYNTHETIC" + b,
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
            refs.providerIntent,
            refs.observation,
            refs.totalMinor,
            paidAt,
            hash(["terminal", b]),
            refs.event,
          ],
        );

        // The confirmed snapshot digest is Ordering's own digest of the Order's creation history.
        const creation = await scoped((tx) =>
          readOrderCreationHistory(
            tx,
            { brandReference: brand, storeReference: store },
            refs.submission,
            1,
          ),
        );
        refs.snapshotDigest = sha(
          orderCreatedSourceInput(creation, creation.orderNumberAllocation.businessDateResolution),
        );
        // Ordering: the store accepted the Batch, then recorded the paid outcome Confirmed.
        await admin.query(
          "INSERT INTO rms_ordering.order_acceptance_record (acceptance_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,accepted_order_version,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,accepted_at) VALUES ($1,$2,$3,$4,$5,$6,1,2,'User',$7,'OrderAcceptance','order.accept','SYNTHETIC_TEST',$8,$9,$10,$11)",
          [
            refs.acceptance,
            id(b + 97),
            brand,
            store,
            order.order,
            refs.batch,
            staff,
            id(b + 98),
            id(b + 99),
            hash(["acceptance", b]),
            acceptedAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Acceptance',2,1,$5,NULL,$6)",
          [refs.acceptance, brand, store, order.order, refs.submission, acceptedAt],
        );
        order.version = 2;
        await admin.query(
          "INSERT INTO rms_ordering.order_payment_disposition_record (disposition_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_transaction_id,payment_intent_id,payment_attempt_id,payment_event_id,source_checkpoint,correlation_id,source_version,source_digest,evaluated_at,disposition,confirmation_id,source_snapshot_digest,confirmed_at,order_confirmed_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,2,$13,$14,'Confirmed',$15,$16,$14,$17)",
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
            hash(["disposition", b]),
            acceptedAt,
            refs.confirmation,
            refs.snapshotDigest,
            refs.confirmedEvent,
          ],
        );

        // Kitchen: the ticket created from the confirmed Batch, one queued work item per line. Its
        // source evidence is the real Ordering kitchen source of the accepted, confirmed Batch, so
        // the kitchen commands below run the real current-source check against it.
        refs.sourceQuery = {
          brandReference: brand,
          storeReference: store,
          orderReference: order.order,
          orderBatchReference: refs.batch,
          confirmationReference: refs.confirmation,
          sourceEventReference: refs.confirmedEvent,
          sourceAggregateVersion: 2n,
          sourceSnapshotDigest: refs.snapshotDigest,
        };
        refs.sourceEvidenceDigest = (
          await scoped((tx) =>
            kitchenSource.resolve({
              transaction: tx,
              query: { ...refs.sourceQuery, observedAt: new Date().toISOString() },
            }),
          )
        ).evidenceDigest;
        await admin.query(
          "INSERT INTO rms_kitchen.kitchen_ticket (kitchen_ticket_id,brand_id,store_id,order_id,order_batch_id,confirmation_id,consumer_name,consumer_version,source_event_id,source_aggregate_version,source_snapshot_digest,confirmed_at,correlation_id,semantic_event_binding_digest,source_evidence_id,source_evidence_version,source_evidence_digest,source_evidence_captured_at,work_plan_id,work_plan_version,work_plan_digest,work_plan_generated_at,aggregate_version,status,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'kitchen.confirmed-order:v1',1,$7,2,$8,$9,$10,$11,$12,1,$13,$9,$15,1,$16,$14,1,'Open','System','System',$14,$14)",
          [
            refs.ticket,
            brand,
            store,
            order.order,
            refs.batch,
            refs.confirmation,
            refs.confirmedEvent,
            refs.snapshotDigest,
            acceptedAt,
            refs.correlation,
            hash(["binding", b]),
            id(b + 10),
            refs.sourceEvidenceDigest,
            kitchenAt,
            id(b + 11),
            hash(["plan", b]),
          ],
        );
        for (const [j, workItem] of refs.workItems.entries())
          await admin.query(
            "INSERT INTO rms_kitchen.kitchen_work_item (kitchen_work_item_id,brand_id,store_id,kitchen_ticket_id,order_id,order_batch_id,order_item_id,source_evidence_id,work_plan_id,source_item_ordinal,split_ordinal,version,status,required_quantity,completed_quantity,product_id,product_version_id,sku_id,menu_version_id,localized_display_names_json,selected_options_json,source_line_digest,station_id,routing_rule_id,routing_rule_version,routing_rule_digest,preparation_id,preparation_version,preparation_digest,preparation_instructions_json,execution_snapshot_digest,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,1,'Queued',$11,0,$12,$13,$14,$15,$16::jsonb,'[]'::jsonb,$17,$18,$19,1,$20,$21,1,$22,$23::jsonb,$24,'System','System',$25,$25)",
            [
              workItem,
              brand,
              store,
              refs.ticket,
              order.order,
              refs.batch,
              refs.items[j],
              id(b + 10),
              id(b + 11),
              j + 1,
              LINES[j].quantity,
              id(700 + j),
              id(710 + j),
              id(800 + j),
              id(720),
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
        return order;
      }

      /**
       * The Ordering owner's kitchen source for the pilot kitchen command (pilot-kitchen-command.mjs):
       * issued kitchen work stays current while later revisions only cancelled item lines.
       */
      const kitchenSource = createPostgresOrderKitchenSourceStore({
        brandReference: brand,
        storeReference: store,
        // The seeded lines carry quote version 1 snapshots (staff-item-cancellation-pricing.mjs);
        // the pilot reads version 2. The revision rule under test does not depend on it.
        quoteVersion: 1,
        sha256: sha,
        authorize: async () => true,
      });
      const issuedSourceIsCurrent = async (transaction, order) =>
        (
          await kitchenSource.resolveIssued({
            transaction,
            query: { ...order.batch.sourceQuery, observedAt: new Date().toISOString() },
          })
        ).evidenceDigest === order.batch.sourceEvidenceDigest;

      /** The kitchen's own lifecycle owner path (KDS): accept, start and complete one work item. */
      function kitchen(order, { beforeCommit = null } = {}) {
        const refs = order.batch;
        let active = null;
        const now = () => new Date().toISOString();
        const kitchenReferences = {
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
          references: kitchenReferences,
          digests: { sha256: sha },
          authorize: async () => true,
          validateCurrentSource: (transaction) => issuedSourceIsCurrent(transaction, order),
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
          references: kitchenReferences,
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
        async function command(action, j, extra = {}) {
          const versions = (
            await admin.query(
              "SELECT t.aggregate_version::text AS ticket,w.version::text AS item FROM rms_kitchen.kitchen_ticket t JOIN rms_kitchen.kitchen_work_item w ON w.kitchen_ticket_id=t.kitchen_ticket_id WHERE w.kitchen_work_item_id=$1",
              [refs.workItems[j]],
            )
          ).rows[0];
          active = {
            action,
            idempotencyKey: "staff-item-cancel-" + refs.workItems[j] + "-" + action,
            actorReference: cook,
            brandReference: brand,
            storeReference: store,
            ticketReference: refs.ticket,
            workItemReference: refs.workItems[j],
            orderItemReference: refs.items[j],
            expectedTicketVersion: versions.ticket,
            expectedWorkItemVersion: versions.item,
            correlationReference: refs.correlation,
            ...extra,
          };
          return service.execute(active);
        }
        return {
          accept: (j) => command("AcceptKitchenWorkItem", j),
          start: (j) => command("StartKitchenWorkItem", j),
          complete: (j) =>
            command("CompleteKitchenWorkItem", j, { quantityDelta: LINES[j].quantity }),
        };
      }

      // Seed the Orders.
      const pickup = await seedOrder(1000); // scenarios 1, 5, 6, 7
      const threshold = await seedOrder(2000); // scenario 2
      const started = await seedOrder(3000); // scenario 3
      const raceStart = await seedOrder(4000); // scenario 4a
      const raceCancel = await seedOrder(5000); // scenario 4b
      const legacy = await seedOrder(6000, { perLine: false }); // scenario 8
      const journey = await seedOrder(7000); // scenario 9
      assert.deepEqual(await stock(), { onHand: "50", reserved: "21" });

      // Store business-date publication for Payment's businessDate port (synthetic Store
      // configuration, actual published owner records and proof).
      const { businessDate: businessDatePort } = await seedOrdinaryRefundStorePublication({
        client: admin,
        scope,
        firstCapturedAt: paidAt,
      });

      // Simulated Stripe (InternalTest): the real Stripe refund adapter over a fake transport.
      const providerRefunds = [];
      let providerSends = 0;
      const stripe = createStripeOrdinaryRefundAdapter({
        brandReference: brand,
        storeReference: store,
        environment: "Test",
        apiVersion: "2024-06-20",
        secretKey: "sk_test_SYNTHETICONLY",
        connectedAccount: null,
        now: () => new Date().toISOString(),
        fetch: async (url, init) => {
          if (init.method === "GET") {
            const intent = new URL(String(url)).searchParams.get("payment_intent");
            return globalThis.Response.json({
              object: "list",
              url: "/v1/refunds",
              has_more: false,
              data: providerRefunds.filter((refund) => refund.payment_intent === intent),
            });
          }
          const body = new globalThis.URLSearchParams(String(init.body));
          const refund = {
            object: "refund",
            id: "re_SYNTHETICITEM" + String(providerRefunds.length + 1).padStart(4, "0"),
            payment_intent: body.get("payment_intent"),
            amount: Number(body.get("amount")),
            currency: "cad",
            status: "succeeded",
            created: Math.floor(Date.now() / 1000),
            metadata: { bop_refund_binding: body.get("metadata[bop_refund_binding]") },
          };
          providerRefunds.push(refund);
          return globalThis.Response.json(refund);
        },
      });
      const providerPort = {
        refundPayment: async (request) => {
          providerSends++;
          return stripe.refundPayment(request);
        },
        lookupRefund: (request) => stripe.lookupRefund(request),
      };

      // The staff commands, composed exactly as the merchant API composes them.
      merchant.tenant = tenant;
      merchant.brand = brand;
      merchant.store = store;
      merchant.actor = staff;
      merchant.allowed = () => true;
      const persistence = (beforeCommit) => ({
        transactions: transactions({ guc: false, beforeCommit }),
        now: () => new Date(Math.floor(Date.now())).toISOString(),
      });
      const authentication = { authorize: async () => ({ sessionReference: id(12) }) };
      const installContext = async (tx, selected) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [selected.tenantReference, selected.brandReference, selected.storeReference],
        );
      };
      function staffItemCancellation({ beforeCommit = null } = {}) {
        return createMerchantOrderItemStaffCancellation({
          persistence: persistence(beforeCommit),
          authentication,
          installContext,
          nextReference: fresh,
          wholeCancellation: createMerchantOrderStaffCancellation({
            persistence: persistence(beforeCommit),
            authentication,
            installContext,
            nextReference: fresh,
          }),
          resolveRefundConfiguration: async (_tx, selected) => {
            assert.deepEqual(selected, {
              tenantReference: merchant.tenant,
              brandReference: merchant.brand,
              storeReference: merchant.store,
            });
            return { providerAccountReference: provider, environment: "Test" };
          },
          businessDate: businessDatePort,
          provider: providerPort,
        });
      }
      const session = { sessionCookie: "synthetic-session", csrf: "synthetic-csrf" };
      const command = (order, lines, overrides = {}) => ({
        orderReference: order.order,
        orderBatchReference: order.batch.batch,
        orderItemReferences: lines.map((j) => order.batch.items[j]),
        expectedOrderVersion: order.version,
        operationReference: fresh(),
        reasonCode: "SOLD_OUT",
        ...overrides,
      });
      const cancel = (order, lines, overrides = {}, options = {}) =>
        staffItemCancellation(options).cancel({
          ...session,
          command: command(order, lines, overrides),
        });
      const preview = (order, lines) =>
        staffItemCancellation().preview({
          ...session,
          command: {
            orderReference: order.order,
            orderBatchReference: order.batch.batch,
            orderItemReferences: lines.map((j) => order.batch.items[j]),
            expectedOrderVersion: order.version,
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
      const audits = async (since) =>
        (
          await admin.query(
            "SELECT action_code,actor_type,actor_reference::text AS actor FROM platform_audit.audit_record WHERE occurred_at>=$1 ORDER BY action_code",
            [since],
          )
        ).rows;
      const itemRecord = async (order) =>
        (
          await admin.query(
            "SELECT cancellation_id::text AS id,operation_id::text AS operation,order_item_ids::text[] AS items,expected_order_version,cancelled_order_version,previous_phase,actor_id::text AS actor,permission_code,reason_code,payment_disposition_id::text AS disposition,refund_request_id::text AS request,refund_operation_id::text AS refund_operation,refund_amount_minor::text AS amount,cancelled_at FROM rms_ordering.order_item_staff_cancellation WHERE order_id=$1 ORDER BY cancelled_at",
            [order.order],
          )
        ).rows;

      // ── Scenario 7: a withdrawn permission or another Store's selection writes nothing.
      let before = await counts();
      merchant.allowed = () => false;
      await assert.rejects(cancel(pickup, [0]), { code: "ORDER_CANCELLATION_PERMISSION_DENIED" });
      await assert.rejects(preview(pickup, [0]), { code: "ORDER_CANCELLATION_PERMISSION_DENIED" });
      // WP-2423: allowed when the staff member is resolved at the start, withdrawn before the
      // commit: kitchen, Ordering, the refund claim, fulfillment and stock all roll back.
      let calls = 0;
      merchant.allowed = () => ++calls <= 1;
      await assert.rejects(cancel(pickup, [0]), { code: "ORDER_CANCELLATION_PERMISSION_DENIED" });
      assert.equal(calls, 2);
      merchant.allowed = () => true;
      merchant.store = otherStore;
      await assert.rejects(cancel(pickup, [0]), { code: "ORDER_CANCELLATION_NOT_FOUND" });
      merchant.store = store;
      // A stale order version or an item of another Order is refused before anything is written.
      await assert.rejects(cancel(pickup, [0], { expectedOrderVersion: 1 }), {
        code: "ORDER_CANCELLATION_VERSION_CONFLICT",
      });
      await assert.rejects(
        cancel(pickup, [0], { orderItemReferences: [threshold.batch.items[0]] }),
        { code: "ORDER_CANCELLATION_NOT_FOUND" },
      );
      assert.deepEqual(await counts(), before);
      assert.equal(providerSends, 0);
      assert.ok(merchant.actions.every((action) => action === "ordering.order.cancel"));

      // Preview: one line refunds exactly its net + tax and its share of the tip; every remaining
      // line is the whole Order, whose refund is the remaining capture including tip. No writes.
      assert.deepEqual(await preview(pickup, [0]), {
        scope: "Items",
        refund: {
          amountMinor: String(LINE_A_REFUND_MINOR),
          currencyCode: "CAD",
          includesTip: true,
          netAmountMinor: "8000",
          taxAmountMinor: "1040",
          tipAmountMinor: String(LINE_A_TIP_MINOR),
        },
      });
      assert.deepEqual(await preview(pickup, [0, 1]), {
        scope: "Batch",
        refund: {
          amountMinor: String(CAPTURED_MINOR),
          currencyCode: "CAD",
          includesTip: true,
          netAmountMinor: "0",
          taxAmountMinor: "0",
          // 46940b76 L3: nothing refunded yet, so the whole tip.
          tipAmountMinor: String(TIP_MINOR),
        },
      });
      assert.deepEqual(await counts(), before);

      // ── Scenario 1: cancel line A of the paid, accepted pickup Order with two queued items.
      const operationReference = fresh();
      // WP-2423 resolution budget: the staff member is resolved in full (the double's `allowed`)
      // once at the start and once before the commit, not by every owner check in between.
      let resolutions = 0;
      merchant.allowed = () => (++resolutions, true);
      const cancelled = await cancel(pickup, [0], { operationReference });
      assert.equal(resolutions, 2);
      merchant.allowed = () => true;
      assert.equal(cancelled.status, "Cancelled");
      assert.equal(cancelled.scope, "Items");
      assert.equal(cancelled.orderReference, pickup.order);
      assert.equal(cancelled.orderBatchReference, pickup.batch.batch);
      assert.deepEqual(cancelled.orderItemReferences, [pickup.batch.items[0]]);
      assert.deepEqual(cancelled.refund, {
        status: "Refunded",
        amountMinor: String(LINE_A_REFUND_MINOR),
        currencyCode: "CAD",
        includesTip: true,
      });
      let after = await counts();
      assert.deepEqual(after, {
        ...before,
        items: before.items + 1,
        revisions: before.revisions + 1,
        kitchen: before.kitchen + 1,
        events: after.events,
        reservations: before.reservations + 1,
        movements: before.movements + 1,
        requests: before.requests + 1,
        operations: before.operations + 1,
        dispatches: before.dispatches + 1,
        observations: before.observations + 1,
        audits: after.audits,
      });
      assert.ok(after.events > before.events);
      const [record] = await itemRecord(pickup);
      assert.deepEqual(
        { ...record, cancelled_at: undefined },
        {
          id: cancelled.cancellationReference,
          operation: operationReference,
          items: [pickup.batch.items[0]],
          expected_order_version: 2,
          cancelled_order_version: 3,
          previous_phase: "Accepted",
          actor: staff,
          permission_code: "ordering.order.cancel",
          reason_code: "SOLD_OUT",
          disposition: pickup.batch.disposition,
          request: record.request,
          refund_operation: record.refund_operation,
          amount: String(LINE_A_REFUND_MINOR),
          cancelled_at: undefined,
        },
      );
      assert.equal(record.cancelled_at.toISOString(), cancelled.cancelledAt);
      const revision = (
        await admin.query(
          "SELECT revision_id::text AS id,kind,version FROM rms_ordering.order_revision WHERE order_id=$1 ORDER BY version DESC LIMIT 1",
          [pickup.order],
        )
      ).rows[0];
      assert.deepEqual(revision, { id: record.id, kind: "StaffItemCancellation", version: 3 });
      // The Order stays active with the remaining line: no termination, no whole cancellation.
      assert.equal(
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_ordering.order_termination_record WHERE order_id=$1)+(SELECT count(*)::int FROM rms_ordering.order_staff_cancellation WHERE order_id=$1) AS n",
            [pickup.order],
          )
        ).rows[0].n,
        0,
      );
      const commandAudits = await audits(cancelled.cancelledAt);
      for (const action of [
        "ORDER_ITEMS_CANCELLED_BY_STAFF",
        "KITCHEN_WORK_CANCELLED",
        "INVENTORY_RESERVATION_RELEASE",
        "PAYMENT_ORDINARY_REFUND_REQUESTED",
      ])
        assert.equal(
          commandAudits.filter((row) => row.action_code === action).length,
          1,
          action + " audit",
        );
      for (const action of ["ORDER_ITEMS_CANCELLED_BY_STAFF", "KITCHEN_WORK_CANCELLED"])
        assert.deepEqual(
          commandAudits
            .filter((row) => row.action_code === action)
            .map((row) => [row.actor_type, row.actor]),
          [["User", staff]],
          action,
        );
      // Kitchen: only line A's work is cancelled; line B stays queued.
      assert.deepEqual(await itemStatuses(pickup.batch.ticket), ["Cancelled", "Queued"]);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT kitchen_work_item_id::text AS item,before_status,actor_id::text AS actor,reason_code,order_cancellation_id::text AS cancellation FROM rms_kitchen.kitchen_work_cancellation WHERE kitchen_ticket_id=$1",
            [pickup.batch.ticket],
          )
        ).rows,
        [
          {
            item: pickup.batch.workItems[0],
            before_status: "Queued",
            actor: staff,
            reason_code: "ORDER_CANCELLED_BEFORE_PREPARATION",
            cancellation: record.id,
          },
        ],
      );
      // Inventory: only line A's per-line reservation is released.
      assert.deepEqual(await reservations(pickup.batch.reservations), {
        [pickup.batch.reservations[0]]: "0",
        [pickup.batch.reservations[1]]: "1",
      });
      assert.deepEqual(await stock(), { onHand: "50", reserved: "19" });
      const releases = (
        await admin.query(
          "SELECT record_json FROM rms_inventory.stock_movement WHERE movement_type='Release'",
        )
      ).rows.map((row) => row.record_json);
      assert.equal(releases.length, 1);
      assert.equal(releases[0].performedBy, staff);
      assert.equal(releases[0].reasonCode, "STAFF_CANCELLED_BEFORE_PREPARATION");
      assert.equal(releases[0].baseQuantityDelta, "-2");
      // Payment: one Cancellation claim bound to the item cancellation, exactly line A's net + tax.
      const claim = (
        await admin.query(
          "SELECT request_id::text AS id,amount_minor::text AS amount,actor_id::text AS actor,record_json FROM rms_payment.ordinary_refund_request WHERE order_id=$1",
          [pickup.order],
        )
      ).rows;
      assert.equal(claim.length, 1);
      assert.equal(claim[0].id, record.request);
      assert.equal(claim[0].amount, String(LINE_A_REFUND_MINOR));
      assert.equal(claim[0].actor, staff);
      assert.deepEqual(claim[0].record_json.claim, {
        kind: "Cancellation",
        cancellationReference: record.id,
        cancellationDigest: claim[0].record_json.claim.cancellationDigest,
      });
      const legs = claim[0].record_json.payments;
      assert.equal(legs.length, 1);
      assert.equal(legs[0].paymentAttemptReference, pickup.batch.attempt);
      assert.deepEqual(
        legs[0].items.map((entry) => entry.orderItemReference),
        [pickup.batch.items[0]],
      );
      assert.deepEqual(legs[0].items[0].refundUnitOrdinals, [1, 2, 3, 4]);
      assert.equal(String(legs[0].items[0].components.tipAmountMinor), String(LINE_A_TIP_MINOR));
      assert.equal(String(legs[0].items[0].components.netAmountMinor), "8000");
      assert.equal(String(legs[0].items[0].components.taxAmountMinor), "1040");
      const operation = (
        await admin.query(
          "SELECT o.operation_id::text AS id,o.amount_minor::text AS amount,o.approval_id,o.executor_id::text AS executor,o.environment,(SELECT count(*)::int FROM rms_payment.ordinary_refund_dispatch d WHERE d.operation_id=o.operation_id) AS dispatches,(SELECT count(*)::int FROM rms_payment.ordinary_refund_observation x WHERE x.operation_id=o.operation_id) AS observations FROM rms_payment.ordinary_refund_operation o WHERE o.request_id=$1",
          [record.request],
        )
      ).rows;
      assert.deepEqual(operation, [
        {
          id: record.refund_operation,
          amount: String(LINE_A_REFUND_MINOR),
          approval_id: null,
          executor: staff,
          environment: "Test",
          dispatches: 1,
          observations: 1,
        },
      ]);
      assert.equal(providerSends, 1);
      assert.deepEqual(
        providerRefunds.map((refund) => [refund.payment_intent, refund.amount]),
        [[pickup.batch.providerIntent, Number(LINE_A_REFUND_MINOR)]],
      );

      // ── Scenario 5: replay of the same command returns the original outcome, writes nothing
      // and never refunds again; a changed replay is refused.
      before = await counts();
      const replay = await cancel(pickup, [0], { operationReference });
      assert.deepEqual(replay, { ...cancelled, status: "AlreadyCancelled" });
      await assert.rejects(cancel(pickup, [0], { operationReference, reasonCode: "STORE_ERROR" }), {
        code: "ORDER_CANCELLATION_NOT_CANCELLABLE",
      });
      // The cancelled line cannot be cancelled again.
      await assert.rejects(cancel(pickup, [0], { expectedOrderVersion: 3 }), {
        code: "ORDER_CANCELLATION_NOT_CANCELLABLE",
      });
      // "Check refund" reports the completed refund without another Provider refund.
      assert.deepEqual(
        await staffItemCancellation().refund({
          ...session,
          command: { orderReference: pickup.order, cancellationReference: record.id },
        }),
        {
          refund: {
            status: "Refunded",
            amountMinor: String(LINE_A_REFUND_MINOR),
            currencyCode: "CAD",
          },
        },
      );
      assert.deepEqual(await counts(), before);
      assert.equal(providerSends, 1);

      // ── Scenario 2: the Cancellation claim never counts toward the ordinary thresholds.
      {
        const itemCancelled = await cancel(threshold, [0], { reasonCode: "CUSTOMER_REQUEST" });
        assert.equal(itemCancelled.status, "Cancelled");
        assert.equal(itemCancelled.refund.status, "Refunded");
        threshold.version = 3;
        const ordinaryReference = fresh();
        const paymentScope = { ...scope, providerAccountReference: provider, environment: "Test" };
        const ordinary = await scoped((tx) =>
          createPostgresOrdinaryRefundRequestRuntime({
            scope: paymentScope,
            authorize: async () => true,
            now: () => new Date().toISOString(),
            newAuditReference: fresh,
            retentionPolicyCode: "FINANCIAL_COMPLIANCE",
            retentionPolicyVersion: 1,
          })(tx, {
            orderReference: threshold.order,
            requestReference: ordinaryReference,
            operationReference: fresh(),
            actorReference: staff,
            expectedClaimVersion: 1,
            reasonCode: "CUSTOMER_REQUEST",
            items: [
              {
                orderBatchReference: threshold.batch.batch,
                orderItemReference: threshold.batch.items[1],
                quantity: 1,
              },
            ],
          }),
        );
        assert.equal(ordinary.status, "Created");
        assert.equal(ordinary.request.claim, undefined);
        const ordinaryMinor = ordinary.request.amountMinor;
        // Meaningful: counting the Cancellation would push the Order above CAD 100.
        assert.ok(ordinaryMinor < 10000n && ordinaryMinor + LINE_A_REFUND_MINOR > 10000n);
        const pricing = createPostgresOrdinaryRefundPricingSource({
          scope,
          authorize: async () => true,
        });
        let validated = null;
        const escalation = await scoped((tx) =>
          createPostgresOrdinaryRefundEscalationSource({
            scope,
            authorize: async () => true,
            captures: createPostgresOrdinaryRefundCaptureSource({
              scope: paymentScope,
              now: () => new Date().toISOString(),
              authorize: async () => true,
              validatePricing: async (t, input) => ((validated = input), pricing(t, input)),
            }),
            businessDate: businessDatePort,
          })(tx, { orderReference: threshold.order, requestReference: ordinaryReference }),
        );
        assert.equal(escalation.claimVersion, 2);
        assert.equal(escalation.decision.cumulativeOrdinaryAmountMinor, ordinaryMinor);
        assert.ok(!escalation.decision.reasons.includes("OrderOrdinaryTotalAboveCad100"));
        // The guest's unit refund of line B returns that unit's tip share (60 / 2 units).
        assert.equal(
          String(ordinary.request.payments[0].items[0].components.tipAmountMinor),
          String(LINE_B_TIP_MINOR / 2n),
        );

        // DEC-TIP-REFUND-PROPORTIONAL: Payment's pricing check accepts the item cancellation with
        // its tip share; one recorded before the decision (tip excluded) stays valid as recorded,
        // while the same tip-less amounts are never valid for a guest refund, and a tip share off
        // by a cent is refused.
        const [itemClaim] = validated.history;
        assert.equal(itemClaim.claim.kind, "Cancellation");
        assert.equal(itemClaim.amountMinor, LINE_A_REFUND_MINOR);
        const withItems = (request, change) => {
          const items = request.payments[0].items.map((item) => ({
            ...item,
            components: { ...item.components, ...change },
          }));
          const payments = [{ ...request.payments[0], items }];
          const amountMinor = items.reduce(
            (sum, item) =>
              sum + Object.values(item.components).reduce((total, part) => total + part, 0n),
            0n,
          );
          return { ...request, amountMinor, payments };
        };
        const check = (request) =>
          scoped((tx) =>
            pricing(tx, {
              request,
              payment: request.payments[0],
              preparation: validated.preparation,
              history: [],
            }),
          );
        assert.equal(await check(itemClaim), true);
        const legacy = withItems(itemClaim, { tipAmountMinor: 0n });
        assert.equal(legacy.amountMinor, LINE_A_MINOR);
        assert.equal(await check(legacy), true);
        const ordinaryShape = { ...legacy };
        delete ordinaryShape.claim;
        assert.equal(await check(ordinaryShape), false);
        assert.equal(
          await check(withItems(itemClaim, { tipAmountMinor: LINE_A_TIP_MINOR - 1n })),
          false,
        );

        // WP-2423 (v15 order 10): after the item cancellation advanced the Order to version 3,
        // the kitchen still accepts, starts and completes the remaining line through the real
        // Ordering current-source check; the issued ticket (source version 2) stays current.
        assert.deepEqual(await itemStatuses(threshold.batch.ticket), ["Cancelled", "Queued"]);
        const lane = kitchen(threshold);
        assert.equal((await lane.accept(1)).outcome, "Accepted");
        assert.equal((await lane.start(1)).outcome, "Started");
        assert.equal((await lane.complete(1)).outcome, "CompletedAndOrderItemReady");
        assert.deepEqual(await itemStatuses(threshold.batch.ticket), ["Cancelled", "Completed"]);
        // Creating kitchen work still requires the exact current revision: version 2 is no longer it.
        await assert.rejects(
          scoped((tx) =>
            kitchenSource.resolve({
              transaction: tx,
              query: { ...threshold.batch.sourceQuery, observedAt: new Date().toISOString() },
            }),
          ),
          { code: "ORDER_KITCHEN_SOURCE_DEPENDENCY_UNAVAILABLE" },
        );
      }

      // ── Scenario 3: the selected line already started (In Progress): refused, nothing written.
      // The other, unstarted line of the same Batch can still be cancelled.
      {
        const lane = kitchen(started);
        assert.equal((await lane.accept(0)).outcome, "Accepted");
        assert.equal((await lane.start(0)).outcome, "Started");
        assert.deepEqual(await itemStatuses(started.batch.ticket), ["In Progress", "Queued"]);
        before = await counts();
        const sends = providerSends;
        await assert.rejects(cancel(started, [0]), {
          code: "ORDER_CANCELLATION_PREPARATION_STARTED",
        });
        await assert.rejects(cancel(started, [0, 1]), {
          code: "ORDER_CANCELLATION_PREPARATION_STARTED",
        });
        assert.deepEqual(await counts(), before);
        assert.equal(providerSends, sends);
        assert.deepEqual(await itemStatuses(started.batch.ticket), ["In Progress", "Queued"]);
        const other = await cancel(started, [1]);
        assert.equal(other.status, "Cancelled");
        assert.equal(other.refund.amountMinor, String(LINE_B_REFUND_MINOR));
        assert.equal(other.refund.status, "Refunded");
        assert.deepEqual(await itemStatuses(started.batch.ticket), ["In Progress", "Cancelled"]);
        // The started line is finished after the other line's cancellation (real source check).
        assert.equal((await lane.complete(0)).outcome, "CompletedAndOrderItemReady");
        assert.deepEqual(await itemStatuses(started.batch.ticket), ["Completed", "Cancelled"]);
        assert.deepEqual(await reservations(started.batch.reservations), {
          [started.batch.reservations[0]]: "2",
          [started.batch.reservations[1]]: "0",
        });
      }

      // ── Scenario 4a: the kitchen starts line A first and holds its row locks; the
      // cancellation waits, then sees the started work and is refused.
      {
        const lane = kitchen(raceStart);
        assert.equal((await lane.accept(0)).outcome, "Accepted");
        let release, reached;
        const gate = new Promise((resolve) => (release = resolve));
        const holding = new Promise((resolve) => (reached = resolve));
        const racing = kitchen(raceStart, {
          beforeCommit: () => {
            reached();
            return gate;
          },
        });
        const start = racing.start(0);
        await holding;
        const refused = cancel(raceStart, [0]).then(
          () => "Cancelled",
          (error) => error.code,
        );
        await blocked();
        release();
        assert.equal((await start).outcome, "Started");
        assert.equal(await refused, "ORDER_CANCELLATION_PREPARATION_STARTED");
        assert.deepEqual(await itemStatuses(raceStart.batch.ticket), ["In Progress", "Queued"]);
        assert.deepEqual(await itemRecord(raceStart), []);
        assert.deepEqual(await reservations(raceStart.batch.reservations), {
          [raceStart.batch.reservations[0]]: "2",
          [raceStart.batch.reservations[1]]: "1",
        });
      }
      // ── Scenario 4b: the cancellation holds the locks first; the kitchen's start of the same
      // line waits, then finds it cancelled and is refused.
      {
        const lane = kitchen(raceCancel);
        assert.equal((await lane.accept(0)).outcome, "Accepted");
        let release, reached;
        const gate = new Promise((resolve) => (release = resolve));
        const holding = new Promise((resolve) => (reached = resolve));
        let first = true;
        const winner = cancel(
          raceCancel,
          [0],
          {},
          {
            beforeCommit: () => {
              if (!first) return undefined;
              first = false;
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
        const won = await winner;
        assert.equal(won.status, "Cancelled");
        assert.equal(won.refund.status, "Refunded");
        assert.equal(await start, "Refused");
        assert.deepEqual(await itemStatuses(raceCancel.batch.ticket), ["Cancelled", "Queued"]);
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM rms_kitchen.kitchen_work_lifecycle_operation WHERE kitchen_ticket_id=$1 AND action_code='KITCHEN_WORK_ITEM_STARTED'",
              [raceCancel.batch.ticket],
            )
          ).rows[0].n,
          0,
        );
      }

      // ── Scenario 8: a legacy submission-wide (schema 1) reservation cannot be released per
      // line: refused, and the whole command (Kitchen, Ordering, Payment claim) rolls back.
      before = await counts();
      {
        const sends = providerSends;
        await assert.rejects(cancel(legacy, [0]), { code: "ORDER_ITEM_CANCELLATION_STOCK_LEGACY" });
        assert.deepEqual(await counts(), before);
        assert.equal(providerSends, sends);
        assert.deepEqual(await itemStatuses(legacy.batch.ticket), ["Queued", "Queued"]);
      }

      // ── Scenario 6: cancelling the last remaining line ends the Order through the whole staff
      // cancellation (step 1); its compensation refunds what remains of the capture, tip included.
      {
        pickup.version = 3;
        const reservedBefore = await stock();
        const lastOperation = fresh();
        // 46940b76 L3: the preview states what is left of the tip after line A's share, read from
        // Payment's own refund claims under the restricted role.
        assert.deepEqual(await preview(pickup, [1]), {
          scope: "Batch",
          refund: {
            amountMinor: String(CAPTURED_MINOR - LINE_A_REFUND_MINOR),
            currencyCode: "CAD",
            includesTip: true,
            netAmountMinor: "0",
            taxAmountMinor: "0",
            tipAmountMinor: String(TIP_MINOR - LINE_A_TIP_MINOR),
          },
        });
        const ended = await cancel(pickup, [1], { operationReference: lastOperation });
        // What remains: line B and the rest of the tip; across both refunds the whole tip returns.
        const remainingMinor = CAPTURED_MINOR - LINE_A_REFUND_MINOR;
        assert.equal(remainingMinor, LINE_B_MINOR + (TIP_MINOR - LINE_A_TIP_MINOR));
        assert.equal(ended.status, "Cancelled");
        assert.equal(ended.scope, "Batch");
        assert.deepEqual(ended.orderItemReferences, [pickup.batch.items[1]]);
        assert.deepEqual(ended.refund, {
          status: "Pending",
          amountMinor: String(remainingMinor),
          currencyCode: "CAD",
          includesTip: true,
        });
        const whole = (
          await admin.query(
            "SELECT cancellation_id::text AS id,operation_id::text AS operation,order_type,expected_order_version,cancelled_order_version,order_item_ids::text[] AS items FROM rms_ordering.order_staff_cancellation WHERE order_id=$1",
            [pickup.order],
          )
        ).rows;
        assert.equal(whole.length, 1);
        assert.equal(whole[0].id, ended.cancellationReference);
        assert.equal(whole[0].operation, lastOperation);
        assert.equal(whole[0].order_type, "Pickup");
        assert.equal(whole[0].expected_order_version, 3);
        assert.equal(whole[0].cancelled_order_version, 4);
        assert.ok(whole[0].items.includes(pickup.batch.items[1]));
        assert.deepEqual(
          (
            await admin.query(
              "SELECT phase,previous_phase,terminated_order_version FROM rms_ordering.order_termination_record WHERE order_id=$1",
              [pickup.order],
            )
          ).rows,
          [{ phase: "Cancelled", previous_phase: "Accepted", terminated_order_version: 4 }],
        );
        assert.deepEqual(await itemStatuses(pickup.batch.ticket), ["Cancelled", "Cancelled"]);
        // A whole cancellation (termination) ends the issued kitchen work: no longer current.
        await assert.rejects(
          scoped((tx) => issuedSourceIsCurrent(tx, pickup)),
          {
            code: "ORDER_KITCHEN_SOURCE_DEPENDENCY_UNAVAILABLE",
          },
        );
        // The remaining line's stock is released per line (line A's was already released).
        assert.deepEqual(await reservations(pickup.batch.reservations), {
          [pickup.batch.reservations[0]]: "0",
          [pickup.batch.reservations[1]]: "0",
        });
        assert.deepEqual(await stock(), {
          onHand: "50",
          reserved: String(Number(reservedBefore.reserved) - 1),
        });
        // No further item refund claim for the last line: the compensation owns that refund.
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM rms_payment.ordinary_refund_request WHERE order_id=$1",
              [pickup.order],
            )
          ).rows[0].n,
          1,
        );

        // The refund workload opens the compensation case for the staff-cancelled payment and
        // refunds the remaining capture through Payment's runtime (simulated Provider; the
        // refund response is lost after the effect and resolved by retrieval only).
        const source = await scoped((tx) =>
          createPostgresStaffOrderCancellationReader({
            brandReference: brand,
            storeReference: store,
          }).loadCompensationByPaymentEvent({
            transaction: tx,
            paymentEventReference: pickup.batch.event,
          }),
        );
        assert.equal(source.reason, "CancelledByStaff");
        assert.equal(source.paymentAttemptReference, pickup.batch.attempt);
        vi.stubEnv("NODE_ENV", "development");
        vi.stubEnv("BOP_PILOT_ENVIRONMENT", undefined);
        try {
          const captured = { amountMinor: CAPTURED_MINOR, currencyCode: "CAD" };
          const now = () => new Date().toISOString();
          let refunded = LINE_A_REFUND_MINOR,
            refundCalls = 0;
          const snapshot = (request) =>
            createPaymentProviderSnapshot({
              kind: "Snapshot",
              context: request.context,
              providerIntentReference: pickup.batch.providerIntent,
              providerTransactionReference: "ch_SYNTHETIC1100",
              paymentMethod: "OnlineCard",
              captureMode: "Automatic",
              status: "Captured",
              requestedAmount: captured,
              authorizedAmount: captured,
              capturedAmount: captured,
              refundedAmount: { amountMinor: refunded, currencyCode: "CAD" },
              observedAt: now(),
              evidenceDigest: sha("synthetic staff item refund observation:" + refunded),
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
                assert.equal(request.amount.amountMinor, remainingMinor);
                refundCalls++;
                refunded += request.amount.amountMinor;
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
          let outcome = await runtime.execute(source);
          if (outcome.status === "AwaitingProviderConfirmation")
            outcome = await runtime.execute(source);
          assert.equal(outcome.status, "AwaitingOperationsReconciliation");
          assert.equal(refundCalls, 1);
          assert.equal(refunded, CAPTURED_MINOR);
          const refund = (
            await admin.query(
              "SELECT record_json AS record FROM rms_payment.payment_compensation_refund WHERE payment_attempt_id=$1",
              [pickup.batch.attempt],
            )
          ).rows;
          assert.equal(refund.length, 1);
          assert.equal(String(refund[0].record.fact.amount.amountMinor), String(remainingMinor));
          // The staff command's replay now reports the whole refund as completed.
          const settled = await cancel(pickup, [1], { operationReference: lastOperation });
          assert.equal(settled.status, "AlreadyCancelled");
          assert.equal(settled.scope, "Batch");
          assert.equal(settled.refund.status, "Refunded");
          assert.equal(settled.refund.amountMinor, String(remainingMinor));
        } finally {
          vi.unstubAllEnvs();
        }
      }

      // ── Scenario 9 (v15 order 10): a pickup order goes all the way to collection after a staff
      // item cancellation. The fulfillment is created from the confirmed Order (version 2); staff
      // cancel one line (version 3); the kitchen completes the remaining line; Fulfillment records it
      // ready, the guest code is issued, staff check it and hand over, and Ordering records the
      // Order fulfilled. Readiness, proof and handoff run the pilot's own current-source check
      // (`createPickupReadinessCurrentSource`) over the real Ordering source; every step runs as
      // the pilot runtime role. Test-only stand-ins: the confirmed Order
      // is the owner-seeded one above, and the published completion Workflow gate is not under test.
      {
        merchant.allowed = () => true;
        merchant.store = store;
        const refs = journey.batch;
        // The pilot business worker runs as the pilot runtime (API) role, like the staff commands.
        const worker = scoped;
        const now = () => new Date().toISOString();
        const derive = (prefix) => (purpose, identity) => {
          const digest = createHash("sha256")
            .update(purpose + ":" + identity)
            .digest("hex");
          return (
            prefix +
            "-" +
            digest.slice(0, 4) +
            "-7" +
            digest.slice(4, 7) +
            "-8" +
            digest.slice(7, 10) +
            "-" +
            digest.slice(10, 22)
          );
        };
        const audit = {
          append: ({ transaction, record }) => appendAuditRecordInTransaction(transaction, record),
        };
        /** The stored OrderConfirmed event, as the pilot's confirmation resolver reads it. */
        const resolveConfirmation = async (transaction, orderReference) => {
          assert.equal(orderReference, journey.order);
          const stored = await createPostgresOrderPaymentDispositionReader(
            scope,
          ).loadByPaymentEvent({ transaction, paymentEventReference: refs.event });
          return stored.orderConfirmedEvent;
        };
        // The seeded lines carry quote version 1 snapshots (see the kitchen source above).
        const fulfillmentSource = createPostgresOrderFulfillmentSourceStore({
          brandReference: brand,
          storeReference: store,
          quoteVersion: 1,
          sha256: sha,
          authorize: async () => true,
        });
        const validateCurrentSource = createPickupReadinessCurrentSource({
          scope: { brandReference: brand, storeReference: store },
          sha256: sha,
          now,
          authorize: () => true,
          resolveConfirmation,
          quoteVersion: 1,
        });

        // OrderConfirmed: the pickup fulfillment of both lines, from the exact current Order.
        const confirmed = await worker((tx) => resolveConfirmation(tx, journey.order));
        assert.equal(confirmed.aggregateVersion, 2n);
        const created = await worker((tx) =>
          createPickupFulfillmentService({
            authorization: { authorize: async () => true },
            orderingSource: {
              resolve: (input) => fulfillmentSource.resolve({ transaction: tx, query: input }),
            },
            references: { derive: derive("0190fa32") },
            digests: { sha256: sha },
            repository: createPostgresPickupFulfillmentStore({
              brandReference: brand,
              storeReference: store,
              sha256: sha,
              authorize: async () => true,
              validateCurrentSource: async (transaction, effect) =>
                (
                  await fulfillmentSource.resolve({
                    transaction,
                    query: {
                      brandReference: brand,
                      storeReference: store,
                      observedAt: effect.aggregate.createdAt,
                      orderReference: effect.aggregate.orderReference,
                      orderBatchReference: effect.aggregate.orderBatchReference,
                      confirmationReference: effect.aggregate.confirmationReference,
                      sourceEventReference: effect.aggregate.sourceEventReference,
                      sourceAggregateVersion: effect.aggregate.sourceAggregateVersion,
                      sourceSnapshotDigest: effect.aggregate.sourceSnapshotDigest,
                    },
                  })
                ).evidenceDigest === effect.aggregate.sourceEvidenceDigest,
            }),
            audit,
          }).consume(tx, confirmed),
        );
        assert.equal(created.status, "Created");
        const fulfillment = created.effect.aggregate;
        assert.equal(fulfillment.items.length, 2);

        // Staff cancel line B before the kitchen starts it: Order version 3, its fulfillment item
        // cancelled in the same transaction; line A remains.
        const cancelledLine = await cancel(journey, [1]);
        assert.equal(cancelledLine.status, "Cancelled");
        journey.version = 3;
        assert.deepEqual(
          (
            await admin.query(
              "SELECT order_item_id::text AS item,aggregate_version_before::int AS before,aggregate_version_after::int AS after,phase_after FROM rms_fulfillment.fulfillment_item_cancellation WHERE order_id=$1",
              [journey.order],
            )
          ).rows,
          [{ item: refs.items[1], before: 1, after: 2, phase_after: "Pending" }],
        );
        // Creating a fulfillment still needs the exact current Order; version 2 no longer is.
        await assert.rejects(
          worker((tx) =>
            fulfillmentSource.resolve({
              transaction: tx,
              query: { ...refs.sourceQuery, observedAt: now() },
            }),
          ),
          { code: "ORDER_FULFILLMENT_SOURCE_CONFLICT" },
        );
        // The fulfillment created from version 2 is still the Order's (only lines were cancelled).
        assert.equal(await worker((tx) => validateCurrentSource(tx, journey.order)), true);

        // The kitchen completes line A; Kitchen publishes it ready.
        const lane = kitchen(journey);
        assert.equal((await lane.accept(0)).outcome, "Accepted");
        assert.equal((await lane.start(0)).outcome, "Started");
        assert.equal((await lane.complete(0)).outcome, "CompletedAndOrderItemReady");
        const kitchenEvent = async (type) => {
          const found = (
            await admin.query(
              "SELECT event_id::text AS id FROM platform_eventing.outbox_event WHERE event_type=$1 AND payload_json->>'orderReference'=$2",
              [type, journey.order],
            )
          ).rows;
          assert.equal(found.length, 1);
          return scoped((tx) => loadOutboxEnvelope(tx, found[0].id));
        };
        const itemReady = parseKitchenItemReadyEnvelope(await kitchenEvent("KitchenItemReady"));
        assert.equal(itemReady.payload.orderItemReference, refs.items[0]);
        assert.equal((await kitchenEvent("KitchenOrderReady")).eventType, "KitchenOrderReady");

        // fulfillment.kitchen-item-ready: line A ready makes the pickup Ready (B is cancelled).
        const readinessOptions = {
          brandReference: brand,
          storeReference: store,
          sha256: sha,
          now,
          authorize: async () => true,
          validateCurrentSource,
        };
        const applied = await worker((tx) =>
          createFulfillmentReadinessService({
            authorization: { authorize: async () => true },
            references: { derive: derive("0190fa33") },
            digests: { sha256: sha },
            repository: createPostgresFulfillmentReadinessStore(readinessOptions),
            audit,
          }).consume(tx, itemReady),
        );
        assert.equal(applied.status, "Applied");
        assert.equal(applied.effect.operation.phaseAfter, "Ready");
        assert.equal(applied.effect.operation.aggregateVersionAfter, 3n);
        // WP-2423 (v15 2026-10-18): the pickup screen's queue is a snapshot read (no Order fence
        // or pickup lock) running the pilot's current-source check over the real Ordering source:
        // the pickup is listed Ready with line A only; the cancelled line B is not handed over.
        const queued = await transactions().runSnapshot((tx) =>
          createPostgresFulfillmentReadinessStore({
            ...readinessOptions,
            authorizeQueue: async () => true,
          }).listPickupQueue({
            transaction: tx,
            afterFulfillmentReference: null,
            limit: 50,
            includeCompleted: false,
          }),
        );
        assert.deepEqual(
          queued.items.map((item) => String(item.fulfillmentReference)),
          [String(fulfillment.fulfillmentReference)],
        );
        assert.equal(queued.items[0].phase, "Ready");
        assert.equal(queued.items[0].items.length, 1);
        assert.equal(
          queued.items[0].items[0].readyQuantity,
          queued.items[0].items[0].orderedQuantity,
        );

        // fulfillment.internal-pickup-proof: the guest's pickup code is issued.
        const credentials = createPickupCredentialProvider([
          { version: 1, derivationKey: randomBytes(32), selectorKey: randomBytes(32) },
        ]);
        const proofOptions = {
          ...readinessOptions,
          appendAudit: (tx, fact) =>
            appendAuditRecordInTransaction(tx, {
              auditId: fresh(),
              brandId: brand,
              storeId: store,
              actor: { type: "System" },
              actionCode: "PICKUP_PROOF_" + fact.kind.toUpperCase(),
              targetType: "Fulfillment",
              targetId: fact.fulfillmentReference,
              beforeSummary: null,
              afterSummary: { operation: fact.kind },
              reasonCode: "PICKUP_PROOF",
              correlationId: fact.correlationReference,
              occurredAt: fact.occurredAt,
              sourceChannel: "EVENT_CONSUMER",
              dataClassification: "Confidential",
              retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
              retentionPolicyVersion: 1,
            }),
        };
        const issued = await worker((tx) =>
          createPostgresPickupProofIssuer({
            store: proofOptions,
            credentials,
            pepperVersion: 1,
            nextReference: fresh,
            publicOrderReference: () => randomBytes(16).toString("base64url"),
          }).ensureIssued({
            transaction: tx,
            orderReference: journey.order,
            idempotencyReference: fresh(),
            correlationReference: refs.correlation,
          }),
        );
        assert.equal(issued.status, "Issued");
        // The guest reads the six-digit code; staff type it at the counter.
        const proofStore = createPostgresPickupProofStore(proofOptions);
        const guestCode = await scoped(async (tx) => {
          const current = await proofStore.lockByOrder({
            transaction: tx,
            orderReference: journey.order,
          });
          const saved = await proofStore.currentCounterCode({
            transaction: tx,
            orderReference: journey.order,
          });
          return credentials.recoverCounterCode({
            brandReference: brand,
            capability: current.capability,
            counterCode: saved,
            observedAt: now(),
          });
        });
        assert.match(guestCode, /^[0-9]{6}$/u);
        const checked = await scoped(async (tx) => {
          const current = await proofStore.lockByOrder({
            transaction: tx,
            orderReference: journey.order,
          });
          const record = validatePickupProof({
            source: current.source,
            capability: current.capability,
            selectorHash: current.capability.selectorHash,
            generation: current.capability.generation,
            expectedCapabilityVersion: 1,
            observedAt: now(),
            verificationReference: fresh(),
            operationReference: fresh(),
            idempotencyReference: fresh(),
            correlationReference: fresh(),
          });
          return proofStore.verify({
            transaction: tx,
            orderReference: journey.order,
            selectorHash: credentials.hashCredential({
              brandReference: brand,
              storeReference: store,
              fulfillmentReference: fulfillment.fulfillmentReference,
              purpose: "PickupHandoff",
              kind: "HumanCode",
              pepperVersion: current.capability.pepperVersion,
              credential: guestCode,
            }),
            record: { ...record, verificationMethod: "HumanCode" },
            rejection: { actorReference: staff },
          });
        });
        assert.equal(checked.status, "Applied");

        // The pickup screen's current state: Ready, with the version staff hand over against.
        const pickupState = await scoped((tx) =>
          createPostgresFulfillmentReadinessStore(readinessOptions).lockPickupHandoffByOrder({
            brandReference: brand,
            storeReference: store,
            transaction: tx,
            orderReference: journey.order,
          }),
        );
        assert.equal(pickupState.source.canonicalPhase, "Ready");
        assert.deepEqual(
          pickupState.source.items.map((line) => String(line.fulfillmentItemReference)),
          [String(fulfillment.items[0].fulfillmentItemReference)],
        );
        // Staff hand line A over (the merchant handoff command); only line A is handed over.
        const workstation = { pickupLocationReference: id(7801), deviceReference: id(7802) };
        const handedOver = await createMerchantPickupHandoff({
          persistence: persistence(null),
          authentication,
          installContext,
          nextReference: fresh,
          store: {
            sha256: sha,
            validateCurrentSource,
            deriveCompletionReference: derive("0190fa39"),
            admit: async (_tx, handoff) =>
              handoff.deviceReference === workstation.deviceReference &&
              handoff.pickupLocationReference === workstation.pickupLocationReference,
            appendAudit: async (transaction, entry) =>
              appendAuditRecordInTransaction(transaction, {
                auditId: entry.auditReference,
                brandId: brand,
                storeId: store,
                actor: { type: "User", reference: entry.actorReference },
                actionCode: entry.actionCode,
                targetType: "Fulfillment",
                targetId: entry.fulfillmentReference,
                afterSummary: { action: entry.purpose },
                reasonCode: "PICKUP_HANDOFF",
                correlationId: entry.correlationReference,
                occurredAt: entry.occurredAt,
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Confidential",
                retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
                retentionPolicyVersion: 1,
              }),
          },
        })({
          ...session,
          command: {
            orderReference: journey.order,
            storeReference: store,
            fulfillmentReference: fulfillment.fulfillmentReference,
            expectedAggregateVersion: String(pickupState.source.aggregateVersion),
            verificationReference: checked.record.verificationReference,
            recipientType: "Customer",
            recipientDisplayMask: "S***",
            ...workstation,
            quantities: [
              {
                fulfillmentItemReference: fulfillment.items[0].fulfillmentItemReference,
                quantity: LINES[0].quantity,
              },
            ],
            idempotencyReference: fresh(),
            correlationReference: refs.correlation,
          },
        });
        assert.equal(handedOver.nextPhase, "Completed");

        // FulfillmentCompleted: Ordering records the Order fulfilled from its current revision
        // (the item cancellation, version 3), as the order-completion consumer does.
        const completedEvent = (
          await admin.query(
            "SELECT event_id::text AS id FROM platform_eventing.outbox_event WHERE event_type='FulfillmentCompleted' AND payload_json->>'orderReference'=$1",
            [journey.order],
          )
        ).rows;
        assert.equal(completedEvent.length, 1);
        const fulfilled = await worker(async (tx) => {
          const event = parseFulfillmentCompletedEnvelope(
            await loadOutboxEnvelope(tx, completedEvent[0].id),
          );
          const state = await createPostgresOrderExecutionReader({
            brandReference: brand,
            storeReference: store,
            sha256: sha,
            authorize: async () => true,
          }).loadByBatch({
            transaction: tx,
            orderReference: journey.order,
            orderBatchReference: refs.batch,
          });
          assert.deepEqual([state.phase, state.version], ["Accepted", 3]);
          const record = createOrderFulfillmentCompletionRecord(
            {
              completionReference: fresh(),
              operationReference: fresh(),
              auditReference: fresh(),
              brandReference: brand,
              storeReference: store,
              orderReference: journey.order,
              orderBatchReference: refs.batch,
              orderType: "Pickup",
              phaseBefore: state.phase,
              expectedOrderVersion: state.version,
              expectedSourceCheckpoint: state.checkpoint,
              fulfilledOrderVersion: state.version + 1,
              phase: "Fulfilled",
              closureStatus: "Open",
              actorType: "System",
              actorReference: null,
              purposeCode: "OrderFulfillment",
              permissionCode: "order.fulfill",
              workflowVersionReference: id(7803),
              transitionReference: id(7804),
              completedAt: event.occurredAt,
              recordedAt: now(),
              sourceEvent: event,
            },
            sha,
          );
          return createPostgresOrderFulfillmentCompletionStore({
            brandReference: brand,
            storeReference: store,
            sha256: sha,
            authorize: async () => true,
            // Test-only: the published completion Workflow is covered by its own suites.
            validateCurrentWorkflow: async () => true,
            audit: async (r) => ({
              auditId: r.auditReference,
              brandId: r.brandReference,
              storeId: r.storeReference,
              actor: { type: "System" },
              actionCode: "ORDER_FULFILLED",
              targetType: "Order",
              targetId: r.orderReference,
              correlationId: r.operationReference,
              occurredAt: r.recordedAt,
              afterSummary: { phase: "Fulfilled", closureStatus: "Open" },
              reasonCode: "FULFILLMENT_COMPLETED",
              sourceChannel: "SYSTEM",
              dataClassification: "Restricted",
              retentionPolicyCode: "FINANCIAL_COMPLIANCE",
              retentionPolicyVersion: 1,
            }),
          }).commit({ transaction: tx, record });
        });
        assert.equal(fulfilled.status, "Created");
        assert.deepEqual(
          (
            await admin.query(
              "SELECT kind,version FROM rms_ordering.order_revision WHERE order_id=$1 ORDER BY version",
              [journey.order],
            )
          ).rows,
          [
            { kind: "Initial", version: 1 },
            { kind: "Acceptance", version: 2 },
            { kind: "StaffItemCancellation", version: 3 },
            { kind: "Fulfillment", version: 4 },
          ],
        );
        // The fulfilled Order still reads as this fulfillment's Order (pickup history, receipts).
        assert.equal(await worker((tx) => validateCurrentSource(tx, journey.order)), true);
      }

      // History stays append-only for the API role.
      await scoped(async (tx) => {
        await assert.rejects(
          tx.query(
            "UPDATE rms_ordering.order_item_staff_cancellation SET reason_code='STORE_ERROR'",
            [],
          ),
        );
      });
      await scoped(async (tx) => {
        await assert.rejects(
          tx.query("DELETE FROM rms_ordering.order_item_staff_cancellation", []),
        );
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
