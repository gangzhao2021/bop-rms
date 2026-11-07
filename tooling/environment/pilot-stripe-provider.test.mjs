import { afterEach, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import {
  verifyStripeWebhookSignature,
  parseWebhookInstant,
} from "../../packages/rms/payment/src/index.ts";
import { signStripeWebhook, startStripeFake } from "./pilot-stripe-fake.mjs";
import {
  parsePilotPaymentConfig,
  pilotPaymentProviderReady,
  STRIPE_WEBHOOK_PATH,
} from "./pilot-payment-config.mjs";
import {
  createPilotPaymentProvider,
  createPilotStripeProvider,
  isPilotPaymentProvider,
  isStripeProvider,
} from "./pilot-stripe-provider.mjs";
import {
  parseStripeOperationsArguments,
  registerStripePaymentMethodDomain,
  runStripeReadinessCheck,
} from "./pilot-stripe-operations.mjs";
import {
  assertPilotReady,
  pilotProviderEnvironment,
  remainingPilotCapabilityGaps,
} from "./pilot-environment.mjs";

const id = (n) => "0190fa71-0000-7000-8000-" + String(n).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
const stripeJson = (extra = {}) => ({
  schemaVersion: 1,
  provider: "stripe",
  stripe: {
    mode: "test",
    apiVersion: "2025-01-27.acacia",
    publishableKey: "pk_test_SYNTHETIC0001",
    secretKeyFile: "stripe-secret-key",
    webhookSecretFile: "stripe-webhook-secret",
    returnUrl: "https://pay-return.example.ca/return",
    webhookUrl: "https://order.example.ca" + STRIPE_WEBHOOK_PATH,
    ...extra,
  },
});
async function fixture({ paymentJson = stripeJson(), at = Date.now() - 300_000 } = {}) {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", undefined);
  let fakeNow = at;
  const fake = await startStripeFake({ clock: () => fakeNow });
  cleanups.push(() => fake.close());
  const directory = mkdtempSync(join(tmpdir(), "bop-stripe-pilot-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const write = (name, value) => {
    writeFileSync(join(directory, name), value, { mode: 0o600 });
    chmodSync(join(directory, name), 0o600);
  };
  if (paymentJson !== null)
    write(
      "payment.json",
      JSON.stringify({
        ...paymentJson,
        ...(paymentJson.stripe
          ? { stripe: { ...paymentJson.stripe, testApiBaseUrl: fake.url } }
          : {}),
      }),
    );
  write("stripe-secret-key", fake.secretKey + "\n");
  write("stripe-webhook-secret", fake.webhookSecret);
  const loadProfile = async () => ({
    environment: "InternalTest",
    database: "local_test",
    binding: { ...scope, validUntil: "2099-01-01T00:00:00.000Z" },
  });
  return {
    fake,
    directory,
    loadProfile,
    advance: (ms) => {
      fakeNow += ms;
    },
  };
}
const context = (n) => ({
  provider: "Stripe",
  environment: "Test",
  ...scope,
  paymentAttemptReference: id(100 + n),
  operationReference: id(200 + n),
});
const create = (provider, n, amount = 1250n) =>
  provider.adapter.createIntent({
    operation: "CreateIntent",
    purpose: "CreatePaymentIntent",
    context: context(n),
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    amount: { amountMinor: amount, currencyCode: "CAD" },
    idempotencyKey: "create-intent:" + id(100 + n),
  });
const retrieval = (n, providerIntentReference) => ({
  operation: "RetrieveIntent",
  purpose: "RetrievePaymentIntent",
  context: context(n),
  providerIntentReference,
});
async function stripeProvider(f) {
  const provider = await createPilotPaymentProvider(
    {},
    {
      directory: f.directory,
      path: join(f.directory, "simulated-provider.sqlite"),
      loadProfile: f.loadProfile,
      expectedDatabaseName: "local_test",
    },
  );
  expect(isStripeProvider(provider)).toBe(true);
  expect(isPilotPaymentProvider(provider)).toBe(true);
  return provider;
}

test("payment.json: simulator and Stripe test mode in InternalTest only, Stripe live mode in Pilot only", () => {
  expect(parsePilotPaymentConfig(null, { environment: "InternalTest" })).toEqual({
    provider: "simulated",
  });
  expect(() => parsePilotPaymentConfig(null, { environment: "Pilot" })).toThrow(
    "PILOT_PAYMENT_CONFIG_INVALID",
  );
  const parsed = parsePilotPaymentConfig(stripeJson(), { environment: "InternalTest" });
  expect(parsed.stripe).toMatchObject({ mode: "test", environment: "Test", testApiBaseUrl: null });
  const reason = (value, environment = "InternalTest") => {
    try {
      parsePilotPaymentConfig(value, { environment });
      return null;
    } catch (error) {
      return error.reason;
    }
  };
  const live = (extra = {}) =>
    stripeJson({ mode: "live", publishableKey: "pk_live_SYNTHETIC0001", ...extra });
  expect(parsePilotPaymentConfig(live(), { environment: "Pilot" }).stripe).toMatchObject({
    mode: "live",
    environment: "Live",
    publishableKey: "pk_live_SYNTHETIC0001",
  });
  // Live keys never serve InternalTest; test keys never serve a Pilot Store; keys match the mode.
  expect(reason(live())).toBe("stripe.mode.live-pilot-only");
  expect(reason(stripeJson(), "Pilot")).toBe("stripe.mode.test-internal-test-only");
  expect(reason(stripeJson({ mode: "sandbox" }))).toBe("stripe.mode");
  expect(reason(stripeJson({ publishableKey: "pk_live_X1" }))).toBe("stripe.publishableKey");
  expect(reason(stripeJson({ walletsEnabled: true }))).toBe("stripe.walletsEnabled.domain-missing");
  expect(
    reason(stripeJson({ paymentMethodDomain: "order.example.ca", walletsEnabled: "yes" })),
  ).toBe("stripe.walletsEnabled");
  expect(reason(live({ publishableKey: "pk_test_X1" }), "Pilot")).toBe("stripe.publishableKey");
  expect(reason(stripeJson({ secretKey: "sk_test_inline" }))).toBe("stripe");
  expect(reason(stripeJson({ returnUrl: "https://order.example.ca/return" }))).toBe(
    "stripe.returnUrl.same-origin",
  );
  expect(reason(stripeJson({ webhookUrl: "https://order.example.ca/hook" }))).toBe(
    "stripe.webhookUrl",
  );
  expect(reason(live({ testApiBaseUrl: "http://127.0.0.1:9" }), "Pilot")).toBe(
    "stripe.testApiBaseUrl.internal-test-only",
  );
  expect(reason(stripeJson({ testApiBaseUrl: "http://10.0.0.1:9" }))).toBe("stripe.testApiBaseUrl");
  expect(
    reason(
      stripeJson({
        nextWebhookSecret: {
          file: "next",
          validFrom: "2026-10-01T00:00:00.000Z",
          validUntil: "2026-10-09T00:00:00.000Z",
        },
      }),
    ),
  ).toBe("stripe.nextWebhookSecret.window");
  expect(reason({ schemaVersion: 1, provider: "simulated" }, "Pilot")).toBe(
    "provider.simulated-internal-test-only",
  );
});

test("the PaymentProvider gap clears only for configured Stripe with its secret files present", async () => {
  const f = await fixture();
  expect(await pilotPaymentProviderReady(f.directory, { environment: "InternalTest" })).toBe(true);
  // A Pilot Store needs live mode: test keys never clear its gap.
  expect(await pilotPaymentProviderReady(f.directory, { environment: "Pilot" })).toBe(false);
  // A live configuration with live secret files clears it in Pilot only.
  const liveDirectory = mkdtempSync(join(tmpdir(), "bop-stripe-live-"));
  cleanups.push(() => rmSync(liveDirectory, { recursive: true, force: true }));
  const writeLive = (name, value) =>
    writeFileSync(join(liveDirectory, name), value, { mode: 0o600 });
  writeLive(
    "payment.json",
    JSON.stringify(stripeJson({ mode: "live", publishableKey: "pk_live_SYNTHETIC0001" })),
  );
  writeLive("stripe-secret-key", "sk_test_SYNTHETIC0001\n");
  writeLive("stripe-webhook-secret", f.fake.webhookSecret);
  // A test-mode secret key in a live configuration is refused.
  expect(await pilotPaymentProviderReady(liveDirectory, { environment: "Pilot" })).toBe(false);
  writeLive("stripe-secret-key", "rk_live_SYNTHETIC0001\n");
  expect(await pilotPaymentProviderReady(liveDirectory, { environment: "Pilot" })).toBe(true);
  expect(await pilotPaymentProviderReady(liveDirectory, { environment: "InternalTest" })).toBe(
    false,
  );
  rmSync(join(f.directory, "stripe-webhook-secret"));
  expect(await pilotPaymentProviderReady(f.directory, { environment: "InternalTest" })).toBe(false);
  const simulated = await fixture({ paymentJson: null });
  expect(
    await pilotPaymentProviderReady(simulated.directory, { environment: "InternalTest" }),
  ).toBe(false);
  expect(remainingPilotCapabilityGaps(["PaymentProvider"]).map((g) => g.code)).not.toContain(
    "PaymentProvider",
  );
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
  expect(() => assertPilotReady({ met: ["PaymentProvider"] })).toThrow(
    /^PILOT_CAPABILITY_MISSING:StaffLogin,/u,
  );
});

test("creates with Payment's own metadata; a lost create answer is recovered by the same create", async () => {
  const f = await fixture();
  const provider = await stripeProvider(f);
  f.fake.injectFault({ method: "POST", path: "/v1/payment_intents", kind: "drop-response" });
  const lost = await create(provider, 1);
  expect(lost).toMatchObject({ kind: "Failure", code: "Unknown", retryDisposition: "Unknown" });
  expect(f.fake.intents.size).toBe(1);
  // DEC-DINING-ABANDONED-PAYMENT: the same create (attempt-derived key) answers the same intent.
  const again = await create(provider, 1);
  expect(again.kind).toBe("Snapshot");
  expect(again.status).toBe("RequiresCustomerAction");
  expect(f.fake.intents.size).toBe(1);
  const intent = f.fake.intents.get(again.providerIntentReference);
  expect(intent.metadata).toEqual({
    bop_payment_operation: id(201),
    bop_payment_attempt: id(101),
  });
  expect(f.fake.calls.filter((c) => c.method === "POST").at(-1).replayed).toBe(true);
  expect(f.fake.calls.every((c) => c.stripeVersion === "2025-01-27.acacia")).toBe(true);
  // A request outside the bound Store never reaches Stripe.
  await expect(
    provider.adapter.retrieveIntent({
      ...retrieval(1, again.providerIntentReference),
      context: { ...context(1), storeReference: id(9) },
    }),
  ).rejects.toThrow("PILOT_STRIPE_SCOPE_DENIED");
});

test("terminal outcomes carry Stripe's own times: capture, decline, 3-D Secure failure, cancel", async () => {
  const f = await fixture();
  const provider = await stripeProvider(f);
  const paid = await create(provider, 1),
    declined = await create(provider, 2),
    authentication = await create(provider, 3),
    abandoned = await create(provider, 4);
  f.advance(60_000);
  f.fake.confirm(paid.providerIntentReference, "succeeded");
  f.fake.confirm(declined.providerIntentReference, "declined");
  const failedEvent = f.fake.confirm(
    authentication.providerIntentReference,
    "authentication_failed",
  );
  const chargedAt = new Date(Math.floor((Date.now() - 240_000) / 1000) * 1000).toISOString();
  const captured = await provider.readTerminalOccurrence(
    retrieval(1, paid.providerIntentReference),
  );
  expect(captured.status).toBe("Captured");
  expect(Math.abs(Date.parse(captured.occurredAt) - Date.parse(chargedAt))).toBeLessThanOrEqual(
    1000,
  );
  const read = await provider.adapter.retrieveIntent(
    retrieval(2, declined.providerIntentReference),
  );
  expect(read.status).toBe("Failed");
  const decline = await provider.readTerminalObservation(
    retrieval(2, declined.providerIntentReference),
  );
  expect(decline.occurrence).toMatchObject({ status: "Failed", failureReason: "Declined" });
  expect(decline.snapshot.observedAt).toBe(decline.occurrence.occurredAt);
  // No charge exists for a failed authentication: only the signed event dates it.
  const pending = await provider.readTerminalObservation(
    retrieval(3, authentication.providerIntentReference),
  );
  expect(pending.occurrence).toBeNull();
  const eventAt = new Date(failedEvent.created * 1000).toISOString();
  const auth = await provider.readTerminalObservation(
    retrieval(3, authentication.providerIntentReference),
    { failedEventAt: eventAt },
  );
  expect(auth.occurrence).toEqual({
    status: "Failed",
    occurredAt: eventAt,
    failureReason: "AuthenticationRequired",
  });
  expect(auth.snapshot.status).toBe("Failed");
  // The declined intent is cancelled so its old client credential can never pay.
  const cancelled = await provider.cancelDeclinedIntent(
    context(2),
    declined.providerIntentReference,
  );
  expect(cancelled.status).toBe("Cancelled");
  expect(f.fake.intents.get(declined.providerIntentReference).status).toBe("canceled");
  await provider.adapter.cancelIntent({
    operation: "CancelIntent",
    purpose: "CancelPaymentIntent",
    context: context(4),
    providerIntentReference: abandoned.providerIntentReference,
    idempotencyKey: "cancel-abandoned:" + id(104),
  });
  expect(
    await provider.readTerminalOccurrence(retrieval(4, abandoned.providerIntentReference)),
  ).toMatchObject({ status: "Cancelled" });
  // A captured intent can't be cancelled; Stripe's refusal answers Unknown, retrieval stays true.
  const refused = await provider.adapter.cancelIntent({
    operation: "CancelIntent",
    purpose: "CancelPaymentIntent",
    context: context(1),
    providerIntentReference: paid.providerIntentReference,
    idempotencyKey: "cancel-abandoned:" + id(101),
  });
  expect(refused.kind).toBe("Failure");
  // The client credential is handed out only while the intent awaits the customer.
  const handoff = await provider.handoff.retrieve(
    retrieval(5, (await create(provider, 5)).providerIntentReference),
    {
      amountMinor: 1250n,
      currencyCode: "CAD",
    },
  );
  expect(handoff.clientSecret).toMatch(/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/u);
  await expect(
    provider.handoff.retrieve(retrieval(2, declined.providerIntentReference), {
      amountMinor: 1250n,
      currencyCode: "CAD",
    }),
  ).rejects.toThrow();
});

test("refunds: a lost refund answer is found by its binding; compensation answers a snapshot", async () => {
  const f = await fixture();
  const provider = await stripeProvider(f);
  const paid = await create(provider, 1);
  f.advance(60_000);
  f.fake.confirm(paid.providerIntentReference, "succeeded");
  const refund = (key, amount = 500n) => ({
    operation: "RefundPayment",
    purpose: "RefundPayment",
    context: context(1),
    providerIntentReference: paid.providerIntentReference,
    originalPaymentMethod: "OnlineCard",
    amount: { amountMinor: amount, currencyCode: "CAD" },
    idempotencyKey: key + context(1).operationReference,
  });
  f.fake.injectFault({ method: "POST", path: "/v1/refunds", kind: "drop-response" });
  const lost = await provider.adapter.refundPayment(refund("ordinary-refund:"));
  expect(lost.kind).toBe("Unresolved");
  const found = await provider.adapter.lookupRefund(refund("ordinary-refund:"));
  expect(found).toMatchObject({ kind: "RefundObservation", status: "succeeded" });
  expect(f.fake.refunds.size).toBe(1);
  // Sending the same refund again is Stripe's idempotent replay, never a second refund.
  await provider.adapter.refundPayment(refund("ordinary-refund:"));
  expect(f.fake.refunds.size).toBe(1);
  const compensation = await provider.adapter.refundPayment({
    ...refund("compensation-refund:", 750n),
    context: { ...context(1), operationReference: id(299) },
    idempotencyKey: "compensation-refund:" + id(299),
  });
  expect(compensation).toMatchObject({ kind: "Snapshot", status: "Captured" });
  expect(compensation.refundedAmount.amountMinor).toBe(1250n);
});

test("capture journal and settlement window come from Stripe intents and balance transactions", async () => {
  const f = await fixture();
  const provider = await stripeProvider(f);
  const a = await create(provider, 1),
    b = await create(provider, 2, 2260n),
    open = await create(provider, 3);
  f.fake.seedIntent({ id: "pi_NOTFROMBOP0001", amount: 999 });
  f.advance(60_000);
  f.fake.confirm(a.providerIntentReference);
  f.fake.confirm(b.providerIntentReference);
  f.fake.confirm("pi_NOTFROMBOP0001");
  void open;
  await provider.adapter.refundPayment({
    operation: "RefundPayment",
    purpose: "RefundPayment",
    context: context(1),
    providerIntentReference: a.providerIntentReference,
    originalPaymentMethod: "OnlineCard",
    amount: { amountMinor: 250n, currencyCode: "CAD" },
    idempotencyKey: "ordinary-refund:" + context(1).operationReference,
  });
  const observedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const page = (after) =>
    provider.readCaptureJournal({
      ...scope,
      environment: "Test",
      observedAt,
      afterProviderIntentReference: after,
      limit: 1,
    });
  const first = await page(null);
  expect(first.records).toHaveLength(1);
  const second = await page(first.nextAfterProviderIntentReference);
  expect(second.nextAfterProviderIntentReference).toBeNull();
  const records = [...first.records, ...second.records];
  expect(records.map((r) => r.providerIntentReference)).toEqual(
    [a.providerIntentReference, b.providerIntentReference].sort(),
  );
  const forB = records.find((r) => r.providerIntentReference === b.providerIntentReference);
  expect(forB).toMatchObject({
    paymentOperationReference: id(202),
    paymentAttemptReference: id(102),
    amount: { amountMinor: 2260n, currencyCode: "CAD" },
  });
  expect(forB.providerTransactionReference).toMatch(/^ch_/u);
  const window = await provider.readSettlementWindow({
    ...scope,
    environment: "Test",
    startsAt: new Date(Date.now() - 3_600_000).toISOString(),
    endsAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
  });
  expect(window).toMatchObject({
    source: "StripeBalanceTransactions",
    capturedAmountMinor: 1250n + 2260n + 999n,
    refundedAmountMinor: 250n,
    captureCount: 3,
    refundCount: 1,
  });
});

test("webhook signatures from the stand-in verify against the configured secret", () => {
  const body = JSON.stringify({ id: "evt_SYNTHETIC0001", object: "event" });
  const seconds = Math.floor(Date.now() / 1000);
  const secret = "whsec_" + "FAKESECRET".repeat(3);
  const header = signStripeWebhook(secret, body, seconds);
  const result = verifyStripeWebhookSignature({
    rawBody: new Uint8Array(Buffer.from(body)),
    signatureHeader: header,
    receivedAt: parseWebhookInstant(new Date(seconds * 1000).toISOString()),
    configuration: {
      provider: "Stripe",
      environment: "Test",
      providerAccountReference: id(5),
      ...scope,
      currentSecret: new Uint8Array(Buffer.from(secret)),
      nextSecret: null,
    },
  });
  expect(result.matchedSecretSlot).toBe("Current");
});

test("operator tool: readiness report and dry-run-by-default domain registration", async () => {
  const f = await fixture({
    paymentJson: stripeJson({ paymentMethodDomain: "order.example.ca" }),
  });
  const options = {
    directory: f.directory,
    environment: "InternalTest",
    loadProfile: f.loadProfile,
  };
  let report = await runStripeReadinessCheck(options);
  const status = (check) => report.items.find((item) => item.check === check)?.status;
  expect(status("account")).toBe("ok");
  expect(status("secret-files")).toBe("ok");
  expect(status("webhook-endpoint")).toBe("fail");
  expect(status("payment-method-domain")).toBe("fail");
  expect(report.ok).toBe(false);
  expect(JSON.stringify(report)).not.toContain(f.fake.secretKey);
  expect(JSON.stringify(report)).not.toContain(f.fake.accountId);
  expect(await registerStripePaymentMethodDomain({ ...options })).toEqual({
    applied: false,
    plan: "POST /v1/payment_method_domains order.example.ca",
  });
  await expect(
    registerStripePaymentMethodDomain({
      ...options,
      apply: true,
      confirmTarget: "other.example.ca",
    }),
  ).rejects.toThrow("PILOT_STRIPE_DOMAIN_NOT_CONFIRMED");
  expect(
    await registerStripePaymentMethodDomain({
      ...options,
      apply: true,
      confirmTarget: "order.example.ca",
    }),
  ).toMatchObject({ applied: true, applePay: "active" });
  f.fake.addWebhookEndpoint({
    url: "https://order.example.ca" + STRIPE_WEBHOOK_PATH,
    enabled_events: [
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "payment_intent.canceled",
    ],
  });
  report = await runStripeReadinessCheck(options);
  expect(report.ok).toBe(true);
  // Wallets stay off until the operator turns them on for the verified domain.
  expect(status("wallets")).toBe("skipped");
  expect((await stripeProvider(f)).walletDomain).toBeNull();
  const configured = JSON.parse(readFileSync(join(f.directory, "payment.json"), "utf8"));
  writeFileSync(
    join(f.directory, "payment.json"),
    JSON.stringify({ ...configured, stripe: { ...configured.stripe, walletsEnabled: true } }),
    { mode: 0o600 },
  );
  report = await runStripeReadinessCheck(options);
  expect(status("wallets")).toBe("ok");
  expect((await stripeProvider(f)).walletDomain).toBe("order.example.ca");
  expect(parseStripeOperationsArguments(["check", ".local/pilot-v16"])).toEqual({
    command: "check",
    directory: ".local/pilot-v16",
  });
  expect(() =>
    parseStripeOperationsArguments(["register-domain", ".local/pilot-v16", "--apply"]),
  ).toThrow(/usage/u);
});

test("the binding refuses requests outside its Store and has no capture operation", async () => {
  const provider = createPilotStripeProvider({
    stripe: {
      mode: "test",
      environment: "Test",
      apiVersion: "2025-01-27.acacia",
      connectedAccount: null,
      testApiBaseUrl: null,
      publishableKey: "pk_test_X",
      returnUrl: "https://r.example/x",
      captureLookbackDays: 7,
    },
    secretKey: "sk_test_SYNTHETIC",
    scope,
    fetch: async () => {
      throw new Error("no network in this test");
    },
  });
  await expect(provider.adapter.captureIntent()).rejects.toThrow(
    "PILOT_STRIPE_OPERATION_UNAVAILABLE",
  );
  await expect(
    provider.readTerminalOccurrence({
      ...retrieval(1, "pi_X1"),
      context: { ...context(1), environment: "Live" },
    }),
  ).rejects.toThrow("PILOT_STRIPE_SCOPE_DENIED");
});

test("live mode: a Pilot Store's binding carries the Live environment end to end", async () => {
  const fake = await startStripeFake({ secretKey: "sk_live_" + "FAKE".repeat(6), livemode: true });
  cleanups.push(() => fake.close());
  const viaFake = (input, init) =>
    globalThis.fetch(fake.url + String(input).slice("https://api.stripe.com".length), init);
  const liveStripe = {
    mode: "live",
    environment: "Live",
    apiVersion: "2025-01-27.acacia",
    connectedAccount: null,
    testApiBaseUrl: null,
    publishableKey: "pk_live_SYNTHETIC0001",
    returnUrl: "https://r.example/x",
    captureLookbackDays: 7,
  };
  const provider = createPilotStripeProvider({
    stripe: liveStripe,
    secretKey: fake.secretKey,
    scope,
    fetch: viaFake,
  });
  expect(provider).toMatchObject({ providerKind: "Stripe", environment: "Live" });
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
  expect(pilotProviderEnvironment()).toBe("Live");
  expect(isStripeProvider(provider)).toBe(true);
  const liveContext = { ...context(1), environment: "Live" };
  const created = await provider.adapter.createIntent({
    operation: "CreateIntent",
    purpose: "CreatePaymentIntent",
    context: liveContext,
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    amount: { amountMinor: 1250n, currencyCode: "CAD" },
    idempotencyKey: "create-intent:" + id(101),
  });
  expect(created).toMatchObject({ kind: "Snapshot", status: "RequiresCustomerAction" });
  expect(created.context.environment).toBe("Live");
  // A test-mode request never reaches the live binding.
  await expect(
    provider.adapter.retrieveIntent({ ...retrieval(1, created.providerIntentReference) }),
  ).rejects.toThrow("PILOT_STRIPE_SCOPE_DENIED");
  // A live binding is not this process's Provider in InternalTest, nor a test binding in Pilot.
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", undefined);
  expect(pilotProviderEnvironment()).toBe("Test");
  expect(isPilotPaymentProvider(provider)).toBe(false);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
  expect(isPilotPaymentProvider({ simulation: true })).toBe(false);
  // A live key against a Stripe answer that is not live mode is never taken as an outcome.
  const testModeFake = await startStripeFake({ secretKey: "sk_live_" + "FAKE".repeat(6) });
  cleanups.push(() => testModeFake.close());
  const mismatched = createPilotStripeProvider({
    stripe: liveStripe,
    secretKey: testModeFake.secretKey,
    scope,
    fetch: (input, init) =>
      globalThis.fetch(
        testModeFake.url + String(input).slice("https://api.stripe.com".length),
        init,
      ),
  });
  const refused = await mismatched.adapter.createIntent({
    operation: "CreateIntent",
    purpose: "CreatePaymentIntent",
    context: { ...context(2), environment: "Live" },
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    amount: { amountMinor: 1250n, currencyCode: "CAD" },
    idempotencyKey: "create-intent:" + id(102),
  });
  expect(refused.kind).not.toBe("Snapshot");
  // The configured mode must be this process's Provider environment.
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", undefined);
  await expect(
    createPilotPaymentProvider(
      {},
      {
        directory: "/nonexistent",
        loadProfile: async () => ({ database: "local_test", binding: scope }),
        expectedDatabaseName: "local_test",
        loadConfig: async () => ({ provider: "stripe", stripe: liveStripe }),
      },
    ),
  ).rejects.toThrow("PILOT_STRIPE_MODE_ENVIRONMENT_MISMATCH");
  expect(() =>
    createPilotStripeProvider({
      stripe: { ...liveStripe, environment: "Sandbox" },
      secretKey: fake.secretKey,
      scope,
    }),
  ).toThrow("PILOT_STRIPE_MODE_INVALID");
});
