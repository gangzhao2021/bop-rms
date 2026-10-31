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
  acquireOrderDispositionFence,
  createPostgresDiningOrderPreparationSource,
  createPostgresOrderKitchenSourceStore,
  loadOrderCanonicalPhase,
} from "../../rms/ordering/src/index.ts";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import { readOrderCreationHistory } from "../../rms/ordering/src/infrastructure/persistence/order-creation-query-store.ts";
import { orderCreatedSourceInput } from "../../rms/ordering/src/application/order-created-source.ts";
import { createStripeOrdinaryRefundAdapter } from "../../rms/payment/src/infrastructure/stripe/stripe-ordinary-refund-adapter.ts";
import { createMerchantOrderStaffCancellation } from "../../../apps/api/src/merchant-order-staff-cancellation.ts";
import { createMerchantOrderItemStaffCancellation } from "../../../apps/api/src/merchant-order-item-staff-cancellation.ts";
import { createMerchantDiningOrderProgress } from "../../../apps/api/src/merchant-dining-order-progress.ts";
import { withStaffContentLocale } from "../../../apps/api/src/staff-content-locale.ts";
import { createMerchantDiningServeCommand } from "../../../apps/api/src/merchant-dining-serve-command.ts";
import { createMerchantDiningServeReadyCommand } from "../../../apps/api/src/merchant-dining-serve-ready-command.ts";
import { createMerchantDiningOrderCloseCommand } from "../../../apps/api/src/merchant-dining-order-close-command.ts";
import { createMerchantDiningClosingCommand } from "../../../apps/api/src/merchant-dining-closing-command.ts";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { createDiningOrderCloseConfiguration } from "../../../apps/api/src/dining-order-close-configuration.ts";
import { createKitchenInventoryConsumption } from "../../../apps/api/src/kitchen-inventory-consumption.ts";
import {
  createDiningOrderDeliveryProgress,
  servedOrderItemFacts,
} from "../../../apps/api/src/dining-order-delivery-progress.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";
import { seedOrdinaryRefundStorePublication } from "../test-support/ordinary-refund-store-publication.mjs";
import { seedStaffItemCancellationQuote } from "../test-support/staff-item-cancellation-pricing.mjs";
import { seedJourneyDining } from "../test-support/dine-in-journey-seed.mjs";

