import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { createPersistentMerchantSettlement } from "../../../apps/api/src/persistent-merchant-settlement.ts";
import { createPersistentMerchantStoreReports } from "../../../apps/api/src/persistent-merchant-store-reports.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { seedJourneyStorePublication } from "../test-support/dine-in-journey-seed.mjs";
import { seedStaffItemCancellationQuote } from "../test-support/staff-item-cancellation-pricing.mjs";

const { Client } = pg;
const id = (n) => "01a7d000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) =>
  "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
const minutes = (n) => n * 60_000;
let freshNumber = 0x80000;
const fresh = () => id(freshNumber++);
const provider = id(20);
const ACTOR = id(10);

/**
 * WP-2423 Q14: the Store sales reports over a seeded business day — an online pickup with a tip, a
 * dine-in table paid round by round (two paid rounds, a third round never paid), two counter orders
 * paid on the Store's card machine (one with a tip, one cancelled and refunded on the machine) and a
 * counter order from the previous business day that could not be fulfilled and was refunded today.
 *
 * The report and the day-end settlement run as a restricted NOBYPASSRLS role holding exactly the
 * rendered pilot API grants; prices and tax (13% exclusive) come from the Pricing owner and the
 * Ordering snapshots copy them (test-only synthetic values). Owner-seeded facts are named below.
 */
