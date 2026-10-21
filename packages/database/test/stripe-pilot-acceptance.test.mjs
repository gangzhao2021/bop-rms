import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { createApp } from "../../../apps/api/src/app.ts";
import {
  PaymentProviderWebhookHandler,
  paymentProviderWebhookRoute,
} from "../../../apps/api/src/payment-provider-webhook.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { parsePilotPaymentConfig } from "../../../tooling/environment/pilot-payment-config.mjs";
import { createInternalOpenPaymentResolution } from "../../../tooling/environment/pilot-open-payment-resolution.mjs";
import { startStripeFake } from "../../../tooling/environment/pilot-stripe-fake.mjs";
import { createPilotStripeProvider } from "../../../tooling/environment/pilot-stripe-provider.mjs";
import {
  createPilotStripeWebhookReceiver,
  createStripeTerminalRecorder,
} from "../../../tooling/environment/pilot-stripe-webhook.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedJourneyPayment } from "../test-support/dine-in-journey-seed.mjs";

const { Client } = pg;
const id = (n) => "01a1ab00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const minutes = (n) => n * 60_000;
const [tenant, brand, store, account] = [1, 2, 3, 4].map(id);

/**
 * WP-2423 DEC-STRIPE-PILOT-WIRING. The pilot's Stripe wiring end to end against the local Stripe
 * stand-in (no network), as the restricted NOBYPASSRLS role holding exactly the rendered pilot
 * API grants (pilot-acl-matrix + additions, including the new webhook inbox grants):
 * 1. a guest pays in Stripe.js; Stripe's signed payment_intent.succeeded reaches the public
 *    webhook route (raw body) → one receipt, raw evidence, completion, terminal fact
 *    (VerifiedWebhook), Audit and PaymentSucceeded; duplicate and replayed deliveries change
 *    nothing; a tampered body or wrong secret is refused and stores nothing; an event type the
 *    pilot does not consume is acknowledged without effect;
 * 2. a declined card: payment_failed → Failed/Declined, and the intent is cancelled at Stripe so
 *    its old client credential can never pay;
 * 3. the webhook is lost: the guest's "check payment" records the capture from Stripe's own
 *    state (ProviderRetrieval, original charge time verified); the late webhook then finds it
 *    already recorded;
 * 4. the create answer was lost (ab88fc83 ④): the open-payment resolution repeats the same create
 *    (attempt-derived key), Stripe answers the intent it already made, Payment cancels it and
 *    records the attempt as not completed — one intent at Stripe, nothing charged.
 * Test-only: owner facts are seeded by the database owner (triggers/FKs skipped for the seed).
 */
