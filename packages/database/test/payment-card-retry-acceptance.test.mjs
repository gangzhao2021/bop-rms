import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import {
  createPaymentIntentCreationService,
  createPaymentProviderSnapshot,
  createPaymentStatusEventConsumerService,
  createPaymentTerminalService,
  createPostgresAdmittedPaymentIntentCreationStore,
  createPostgresOrderPaymentAttemptPosition,
  createPostgresPaymentProviderObservationStore,
  createPostgresPaymentStatusStore,
  createPostgresPaymentTerminalSource,
  createPostgresPaymentTerminalStore,
  listOrderPaymentTerminalOutcomes,
  listStoreOrderBatchPaymentOutcomes,
  parsePaymentInstant,
  paymentProviderAdmissionKillSwitchKey,
} from "../../rms/payment/src/index.ts";
import { createCheckoutAllocationPaymentObservation } from "../../../apps/api/src/checkout-allocation-payment-observation.ts";
import { createOrderCapturedPaymentSource } from "../../../apps/api/src/order-captured-payment-source.ts";
import { resolveMerchantBatchPaymentDue } from "../../../apps/api/src/dining-batch-payment-due.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01a0f020-0000-7000-8000-" + n.toString(16).padStart(12, "0");
let sequence = 0x10000;
/** Fresh UUIDv7 whose timestamp prefix is the current instant. */
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (sequence++).toString(16).padStart(12, "0");
const sha = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const frozen = (value) => {
  for (const child of Object.values(value)) if (child && typeof child === "object") frozen(child);
  return Object.freeze(value);
};
const [brand, store, account, control] = [1, 2, 3, 4].map(id);
const scope = { brandReference: brand, storeReference: store };
const terminalScope = { ...scope, providerAccountReference: account, environment: "Test" };

/**
 * WP-2423 Q20 (DEC-PAYMENT-CARD-RETRY): a declined card, then another card for the same dine-in
 * round. The Payment owner code (intent creation and retry, Provider observation, terminal facts,
 * status projection consumer) and the reads behind the Q6 unpaid-round cancellation, the staff
 * "payment failed" warning and Ordering's paid-outcome source run as a restricted NOBYPASSRLS role
 * holding exactly the rendered pilot API grants. Test-only stand-ins: an in-memory Provider (the
 * simulator's semantics: one Provider intent per attempt), allow-all owner admission and Guest
 * authorization, and a Store kill switch that is inactive.
 */