it("reports a business day's sales, items, hours and tips, matches the settlement and exports CSV", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_store_reports" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_rp_" + context.runId,
      worker = "wp2423_rp_w_" + context.runId;
    vi.stubEnv("NODE_ENV", "development");
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));

      const queryLog = [];
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL statement_timeout = '20s'");
            await client.query("SET LOCAL lock_timeout = '5s'");
            const result = await work({
              query: (sql, values) => {
                queryLog.push(sql);
                return client.query(sql, values === undefined ? [] : [...values]);
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
      const scope = { brandReference: id(1), storeReference: id(2) };
      const ownerScope = { tenantReference: id(3), ...scope };
      const ownerRunner = {
        async run(work) {
          await admin.query("BEGIN");
          try {
            await admin.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [ownerScope.tenantReference, scope.brandReference, scope.storeReference],
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
      const now = () => new Date().toISOString();
      const session = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        scope: ownerScope,
        actor: ACTOR,
        at: now(),
        extraPermissions: [
          "operations.order-exception.manage",
          "reporting.sales.read",
          "reporting.sales.export",
          // Catalog v17: the day-end settlement the reports are compared with.
          "payment.settlement.read",
        ],
      });
      // Synthetic test-only Store configuration: today's business day began three hours ago.
      const local = (instant, options) =>
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "America/Toronto",
          hourCycle: "h23",
          ...options,
        }).format(new Date(instant));
      const dayStart = local(time(-minutes(180)), { hour: "2-digit", minute: "2-digit" }) + ":00";
      // Today's business date is the Store-local date at its start (three hours ago).
      const today = local(time(-minutes(180)), {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .split("/")
        .reverse()
        .join("-");
      // Published before yesterday began and before the UTC noon that anchors yesterday's
      // boundaries, within the synthetic live gate's two-day validity.
      const yesterdayNoon = Date.parse(today + "T12:00:00.000Z") - 86_400_000;
      await seedJourneyStorePublication({
        client: admin,
        scope: ownerScope,
        publishedAt: new Date(
          Math.min(base - minutes(60 * 30), yesterdayNoon - minutes(120)),
        ).toISOString(),
        businessDayStart: dayStart,
        prefix: "01a7d100",
      });

      // ── Owner-seeded Orders: Pricing quote → Ordering snapshot rows, then the payment facts.
      const products = {
        latteLarge: { name: "Synthetic latte — Large", unit: 500, sellable: id(601) },
        latteSmall: { name: "Synthetic latte — Small", unit: 400, sellable: id(602) },
        muffin: { name: "Synthetic muffin", unit: 300, sellable: id(603) },
      };
      let sequence = 1;
      const headers = new Set();
      async function seedBatch({
        n,
        batch,
        orderType,
        sourceChannel,
        lines,
        submittedAt,
        businessDate,
      }) {
        const order = id(n),
          refs = {
            batch: id(n + 10 + batch),
            submission: id(n + 20 + batch),
            cart: id(n + 30 + batch),
            quote: id(n + 40 + batch),
            checkout: id(n + 50 + batch),
          };
        if (!headers.has(order)) {
          headers.add(order);
          const number = String(sequence++);
          await admin.query(
            "INSERT INTO rms_ordering.order_number_allocation (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,business_date_configuration_id,business_date_configuration_version,business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) VALUES ($1,$2,$3,$4,$5,$10,$6,$7,1,$8,'America/Toronto',$9,$6,'Exact')",
            [
              order,
              scope.brandReference,
              scope.storeReference,
              businessDate,
              number,
              submittedAt,
              id(50),
              hash("bd"),
              dayStart.slice(0, 5),
              number,
            ],
          );
          await admin.query(
            "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,1,'Submitted','Open','NotReported',$10)",
            [
              order,
              scope.brandReference,
              scope.storeReference,
              businessDate,
              number,
              orderType,
              sourceChannel,
              orderType === "DineIn" ? id(n + 9) : null,
              id(n + 8),
              submittedAt,
            ],
          );
        }
        const items = lines.map((_, j) => id(n + 100 + batch * 10 + j));
        const { quote, snapshots } = await seedStaffItemCancellationQuote({
          runner: ownerRunner,
          scope,
          orderBatchReference: refs.batch,
          quoteReference: refs.quote,
          cartReference: refs.cart,
          cartVersion: 1,
          inputDigest: hash(["quote-input", n, batch]),
          quotedAt: new Date(Date.parse(submittedAt) - minutes(2)).toISOString(),
          capturedAt: new Date(Date.parse(submittedAt) - minutes(1)).toISOString(),
          addedAt: new Date(Date.parse(submittedAt) - minutes(5)).toISOString(),
          actorReference: id(n + 8),
          nextReference: fresh,
          lines: lines.map(([product, quantity], j) => ({
            name: product.name,
            unitAmountMinor: product.unit,
            quantity,
            cartLineReference: id(n + 200 + batch * 10 + j),
            orderItemReference: items[j],
            sellableReference: product.sellable,
            priceEntryReference: id(n + 300 + batch * 10 + j),
          })),
        });
        await admin.query(
          "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at,submission_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10)",
          [
            refs.submission,
            scope.brandReference,
            scope.storeReference,
            order,
            id(n + 8),
            hash(["intent", n, batch]),
            refs.cart,
            refs.quote,
            submittedAt,
            batch === 0 ? "Initial" : "Additional",
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_batch (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)",
          [
            refs.batch,
            scope.brandReference,
            scope.storeReference,
            order,
            refs.submission,
            refs.cart,
            refs.checkout,
            refs.quote,
            id(n + 8),
            submittedAt,
          ],
        );
        for (const [j, item] of items.entries()) {
          const snapshot = JSON.parse(snapshots[j]);
          await admin.query(
            "INSERT INTO rms_ordering.order_item (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)",
            [
              item,
              scope.brandReference,
              scope.storeReference,
              order,
              refs.batch,
              id(n + 200 + batch * 10 + j),
              lines[j][1],
              snapshot.catalog.snapshotDigest,
              snapshot.pricing.quoteInputDigest,
              snapshots[j],
              snapshot.snapshotCapturedAt,
              j + 1,
            ],
          );
        }
        return {
          order,
          batch: refs.batch,
          submission: refs.submission,
          cart: refs.cart,
          quote: refs.quote,
          guest: id(n + 8),
          submittedAt,
          total: quote.total.amountMinor,
        };
      }
      /** Owner-seeded online capture (Provider facts as the paid pickup seeder writes them). */
      async function payOnline(paid, tip, paidAt, n) {
        const intent = id(n + 1),
          attempt = id(n + 2),
          transaction = id(n + 3),
          observation = id(n + 4),
          webhook = id(n + 5),
          operation = id(n + 6),
          created = new Date(Date.parse(paidAt) - minutes(5)).toISOString();
        const total = paid.total + BigInt(tip);
        await admin.query(
          "INSERT INTO rms_payment.payment_intent (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,creation_status,prepared_at,capacity_expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,$15,$16,$17,'CAD','OnlineCard','Automatic',1,'ProviderCreatePending',$18,$19,$18)",
          [
            intent,
            scope.brandReference,
            scope.storeReference,
            operation,
            paid.order,
            paid.batch,
            paid.submission,
            id(n + 7),
            id(n + 8),
            id(n + 9),
            id(n + 10),
            id(n + 11),
            hash(["intent", n]),
            hash(["preparation", n]),
            paid.total,
            tip,
            total,
            created,
            new Date(Date.parse(created) + minutes(30)).toISOString(),
          ],
        );
        await admin.query(
          "INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,provider_environment,provider_idempotency_digest,created_at) VALUES ($1,$2,$3,$4,1,'Stripe','Test',$5,$6)",
          [attempt, scope.brandReference, scope.storeReference, intent, hash(["idem", n]), created],
        );
        await admin.query(
          "INSERT INTO rms_payment.payment_intent_operation_record (payment_operation_id,brand_id,store_id,payment_intent_id,guest_session_id,intent_digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [
            operation,
            scope.brandReference,
            scope.storeReference,
            intent,
            id(n + 7),
            hash(["intent", n]),
            created,
          ],
        );
        await admin.query(
          "INSERT INTO rms_payment.payment_provider_observation (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,observation_kind,normalized_status,provider_intent_reference,provider_transaction_reference,requested_minor,authorized_minor,captured_minor,refunded_minor,currency_code,evidence_digest,provider_observed_at,recorded_at) VALUES ($1,$2,$3,$4,$5,'Snapshot','Captured',$6,$7,$8,$8,$8,0,'CAD',$9,$10,$10)",
          [
            observation,
            scope.brandReference,
            scope.storeReference,
            intent,
            attempt,
            "pi_SYNTHETICQ14" + n,
            "ch_SYNTHETICQ14" + n,
            total,
            hash(["observation", n]),
            paidAt,
          ],
        );
        const event = "evt_SYNTHETICQ14" + String(n).padStart(8, "0");
        await admin.query(
          "INSERT INTO rms_payment.provider_webhook_record (webhook_receipt_id,brand_id,store_id,provider,provider_environment,provider_account_id,provider_event_id,provider_event_type,provider_created_at,received_at,signature_timestamp,evidence_digest,accepted_at,raw_evidence_expires_at,dedupe_expires_at) VALUES ($1,$2,$3,'Stripe','Test',$4,$5,'payment_intent.succeeded',$6,$6,$6,$7,$6,$6::timestamptz+interval '30 days',$6::timestamptz+interval '90 days')",
          [
            webhook,
            scope.brandReference,
            scope.storeReference,
            provider,
            event,
            paidAt,
            hash(["webhook", n]),
          ],
        );
        await admin.query(
          "INSERT INTO rms_payment.payment_terminal_fact (payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,provider_intent_reference,provider_observation_id,authoritative_source,terminal_outcome,amount_minor,currency_code,failure_reason,retry_disposition,occurred_at,recorded_at,evidence_digest,event_id,causation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Test',$10,$11,'VerifiedWebhook','Succeeded',$12,'CAD',NULL,NULL,$13,$13,$14,$15,$7)",
          [
            transaction,
            scope.brandReference,
            scope.storeReference,
            intent,
            attempt,
            paid.order,
            webhook,
            event,
            provider,
            "pi_SYNTHETICQ14" + n,
            observation,
            total,
            paidAt,
            hash(["terminal", n]),
            id(n + 12),
          ],
        );
      }
      /** Owner-seeded card-machine payment, as the counter's "Taken on card machine" records it. */
      async function payOnCardMachine(paid, tip, takenAt, n) {
        const total = paid.total + BigInt(tip);
        // The preparation the counter's "Send order" step records (Ordering evidence shape).
        const preparation = {
          preparationReference: id(n + 8),
          orderReference: paid.order,
          orderBatchReference: paid.batch,
          submissionReference: paid.submission,
          sourceCartReference: paid.cart,
          sourceCartVersion: 1,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          guestSessionReference: paid.guest,
          quoteReference: paid.quote,
          capacityAllocationReference: id(n + 9),
          readiness: "PaymentPending",
          transactionBoundary: "OrderSubmissionPaymentPreparation",
          orderAllocation: { amountMinor: String(paid.total), currencyCode: "CAD" },
          tip: { amountMinor: String(tip), currencyCode: "CAD" },
          total: { amountMinor: String(total), currencyCode: "CAD" },
          committedAt: paid.submittedAt,
          capacityExpiresAt: new Date(Date.parse(paid.submittedAt) + minutes(30)).toISOString(),
          sourceDigest: hash(["preparation", n]),
        };
        await admin.query(
          `INSERT INTO rms_payment.card_machine_payment VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'CAD','Test',NULL,'AtCounter',$17,$17,$18,$19,$20)`,
          [
            ownerScope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            id(n + 1),
            id(n + 2),
            id(n + 3),
            id(n + 4),
            id(n + 5),
            hash(["card", n]),
            paid.order,
            paid.batch,
            paid.submission,
            JSON.stringify(preparation),
            paid.total,
            tip,
            total,
            takenAt,
            ACTOR,
            id(n + 6),
            id(n + 7),
          ],
        );
        return { payment: id(n + 1), total };
      }
      async function refundOnCardMachine(card, order, kind, amount, refundedAt, n) {
        await admin.query(
          `INSERT INTO rms_payment.card_machine_refund VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CAD',NULL,$12,$12,$13,$14)`,
          [
            ownerScope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            id(n + 1),
            card.payment,
            order,
            id(n + 2),
            hash(["refund", n]),
            kind,
            id(n + 3),
            amount,
            refundedAt,
            ACTOR,
            id(n + 4),
          ],
        );
      }

      const yesterdayAt = time(-minutes(300));
      // The business day before today (yesterdayAt is before today's start, three hours ago).
      const yesterday = new Date(Date.parse(today + "T00:00:00.000Z") - 86_400_000)
        .toISOString()
        .slice(0, 10);
      const { latteLarge, latteSmall, muffin } = products;
      // Online pickup, tip 2.00.
      const p1 = await seedBatch({
        n: 0x1000,
        batch: 0,
        orderType: "Pickup",
        sourceChannel: "Web",
        lines: [
          [latteLarge, 2],
          [muffin, 1],
        ],
        submittedAt: time(-minutes(130)),
        businessDate: today,
      });
      await payOnline(p1, 200, time(-minutes(125)), 0x1500);
      // Dine-in table: round 1 (tip 1.00) and round 2 paid online; round 3 never paid.
      const t1 = await seedBatch({
        n: 0x2000,
        batch: 0,
        orderType: "DineIn",
        sourceChannel: "Qr",
        lines: [[latteLarge, 1]],
        submittedAt: time(-minutes(100)),
        businessDate: today,
      });
      await payOnline(t1, 100, time(-minutes(98)), 0x2500);
      const t2 = await seedBatch({
        n: 0x2000,
        batch: 1,
        orderType: "DineIn",
        sourceChannel: "Qr",
        lines: [[muffin, 2]],
        submittedAt: time(-minutes(60)),
        businessDate: today,
      });
      await payOnline(t2, 0, time(-minutes(58)), 0x2600);
      await seedBatch({
        n: 0x2000,
        batch: 2,
        orderType: "DineIn",
        sourceChannel: "Qr",
        lines: [[latteSmall, 1]],
        submittedAt: time(-minutes(30)),
        businessDate: today,
      });
      // Counter orders on the Store's card machine: one with a 0.50 tip, one cancelled and refunded.
      const c1 = await seedBatch({
        n: 0x3000,
        batch: 0,
        orderType: "Pickup",
        sourceChannel: "Pos",
        lines: [[latteSmall, 1]],
        submittedAt: time(-minutes(90)),
        businessDate: today,
      });
      await payOnCardMachine(c1, 50, time(-minutes(89)), 0x3500);
      const c2 = await seedBatch({
        n: 0x4000,
        batch: 0,
        orderType: "Pickup",
        sourceChannel: "Pos",
        lines: [[muffin, 1]],
        submittedAt: time(-minutes(80)),
        businessDate: today,
      });
      const c2Card = await payOnCardMachine(c2, 0, time(-minutes(79)), 0x4500);
      await refundOnCardMachine(
        c2Card,
        c2.order,
        "StaffCancellation",
        c2Card.total,
        time(-minutes(75)),
        0x4600,
      );
      // Yesterday's counter order, paid then and refunded today (could not be fulfilled).
      const c0 = await seedBatch({
        n: 0x5000,
        batch: 0,
        orderType: "Pickup",
        sourceChannel: "Pos",
        lines: [[latteSmall, 1]],
        submittedAt: new Date(Date.parse(yesterdayAt) - minutes(2)).toISOString(),
        businessDate: yesterday,
      });
      const c0Card = await payOnCardMachine(c0, 0, yesterdayAt, 0x5500);
      await refundOnCardMachine(
        c0Card,
        c0.order,
        "UnfulfillableOrder",
        c0Card.total,
        time(-minutes(20)),
        0x5600,
      );
      // 13% test-only tax on these synthetic prices.
      assert.deepEqual(
        [p1.total, t1.total, t2.total, c1.total, c2.total],
        [1469n, 565n, 678n, 452n, 339n],
      );

      const persistence = {
        ...session.persistence,
        transactions,
        now,
        publication: {
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
        },
      };
      const resolveConfiguration = async () => ({
        providerAccountReference: provider,
        environment: "Test",
      });
      const reports = createPersistentMerchantStoreReports({ persistence, resolveConfiguration });
      const settlement = createPersistentMerchantSettlement({
        persistence,
        resolveConfiguration,
        settlementRunReference: async () => null,
      });
      const cookie = session.sessionCookie;

      // ── Today: summary, payment and order-type splits.
      const view = await reports.read({ sessionCookie: cookie, from: null, to: null });
      assert.equal(view.from, today);
      assert.equal(view.includesOpenDay, true);
      assert.deepEqual(
        {
          paymentCount: view.summary.paymentCount,
          orderCount: view.summary.orderCount,
          gross: view.summary.grossSalesMinor,
          discounts: view.summary.discountsMinor,
          net: view.summary.netSalesMinor,
          tax: view.summary.taxMinor,
          tips: view.summary.tipsMinor,
          collected: view.summary.collectedMinor,
          unmatched: view.summary.unmatchedMinor,
          refundCount: view.summary.refundCount,
          refunds: view.summary.refundsMinor,
          refundParts: view.summary.refunds,
          netCollected: view.summary.netCollectedMinor,
        },
        {
          paymentCount: 5,
          orderCount: 4,
          gross: "3100",
          discounts: "0",
          net: "3100",
          tax: "403",
          tips: "350",
          collected: "3853",
          unmatched: "0",
          refundCount: 2,
          refunds: "791",
          refundParts: {
            salesMinor: "700",
            taxMinor: "91",
            tipsMinor: "0",
            serviceChargesMinor: "0",
            notItemizedMinor: "0",
          },
          netCollected: "3062",
        },
      );
      const byChannel = Object.fromEntries(
        view.byChannel.map((entry) => [
          entry.channel,
          [entry.paymentCount, entry.collectedMinor, entry.tipsMinor, entry.refundsMinor],
        ]),
      );
      assert.deepEqual(byChannel, {
        Online: [3, "3012", "300", "0"],
        CardMachine: [2, "841", "50", "791"],
        // DEC-DINE-IN-PAY-LATER (33ba39a4): tables paid in cash have their own channel (none here).
        Cash: [0, "0", "0", "0"],
      });
      const byType = Object.fromEntries(
        view.byOrderType.map((entry) => [
          entry.orderType,
          [entry.orderCount, entry.paymentCount, entry.netSalesMinor, entry.refundsMinor],
        ]),
      );
      // The table's unpaid third round is not a sale; yesterday's counter order is not a sale of
      // today but its refund today counts in Counter.
      assert.deepEqual(byType, {
        DineIn: [1, 2, "1100", "0"],
        Pickup: [1, 1, "1300", "0"],
        Counter: [2, 2, "700", "791"],
      });

      // ── Items (name and size), hours (store time) and tips.
      assert.deepEqual(
        view.items.map((row) => [
          row.name,
          row.quantitySold,
          row.netSalesMinor,
          row.refundedQuantity,
          row.refundsMinor,
          row.netAfterRefundsMinor,
        ]),
        [
          ["Synthetic latte — Large", 3, "1500", 0, "0", "1500"],
          ["Synthetic muffin", 4, "1200", 1, "300", "900"],
          ["Synthetic latte — Small", 1, "400", 1, "400", "0"],
        ],
      );
      const hourOf = (offset) =>
        local(time(-minutes(offset)), { hour: "2-digit" }).padStart(2, "0") + ":00";
      const expectedHours = new Map();
      for (const [offset, collected] of [
        [125, 1669],
        [98, 665],
        [89, 502],
        [79, 339],
        [58, 678],
      ])
        expectedHours.set(hourOf(offset), (expectedHours.get(hourOf(offset)) ?? 0) + collected);
      assert.deepEqual(
        Object.fromEntries(view.hours.map((row) => [row.hour, Number(row.collectedMinor)])),
        Object.fromEntries(expectedHours),
      );
      assert.deepEqual(view.tips, [
        {
          businessDate: today,
          channels: [
            { channel: "Online", tipsMinor: "300", refundedMinor: "0", netMinor: "300" },
            { channel: "CardMachine", tipsMinor: "50", refundedMinor: "0", netMinor: "50" },
            { channel: "Cash", tipsMinor: "0", refundedMinor: "0", netMinor: "0" },
          ],
        },
      ]);
      assert.equal(view.permissions.mayExport, true);

      // ── Reconciliation: the same figures as the day-end settlement for the day.
      assert.equal(view.reconciliation.matchesSettlement, true);
      const day = await settlement({ sessionCookie: cookie, businessDate: today });
      assert.equal(day.captured.amountMinor, byChannel.Online[1]);
      assert.equal(day.captured.count, byChannel.Online[0]);
      assert.equal(day.refunded.amountMinor, byChannel.Online[3]);
      assert.deepEqual(day.cardMachine, {
        taken: { count: 2, amountMinor: "841", currencyCode: "CAD" },
        tipMinor: "50",
        recordedAfterOutageCount: 0,
        refunded: { count: 2, amountMinor: "791", currencyCode: "CAD" },
      });
      assert.equal(
        BigInt(day.captured.amountMinor) + BigInt(day.cardMachine.taken.amountMinor),
        BigInt(view.summary.collectedMinor),
      );
      assert.equal(
        BigInt(day.refunded.amountMinor) + BigInt(day.cardMachine.refunded.amountMinor),
        BigInt(view.summary.refundsMinor),
      );

      // ── WP-2423 item 8 ② (closing summary): tonight is today's report itself — the same
      // sources and computation — so it matches the day-end settlement for the day.
      const tonight = await reports.tonight({ sessionCookie: cookie });
      // An open day ends at the moment it is read: compare everything else.
      const figures = (value) =>
        JSON.parse(
          JSON.stringify(value, (key, entry) =>
            key === "endsAt" || key === "generatedAt" ? undefined : entry,
          ),
        );
      assert.deepEqual(
        figures(tonight.report),
        figures(await reports.read({ sessionCookie: cookie, from: null, to: null })),
      );
      const tonightChannel = Object.fromEntries(
        tonight.report.byChannel.map((entry) => [entry.channel, entry]),
      );
      assert.equal(tonightChannel.Online.collectedMinor, day.captured.amountMinor);
      assert.equal(tonightChannel.Online.refundsMinor, day.refunded.amountMinor);
      assert.equal(tonightChannel.CardMachine.collectedMinor, day.cardMachine.taken.amountMinor);
      assert.equal(tonightChannel.CardMachine.tipsMinor, day.cardMachine.tipMinor);
      assert.equal(tonightChannel.CardMachine.refundsMinor, day.cardMachine.refunded.amountMinor);
      assert.equal(tonight.report.reconciliation.matchesSettlement, true);
      // No table is open and nothing was cancelled in this seeded day.
      assert.deepEqual(tonight.openTables, []);
      assert.equal(tonight.openTablesOwedMinor, "0");
      assert.deepEqual(tonight.cancelled, {
        removedBeforePayment: { dishCount: 0, amountMinor: "0" },
        cancelledAfterPayment: { dishCount: 0, amountMinor: "0" },
        cancelledUnpaid: { roundCount: 0, dishCount: 0, amountMinor: "0" },
      });

      // ── Yesterday and the two-day range, each matching that day's settlement.
      const before = await reports.read({ sessionCookie: cookie, from: yesterday, to: yesterday });
      assert.equal(before.includesOpenDay, false);
      assert.equal(before.summary.collectedMinor, "452");
      assert.equal(before.summary.refundsMinor, "0");
      assert.equal(before.reconciliation.matchesSettlement, true);
      const closed = await settlement({ sessionCookie: cookie, businessDate: yesterday });
      assert.equal(closed.cardMachine.taken.amountMinor, "452");
      const both = await reports.read({ sessionCookie: cookie, from: yesterday, to: today });
      assert.deepEqual(
        both.days.map((entry) => [entry.businessDate, entry.status, entry.summary.collectedMinor]),
        [
          [yesterday, "Closed", "452"],
          [today, "Open", "3853"],
        ],
      );
      assert.equal(both.summary.collectedMinor, "4305");
      assert.equal(both.reconciliation.matchesSettlement, true);
      // The latte sold yesterday and refunded today nets to zero over the two days.
      assert.deepEqual(
        both.items.find((row) => row.name === "Synthetic latte — Small"),
        {
          name: "Synthetic latte — Small",
          quantitySold: 2,
          grossSalesMinor: "800",
          discountsMinor: "0",
          compsMinor: "0",
          netSalesMinor: "800",
          refundedQuantity: 1,
          refundsMinor: "400",
          netAfterRefundsMinor: "400",
        },
      );
      // ── Query budget (regression for the 16 s week report on v15): the caller's scope is
      // resolved at the start and once before the reply, not inside every owner read, and a
      // longer range adds only the Store's window for each extra closed day — never per-day
      // payment, refund or order reads, nor per-order queries.
      const counted = async (from, to) => {
        queryLog.length = 0;
        await reports.read({ sessionCookie: cookie, from, to });
        return {
          total: queryLog.length,
          scopeResolutions: queryLog.filter((sql) =>
            sql.includes("FROM bop_identity.browser_session_selection"),
          ).length,
          paymentAndOrderReads: queryLog.filter((sql) => /\brms_(payment|ordering)\./u.test(sql))
            .length,
        };
      };
      const oneDay = await counted(today, today),
        twoDays = await counted(yesterday, today);
      assert.ok(oneDay.total <= 160, "one day's report took " + oneDay.total + " queries");
      assert.ok(
        oneDay.scopeResolutions <= 6,
        "scope resolved " + oneDay.scopeResolutions + " times",
      );
      assert.equal(twoDays.scopeResolutions, oneDay.scopeResolutions);
      assert.equal(twoDays.paymentAndOrderReads, oneDay.paymentAndOrderReads);
      assert.ok(
        twoDays.total - oneDay.total <= 40,
        "an extra closed day cost " + (twoDays.total - oneDay.total) + " queries",
      );

      // A future day, a reversed range and more than 31 days are refused.
      await assert.rejects(reports.read({ sessionCookie: cookie, from: today, to: "2999-01-01" }));
      await assert.rejects(reports.read({ sessionCookie: cookie, from: today, to: yesterday }));
      await assert.rejects(reports.read({ sessionCookie: cookie, from: "2000-01-01", to: today }));

      // ── CSV: UTF-8 with a header row, business date column, decimal money, no customer data.
      const items = await reports.export({
        sessionCookie: cookie,
        from: yesterday,
        to: today,
        report: "items",
      });
      assert.equal(items.fileName, `items-${yesterday}-to-${today}.csv`);
      assert.ok(items.body.startsWith("﻿"));
      const rows = items.body.slice(1).trimEnd().split("\r\n");
      assert.equal(
        rows[0],
        "business_date,item,quantity_sold,gross_sales,discounts,comps_and_discounts_by_manager,net_sales,refunded_quantity,refunds,net_after_refunds,currency",
      );
      assert.ok(
        rows.includes(`${yesterday},Synthetic latte — Small,1,4.00,0.00,0.00,4.00,0,0.00,4.00,CAD`),
      );
      assert.ok(
        rows.includes(`${today},Synthetic latte — Small,1,4.00,0.00,0.00,4.00,1,4.00,0.00,CAD`),
      );
      assert.ok(rows.includes(`${today},Synthetic muffin,4,12.00,0.00,0.00,12.00,1,3.00,9.00,CAD`));
      const summaryCsv = (
        await reports.export({ sessionCookie: cookie, from: today, to: today, report: "summary" })
      ).body;
      assert.match(
        summaryCsv,
        new RegExp(
          // Comps (none) after discounts; cash and written-off tables (none) after the channels.
          `\\r\\n${today},open \\(so far\\),5,4,31\\.00,0\\.00,0\\.00,0,31\\.00,0\\.00,4\\.03,4\\.03,3\\.50,38\\.53,7\\.91,30\\.62,30\\.12,8\\.41,0\\.00,0\\.00,7\\.91,0\\.00,0\\.00,0,0\\.00,CAD\\r\\n$`,
          "u",
        ),
      );
      const tipsCsv = (
        await reports.export({ sessionCookie: cookie, from: today, to: today, report: "tips" })
      ).body;
      assert.ok(tipsCsv.includes(`${today},Store card machine,0.50,0.00,0.50,CAD`));
      const hourlyCsv = (
        await reports.export({ sessionCookie: cookie, from: today, to: today, report: "hourly" })
      ).body;
      for (const body of [items.body, summaryCsv, tipsCsv, hourlyCsv])
        assert.doesNotMatch(body, /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u, "no references");

      // ── Reading never implies exporting; without the read permission nothing is shown.
      const grant = (n) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [grant(25)],
      );
      const readOnly = await reports.read({ sessionCookie: cookie, from: null, to: null });
      assert.equal(readOnly.permissions.mayExport, false);
      await assert.rejects(
        reports.export({ sessionCookie: cookie, from: today, to: today, report: "items" }),
      );
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [grant(24)],
      );
      await assert.rejects(reports.read({ sessionCookie: cookie, from: null, to: null }));
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      for (const name of [api, worker])
        await admin
          .query("DROP OWNED BY " + name + " CASCADE")
          .then(() => admin.query("DROP ROLE " + name))
          .catch(() => undefined);
      await admin.end();
    }
  });
});