it("records Stripe payments from signed webhooks, guest checks and lost create answers", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_stripe" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_stp_" + context.runId,
      worker = "wp2423_stp_w_" + context.runId;
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BOP_PILOT_ENVIRONMENT", undefined);
    const directory = mkdtempSync(join(tmpdir(), "bop-stripe-acceptance-"));
    let fake, server;
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

      // ── Stripe stand-in and this installation's Stripe configuration (secret files 0600).
      let stripeNow = base - minutes(9);
      fake = await startStripeFake({ clock: () => stripeNow });
      const secretFile = (name, value) => {
        writeFileSync(join(directory, name), value, { mode: 0o600 });
        chmodSync(join(directory, name), 0o600);
      };
      secretFile("stripe-secret-key", fake.secretKey);
      secretFile("stripe-webhook-secret", fake.webhookSecret);
      const { stripe } = parsePilotPaymentConfig(
        {
          schemaVersion: 1,
          provider: "stripe",
          stripe: {
            mode: "test",
            apiVersion: fake.apiVersion,
            publishableKey: "pk_test_SYNTHETIC0001",
            secretKeyFile: "stripe-secret-key",
            webhookSecretFile: "stripe-webhook-secret",
            returnUrl: "https://pay-return.example.ca/return",
            webhookUrl: "https://order.example.ca" + paymentProviderWebhookRoute,
            testApiBaseUrl: fake.url,
          },
        },
        { environment: "InternalTest" },
      );
      const provider = createPilotStripeProvider({
        stripe,
        secretKey: fake.secretKey,
        scope: { brandReference: brand, storeReference: store },
      });

      // ── Seed: four guest payments the Payment owner already holds.
      const round = (n) => ({
        f: {
          request: {
            record: {
              order: { orderReference: id(0x100 + n) },
              guestSessionReference: id(0x110 + n),
            },
          },
        },
        batch: {
          orderBatchReference: id(0x120 + n),
          submissionReference: id(0x130 + n),
          sourceCartReference: id(0x140 + n),
          sourceCartVersion: 1,
          quoteReference: id(0x150 + n),
        },
      });
      const refsOf = (n) => {
        const k = 0x7000 + n * 0x10;
        return {
          paymentIntent: id(k + 1),
          attempt: id(k + 2),
          observation: id(k + 3),
          webhook: id(k + 4),
          transaction: id(k + 5),
          paymentEvent: id(k + 6),
          projection: id(k + 7),
          preparation: id(k + 8),
          commitment: id(k + 9),
          paymentOperation: id(k + 10),
          providerIntent: "pi_SYNTHETICSTRIPE" + n,
          providerEvent: "evt_SYNTHETICSTRIPE" + n,
        };
      };
      const requestedAt = time(-minutes(10));
      const pay = { paid: refsOf(1), declined: refsOf(2), lost: refsOf(3), unknown: refsOf(4) };
      await admin.query("SET session_replication_role = replica");
      try {
        for (const [n, refs, outcome] of [
          [1, pay.paid, "Open"],
          [2, pay.declined, "Open"],
          [3, pay.lost, "Open"],
          [4, pay.unknown, "CreateUnknown"],
        ])
          await seedJourneyPayment(admin, {
            scope: { brandReference: brand, storeReference: store },
            providerAccountReference: account,
            round: round(n),
            refs,
            outcome,
            requestedAt,
            occurredAt: new Date(Date.parse(requestedAt) + 1000).toISOString(),
            totalMinor: 1689,
            idempotencyDigest: digest("create-intent:" + refs.attempt),
          });
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      // Stripe holds the three created intents with Payment's own metadata.
      for (const refs of [pay.paid, pay.declined, pay.lost])
        fake.seedIntent({
          id: refs.providerIntent,
          amount: 1689,
          metadata: {
            bop_payment_operation: refs.paymentOperation,
            bop_payment_attempt: refs.attempt,
          },
        });

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
      const resources = {
        scope: { brandReference: brand, storeReference: store },
        now,
        transactions,
        publicProfile: { binding: { tenantReference: tenant, validUntil: time(minutes(600)) } },
        credentials: { reference: fresh },
      };
      const rejected = [];
      const receiver = createPilotStripeWebhookReceiver(resources, {
        provider,
        directory,
        stripe,
        providerAccountReference: account,
        onRejected: (code) => rejected.push(code),
      });
      server = createServer(
        createApp({
          paymentProviderWebhook: new PaymentProviderWebhookHandler({ port: receiver }),
        }),
      );
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      fake.setWebhookTarget(
        "http://127.0.0.1:" + server.address().port + paymentProviderWebhookRoute,
      );
      const realSeconds = () => Math.floor(Date.now() / 1000);

      const one = async (sql, values = []) => (await admin.query(sql, values)).rows;
      const terminal = (refs) =>
        one(
          "SELECT terminal_outcome AS outcome,failure_reason AS reason,authoritative_source AS source,webhook_receipt_id IS NOT NULL AS webhook FROM rms_payment.payment_terminal_fact WHERE payment_intent_id=$1",
          [refs.paymentIntent],
        );
      const counts = async () =>
        (
          await one(
            "SELECT (SELECT count(*)::int FROM rms_payment.provider_webhook_record) AS receipts,(SELECT count(*)::int FROM rms_payment.provider_webhook_raw_evidence) AS raw,(SELECT count(*)::int FROM rms_payment.provider_webhook_processing_record) AS completed,(SELECT count(*)::int FROM rms_payment.payment_terminal_fact) AS facts,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type IN ('PaymentSucceeded','PaymentFailed')) AS events",
          )
        )[0];

      // ── 1. The guest pays; Stripe's signed event is the payment's terminal evidence.
      stripeNow = base - minutes(5);
      const succeeded = fake.confirm(pay.paid.providerIntent, "succeeded");
      const start = await counts();
      assert.equal(await fake.deliver(succeeded, { timestamp: realSeconds() }), 200);
      assert.deepEqual(await terminal(pay.paid), [
        { outcome: "Succeeded", reason: null, source: "VerifiedWebhook", webhook: true },
      ]);
      assert.deepEqual(await counts(), {
        receipts: start.receipts + 1,
        raw: start.raw + 1,
        completed: start.completed + 1,
        facts: start.facts + 1,
        events: start.events + 1,
      });
      assert.deepEqual(
        await one(
          "SELECT source_channel,reason_code FROM platform_audit.audit_record WHERE action_code='PAYMENT_TERMINAL_RECORDED' AND target_id=$1",
          [pay.paid.paymentIntent],
        ),
        [{ source_channel: "PROVIDER_WEBHOOK", reason_code: "PAYMENT_CAPTURED" }],
      );
      // The observation that the fact cites carries Stripe's own charge time.
      assert.deepEqual(
        await one(
          "SELECT f.occurred_at=o.provider_observed_at AS same, o.normalized_status AS status FROM rms_payment.payment_terminal_fact f JOIN rms_payment.payment_provider_observation o ON o.provider_observation_id=f.provider_observation_id WHERE f.payment_intent_id=$1",
          [pay.paid.paymentIntent],
        ),
        [{ same: true, status: "Captured" }],
      );
      // Stripe retries (duplicate delivery, and the same event signed again later): no effect.
      const afterPaid = await counts();
      assert.equal(await fake.deliver(succeeded, { timestamp: realSeconds() }), 200);
      assert.equal(await fake.deliver(succeeded, { timestamp: realSeconds() - 30 }), 200);
      assert.deepEqual(await counts(), afterPaid);
      // A forged or tampered request is refused before anything is stored.
      assert.equal(
        await fake.deliver(succeeded, {
          timestamp: realSeconds(),
          secret: "whsec_" + "WRONG".repeat(6),
        }),
        400,
      );
      assert.equal(await fake.deliver(succeeded, { timestamp: realSeconds(), tamper: true }), 400);
      assert.equal(await fake.deliver(succeeded, { timestamp: realSeconds() - 600 }), 400);
      assert.deepEqual(await counts(), afterPaid);
      assert.deepEqual(rejected, [
        "PROVIDER_WEBHOOK_SIGNATURE_INVALID",
        "PROVIDER_WEBHOOK_SIGNATURE_INVALID",
        "PROVIDER_WEBHOOK_TIMESTAMP_INVALID",
      ]);
      // An event type the pilot does not consume (here the older "created" event arriving after
      // the success) is acknowledged once and changes nothing.
      const created = fake.events.find(
        (event) =>
          event.type === "payment_intent.created" &&
          event.data.object.id === pay.paid.providerIntent,
      ) ?? {
        ...succeeded,
        id: "evt_SYNTHETICCREATED1",
        type: "payment_intent.created",
      };
      assert.equal(await fake.deliver(created, { timestamp: realSeconds() }), 200);
      assert.deepEqual(await counts(), {
        ...afterPaid,
        receipts: afterPaid.receipts + 1,
        raw: afterPaid.raw + 1,
        completed: afterPaid.completed + 1,
      });
      assert.deepEqual(await terminal(pay.paid), [
        { outcome: "Succeeded", reason: null, source: "VerifiedWebhook", webhook: true },
      ]);

      // ── 2. A declined card: Failed/Declined from the signed event, and the intent is cancelled.
      const failed = fake.confirm(pay.declined.providerIntent, "declined");
      assert.equal(await fake.deliver(failed, { timestamp: realSeconds() }), 200);
      assert.deepEqual(await terminal(pay.declined), [
        { outcome: "Failed", reason: "Declined", source: "VerifiedWebhook", webhook: true },
      ]);
      assert.equal(fake.intents.get(pay.declined.providerIntent).status, "canceled");
      assert.ok(
        fake.calls.some(
          (call) => call.idempotencyKey === "cancel-declined:" + pay.declined.attempt,
        ),
      );
      // Stripe's own canceled event for that cancellation arrives later: already recorded.
      const canceled = fake.eventsFor(pay.declined.providerIntent, "payment_intent.canceled")[0];
      const beforeCanceled = await counts();
      assert.equal(await fake.deliver(canceled, { timestamp: realSeconds() }), 200);
      assert.equal((await counts()).facts, beforeCanceled.facts);

      // ── 3. The webhook is lost; the guest's "check payment" reads Stripe and records it.
      stripeNow = base - minutes(4);
      const lostEvent = fake.confirm(pay.lost.providerIntent, "succeeded");
      const recorder = createStripeTerminalRecorder(resources, {
        provider,
        providerAccountReference: account,
      });
      assert.deepEqual(
        await recorder.record({
          paymentOperationReference: pay.lost.paymentOperation,
          providerIntentReference: pay.lost.providerIntent,
        }),
        { result: "Recorded", outcome: "Succeeded", source: "ProviderRetrieval" },
      );
      assert.deepEqual(await terminal(pay.lost), [
        { outcome: "Succeeded", reason: null, source: "ProviderRetrieval", webhook: false },
      ]);
      const beforeLate = await counts();
      assert.equal(await fake.deliver(lostEvent, { timestamp: realSeconds() }), 200);
      assert.equal((await counts()).facts, beforeLate.facts);
      assert.equal((await counts()).completed, beforeLate.completed + 1);

      // ── 4. The create answer was lost: Stripe made the intent, Payment never saw it.
      stripeNow = base - minutes(9);
      fake.injectFault({ method: "POST", path: "/v1/payment_intents", kind: "drop-response" });
      const lostCreate = await provider.adapter.createIntent({
        operation: "CreateIntent",
        purpose: "CreatePaymentIntent",
        context: {
          provider: "Stripe",
          environment: "Test",
          brandReference: brand,
          storeReference: store,
          paymentAttemptReference: pay.unknown.attempt,
          operationReference: pay.unknown.paymentOperation,
        },
        paymentMethod: "OnlineCard",
        captureMode: "Automatic",
        amount: { amountMinor: 1689n, currencyCode: "CAD" },
        idempotencyKey: "create-intent:" + pay.unknown.attempt,
      });
      assert.equal(lostCreate.code, "Unknown");
      const intentsBefore = fake.intents.size;
      const resolution = createInternalOpenPaymentResolution(resources, {
        createSimulatedProvider: async () => provider,
        providerAccountReference: account,
      });
      assert.deepEqual(await resolution.resolve(pay.unknown.paymentOperation), {
        status: "Failed",
        notCompleted: true,
      });
      assert.equal(fake.intents.size, intentsBefore, "the same create answered the same intent");
      const createCalls = fake.calls.filter(
        (call) => call.idempotencyKey === "create-intent:" + pay.unknown.attempt,
      );
      assert.equal(createCalls.length, 2);
      assert.equal(createCalls[1].replayed, true);
      const unknownIntent = [...fake.intents.values()].find(
        (intent) => intent.metadata.bop_payment_attempt === pay.unknown.attempt,
      );
      assert.equal(unknownIntent.status, "canceled");
      assert.equal(unknownIntent.amount_received, 0);
      assert.deepEqual(await terminal(pay.unknown), [
        { outcome: "Failed", reason: "Cancelled", source: "ProviderRetrieval", webhook: false },
      ]);

      // Receipts are append-only and the API role cannot remove Restricted raw evidence.
      const kept = await counts();
      await transactions.run((tx) => tx.query("DELETE FROM rms_payment.provider_webhook_record"));
      await assert.rejects(
        transactions.run((tx) => tx.query("DELETE FROM rms_payment.provider_webhook_raw_evidence")),
        /permission denied/u,
      );
      assert.deepEqual(await counts(), kept);
    } finally {
      vi.unstubAllEnvs();
      await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
      await fake?.close();
      rmSync(directory, { recursive: true, force: true });
      for (const name of [role, worker]) {
        await admin.query("DROP OWNED BY " + name);
        await admin.query("DROP ROLE " + name);
      }
      await admin.end();
    }
  });
});
