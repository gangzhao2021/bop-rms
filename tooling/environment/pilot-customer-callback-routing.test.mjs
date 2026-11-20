import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  callbackBodyLimit,
  createCustomerCallbackRouting,
  logCallbackRouting,
} from "./pilot-customer-callback-routing.mjs";

const id = (n) => "0190aa21-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const topic = (name) => "arn:aws:sns:ca-central-1:123456789012:" + name;
const link = (c) => c.repeat(43);
const store = (n, overrides = {}) => ({
  storeReference: id(n),
  tenantReference: id(100 + n),
  port: 4300 + n,
  issuedOrderLink: vi.fn(async (token) => token === link(String(n))),
  feedbackRoute: null,
  stripeWebhook: null,
  ...overrides,
});
const json = (value) => Buffer.from(JSON.stringify(value));
const pageOrigin = "https://order.example.test";
const fromPage = {
  origin: pageOrigin,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};
const orderLink = (token, { body = json({ token }), headers = fromPage, url = "" } = {}) => ({
  url: "/api/v1/customer/order-recovery" + url,
  body,
  headers,
  peerAddress: "203.0.113.9",
});
const signedSns = { verifyVersion2: vi.fn(async () => true) };
const sesEnvelope = (topicArn, set, type = "Notification") =>
  json({
    Type: type,
    MessageId: "018faa00-0000-4000-8000-000000000001",
    TopicArn: topicArn,
    Message:
      type === "Notification"
        ? JSON.stringify({
            eventType: "Bounce",
            mail: set === null ? {} : { tags: { "ses:configuration-set": [set] } },
          })
        : "You have chosen to subscribe.",
    Timestamp: "2026-11-19T12:00:00.000Z",
    SignatureVersion: "2",
    Signature: Buffer.alloc(64, 7).toString("base64"),
    SigningCertURL:
      "https://sns.ca-central-1.amazonaws.com/SimpleNotificationService-" + "a".repeat(32) + ".pem",
    ...(type === "SubscriptionConfirmation"
      ? {
          Token: "T".repeat(43),
          SubscribeURL: "https://sns.ca-central-1.amazonaws.com/?Action=ConfirmSubscription",
        }
      : {}),
  });
const ses = (body) => ({ url: "/api/v1/provider/ses-feedback", body, headers: {} });
const stripeEvent = (metadata, type = "payment_intent.succeeded") =>
  json({
    id: "evt_SYNTHETIC",
    object: "event",
    type,
    created: 1_790_000_000,
    data: { object: { id: "pi_SYNTHETIC", object: "payment_intent", metadata } },
  });
const stripe = (body) => ({
  url: "/api/v1/payment-provider/stripe/webhook",
  body,
  headers: { "stripe-signature": "t=1,v1=" + "0".repeat(64) },
});
const claim = (verifies, operations = []) => ({
  verifies: vi.fn(async () => verifies),
  holdsOperation: vi.fn(async (reference) => operations.includes(reference)),
});

function routing(stores, { everyStoreServed = true } = {}) {
  const log = vi.fn();
  return {
    log,
    route: createCustomerCallbackRouting({
      stores,
      everyStoreServed,
      snsSignatures: signedSns,
      orderLinkOrigin: pageOrigin,
      log,
    }),
  };
}