it("lets a customer pay a declined round with another card once, inside its payment window", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_card_retry" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_cr_" + context.runId,
      worker = "wp2423_cr_w_" + context.runId;
    assert.match(api, /^wp2423_cr_[a-f0-9]+$/u);
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

      /** One restricted-role transaction per run, one query at a time (application rule). */
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL lock_timeout='10s'");
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
      const rows = async (sql, values = []) => (await admin.query(sql, values)).rows;

      // ── Test-only Provider: one Provider intent per attempt (idempotency key), decline or capture.
      const provider = new Map(),
        createCalls = [];
      const money = (amountMinor) => ({ amountMinor, currencyCode: "CAD" });
      const snapshotOf = (entry, context) =>
        createPaymentProviderSnapshot({
          kind: "Snapshot",
          context,
          providerIntentReference: entry.reference,
          providerTransactionReference: entry.status === "Captured" ? entry.charge : null,
          paymentMethod: "OnlineCard",
          captureMode: "Automatic",
          status: entry.status,
          requestedAmount: money(entry.amount),
          authorizedAmount: money(entry.status === "Captured" ? entry.amount : 0n),
          capturedAmount: money(entry.status === "Captured" ? entry.amount : 0n),
          refundedAmount: money(0n),
          observedAt: entry.observedAt,
          evidenceDigest: sha(entry.reference + ":" + entry.status),
        });
      const adapter = {
        async createIntent(request) {
          createCalls.push(request.context.paymentAttemptReference);
          let entry = provider.get(request.idempotencyKey);
          if (!entry) {
            entry = {
              reference: "pi_RETRYTEST" + provider.size.toString().padStart(6, "0"),
              charge: "ch_RETRYTEST" + provider.size.toString().padStart(6, "0"),
              amount: request.amount.amountMinor,
              status: "RequiresCustomerAction",
              observedAt: now(),
              context: request.context,
            };
            provider.set(request.idempotencyKey, entry);
          }
          return snapshotOf(entry, request.context);
        },
        retrieveIntent: async () => assert.fail("not used"),
        cancelIntent: async () => assert.fail("not used"),
        captureIntent: async () => assert.fail("not used"),
        refundPayment: async () => assert.fail("not used"),
      };

      // ── Payment owner compositions under the restricted role.
      const intentStore = createPostgresAdmittedPaymentIntentCreationStore(
        transactions,
        scope,
        { now, generateObservationReference: fresh },
        // Test-only owner admission: the round is still current (Ordering/Dining/Inventory
        // fences are covered by the dine-in journey acceptance).
        { admit: async () => true },
      );
      const ports = (guestSessionReference) => ({
        providerEnvironment: "Test",
        clock: { now },
        killSwitch: {
          evaluate: async (request) =>
            frozen({
              effectiveControl: {
                controlId: control,
                version: 1,
                scope: { kind: "Store", ...scope },
              },
              backendExecution: "Allow",
              frontendVisibility: "Show",
              reason: "KILL_INACTIVE",
              killMode: "BlockNew",
              inFlightPolicy: "AllowToComplete",
              record: {
                key: paymentProviderAdmissionKillSwitchKey,
                kind: "KillSwitch",
                version: 1,
                scopeKind: "Store",
                backendExecution: "Allow",
                frontendVisibility: "Show",
                reason: "KILL_INACTIVE",
                killMode: "BlockNew",
                evaluatedAt: request.evaluatedAt,
              },
            }),
        },
        // Test-only Guest authorization of the round's own guest.
        authorization: {
          authorize: async () => ({
            action: "CreatePaymentIntent",
            guestSessionReference,
            ...scope,
          }),
        },
        ordering: { preparePayment: async () => assert.fail("set per round") },
        audit: {
          create: async (value) => ({
            auditId: fresh(),
            brandId: brand,
            storeId: store,
            actor: { type: "System" },
            actionCode: "PAYMENT_INTENT_CREATE",
            targetType: "PaymentIntent",
            targetId: value.paymentIntentReference,
            reasonCode: "AUTHORIZED_PAYMENT_INTENT_CREATE",
            occurredAt: value.observedAt,
            correlationId: value.paymentOperationReference,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          }),
        },
        references: {
          generate: fresh,
          hash: sha,
          equals: (a, b) => a === b,
          providerIdempotencyKey: (input) =>
            "bop:" + input.paymentOperationReference + ":" + input.paymentAttemptReference,
        },
        repository: intentStore,
        provider: adapter,
      });
      const terminalStore = createPostgresPaymentTerminalStore(transactions, terminalScope);
      const terminal = createPaymentTerminalService({
        source: createPostgresPaymentTerminalSource(transactions, terminalScope),
        repository: terminalStore,
        clock: { now },
        references: { generate: fresh },
        audit: {
          create: async ({ fact, correlationReference }) => ({
            auditId: fresh(),
            brandId: brand,
            storeId: store,
            actor: { type: "System" },
            actionCode: "PAYMENT_TERMINAL_RECORDED",
            targetType: "PaymentIntent",
            targetId: fact.paymentIntentReference,
            afterSummary: { outcome: fact.outcome },
            reasonCode: fact.outcome === "Failed" ? "PAYMENT_FAILED" : "PAYMENT_CAPTURED",
            correlationId: correlationReference,
            occurredAt: fact.recordedAt,
            sourceChannel: "PAYMENT_RECONCILIATION",
            dataClassification: "Restricted",
            retentionPolicyCode: "FINANCIAL_COMPLIANCE",
            retentionPolicyVersion: 1,
          }),
        },
      });
      const observations = createPostgresPaymentProviderObservationStore(transactions, scope, {
        now,
      });
      const status = createPaymentStatusEventConsumerService({
        scope,
        authorization: { authorize: async () => true },
        projections: createPostgresPaymentStatusStore({
          scope: terminalScope,
          authorize: async () => true,
          authorizeOrder: async () => true,
        }),
        references: { generateGeneration: fresh, now },
        sha256: (value) => createHash("sha256").update(value).digest("hex"),
      });

      /** A dine-in round: payment requested now, 30-minute payment window. */
      const round = (n) => {
        const at = now();
        const preparation = {
          preparationReference: id(n + 1),
          orderReference: id(n + 2),
          orderBatchReference: id(n + 3),
          submissionReference: id(n + 4),
          sourceCartReference: id(n + 5),
          sourceCartVersion: 1,
          ...scope,
          guestSessionReference: id(n + 6),
          quoteReference: id(n + 7),
          capacityAllocationReference: id(n + 8),
          readiness: "PaymentPending",
          transactionBoundary: "OrderSubmissionPaymentPreparation",
          orderAllocation: money(2260n),
          tip: money(0n),
          total: money(2260n),
          committedAt: at,
          capacityExpiresAt: new Date(Date.parse(at) + 30 * 60_000).toISOString(),
          sourceDigest: sha("preparation:" + n),
        };
        const operation = id(n + 9);
        const service = createPaymentIntentCreationService({
          ...ports(preparation.guestSessionReference),
          ordering: { preparePayment: async () => preparation },
        });
        return {
          preparation,
          operation,
          service,
          allocation: {
            ...scope,
            guestSessionReference: preparation.guestSessionReference,
            createOperationReference: id(n + 10),
            cartReference: preparation.sourceCartReference,
            cartVersion: 1,
            quoteReference: preparation.quoteReference,
            quoteVersion: 1,
            checkoutSessionReference: id(n + 11),
            submissionReference: preparation.submissionReference,
            paymentOperationReference: operation,
            allocatedAt: at,
          },
          create: () =>
            service.create({
              paymentOperationReference: operation,
              submissionReference: preparation.submissionReference,
              cartReference: preparation.sourceCartReference,
              expectedCartVersion: 1,
              quoteReference: preparation.quoteReference,
              tipSelectionReference: null,
              requestedAt: at,
            }),
          retry: () =>
            service.retry({
              paymentOperationReference: operation,
              submissionReference: preparation.submissionReference,
              requestedAt: now(),
            }),
        };
      };
      /** The Provider declines or approves this attempt; Payment records the outcome. */
      const settle = async (record, outcome) => {
        const snapshot = record.providerOutcome;
        const entry = [...provider.values()].find(
          (value) => value.reference === snapshot.providerIntentReference,
        );
        entry.status = outcome === "approve" ? "Captured" : "Failed";
        entry.observedAt = now();
        const observed = snapshotOf(entry, snapshot.context);
        const observationReference = fresh();
        await observations.record({
          observationReference,
          paymentIntentReference: record.intent.paymentIntentReference,
          snapshot: observed,
        });
        const captured = outcome === "approve";
        const result = await terminal.record({
          observationReference,
          causationReference: fresh(),
          webhookReceiptReference: null,
          providerEventReference: null,
          providerAccountReference: account,
          providerIntentReference: observed.providerIntentReference,
          environment: "Test",
          paymentIntentReference: record.intent.paymentIntentReference,
          paymentAttemptReference: record.attempt.paymentAttemptReference,
          ...scope,
          source: "ProviderRetrieval",
          status: captured ? "Captured" : "Failed",
          amount: captured ? observed.capturedAmount : null,
          failureReason: captured ? null : "Declined",
          retryDisposition: captured ? null : "NewOperation",
          occurredAt: parsePaymentInstant(observed.observedAt),
          evidenceDigest: observed.evidenceDigest,
        });
        // The pilot worker's status projection consumer takes the terminal event.
        await transactions.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          const envelope = await loadOutboxEnvelope(tx, result.fact.event.eventId);
          assert.ok(envelope, "terminal event in the outbox");
          return status.consume(tx, envelope);
        });
        return result.fact;
      };
      const read = (fn) => transactions.run(fn);
      /** What staff see on the order screen for the round (Q6 warning). */
      const staffWarning = async (r) => {
        const outcomes = await read((tx) =>
          listStoreOrderBatchPaymentOutcomes(tx, scope, [r.preparation.orderReference]),
        );
        return resolveMerchantBatchPaymentDue({
          orderType: "DineIn",
          open: true,
          batch: {
            orderBatchReference: r.preparation.orderBatchReference,
            acceptanceStatus: "NotAccepted",
          },
          paidBatches: new Set(),
          deadlines: new Map([
            [r.preparation.orderBatchReference, r.preparation.capacityExpiresAt],
          ]),
          outcomes: new Map(outcomes.map((entry) => [entry.orderBatchReference, entry.status])),
        });
      };
      /** The payment evidence the Q6 unpaid-round expiry records at the deadline. */
      const deadlineEvidence = (r) =>
        read((tx) =>
          createCheckoutAllocationPaymentObservation({
            scope: terminalScope,
            now,
            authorize: async () => true,
          }).resolve(tx, r.allocation),
        );
      const counts = async (intent) =>
        (
          await rows(
            "SELECT (SELECT count(*)::int FROM rms_payment.payment_attempt WHERE payment_intent_id=$1) AS attempts," +
              "(SELECT count(*)::int FROM rms_payment.payment_terminal_fact WHERE payment_intent_id=$1 AND terminal_outcome='Succeeded') AS captures," +
              "(SELECT count(*)::int FROM rms_payment.payment_terminal_fact WHERE payment_intent_id=$1 AND terminal_outcome='Failed') AS declines," +
              "(SELECT count(*)::int FROM rms_payment.payment_status_projection WHERE payment_intent_id=$1 AND is_active) AS active",
            [intent],
          )
        )[0];

      // ── A. Declined, then another card approved: one capture, round paid, nothing to cancel.
      const A = round(0x100);
      const first = await A.create();
      assert.equal(first.status, "Created");
      await settle(first.record, "decline");
      assert.deepEqual(await staffWarning(A), {
        status: "Failed",
        cancelsAt: A.preparation.capacityExpiresAt,
      });
      const declined = await deadlineEvidence(A);
      assert.equal(declined.outcome, "Failed");

      const second = await A.retry();
      assert.equal(second.status, "Created");
      assert.equal(
        second.record.intent.paymentIntentReference,
        first.record.intent.paymentIntentReference,
      );
      assert.equal(second.record.attempt.attemptNumber, 2);
      assert.notEqual(
        second.record.providerOutcome.providerIntentReference,
        first.record.providerOutcome.providerIntentReference,
      );
      // While the new card is open, the round's latest payment is unresolved, not failed.
      assert.equal((await deadlineEvidence(A)).status, "Unresolved");
      const paid = await settle(second.record, "approve");
      assert.equal(paid.paymentAttemptReference, second.record.attempt.paymentAttemptReference);
      assert.deepEqual(await counts(first.record.intent.paymentIntentReference), {
        attempts: 2,
        captures: 1,
        declines: 1,
        active: 1,
      });
      // Staff warning cleared; the Q6 deadline sees a payment made before the deadline.
      assert.equal(await staffWarning(A), null);
      const evidence = await deadlineEvidence(A);
      assert.equal(evidence.outcome, "Succeeded");
      assert.equal(
        evidence.terminal.paymentAttemptReference,
        second.record.attempt.paymentAttemptReference,
      );
      assert.ok(evidence.terminal.occurredAt < A.preparation.capacityExpiresAt);
      // Ordering's paid-outcome source accepts the second attempt's PaymentSucceeded event.
      const captured = await read((tx) =>
        createOrderCapturedPaymentSource({
          scope: terminalScope,
          now,
          authorize: async () => true,
        }).resolve(tx, paid.event),
      );
      assert.equal(captured.terminal.paymentTransactionReference, paid.paymentTransactionReference);
      // The customer order page and the order's payment inventory see one paid payment.
      const outcomes = await read((tx) =>
        listOrderPaymentTerminalOutcomes(tx, terminalScope, A.preparation.orderReference),
      );
      assert.deepEqual(
        outcomes.map((entry) => [entry.outcome, entry.amount?.amountMinor]),
        [["Succeeded", 2260n]],
      );
      const position = await read((tx) =>
        createPostgresOrderPaymentAttemptPosition({
          scope: terminalScope,
          authorize: async () => true,
        }).load(tx, { orderReference: A.preparation.orderReference, observedAt: now() }),
      );
      assert.equal(position.capturedMinor, 2260n);
      assert.deepEqual([position.failedCount, position.unresolvedCount], [0, 0]);
      // Nothing more can be charged: no further attempt, and the database refuses one.
      await assert.rejects(A.retry(), { code: "PAYMENT_INTENT_ALREADY_PAID" });
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,provider_environment,provider_idempotency_digest,created_at) VALUES ($1,$2,$3,$4,3,'Stripe','Test',$5,now())",
          [fresh(), brand, store, first.record.intent.paymentIntentReference, sha("x")],
        ),
        /not a retry of a failed attempt/u,
      );
      assert.equal((await counts(first.record.intent.paymentIntentReference)).attempts, 2);

      // ── B. Declined twice: the round stays failed and is still cancelled at its deadline.
      const B = round(0x200);
      const b1 = await B.create();
      await settle(b1.record, "decline");
      const b2 = await B.retry();
      // A retry while the new card is open returns that same attempt (no new Provider intent).
      const calls = createCalls.length;
      const again = await B.retry();
      assert.equal(
        again.record.attempt.paymentAttemptReference,
        b2.record.attempt.paymentAttemptReference,
      );
      assert.equal(createCalls.length, calls);
      await settle(b2.record, "decline");
      assert.deepEqual(await staffWarning(B), {
        status: "Failed",
        cancelsAt: B.preparation.capacityExpiresAt,
      });
      const failed = await deadlineEvidence(B);
      assert.equal(failed.outcome, "Failed");
      assert.equal(
        failed.terminal.paymentAttemptReference,
        b2.record.attempt.paymentAttemptReference,
      );
      assert.deepEqual(await counts(b1.record.intent.paymentIntentReference), {
        attempts: 2,
        captures: 0,
        declines: 2,
        active: 1,
      });

      // ── C. Two retries at once (double tap, two phones at the table): one new attempt.
      const C = round(0x300);
      const c1 = await C.create();
      await settle(c1.record, "decline");
      const before = createCalls.length;
      const both = await Promise.all([C.retry(), C.retry()]);
      assert.equal(
        new Set(both.map((value) => value.record.attempt.paymentAttemptReference)).size,
        1,
      );
      assert.equal(createCalls.length - before, 1);
      assert.equal((await counts(c1.record.intent.paymentIntentReference)).attempts, 2);

      // ── D. Five cards at most; then the customer pays staff at the counter.
      const D = round(0x400);
      let latest = (await D.create()).record;
      for (let attempt = 1; attempt < 5; attempt++) {
        await settle(latest, "decline");
        latest = (await D.retry()).record;
      }
      assert.equal(latest.attempt.attemptNumber, 5);
      await settle(latest, "decline");
      await assert.rejects(D.retry(), { code: "PAYMENT_INTENT_RETRY_LIMIT_REACHED" });
      assert.equal((await counts(latest.intent.paymentIntentReference)).attempts, 5);

      // ── E. After the payment window: no further attempt, also refused by the database.
      const E = round(0x500);
      const e1 = await E.create();
      await settle(e1.record, "decline");
      await admin.query("SET session_replication_role = replica");
      try {
        // Test-only: move the round's payment window into the past (owner seed edit).
        for (const [table, columns] of [
          ["payment_intent", ["prepared_at", "capacity_expires_at", "created_at"]],
          ["payment_intent_operation_record", ["created_at"]],
          ["payment_attempt", ["created_at"]],
        ])
          await admin.query(
            "UPDATE rms_payment." +
              table +
              " SET " +
              columns.map((column) => column + "=" + column + "-interval '40 minutes'").join(",") +
              " WHERE payment_intent_id=$1",
            [e1.record.intent.paymentIntentReference],
          );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await assert.rejects(E.retry(), { code: "PAYMENT_INTENT_PREPARATION_EXPIRED" });
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,provider_environment,provider_idempotency_digest,created_at) VALUES ($1,$2,$3,$4,2,'Stripe','Test',$5,now())",
          [fresh(), brand, store, e1.record.intent.paymentIntentReference, sha("y")],
        ),
        /not a retry of a failed attempt/u,
      );
      assert.equal((await counts(e1.record.intent.paymentIntentReference)).attempts, 1);

      // Every attempt and terminal fact stays: payment history is never rewritten.
      await transactions
        .run((tx) =>
          tx.query("DELETE FROM rms_payment.payment_attempt WHERE payment_intent_id=$1", [
            first.record.intent.paymentIntentReference,
          ]),
        )
        .catch(() => undefined);
      assert.deepEqual(await counts(first.record.intent.paymentIntentReference), {
        attempts: 2,
        captures: 1,
        declines: 1,
        active: 1,
      });
    } finally {
      await admin.end();
    }
  });
});