// Test double (as in the pickup item cancellation acceptance): the merchant session/permission
// resolution names the staff member, the selected Store and the current permission decision; it
// records which permission each command asked for. Everything after it runs the real owner code.
const merchant = vi.hoisted(() => ({
  store: null,
  actor: null,
  tenant: null,
  brand: null,
  allowed: null,
  actions: [],
}));
vi.mock("../../../apps/api/src/merchant-store-scope.ts", async (importActual) => ({
  // A real staff session (the table's checkout, which needs Identity's actual context) goes
  // through the actual scope; the synthetic one stands in for the other merchant commands.
  createMerchantStoreScope:
    (persistence) =>
    async (tx, cookie, action, ...rest) => {
      if (cookie !== "synthetic-session")
        return (await importActual()).createMerchantStoreScope(persistence)(
          tx,
          cookie,
          action,
          ...rest,
        );
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
const id = (n) => "0190a7c6-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const sha = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
const [tenant, brand, store, site, location, item, account, staff, cook, provider] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 11,
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

// One table round with two lines (synthetic test-only prices and 13% exclusive tax):
// line A 4 × CAD 20.00 = 80.00 + 10.40 tax = 90.40; line B 2 × CAD 10.00 = 20.00 + 2.60 = 22.60.
// Tip CAD 3.00. Captured online CAD 116.00. DEC-TIP-REFUND-PROPORTIONAL (Owner, 2026-10-17): a
// cancelled line returns its share of the tip by the ordinary refund allocation (B: 0.60 of 3.00).
const LINES = [
  { unitAmountMinor: 2000, quantity: 4, stock: "2" },
  { unitAmountMinor: 1000, quantity: 2, stock: "1" },
];
const LINE_A_MINOR = 9040n,
  LINE_B_MINOR = 2260n,
  TIP_MINOR = 300n,
  CAPTURED_MINOR = LINE_A_MINOR + LINE_B_MINOR + TIP_MINOR,
  LINE_B_TIP_MINOR = 60n,
  LINE_B_REFUND_MINOR = LINE_B_MINOR + LINE_B_TIP_MINOR;

/**
 * WP-2423 Q6 step 2a, dine-in: a table's paid, accepted round has two lines; staff cancel the line
 * the kitchen has not started (Order version 2 -> 3, StaffItemCancellation). The rest of the table's
 * ordinary path then still works on the later revision: the kitchen accepts, starts and completes
 * the remaining line (the pilot kitchen command's current-source check, `resolveIssued`, over the
 * real Ordering kitchen source), Inventory consumes it from the Kitchen events, the staff serving
 * view shows the remaining line Ready at the current Order version, staff serve it (the merchant
 * serve command at version 3; the version the page held before the cancellation is refused), and
 * "Serve all ready items" composes that command per line: a request from a page still holding the
 * version before the cancellation serves neither line (both changed), the current page's request
 * serves line A once even when retried, and another device's request finds it already served. Then
 * the Order closes: the cancelled-and-refunded line does not block execution or settlement.
 *
 * Every command runs under a restricted NOBYPASSRLS role holding exactly the rendered pilot API
 * grants. Test-only stand-ins: the paid, accepted round (Order, quote, capture, acceptance,
 * Confirmed disposition, kitchen ticket whose source evidence is the real Ordering kitchen source)
 * and the occupied table are seeded by the isolated database owner; the merchant session is the
 * test double above; Stripe is simulated behind the real Stripe refund adapter; Kitchen admission
 * and Expo decisions are synthetic "allowed"/"disabled" decisions as in the pilot kitchen command.
 */
it("after staff cancel one line of a dine-in round, the kitchen completes the rest, staff serve it and the order closes", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_item_dine_in" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_sicd_" + context.runId,
      other = "wp2423_sicd_w_" + context.runId;
    assert.match(role, /^wp2423_sicd_[a-f0-9]+$/u);
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

      /** One restricted-role transaction on its own connection. */
      function transactions({ guc = true } = {}) {
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
      const one = async (sql, values = []) => (await admin.query(sql, values)).rows;

      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (offset) => new Date(base + offset).toISOString();
      const businessDateOf = (at) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(at));
      const owner = (tx) => createPostgresStockReservationStore({ run: (work) => work(tx) }, scope);

      // ── Stock: one tracked item, 50 KG on hand (test-only owner seed).
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
          await one(
            'SELECT on_hand::text AS "onHand",reserved::text AS reserved FROM rms_inventory.stock_balance WHERE account_id=$1',
            [account],
          )
        )[0];

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

      // ── The occupied table: an Active dining session with the Host and one more guest
      // (test-only owner seed through the dine-in journey's Dining seed).
      const n = 1000,
        b = n + 100;
      const order = {
        order: id(n + 1),
        guest: id(n + 2),
        session: id(n + 3),
        host: id(n + 4),
        version: 0,
      };
      const dining = await seedJourneyDining({
        client: admin,
        scope,
        round: {
          f: {
            scope: { storeReference: store },
            request: {
              record: {
                order: { diningSessionReference: order.session },
                guestSessionReference: order.guest,
              },
            },
            cart: { items: [{ addedByParticipantReference: order.host }] },
          },
        },
        startedAt: time(-minutes(50)),
        guestParticipant: id(n + 5),
        // The table closes at the end: seated as the real open moved it on.
        tableVersion: 2,
      });
      assert.equal(dining.session.diningSessionReference, order.session);

      // ── The table's paid, accepted round with two lines (test-only owner seed, as the pickup
      // item cancellation acceptance seeds its Orders, with order type DineIn at this table).
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
        providerIntent: "pi_SYNTHETICDINE" + b,
      };
      await admin.query(
        "INSERT INTO rms_ordering.order_number_allocation " +
          "(order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at," +
          "business_date_configuration_id,business_date_configuration_version,business_date_content_digest," +
          "time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) " +
          "VALUES ($1,$2,$3,$4,1,'1',$5,$6,1,$7,'America/Toronto','00:00',$8,'Exact')",
        [
          order.order,
          brand,
          store,
          businessDate,
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
          "VALUES ($1,$2,$3,$4,'1','DineIn','Web',$5,$6,$6,1,'Submitted','Open','NotReported',$7)",
        [order.order, brand, store, businessDate, order.session, order.guest, submittedAt],
      );
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
          // Owner 2026-10-24: line A has a Chinese name, line B does not.
          ...(j === 0
            ? { localizedNames: { "en-CA": "Synthetic item 1", "zh-Hans-CA": "合成商品一" } }
            : {}),
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
      const orderAllocationMinor = quote.total.amountMinor;
      assert.equal(orderAllocationMinor + TIP_MINOR, CAPTURED_MINOR);
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

      // Stock reserved per line at submission, and the inventory final validation.
      const audit = (k, targetType, targetId, actionCode, correlationId) => ({
        auditId: id(b + k),
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: staff },
        actionCode,
        targetType,
        targetId,
        reasonCode: "AUTHORIZED_CHANGE",
        correlationId,
        occurredAt: submittedAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Internal",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
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
        demandDigest: hash(["demand", b]),
      };
      const reserved = await scoped(async (tx) => {
        const version = await owner(tx).loadAccountLedgerVersion(account);
        return owner(tx).commitSet({
          setReference: id(b + 120),
          operationReference: id(b + 121),
          workflowReference: refs.workflow,
          workflowVersion: 1,
          writes: LINES.map((line, j) => ({
            operationReference: id(b + 130 + 3 * j),
            accountReference: account,
            action: "Reserve",
            expectedLedgerVersion: version + j,
            quantity: line.stock,
            reservation: createInventoryReservation({
              reservationReference: refs.reservations[j],
              binding: { ...binding, cartItemReference: refs.cartLines[j] },
              unit,
              quantity: line.stock,
              occurredAt: submittedAt,
            }),
            movementReference: id(b + 131 + 3 * j),
            audit: audit(
              132 + 3 * j,
              "InventoryReservation",
              refs.reservations[j],
              "INVENTORY_RESERVATION_RESERVE",
              id(b + 130 + 3 * j),
            ),
          })),
          audit: audit(
            122,
            "InventoryReservationSet",
            id(b + 120),
            "INVENTORY_RESERVATION_SET",
            id(b + 121),
          ),
        });
      });
      assert.equal(reserved.status, "Applied");
      const validation = parseSubmissionInventoryFinalValidation({
        schemaVersion: 1,
        validationReference: id(b + 140),
        operationReference: id(b + 141),
        actorReference: reserved.set.actorReference,
        auditReference: id(b + 142),
        tenantReference: tenant,
        brandReference: brand,
        storeReference: store,
        orderReference: order.order,
        submissionReference: refs.submission,
        cartReference: refs.cart,
        cartVersion: 1,
        quoteReference: refs.quote,
        demandReference: refs.demand,
        demandDigest: hash(["demand", b]),
        workflowReference: refs.workflow,
        workflowVersionReference: id(b + 143),
        workflowVersion: 1,
        transitionReference: id(b + 144),
        observedAt: submittedAt,
        items: [
          {
            itemReference: item,
            currentItemVersion: 2,
            configurationOperationReferences: [id(b + 145)],
            unit,
            quantity: "3",
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
          validation.validationReference,
          validation.operationReference,
          validation.actorReference,
          validation.auditReference,
          validation.orderReference,
          validation.submissionReference,
          validation.cartReference,
          validation.cartVersion,
          validation.quoteReference,
          validation.demandReference,
          validation.demandDigest,
          validation.workflowReference,
          validation.workflowVersionReference,
          validation.workflowVersion,
          validation.transitionReference,
          reserved.set.setReference,
          submittedAt,
          hash(validation),
          validation,
        ],
      );
      assert.deepEqual(await stock(), { onHand: "50", reserved: "3" });

      // Payment: the intent (quote total plus tip), the attempt, the captured Provider observation
      // and the verified terminal fact of the online payment.
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
          orderAllocationMinor,
          TIP_MINOR,
          CAPTURED_MINOR,
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
          "ch_SYNTHETICDINE" + b,
          CAPTURED_MINOR,
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
          "evt_SYNTHETICDINE" + b,
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
          "evt_SYNTHETICDINE" + b,
          provider,
          refs.providerIntent,
          refs.observation,
          CAPTURED_MINOR,
          paidAt,
          hash(["terminal", b]),
          refs.event,
        ],
      );

      // Ordering: the store accepted the round (version 2), then recorded the payment Confirmed.
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

      // Kitchen: the ticket created from the confirmed round, one queued work item per line. Its
      // source evidence is the real Ordering kitchen source of the accepted dine-in round (the
      // dining item state and the round's acceptance version), so the kitchen commands below run
      // the pilot's real current-source check against it.
      const kitchenSource = createPostgresOrderKitchenSourceStore({
        brandReference: brand,
        storeReference: store,
        // The seeded lines carry quote version 1 snapshots (staff-item-cancellation-pricing.mjs);
        // the pilot reads version 2. The revision rule under test does not depend on it.
        quoteVersion: 1,
        sha256: sha,
        authorize: async () => true,
      });
      const sourceQuery = {
        brandReference: brand,
        storeReference: store,
        orderReference: order.order,
        orderBatchReference: refs.batch,
        confirmationReference: refs.confirmation,
        sourceEventReference: refs.confirmedEvent,
        sourceAggregateVersion: 2n,
        sourceSnapshotDigest: refs.snapshotDigest,
      };
      const sourceEvidenceDigest = (
        await scoped((tx) =>
          kitchenSource.resolve({
            transaction: tx,
            query: { ...sourceQuery, observedAt: new Date().toISOString() },
          }),
        )
      ).evidenceDigest;

      // v15 2026-10-17 regression (40P01): a guest's dine-in status read takes the Order's
      // disposition fence (customer-order-status-read.ts), then reads the Order header and Batch
      // FOR SHARE; the kitchen command's current-source check (`resolveIssued`) runs concurrently.
      // The guest read holds the fence first and reads the rows only once the kitchen check is
      // waiting on a lock. When the check locked the header before requesting the fence, the two
      // deadlocked; with the fence first, the check waits for the read and both complete.
      {
        const fenceScope = {
          brandReference: brand,
          storeReference: store,
          orderReference: order.order,
        };
        const waiting = async () => {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const rows = await one(
              "SELECT count(*)::int AS waiting FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_database d ON d.oid=l.database WHERE d.datname=current_database() AND NOT l.granted",
            );
            if (rows[0].waiting > 0) return;
            await delay(25);
          }
          throw new Error("kitchen source check never waited on the Order fence");
        };
        const deadlocks = async () =>
          (
            await one(
              "SELECT deadlocks::int AS deadlocks FROM pg_catalog.pg_stat_database WHERE datname=current_database()",
            )
          )[0].deadlocks;
        const deadlocksBefore = await deadlocks();
        let fenced;
        const held = new Promise((resolve) => (fenced = resolve));
        const reader = transactions().run(async (tx) => {
          await acquireOrderDispositionFence(tx, fenceScope);
          fenced();
          await waiting();
          return createPostgresDiningOrderPreparationSource({
            brandReference: brand,
            storeReference: store,
            authorize: async () => true,
          }).resolve({
            transaction: tx,
            brandReference: brand,
            storeReference: store,
            orderReference: order.order,
            diningSessionReference: order.session,
            guestSessionReference: order.guest,
            observedAt: new Date().toISOString(),
          });
        });
        await held;
        const writer = scoped((tx) =>
          kitchenSource.resolveIssued({
            transaction: tx,
            query: { ...sourceQuery, observedAt: new Date().toISOString() },
          }),
        );
        const [read, check] = await Promise.allSettled([reader, writer]);
        const reason = (result) =>
          result.status === "rejected"
            ? String(result.reason?.code ?? "") +
              " " +
              String(result.reason?.message ?? result.reason) +
              " " +
              String(result.reason?.cause?.code ?? "")
            : "";
        // The kitchen source reports a lock failure as unavailable; the server's deadlock count
        // (flushed when the victim's connection closes) names it.
        let deadlocksAfter = await deadlocks();
        for (let attempt = 0; attempt < 20 && deadlocksAfter === deadlocksBefore; attempt += 1) {
          await delay(100);
          deadlocksAfter = await deadlocks();
        }
        assert.equal(deadlocksAfter - deadlocksBefore, 0, "deadlocks detected (40P01)");
        assert.equal(read.status, "fulfilled", "guest status read: " + reason(read));
        assert.equal(check.status, "fulfilled", "kitchen source check: " + reason(check));
        assert.equal(read.value.orderVersion, 2);
        assert.equal(read.value.orderReference, order.order);
        assert.equal(check.value.evidenceDigest, sourceEvidenceDigest);
      }
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
          sourceEvidenceDigest,
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
      const workStatuses = async () =>
        (
          await one(
            "SELECT status FROM rms_kitchen.kitchen_work_item WHERE kitchen_ticket_id=$1 ORDER BY source_item_ordinal",
            [refs.ticket],
          )
        ).map((row) => row.status);

      // Store business-date publication for Payment's businessDate port (synthetic Store
      // configuration, actual published owner records and proof).
      const { businessDate: businessDatePort } = await seedOrdinaryRefundStorePublication({
        client: admin,
        scope,
        firstCapturedAt: paidAt,
      });

      // Simulated Stripe (InternalTest): the real Stripe refund adapter over a fake transport.
      const providerRefunds = [];
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
            id: "re_SYNTHETICDINE" + String(providerRefunds.length + 1).padStart(4, "0"),
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

      // ── The merchant compositions, exactly as the merchant API composes them.
      merchant.tenant = tenant;
      merchant.brand = brand;
      merchant.store = store;
      merchant.actor = staff;
      merchant.allowed = () => true;
      const now = () => new Date(Math.floor(Date.now())).toISOString();
      const persistence = { transactions: transactions({ guc: false }), now };
      const authentication = { authorize: async () => ({ sessionReference: id(12) }) };
      const session = { sessionCookie: "synthetic-session", csrf: "synthetic-csrf" };
      const installContext = async (tx, selected) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [selected.tenantReference, selected.brandReference, selected.storeReference],
        );
      };
      const cancelItems = createMerchantOrderItemStaffCancellation({
        persistence,
        authentication,
        installContext,
        nextReference: fresh,
        wholeCancellation: createMerchantOrderStaffCancellation({
          persistence,
          authentication,
          installContext,
          nextReference: fresh,
        }),
        resolveRefundConfiguration: async () => ({
          providerAccountReference: provider,
          environment: "Test",
        }),
        businessDate: businessDatePort,
        provider: {
          refundPayment: (request) => stripe.refundPayment(request),
          lookupRefund: (request) => stripe.lookupRefund(request),
        },
      });
      const progress = () =>
        createMerchantDiningOrderProgress({ persistence, locale: "en-CA", authentication })({
          ...session,
          query: { orderReference: order.order },
        });
      const serve = createMerchantDiningServeCommand({
        persistence,
        authentication,
        reference: fresh,
        audit: {
          reasonCode: "DINING_ITEM_SERVED",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        },
      });
      const closeOrder = createMerchantDiningOrderCloseCommand({
        persistence,
        authentication,
        resolveConfiguration: createDiningOrderCloseConfiguration({
          ...scope,
          providerAccountReference: provider,
          environment: "Test",
        }),
        newReference: fresh,
        audit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
      });
      const phases = (view) =>
        view.items.map((entry) => [entry.orderItemReference, entry.phase, entry.deliveredQuantity]);
      // WP-2423 / DEC-PILOT-BATCH-PHASE-01: the Order phase the guest status read reports, composed
      // as that read does (restricted role, Order fence first): Ordering's merge of its own records
      // plus the served facts read through Dining's public served-quantity reader.
      const orderPhase = () =>
        scoped(async (tx) => {
          const orderScope = { brandReference: brand, storeReference: store };
          await acquireOrderDispositionFence(tx, { ...orderScope, orderReference: order.order });
          const delivery = await createDiningOrderDeliveryProgress({
            ...orderScope,
            diningScope: scope,
            authorize: async () => true,
            authorizeKitchen: async () => true,
            authorizeDining: async () => true,
          }).load({
            transaction: tx,
            ...orderScope,
            orderReference: order.order,
            diningSessionReference: order.session,
            guestSessionReference: order.guest,
            observedAt: new Date().toISOString(),
          });
          assert.ok(delivery);
          const merged = await loadOrderCanonicalPhase(
            tx,
            orderScope,
            order.order,
            servedOrderItemFacts(delivery.items),
          );
          return merged?.canonicalPhase;
        });

      // ── Before: the round is accepted and both lines wait for the kitchen.
      const before = await progress();
      // Owner 2026-10-24: a staff member who chose Chinese reads the items in Chinese where the
      // frozen item has a Chinese name, else in the Store's language (restricted role, same read).
      const chinese = await withStaffContentLocale("zh-Hans-CA", () => progress());
      assert.deepEqual(
        chinese.items.map((entry) => entry.displayName),
        ["合成商品一", "Synthetic item 2"],
      );
      assert.deepEqual(
        before.items.map((entry) => entry.displayName),
        ["Synthetic item 1", "Synthetic item 2"],
      );
      assert.equal(before.currentOrderVersion, 2);
      assert.equal(before.orderVersion, 2);
      assert.deepEqual(phases(before), [
        [refs.items[0], "Accepted", 0],
        [refs.items[1], "Accepted", 0],
      ]);

      // ── Staff cancel line B (not started): Order version 2 -> 3, only B's kitchen work is
      // cancelled, B's stock is released and B's net + tax is refunded online.
      const cancelled = await cancelItems.cancel({
        ...session,
        command: {
          orderReference: order.order,
          orderBatchReference: refs.batch,
          orderItemReferences: [refs.items[1]],
          expectedOrderVersion: order.version,
          operationReference: fresh(),
          reasonCode: "SOLD_OUT",
        },
      });
      assert.equal(cancelled.status, "Cancelled");
      assert.equal(cancelled.scope, "Items");
      assert.deepEqual(cancelled.refund, {
        status: "Refunded",
        amountMinor: String(LINE_B_REFUND_MINOR),
        currencyCode: "CAD",
        includesTip: true,
      });
      assert.deepEqual(
        await one(
          "SELECT kind,version FROM rms_ordering.order_revision WHERE order_id=$1 ORDER BY version DESC LIMIT 1",
          [order.order],
        ),
        [{ kind: "StaffItemCancellation", version: 3 }],
      );
      order.version = 3;
      assert.deepEqual(await workStatuses(), ["Queued", "Cancelled"]);
      assert.deepEqual(await stock(), { onHand: "50", reserved: "2" });
      assert.deepEqual(
        providerRefunds.map((refund) => [refund.payment_intent, refund.amount]),
        [[refs.providerIntent, Number(LINE_B_REFUND_MINOR)]],
      );

      // ── The kitchen completes line A. The pilot kitchen command's current-source check
      // (pilot-kitchen-command.mjs: `resolveIssued` over the real Ordering source) still finds the
      // ticket issued at version 2 current after the item cancellation.
      const issuedSourceIsCurrent = async (transaction) =>
        (
          await kitchenSource.resolveIssued({
            transaction,
            query: { ...sourceQuery, observedAt: new Date().toISOString() },
          })
        ).evidenceDigest === sourceEvidenceDigest;
      assert.equal(await scoped(issuedSourceIsCurrent), true);
      const kitchenReferences = {
        next: fresh,
        derive(purpose, identity) {
          const digest = createHash("sha256")
            .update(purpose + identity)
            .digest("hex");
          return (
            "0190abce-" +
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
      let activeKitchenCommand = null;
      const kitchenRunner = transactions();
      const kitchen = createKitchenWorkLifecycleService({
        trustedContext: {
          resolveAuthority: async () => ({
            actorReference: activeKitchenCommand.actorReference,
            brandReference: brand,
            storeReference: store,
            observedAt: new Date().toISOString(),
          }),
        },
        correlationContext: { resolve: async () => ({ correlationReference: refs.correlation }) },
        authorization: { authorize: async () => true },
        transactions: { withTransaction: (work) => kitchenRunner.run(work) },
        tenantContext: { install: async () => undefined },
        idempotency: {
          acquireFence: async ({ transaction, idempotencyKey }) => {
            await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              brand + ":" + store + ":" + idempotencyKey,
            ]);
          },
        },
        repository: createPostgresKitchenWorkLifecycleStore({
          brandReference: brand,
          storeReference: store,
          references: kitchenReferences,
          digests: { sha256: sha },
          authorize: async () => true,
          validateCurrentSource: (transaction) => issuedSourceIsCurrent(transaction),
        }),
        references: kitchenReferences,
        digests: { sha256: sha },
        clock: { now: () => new Date().toISOString() },
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
            evaluatedAt: new Date().toISOString(),
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
            evaluatedAt: new Date().toISOString(),
            validUntil: new Date(Date.now() + minutes(60)).toISOString(),
          }),
        },
      });
      const kitchenCommand = async (action, extra = {}) => {
        const [versions] = await one(
          "SELECT t.aggregate_version::text AS ticket,w.version::text AS item FROM rms_kitchen.kitchen_ticket t JOIN rms_kitchen.kitchen_work_item w ON w.kitchen_ticket_id=t.kitchen_ticket_id WHERE w.kitchen_work_item_id=$1",
          [refs.workItems[0]],
        );
        activeKitchenCommand = {
          action,
          idempotencyKey: "dine-in-item-cancel-" + refs.workItems[0] + "-" + action,
          actorReference: cook,
          brandReference: brand,
          storeReference: store,
          ticketReference: refs.ticket,
          workItemReference: refs.workItems[0],
          orderItemReference: refs.items[0],
          expectedTicketVersion: versions.ticket,
          expectedWorkItemVersion: versions.item,
          correlationReference: refs.correlation,
          ...extra,
        };
        return kitchen.execute(activeKitchenCommand);
      };
      assert.equal((await kitchenCommand("AcceptKitchenWorkItem")).outcome, "Accepted");
      assert.equal((await kitchenCommand("StartKitchenWorkItem")).outcome, "Started");
      assert.equal(
        (await kitchenCommand("CompleteKitchenWorkItem", { quantityDelta: LINES[0].quantity }))
          .outcome,
        "CompletedAndOrderItemReady",
      );
      assert.deepEqual(await workStatuses(), ["Completed", "Cancelled"]);

      // Inventory consumes line A from the Kitchen lifecycle Events (pilot-inventory-consumers.mjs
      // composition, run here directly inside a restricted-role transaction).
      const consume = createKitchenInventoryConsumption({
        scope,
        nextReference: fresh,
        authorize: async () => true,
        retentionPolicy: { code: "AUDIT_DEFAULT", version: 1 },
      });
      const lifecycleEvents = await one(
        "SELECT event_id::text AS id,event_type FROM platform_eventing.outbox_event WHERE event_type IN ('KitchenWorkStarted','KitchenItemCompleted') AND payload_json->>'orderItemReference'=$1 ORDER BY occurred_at,event_id",
        [refs.items[0]],
      );
      assert.deepEqual(
        lifecycleEvents.map((event) => event.event_type),
        ["KitchenWorkStarted", "KitchenItemCompleted"],
      );
      for (const event of lifecycleEvents)
        await scoped(async (tx) => consume(tx, await loadOutboxEnvelope(tx, event.id)));
      // Line A's 2 KG are used; line B's reservation was released by the cancellation.
      assert.deepEqual(await stock(), { onHand: "48", reserved: "0" });

      // ── The guests ask for the bill before their last dish is served: checkout starts (the
      // table is Closing, no more rounds) and the dish is still served (DEC-DINE-IN-PAY-LATER).
      const manager = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions({ guc: false }),
        scope,
        actor: id(0x710),
        at: now(),
        extraPermissions: ["dining.operate", "dining.session.close", "order.close"],
        referencePrefix: "01909962",
        sessionReferencePrefix: "01909961",
      });
      const closingCommand = createMerchantDiningClosingCommand({
        persistence: { ...manager.persistence, now },
        authentication: manager.authentication,
        providerAccountReference: provider,
        environment: "Test",
        newReference: fresh,
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const tableClosing = async (action) =>
        closingCommand({
          sessionCookie: manager.sessionCookie,
          csrf: manager.csrf,
          command: {
            action,
            diningSessionReference: order.session,
            operationReference: fresh(),
            expectedSessionVersion: Number(
              (
                await one("SELECT version FROM rms_dining.dining_session WHERE session_id=$1", [
                  order.session,
                ])
              )[0].version,
            ),
          },
        });
      assert.equal((await tableClosing("Begin")).phase, "Closing");

      // ── The serving view (current Order version 3): line A Ready, line B Cancelled.
      const ready = await progress();
      assert.equal(ready.currentOrderVersion, 3);
      assert.equal(ready.orderVersion, 3);
      assert.equal(ready.phase, "Ready");
      assert.deepEqual(phases(ready), [
        [refs.items[0], "Ready", 0],
        [refs.items[1], "Cancelled", 0],
      ]);

      // Not served yet: the guest's Order phase is not Fulfilled.
      assert.notEqual(await orderPhase(), "Fulfilled");

      // ── Staff serve line A at the current version. A page still holding the version before
      // the cancellation is refused and writes nothing (it refreshes and serves at version 3).
      const serveCommand = (expectedOrderVersion) => ({
        ...session,
        command: {
          operationReference: fresh(),
          orderReference: order.order,
          orderItemReference: refs.items[0],
          quantity: LINES[0].quantity,
          expectedOrderVersion,
          expectedItemServiceVersion: 0,
          expectedSessionVersion: ready.sessionVersion,
          expectedTableAssignmentVersion: ready.tableAssignmentVersion,
        },
      });
      await assert.rejects(serve(serveCommand(2)), /DINING_SERVE_COMMAND_DENIED/u);

      // ── WP-2423 "Serve all ready items": the same serve command, once per line, each in its own
      // restricted-role transaction, with operation references derived from the request's.
      const serveReady = createMerchantDiningServeReadyCommand({
        serve,
        progress: createMerchantDiningOrderProgress({
          persistence,
          locale: "en-CA",
          authentication,
        }),
      });
      const readyRequest = (operationReference, expectedOrderVersion, lines) => ({
        ...session,
        command: {
          operationReference,
          orderReference: order.order,
          expectedOrderVersion,
          expectedSessionVersion: ready.sessionVersion,
          expectedTableAssignmentVersion: ready.tableAssignmentVersion,
          lines: lines.map(([orderItemReference, quantity]) => ({
            orderItemReference,
            quantity,
            expectedItemServiceVersion: 0,
          })),
        },
      });
      const serviceRecords = async () =>
        (
          await one(
            "SELECT count(*)::int AS n FROM rms_dining.dining_item_service_record WHERE order_id=$1",
            [order.order],
          )
        )[0].n;
      const outcomes = (result) => result.lines.map((line) => line.outcome);
      // A page still holding version 2 (both lines then waiting to be served) serves nothing:
      // line A's Order revision moved on and line B was cancelled meanwhile.
      const stale = await serveReady(
        readyRequest(fresh(), 2, [
          [refs.items[0], LINES[0].quantity],
          [refs.items[1], LINES[1].quantity],
        ]),
      );
      assert.deepEqual(outcomes(stale), ["Changed", "Changed"]);
      assert.equal(await serviceRecords(), 0);
      // The current page's request serves line A; its retry (same reference) serves nothing twice.
      const batchReference = fresh();
      const current = readyRequest(batchReference, ready.currentOrderVersion, [
        [refs.items[0], LINES[0].quantity],
      ]);
      const servedAll = await serveReady(current);
      assert.deepEqual(
        [servedAll.served, servedAll.alreadyServed, servedAll.changed, servedAll.failed],
        [1, 0, 0, 0],
      );
      assert.deepEqual(outcomes(await serveReady(current)), ["Served"]);
      assert.equal(await serviceRecords(), 1);
      // Another device that still shows line A ready finds it already served; so does a single
      // serve with a new operation.
      assert.deepEqual(
        outcomes(
          await serveReady(
            readyRequest(fresh(), ready.currentOrderVersion, [[refs.items[0], LINES[0].quantity]]),
          ),
        ),
        ["AlreadyServed"],
      );
      await assert.rejects(serve(serveCommand(ready.currentOrderVersion)), {
        code: "DINING_ITEM_SERVICE_UNAVAILABLE",
      });
      assert.equal(await serviceRecords(), 1);
      const delivered = await progress();
      assert.equal(delivered.phase, "Fulfilled");
      // The guest's Order phase: line A served, line B cancelled — Fulfilled (Dining publishes no
      // event; before this the phase stopped short of Fulfilled after serving).
      assert.equal(await orderPhase(), "Fulfilled");
      assert.deepEqual(phases(delivered), [
        [refs.items[0], "Fulfilled", LINES[0].quantity],
        [refs.items[1], "Cancelled", 0],
      ]);

      // ── The Order closes: the cancelled line was refunded (Payment settled), the remaining
      // line was served, and the close records the Order's financial finality at version 3.
      const closed = await closeOrder({
        ...session,
        command: {
          orderReference: order.order,
          operationReference: fresh(),
          expectedOrderVersion: delivered.currentOrderVersion,
          expectedClosureVersion: delivered.closureVersion,
          reasonCode: "ORDER_COMPLETED",
        },
      });
      assert.deepEqual(closed, { status: "Committed", closedOrderVersion: 3, closureVersion: 1 });
      assert.deepEqual(
        await one(
          "SELECT (SELECT count(*)::int FROM rms_ordering.order_closure_version WHERE order_id=$1 AND status='Closed') AS closures,(SELECT count(*)::int FROM rms_payment.order_settled_finality WHERE order_id=$1) AS finalities",
          [order.order],
        ),
        [{ closures: 1, finalities: 1 }],
      );
      assert.equal((await progress()).closureStatus, "Closed");
      // Served and paid: the table closes.
      assert.equal((await tableClosing("Finalize")).phase, "Closed");
      // Closing the table's Order keeps the served Order Fulfilled.
      assert.equal(await orderPhase(), "Fulfilled");
      assert.deepEqual(
        [...new Set(merchant.actions)].sort(),
        ["dining.item.serve", "order.close", "ordering.order.cancel"].sort(),
      );
    } finally {
      for (const name of [role, other]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
