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
  createPostgresPaymentProviderObservationStore,
  createPostgresPaymentStatusStore,
  createPostgresPaymentTerminalSource,
  createPostgresPaymentTerminalStore,
  listOrderPaymentTerminalOutcomes,
  listOrderPaymentsDue,
  parsePaymentInstant,
  paymentProviderAdmissionKillSwitchKey,
} from "../../rms/payment/src/index.ts";
import { reportOrderPaymentOutcomes } from "../../../apps/api/src/customer-order-payment-outcomes.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01a0f044-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
 * WP-2423 guest-payment-state (M18, M118): what the guest's order page reads about an order that
 * isn't paid. Payment's own reads (intent, attempts, terminal facts, status projection) run as a
 * restricted NOBYPASSRLS role holding exactly the rendered pilot API grants. Test-only stand-ins: an
 * in-memory Provider, allow-all owner admission and Guest authorization, an inactive kill switch.
 */
it("tells an unpaid order's deadline and newest attempt, and reports a newer card as paid before the projection", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_guest_pay" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_gps_" + context.runId,
      worker = "wp2423_gps_w_" + context.runId;
    assert.match(api, /^wp2423_gps_[a-f0-9]+$/u);
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
      const settle = async (record, outcome, { project = true } = {}) => {
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
        // The pilot worker's status projection consumer takes the terminal event (later, or now).
        if (project)
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
      const due = (r, readScope = terminalScope) =>
        read((tx) => listOrderPaymentsDue(tx, readScope, r.preparation.orderReference));
      /** What the guest's order page reports: projected outcomes plus newer recorded facts. */
      const reported = async (r) => {
        const projections = await read((tx) =>
          createPostgresPaymentStatusStore({
            scope: terminalScope,
            authorize: async () => true,
            authorizeOrder: async () => true,
          }).listByOrder({ transaction: tx, orderReference: r.preparation.orderReference }),
        );
        const facts = await read((tx) =>
          listOrderPaymentTerminalOutcomes(tx, terminalScope, r.preparation.orderReference),
        );
        return reportOrderPaymentOutcomes(
          projections.map((projection) => ({
            paymentIntentReference: String(projection.snapshot.paymentIntentReference),
            status: projection.snapshot.terminalStatus,
            occurredAt: projection.snapshot.terminalOccurredAt,
            amount: projection.snapshot.amount,
            freshnessStatus: projection.freshnessStatus,
          })),
          facts,
        ).map((payment) => payment.status);
      };

      // ── (a) Placed, payment open: the order page can say "not paid yet, pay by".
      const A = round(0x100);
      const first = await A.create();
      const window = {
        orderBatchReference: A.preparation.orderBatchReference,
        payBy: A.preparation.capacityExpiresAt,
      };
      assert.deepEqual(await due(A), [{ ...window, lastAttempt: "Open" }]);
      // Another Store's context sees nothing of this order.
      assert.deepEqual(await due(A, { ...terminalScope, storeReference: id(0x999) }), []);

      // ── (b) Declined: still due, the newest attempt declined.
      await settle(first.record, "decline");
      assert.deepEqual(await due(A), [{ ...window, lastAttempt: "Declined" }]);
      assert.deepEqual(await reported(A), ["Failed"]);

      // Another card is open: due, newest attempt open (the page says pending, not failed).
      const second = await A.retry();
      assert.equal(second.record.attempt.attemptNumber, 2);
      assert.deepEqual(await due(A), [{ ...window, lastAttempt: "Open" }]);

      // It goes through; the status projection has not caught up yet (the decline is still the
      // projected outcome). The order page already reports it paid, and nothing is due.
      await settle(second.record, "approve", { project: false });
      assert.deepEqual(await reported(A), ["Succeeded"]);
      assert.deepEqual(await due(A), []);

      // ── A payment never finished and cancelled when its time ran out is not finishable.
      const B = round(0x200);
      const b1 = await B.create();
      assert.deepEqual(
        (await due(B)).map((entry) => entry.lastAttempt),
        ["Open"],
      );
      await settle(b1.record, "decline");
      assert.deepEqual(
        (await due(B)).map((entry) => entry.lastAttempt),
        ["Declined"],
      );
    } finally {
      await admin.end();
    }
  });
});
