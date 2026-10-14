import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { URL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { it } from "vitest";
import {
  createPostgresOrderAcceptanceHoldStore,
  isPaidOrderWithinAcceptanceWindow,
  listStoreOrderAcceptanceHolds,
  loadOrderNotAcceptedClosure,
  resolveOrderAcceptanceDeadline,
} from "../../rms/ordering/src/index.ts";
import {
  loadStoreBackOnlineAfter,
  loadStorePresence,
  recordStorePresence,
} from "../../rms/store/src/index.ts";
import { createOrderAcceptanceHoldEvaluator } from "../../../apps/api/src/order-acceptance-hold-evaluator.ts";
import { currentAcceptanceDeadline } from "../../../apps/api/src/order-pending-acceptance-source.ts";
import { readStaffCancellationRefundStatus } from "../../../apps/api/src/merchant-order-staff-cancellation.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "0190b1d0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const [tenant, brand, store, actor, manager] = [1, 2, 3, 4, 5].map(id);
const scope = { brandReference: brand, storeReference: store };
const minutes = (n) => n * 60_000;
let sequence = 100_000;
const next = () => id(sequence++);

/**
 * WP-2423 Q9-G1 (DEC-OUTAGE-ACCEPTANCE-HOLD). Under a restricted NOBYPASSRLS role holding exactly
 * the rendered pilot API grants (matrix plus additions): Store presence is recorded in bounded
 * periods; a paid pickup whose deadline passed while staff were online is left to the ordinary
 * expiry refund; one whose deadline passed while the Store was offline is held (no refund), gets
 * back-online + 15 minutes once staff return, can be accepted in that window, and is refunded after
 * it lapses; a manager's refund ends a hold at once; holds never race an acceptance.
 */
it("holds paid pickups through a Store outage and lets staff decide after recovery", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_outage_hold" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_oh_" + context.runId,
      other = "wp2423_oh_w_" + context.runId;
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
          await client.query("SET LOCAL lock_timeout='10s'");
          await client.query("SET LOCAL statement_timeout='20s'");
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
      const T = (offset) => new Date(base + minutes(offset)).toISOString();

      // --- Store presence: bounded periods with outage gaps between them ---------------------
      const touch = (at) =>
        scoped((tx) =>
          recordStorePresence(tx, scope, { observedAt: at, newPeriodReference: next }),
        );
      assert.equal(await touch(T(-200)), "Started");
      assert.equal(await touch(new Date(base - minutes(200) + 30_000).toISOString()), "Unchanged");
      for (let m = -199; m <= -180; m++) assert.equal(await touch(T(m)), "Extended");
      // Concurrent first requests after an outage start exactly one period.
      const started = await Promise.all([0, 1, 2, 3, 4].map(() => touch(T(-100))));
      assert.equal(started.filter((value) => value === "Started").length, 1);
      for (let m = -99; m <= -88; m++) await touch(T(m));
      await touch(T(-60));
      await touch(T(-59));
      await touch(T(-58));
      const periods = await admin.query(
        "SELECT count(*)::int n FROM rms_store.store_presence_session WHERE brand_id=$1 AND store_id=$2",
        [brand, store],
      );
      assert.equal(periods.rows[0].n, 3);
      const presence = (at) => scoped((tx) => loadStorePresence(tx, scope, at));
      assert.deepEqual(await presence(T(-185)), {
        online: true,
        onlineSince: T(-200),
        lastSeenAt: T(-185),
        offlineSince: null,
      });
      assert.deepEqual(await presence(T(-120)), {
        online: false,
        onlineSince: null,
        lastSeenAt: T(-180),
        offlineSince: T(-180),
      });
      assert.equal(await scoped((tx) => loadStoreBackOnlineAfter(tx, scope, T(-120))), T(-100));
      assert.equal(await scoped((tx) => loadStoreBackOnlineAfter(tx, scope, T(-57))), null);
      // History is kept: no delete, no rewrite of a closed period, no overlapping period.
      await assert.rejects(
        scoped((tx) =>
          tx.query("DELETE FROM rms_store.store_presence_session WHERE brand_id=$1", [brand]),
        ),
      );
      await assert.rejects(
        scoped((tx) =>
          tx.query(
            "UPDATE rms_store.store_presence_session SET last_seen_at=$2 WHERE brand_id=$1 AND started_at=$3",
            [brand, T(-179), T(-200)],
          ),
        ),
      );
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_store.store_presence_session (brand_id,store_id,session_id,started_at,last_seen_at) VALUES ($1,$2,$3,$4,$4)",
          [brand, store, next(), T(-95)],
        ),
      );

      // --- Paid pickup orders ------------------------------------------------------------------
      const businessDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(
        new Date(base - minutes(300)),
      );
      let orderNumber = 0;
      async function seedOrder(expiresAt) {
        orderNumber += 1;
        const refs = {
          order: next(),
          batch: next(),
          submission: next(),
          event: next(),
          transaction: next(),
          attempt: next(),
          expiresAt,
          committedAt: new Date(Date.parse(expiresAt) - minutes(30)).toISOString(),
          capturedAt: new Date(Date.parse(expiresAt) - minutes(25)).toISOString(),
        };
        const createdAt = refs.committedAt;
        await admin.query(
          "INSERT INTO rms_ordering.order_number_allocation " +
            "(order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at," +
            "business_date_configuration_id,business_date_configuration_version,business_date_content_digest," +
            "time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,'America/Toronto','00:00',$7,'Exact')",
          [
            refs.order,
            brand,
            store,
            businessDate,
            orderNumber,
            String(orderNumber),
            createdAt,
            id(50),
            hash("bd"),
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_header " +
            "(order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id," +
            "created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) " +
            "VALUES ($1,$2,$3,$4,$5,'Pickup','Web',NULL,$6,$6,1,'Submitted','Open','NotReported',$7)",
          [refs.order, brand, store, businessDate, String(orderNumber), actor, createdAt],
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
            next(),
            hash(["intent", orderNumber]),
            next(),
            next(),
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
            next(),
            next(),
            next(),
            actor,
            createdAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Initial',1,0,NULL,$1,$5)",
          [refs.submission, brand, store, refs.order, createdAt],
        );
        return refs;
      }
      const event = (refs) => ({
        eventId: refs.event,
        eventType: "PaymentSucceeded",
        schemaVersion: 1,
        occurredAt: refs.capturedAt,
        producerModule: "@rms/payment",
        tenantId: brand,
        storeId: store,
        aggregateType: "PaymentIntent",
        aggregateId: id(9),
        aggregateVersion: 2n,
        correlationId: id(10),
        causationId: id(11),
        actor: { type: "System" },
        payload: {
          paymentTransactionReference: refs.transaction,
          paymentIntentReference: id(9),
          paymentAttemptReference: refs.attempt,
          orderReference: refs.order,
          amountMinor: "1500",
          currencyCode: "CAD",
          evidenceKind: "Captured",
          terminalOccurredAt: refs.capturedAt,
        },
        redactionClassification: "payment",
        replayMetadata: { replaySafe: true },
      });
      const holds = createPostgresOrderAcceptanceHoldStore({
        ...scope,
        authorize: async () => true,
      });
      // The owner facts the paid context resolves (order, acceptance, capacity, holds) for a pickup.
      const paidContext = (byEvent, observedAt) => ({
        async resolve(tx, value) {
          const refs = byEvent.get(value.eventId);
          const accepted = await tx.query(
            "SELECT 1 FROM rms_ordering.order_acceptance_record WHERE brand_id=$1 AND store_id=$2 AND order_batch_id=$3",
            [brand, store, refs.batch],
          );
          return {
            order: { order: { orderType: "Pickup", canonicalPhase: "Submitted" } },
            acceptance: accepted.rows.length === 0 ? null : { accepted: true },
            initialExecution: { phase: "Submitted" },
            capacity: { commitment: { state: "PaymentPending" } },
            payment: {
              intent: {
                preparation: {
                  orderReference: refs.order,
                  orderBatchReference: refs.batch,
                  committedAt: refs.committedAt,
                  capacityExpiresAt: refs.expiresAt,
                },
              },
            },
            observedAt: observedAt.at,
            acceptanceDeadline: resolveOrderAcceptanceDeadline({
              capacityExpiresAt: refs.expiresAt,
              holds: await holds.listByBatch(tx, refs.batch),
            }),
          };
        },
      });
      const byEvent = new Map();
      const clock = { at: T(0) };
      const evaluator = createOrderAcceptanceHoldEvaluator({
        scope,
        context: paidContext(byEvent, clock),
        authorize: async () => true,
        reference: next,
        audit: { retentionPolicyCode: "FINANCIAL_COMPLIANCE", retentionPolicyVersion: 1 },
      });
      const evaluate = (refs, at) => {
        clock.at = at;
        return scoped((tx) => evaluator.evaluate(tx, event(refs)));
      };
      /** What the merchant acceptance and the paid outcome check: may it still be accepted? */
      const acceptable = async (refs, at) => {
        clock.at = at;
        const current = await scoped((tx) => paidContext(byEvent, clock).resolve(tx, event(refs)));
        return isPaidOrderWithinAcceptanceWindow({
          orderType: "Pickup",
          committedAt: refs.committedAt,
          capacityExpiresAt: refs.expiresAt,
          terminalOccurredAt: refs.capturedAt,
          observedAt: at,
          ...currentAcceptanceDeadline(current),
        });
      };
      const accept = (refs, at) =>
        scoped(async (tx) => {
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "OrderingOrderDisposition:" + brand + ":" + store + ":" + refs.order,
          ]);
          await tx.query(
            "INSERT INTO rms_ordering.order_acceptance_record (acceptance_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,accepted_order_version,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,accepted_at) VALUES ($1,$2,$3,$4,$5,$6,1,2,'User',$7,'ORDER_ACCEPTANCE','order.accept','SYNTHETIC',$8,$9,$10,$11)",
            [
              next(),
              next(),
              brand,
              store,
              refs.order,
              refs.batch,
              actor,
              next(),
              next(),
              hash(["accept", refs.order]),
              at,
            ],
          );
        });
      const dispose = (refs, at) =>
        admin.query(
          "INSERT INTO rms_ordering.order_payment_disposition_record " +
            "(disposition_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_transaction_id,payment_intent_id,payment_attempt_id,payment_event_id,source_checkpoint,correlation_id,source_version,source_digest,evaluated_at,disposition,reason,kitchen_release_disposition) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$6,$11,1,$12,$13,'PaidWithoutFulfillableOrder','CapacityExpired','Blocked')",
          [
            next(),
            brand,
            store,
            refs.order,
            refs.batch,
            refs.submission,
            refs.transaction,
            id(9),
            refs.attempt,
            refs.event,
            id(10),
            hash(["d", refs.order]),
            at,
          ],
        );
      const holdRows = async (refs) =>
        (
          await admin.query(
            "SELECT hold_sequence,lapsed_deadline,store_last_seen_at,held_at FROM rms_ordering.order_acceptance_hold WHERE order_batch_id=$1 ORDER BY hold_sequence",
            [refs.batch],
          )
        ).rows;
      const customerHold = (refs) =>
        scoped(async (tx) =>
          (await listStoreOrderAcceptanceHolds(tx, scope, [refs.order])).get(refs.order),
        );

      // A: deadline passed while staff were online → ordinary expiry refund, unchanged.
      const A = await seedOrder(T(-190));
      // B, C: deadline passed during the outage (staff last seen T-180, back at T-100).
      const B = await seedOrder(T(-120));
      const C = await seedOrder(T(-120));
      // D: deadline passes offline twice (T-80, then its decision deadline T-45); manager refunds.
      const D = await seedOrder(T(-80));
      // F: staff accept while the System is about to hold it.
      const F = await seedOrder(T(-80));
      for (const refs of [A, B, C, D, F]) byEvent.set(refs.event, refs);

      assert.equal(await evaluate(A, T(-189)), "Unchanged");
      assert.deepEqual(await holdRows(A), []);
      assert.equal(await acceptable(A, T(-189)), false); // the outcome closes and refunds it

      assert.equal(await evaluate(B, T(-119)), "Held");
      assert.equal(await evaluate(C, T(-119)), "Held");
      assert.equal(await evaluate(B, T(-110)), "Unchanged"); // still offline: no second hold
      const heldB = await holdRows(B);
      assert.equal(heldB.length, 1);
      assert.equal(heldB[0].lapsed_deadline.toISOString(), T(-120));
      assert.equal(heldB[0].store_last_seen_at.toISOString(), T(-180));
      // While held there is no deadline: not refunded, and still acceptable.
      assert.equal(await acceptable(B, T(-105)), true);
      assert.equal((await customerHold(B))?.resolutions.length, 0);

      // Staff are back at T-100: deadline becomes T-85.
      assert.equal(await evaluate(B, T(-99)), "Resumed");
      assert.equal(await evaluate(C, T(-99)), "Resumed");
      assert.equal(await evaluate(C, T(-98)), "Unchanged");
      const resolutions = await admin.query(
        "SELECT r.resolution,r.store_back_online_at,r.decide_by FROM rms_ordering.order_acceptance_hold_resolution r JOIN rms_ordering.order_acceptance_hold h USING (brand_id,store_id,hold_id) WHERE h.order_batch_id=$1",
        [B.batch],
      );
      assert.deepEqual(
        resolutions.rows.map((row) => [
          row.resolution,
          row.store_back_online_at.toISOString(),
          row.decide_by.toISOString(),
        ]),
        [["StoreBackOnline", T(-100), T(-85)]],
      );
      assert.equal(await acceptable(B, T(-95)), true);
      assert.equal(await acceptable(B, T(-85)), false);
      await accept(B, T(-95));
      assert.equal(await evaluate(B, T(-94)), "NotApplicable");
      assert.equal(await customerHold(B), undefined);

      // C lapses at T-85 with staff online → ordinary disposition and refund.
      assert.equal(await evaluate(C, T(-84)), "Unchanged");
      assert.equal(await acceptable(C, T(-84)), false);
      await dispose(C, T(-84));
      const closure = await scoped((tx) => loadOrderNotAcceptedClosure(tx, scope, C.order));
      assert.deepEqual(closure, {
        closedAt: T(-84),
        orderReference: C.order,
        paymentTransactionReference: C.transaction,
        paymentAttemptReference: C.attempt,
      });
      assert.equal(
        await scoped((tx) =>
          readStaffCancellationRefundStatus(tx, scope, closure, async () => true),
        ),
        "Pending",
      );
      assert.equal(await customerHold(C), undefined);
      // A closed batch never gets a hold or resolution (database fence).
      await assert.rejects(
        scoped((tx) =>
          tx.query(
            "INSERT INTO rms_ordering.order_acceptance_hold (hold_id,brand_id,store_id,order_id,order_batch_id,payment_event_id,hold_sequence,lapsed_deadline,store_last_seen_at,held_at) VALUES ($1,$2,$3,$4,$5,$6,2,$7,NULL,$8)",
            [next(), brand, store, C.order, C.batch, C.event, T(-85), T(-84)],
          ),
        ),
      );

      // F: an acceptance holding the Order's lock wins; the hold then finds the batch closed.
      const lockHolder = new Client(context.clientConfig);
      await lockHolder.connect();
      try {
        await lockHolder.query("BEGIN");
        await lockHolder.query("SET LOCAL ROLE " + role);
        await lockHolder.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        await lockHolder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "OrderingOrderDisposition:" + brand + ":" + store + ":" + F.order,
        ]);
        await lockHolder.query(
          "INSERT INTO rms_ordering.order_acceptance_record (acceptance_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,accepted_order_version,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,accepted_at) VALUES ($1,$2,$3,$4,$5,$6,1,2,'User',$7,'ORDER_ACCEPTANCE','order.accept','SYNTHETIC',$8,$9,$10,$11)",
          [
            next(),
            next(),
            brand,
            store,
            F.order,
            F.batch,
            actor,
            next(),
            next(),
            hash(["accept", F.order]),
            T(-79),
          ],
        );
        const racing = evaluate(F, T(-79));
        await setTimeout(300);
        await lockHolder.query("COMMIT");
        assert.equal(await racing, "Closed");
      } finally {
        await lockHolder.end();
      }
      assert.deepEqual(await holdRows(F), []);

      // D: offline at T-80 → held; back at T-60 → decide by T-45; offline again at T-45 → held
      // again (sequence 2); a manager then chooses to refund → closed at once, never re-held.
      assert.equal(await evaluate(D, T(-79)), "Held");
      assert.equal(await evaluate(D, T(-59)), "Resumed");
      assert.equal(await acceptable(D, T(-50)), true);
      assert.equal(await evaluate(D, T(-44)), "Held");
      const chain = await holdRows(D);
      assert.deepEqual(
        chain.map((row) => [
          row.hold_sequence,
          row.lapsed_deadline.toISOString(),
          row.store_last_seen_at.toISOString(),
        ]),
        [
          [1, T(-80), T(-88)],
          [2, T(-45), T(-58)],
        ],
      );
      const current = await customerHold(D);
      assert.equal(current.sequence, 2);
      const refund = (holdReference) =>
        scoped((tx) =>
          holds.resolve(tx, {
            orderReference: D.order,
            orderBatchReference: D.batch,
            holdReference,
            resolution: "StaffRefund",
            storeBackOnlineAt: null,
            decideBy: T(-30),
            actorReference: manager,
            recordedAt: T(-30),
            audit: async (hold) => ({
              auditId: next(),
              brandId: brand,
              storeId: store,
              actor: { type: "User", reference: manager },
              actionCode: "ORDER_ACCEPTANCE_HOLD_REFUND_CHOSEN",
              targetType: "OrderAcceptanceHold",
              targetId: hold.holdReference,
              correlationId: hold.holdReference,
              afterSummary: { decision: "Refund" },
              reasonCode: "PAID_DURING_STORE_OUTAGE",
              occurredAt: T(-30),
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Restricted",
              retentionPolicyCode: "FINANCIAL_COMPLIANCE",
              retentionPolicyVersion: 1,
            }),
          }),
        );
      assert.equal((await refund(current.holdReference)).status, "Created");
      assert.equal((await refund(current.holdReference)).status, "Existing");
      assert.equal(await evaluate(D, T(-29)), "Unchanged"); // offline, but the manager chose refund
      assert.equal(await acceptable(D, T(-29)), false);
      assert.equal((await holdRows(D)).length, 2);

      // Every hold, return and decision is audited; history is append-only.
      const audits = await admin.query(
        "SELECT action_code,count(*)::int n FROM platform_audit.audit_record WHERE target_type='OrderAcceptanceHold' GROUP BY action_code ORDER BY action_code",
      );
      assert.deepEqual(
        audits.rows.map((row) => [row.action_code, row.n]),
        [
          ["ORDER_ACCEPTANCE_HELD_STORE_OFFLINE", 4],
          ["ORDER_ACCEPTANCE_HOLD_REFUND_CHOSEN", 1],
          ["ORDER_ACCEPTANCE_HOLD_STORE_BACK_ONLINE", 3],
        ],
      );
      for (const table of ["order_acceptance_hold", "order_acceptance_hold_resolution"])
        for (const sql of [
          "UPDATE rms_ordering." + table + " SET brand_id=brand_id",
          "DELETE FROM rms_ordering." + table,
        ])
          await assert.rejects(scoped((tx) => tx.query(sql, [])));
    } finally {
      await admin.end();
    }
  });
});