describe("batch 34: callbacks that name no Store reach the Store that claims them", () => {
  it("routes only these POST paths, each with its own route's body limit", () => {
    expect(callbackBodyLimit("POST", "/api/v1/customer/order-recovery")).toBe(16 * 1024);
    expect(callbackBodyLimit("POST", "/api/v1/provider/ses-feedback")).toBe(128 * 1024);
    expect(callbackBodyLimit("POST", "/api/v1/payment-provider/stripe/webhook")).toBe(1024 * 1024);
    for (const [method, url] of [
      ["GET", "/api/v1/customer/order-recovery"],
      ["POST", "/api/v1/customer/order-messages"],
      ["POST", "/api/v1/customer/order-recovery/x"],
    ])
      expect(callbackBodyLimit(method, url)).toBeNull();
  });

  it("order link: every Store is asked (no early answer); only the issuing one gets it", async () => {
    const stores = [store(1), store(2), store(3)];
    const { route } = routing(stores);
    expect((await route(orderLink(link("1")))).store).toBe(stores[0]);
    for (const each of stores) expect(each.issuedOrderLink).toHaveBeenCalledTimes(1);
    expect((await route(orderLink(link("3")))).store).toBe(stores[2]);
    // No Store issued it, or it is malformed (two Tenants): the first Store answers it on its own
    // per-address budget, so guessing is rate limited as at one Store.
    for (const token of [link("Z"), "short", 7])
      expect((await route(orderLink(token))).store).toBe(stores[0]);
    // Two Stores both claiming one link (a keyed-hash collision): the uniform refusal, logged.
    const both = [
      store(1, { issuedOrderLink: vi.fn(async () => true) }),
      store(2, { issuedOrderLink: vi.fn(async () => true) }),
    ];
    const twice = routing(both);
    const { answer } = await twice.route(orderLink(link("1")));
    expect([answer.status, answer.body]).toEqual([
      400,
      { schemaVersion: 1, error: { code: "order_link_unavailable" } },
    ]);
    expect(answer.headers["Cache-Control"]).toBe("no-store");
    expect(twice.log).toHaveBeenCalledWith({
      code: "PILOT_CALLBACK_UNCLAIMED",
      provider: "order-link",
      reason: "Ambiguous",
    });
  });

  it("order link: a Store that can't answer, or one not served, is a retry, never 'expired'", async () => {
    const down = store(2, { issuedOrderLink: vi.fn(async () => Promise.reject(new Error("x"))) });
    const outage = await routing([store(1), down]).route(orderLink(link("Z")));
    expect([outage.answer.status, outage.answer.body.error.code]).toEqual([
      503,
      "order_link_service_unavailable",
    ]);
    expect(outage.answer.headers["Retry-After"]).toBe("30");
    // The Store that answers still gets its own link while another is down.
    const ok = store(1);
    expect((await routing([ok, down]).route(orderLink(link("1")))).store).toBe(ok);
    const missing = await routing([store(1), store(2)], { everyStoreServed: false }).route(
      orderLink(link("Z")),
    );
    expect(missing.answer.status).toBe(503);
  });

  it("batch 35: what no Store looked up spends the first Store's per-address budget first", async () => {
    const budget = (status) =>
      vi.fn(async () => (status === "Allowed" ? { status } : { status, retryAfterSeconds: 1800 }));
    const allowed = budget("Allowed");
    const stores = [store(1, { spendOrderLinkAttempt: allowed }), store(2)];
    const { route } = routing(stores);
    // Malformed, as the Store's route would refuse it unread: spent here, then the first Store's
    // own uniform refusal. Nothing asked of any Store.
    const malformed = [
      orderLink("short"),
      orderLink(7),
      orderLink(link("Z"), { body: json({ token: link("Z"), extra: 1 }) }),
      orderLink(link("Z"), { body: Buffer.from("{not json") }),
      orderLink(link("Z"), { body: json([link("Z")]) }),
      orderLink(link("Z"), { headers: { ...fromPage, "content-type": "text/plain" } }),
      orderLink(link("Z"), { url: "?t=1" }),
    ];
    for (const request of malformed) expect((await route(request)).store).toBe(stores[0]);
    expect(allowed).toHaveBeenCalledTimes(malformed.length);
    expect(allowed).toHaveBeenCalledWith({ peerAddress: "203.0.113.9" });
    for (const each of stores) expect(each.issuedOrderLink).not.toHaveBeenCalled();
    // Well formed: the Store that issued it, or the first Store (its own route spends the budget).
    expect((await route(orderLink(link("2")))).store).toBe(stores[1]);
    expect((await route(orderLink(link("Z")))).store).toBe(stores[0]);
    expect(allowed).toHaveBeenCalledTimes(malformed.length);
    // Not sent by the app's own page: no Store asked, nothing spent, the first Store refuses it.
    for (const headers of [{}, { ...fromPage, origin: "https://other.example" }])
      expect((await route(orderLink(link("2"), { headers }))).store).toBe(stores[0]);
    expect(stores[1].issuedOrderLink).toHaveBeenCalledTimes(2);
    expect(allowed).toHaveBeenCalledTimes(malformed.length);

    // Spent: 429 with when to try again, for a malformed one and for one asked during an outage.
    const limited = budget("RateLimited");
    const down = store(2, { issuedOrderLink: vi.fn(async () => Promise.reject(new Error("x"))) });
    const spent = routing([store(1, { spendOrderLinkAttempt: limited }), down]);
    for (const request of [orderLink("short"), orderLink(link("Z"))]) {
      const { answer } = await spent.route(request);
      expect([answer.status, answer.headers["Retry-After"], answer.body]).toEqual([
        429,
        "1800",
        { schemaVersion: 1, error: { code: "order_link_rate_limited" } },
      ]);
    }
    // Still allowed during the outage: spent, and the retry.
    const outage = await routing([store(1, { spendOrderLinkAttempt: allowed }), down]).route(
      orderLink(link("Z")),
    );
    expect(outage.answer.status).toBe(503);
    // A budget that can't be checked is a retry, never an unlimited refusal.
    const broken = routing([
      store(1, { spendOrderLinkAttempt: vi.fn(async () => Promise.reject(new Error("x"))) }),
      store(2),
    ]);
    const failed = await broken.route(orderLink("short"));
    expect([failed.answer.status, failed.answer.headers["Retry-After"]]).toEqual([503, "30"]);
  });

  it("order link with one Tenant: what no Store issued goes to the first Store, as before", async () => {
    const stores = [store(1, { tenantReference: id(9) }), store(2, { tenantReference: id(9) })];
    const { route } = routing(stores);
    expect((await route(orderLink(link("2")))).store).toBe(stores[1]);
    expect((await route(orderLink(link("Z")))).store).toBe(stores[0]);
    expect((await route(orderLink("short"))).store).toBe(stores[0]);
  });

  it("SES: the topic names the Store; Stores sharing a topic are told apart by configuration set", async () => {
    const shared = topic("installation-events");
    const stores = [
      store(1, { feedbackRoute: { topicArn: shared, configurationSetName: "store-one" } }),
      store(2, { feedbackRoute: { topicArn: shared, configurationSetName: "store-two" } }),
      store(3, { feedbackRoute: { topicArn: topic("own"), configurationSetName: "store-two" } }),
    ];
    const { route, log } = routing(stores);
    expect((await route(ses(sesEnvelope(shared, "store-two")))).store).toBe(stores[1]);
    expect((await route(ses(sesEnvelope(shared, "store-one")))).store).toBe(stores[0]);
    // Its own topic is enough, whatever (or no) configuration set it carries.
    expect((await route(ses(sesEnvelope(topic("own"), null)))).store).toBe(stores[2]);
    // Confirming the shared topic's subscription is the same act for each: the first.
    expect((await route(ses(sesEnvelope(shared, null, "SubscriptionConfirmation")))).store).toBe(
      stores[0],
    );
    expect(log).not.toHaveBeenCalled();
    // A shared topic and no (or an unknown) configuration set: acknowledged and logged.
    for (const [set, reason] of [
      [null, "NoConfigurationSet"],
      ["someone-else", "NoConfigurationSet"],
    ]) {
      const { answer } = await route(ses(sesEnvelope(shared, set)));
      expect([answer.status, answer.body]).toEqual([200, { outcome: "Ignored" }]);
      expect(log).toHaveBeenLastCalledWith({
        code: "PILOT_CALLBACK_UNCLAIMED",
        provider: "ses",
        reason,
      });
    }
  });

  it("SES: refused before routing when unverified; a missing Store makes it a retry", async () => {
    const stores = [
      store(1, { feedbackRoute: { topicArn: topic("a"), configurationSetName: "a" } }),
    ];
    const forged = createCustomerCallbackRouting({
      stores,
      everyStoreServed: true,
      snsSignatures: { verifyVersion2: async () => false },
      log: vi.fn(),
    });
    expect((await forged(ses(sesEnvelope(topic("a"), "a")))).answer.status).toBe(403);
    const { route } = routing(stores);
    expect((await route(ses(Buffer.from("not json")))).answer.status).toBe(400);
    expect(
      (
        await route({
          ...ses(sesEnvelope(topic("a"), "a")),
          headers: { "x-amz-sns-message-type": "SubscriptionConfirmation" },
        })
      ).answer.status,
    ).toBe(400);
    const waiting = routing(stores, { everyStoreServed: false });
    expect((await waiting.route(ses(sesEnvelope(topic("b"), "b")))).answer).toMatchObject({
      status: 503,
      body: { outcome: "retry" },
    });
    expect(waiting.log).not.toHaveBeenCalled();
  });

  it("Stripe: the Store whose secret signed it; one shared account by the Store's payment operation", async () => {
    const own = [
      store(1, { stripeWebhook: claim(false) }),
      store(2, { stripeWebhook: claim(true) }),
    ];
    expect((await routing(own).route(stripe(stripeEvent({})))).store).toBe(own[1]);
    for (const each of own) expect(each.stripeWebhook.verifies).toHaveBeenCalledTimes(1);
    // One account for two Stores of one brand: both secrets verify; the metadata decides.
    const operation = id(0x77);
    const sharing = [
      store(1, { stripeWebhook: claim(true, [id(0x76)]) }),
      store(2, { stripeWebhook: claim(true, [operation]) }),
    ];
    const { route, log } = routing(sharing);
    expect(
      (
        await route(
          stripe(stripeEvent({ bop_payment_operation: operation, bop_payment_attempt: id(1) })),
        )
      ).store,
    ).toBe(sharing[1]);
    // Not a payment outcome, or a payment neither Store holds: acknowledged and logged.
    for (const [body, reason] of [
      [stripeEvent({}, "charge.refunded"), "NoPaymentOperation"],
      [stripeEvent({ bop_payment_operation: id(0x99) }), "NoStore"],
    ]) {
      const { answer } = await route(stripe(body));
      expect([answer.status, answer.body]).toEqual([200, { received: true }]);
      expect(log).toHaveBeenLastCalledWith({
        code: "PILOT_CALLBACK_UNCLAIMED",
        provider: "stripe",
        reason,
      });
    }
  });

  it("Stripe: refused when no Store's secret signed it; a retry when a Store can't be asked", async () => {
    const { route, log } = routing([store(1, { stripeWebhook: claim(false) }), store(2)]);
    const refused = await route(stripe(stripeEvent({})));
    expect([refused.answer.status, refused.answer.body.error.code]).toEqual([
      400,
      "webhook_rejected",
    ]);
    expect(log).toHaveBeenCalledWith({
      code: "PILOT_CALLBACK_REFUSED",
      provider: "stripe",
      reason: "NoStoreSecret",
    });
    const unreadable = store(2, {
      stripeWebhook: { verifies: async () => Promise.reject(new Error("x")) },
    });
    const outage = await routing([store(1, { stripeWebhook: claim(false) }), unreadable]).route(
      stripe(stripeEvent({})),
    );
    expect([outage.answer.status, outage.answer.headers["Retry-After"]]).toEqual([503, "30"]);
    const missing = await routing([store(1, { stripeWebhook: claim(false) })], {
      everyStoreServed: false,
    }).route(stripe(stripeEvent({})));
    expect(missing.answer.status).toBe(503);
    // No signature at all: the route's own refusal, no Store asked.
    const bare = await route({ ...stripe(stripeEvent({})), headers: {} });
    expect(bare.answer.status).toBe(400);
  });

  it("logs one level-40 line of codes only", () => {
    const write = vi.fn();
    logCallbackRouting(
      { code: "PILOT_CALLBACK_UNCLAIMED", provider: "ses", reason: "NoStore" },
      { write, now: () => Date.parse("2026-11-19T12:00:00.000Z") },
    );
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({
      level: 40,
      time: "2026-11-19T12:00:00.000Z",
      event: "customer_callback_routing",
      code: "PILOT_CALLBACK_UNCLAIMED",
      provider: "ses",
      reason: "NoStore",
    });
  });
});
