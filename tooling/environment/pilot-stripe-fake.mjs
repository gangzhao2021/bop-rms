// WP-2423 DEC-STRIPE-PILOT-WIRING — TEST-ONLY local Stripe stand-in.
//
// A loopback HTTP server implementing the subset of the Stripe REST API the pilot calls
// (payment intents, refunds, balance transactions, account, webhook endpoints, payment method
// domains) with Stripe's idempotency semantics, plus signed webhook delivery and fault injection
// (lost response, delayed response, 5xx, duplicate and out-of-order events). It never contacts
// Stripe and holds only synthetic data. It is not a Provider and proves software behaviour only.
import { createHmac, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { setTimeout } from "node:timers";
import { URL, URLSearchParams } from "node:url";

const STRIPE_BASE = "https://api.stripe.com";
const token = (prefix, size = 14) =>
  prefix +
  randomBytes(size)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/gu, "")
    .slice(0, size + 4);

/** Signs a raw webhook body exactly as Stripe does (`t=…,v1=HMAC-SHA256(secret, t.body)`). */
export function signStripeWebhook(secret, rawBody, timestampSeconds) {
  const signature = createHmac("sha256", secret)
    .update(String(timestampSeconds) + "." + rawBody)
    .digest("hex");
  return "t=" + timestampSeconds + ",v1=" + signature;
}

export async function startStripeFake({
  secretKey = "sk_test_" + "FAKE".repeat(6),
  webhookSecret = "whsec_" + "FAKESECRET".repeat(3),
  accountId = "acct_FAKEPILOT0001",
  livemode = false,
  apiVersion = "2025-01-27.acacia",
  clock = () => Date.now(),
} = {}) {
  const intents = new Map(),
    charges = new Map(),
    refunds = new Map(),
    balance = [],
    events = [],
    idempotency = new Map(),
    faults = [],
    calls = [],
    endpoints = [],
    domains = [];
  let webhookTarget = null;
  const seconds = () => Math.floor(clock() / 1000);
  const chargeView = (id) => (id === null ? null : globalThis.structuredClone(charges.get(id)));
  const intentView = (intent, expand) => {
    const value = globalThis.structuredClone(intent);
    if (expand && value.latest_charge !== null)
      value.latest_charge = chargeView(value.latest_charge);
    return value;
  };
  function emit(type, intent) {
    const event = {
      id: token("evt_", 20),
      object: "event",
      api_version: apiVersion,
      created: seconds(),
      livemode,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type,
      data: { object: intentView(intent, false) },
    };
    events.push(event);
    return event;
  }
  function addBalance(type, amount, source) {
    balance.push({
      id: token("txn_", 20),
      object: "balance_transaction",
      amount,
      currency: "cad",
      created: seconds(),
      fee: 0,
      net: amount,
      type,
      source,
      status: "available",
    });
  }
  function error(status, type, code) {
    return { status, body: { error: { type, code, message: "synthetic Stripe fake error" } } };
  }
  function list(url, data, query) {
    const limit = Math.min(Number(query.get("limit") ?? 10), 100);
    const after = query.get("starting_after");
    let start = 0;
    if (after !== null) {
      start = data.findIndex((entry) => entry.id === after) + 1;
      if (start === 0) return error(400, "invalid_request_error", "resource_missing");
    }
    const page = data.slice(start, start + limit);
    return {
      status: 200,
      body: { object: "list", url, has_more: start + limit < data.length, data: page },
    };
  }
  const newestFirst = (a, b) => b.created - a.created || (a.id < b.id ? 1 : -1);
  const inRange = (query, created) => {
    const gte = query.get("created[gte]"),
      lte = query.get("created[lte]"),
      lt = query.get("created[lt]");
    return (
      (gte === null || created >= Number(gte)) &&
      (lte === null || created <= Number(lte)) &&
      (lt === null || created < Number(lt))
    );
  };
  function handle(method, path, query, form) {
    const expand =
      query.getAll("expand[]").includes("latest_charge") ||
      form.getAll("expand[]").includes("latest_charge");
    let match;
    if (method === "POST" && path === "/v1/payment_intents") {
      const amount = Number(form.get("amount"));
      if (!Number.isSafeInteger(amount) || amount < 1 || form.get("currency") !== "cad")
        return error(400, "invalid_request_error", "parameter_invalid_integer");
      const metadata = {};
      for (const [key, value] of form)
        if (key.startsWith("metadata[")) metadata[key.slice(9, -1)] = value;
      const id = token("pi_", 20);
      const intent = {
        id,
        object: "payment_intent",
        amount,
        amount_capturable: 0,
        amount_received: 0,
        canceled_at: null,
        cancellation_reason: null,
        capture_method: form.get("capture_method") ?? "automatic",
        client_secret: id + "_secret_" + token("", 20),
        confirmation_method: "automatic",
        created: seconds(),
        currency: "cad",
        last_payment_error: null,
        latest_charge: null,
        livemode,
        metadata,
        payment_method_types: form.getAll("payment_method_types[]"),
        status: "requires_payment_method",
      };
      intents.set(id, intent);
      emit("payment_intent.created", intent);
      return { status: 200, body: intentView(intent, expand) };
    }
    if (method === "GET" && path === "/v1/payment_intents") {
      const data = [...intents.values()]
        .filter((intent) => inRange(query, intent.created))
        .sort(newestFirst)
        .map((intent) => intentView(intent, false));
      return list("/v1/payment_intents", data, query);
    }
    if ((match = /^\/v1\/payment_intents\/(pi_[A-Za-z0-9]+)(\/cancel)?$/u.exec(path))) {
      const intent = intents.get(match[1]);
      if (!intent) return error(404, "invalid_request_error", "resource_missing");
      if (method === "GET" && !match[2]) return { status: 200, body: intentView(intent, expand) };
      if (method === "POST" && match[2]) {
        if (
          !["requires_payment_method", "requires_action", "requires_confirmation"].includes(
            intent.status,
          )
        )
          return error(400, "invalid_request_error", "payment_intent_unexpected_state");
        intent.status = "canceled";
        intent.canceled_at = seconds();
        intent.cancellation_reason = form.get("cancellation_reason") ?? null;
        emit("payment_intent.canceled", intent);
        return { status: 200, body: intentView(intent, expand) };
      }
    }
    if (method === "POST" && path === "/v1/refunds") {
      const intent = intents.get(form.get("payment_intent"));
      const amount = Number(form.get("amount"));
      if (!intent || intent.status !== "succeeded")
        return error(400, "invalid_request_error", "charge_not_refundable");
      const charge = charges.get(intent.latest_charge);
      if (
        !Number.isSafeInteger(amount) ||
        amount < 1 ||
        charge.amount_refunded + amount > charge.amount
      )
        return error(400, "invalid_request_error", "amount_too_large");
      const metadata = {};
      for (const [key, value] of form)
        if (key.startsWith("metadata[")) metadata[key.slice(9, -1)] = value;
      const refund = {
        id: token("re_", 20),
        object: "refund",
        amount,
        charge: charge.id,
        created: seconds(),
        currency: "cad",
        metadata,
        payment_intent: intent.id,
        status: "succeeded",
      };
      refunds.set(refund.id, refund);
      charge.amount_refunded += amount;
      charge.refunded = charge.amount_refunded === charge.amount;
      addBalance("refund", -amount, refund.id);
      return { status: 200, body: globalThis.structuredClone(refund) };
    }
    if (method === "GET" && path === "/v1/refunds") {
      const intent = query.get("payment_intent");
      const data = [...refunds.values()]
        .filter((refund) => intent === null || refund.payment_intent === intent)
        .sort(newestFirst)
        .map((refund) => globalThis.structuredClone(refund));
      return list("/v1/refunds", data, query);
    }
    if (method === "GET" && path === "/v1/balance_transactions") {
      const data = balance
        .filter((entry) => inRange(query, entry.created))
        .sort(newestFirst)
        .map((entry) => globalThis.structuredClone(entry));
      return list("/v1/balance_transactions", data, query);
    }
    if (method === "GET" && path === "/v1/account")
      return {
        status: 200,
        body: {
          id: accountId,
          object: "account",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          country: "CA",
          default_currency: "cad",
        },
      };
    if (method === "GET" && path === "/v1/webhook_endpoints")
      return list("/v1/webhook_endpoints", globalThis.structuredClone(endpoints), query);
    if (method === "GET" && path === "/v1/payment_method_domains") {
      const name = query.get("domain_name");
      const data = domains.filter((d) => name === null || d.domain_name === name);
      return list("/v1/payment_method_domains", globalThis.structuredClone(data), query);
    }
    if (method === "POST" && path === "/v1/payment_method_domains") {
      const name = form.get("domain_name");
      if (typeof name !== "string" || name.length === 0)
        return error(400, "invalid_request_error", "parameter_missing");
      const existing = domains.find((d) => d.domain_name === name);
      if (existing) return { status: 200, body: globalThis.structuredClone(existing) };
      const domain = {
        id: token("pmd_", 20),
        object: "payment_method_domain",
        domain_name: name,
        enabled: form.get("enabled") === "true",
        livemode,
        apple_pay: { status: "active" },
        google_pay: { status: "active" },
        link: { status: "active" },
        created: seconds(),
      };
      domains.push(domain);
      return { status: 200, body: globalThis.structuredClone(domain) };
    }
    return error(404, "invalid_request_error", "resource_missing");
  }
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(request.url, "http://127.0.0.1");
      const key = request.headers["idempotency-key"] ?? null;
      const record = {
        method: request.method,
        path: url.pathname,
        query: url.search,
        idempotencyKey: key,
        stripeVersion: request.headers["stripe-version"] ?? null,
      };
      calls.push(record);
      const fault = faults.findIndex(
        (f) => f.method === request.method && url.pathname.startsWith(f.path) && f.times > 0,
      );
      const selected = fault >= 0 ? faults[fault] : null;
      if (selected) {
        selected.times -= 1;
        if (selected.times === 0) faults.splice(fault, 1);
      }
      if (request.headers.authorization !== "Bearer " + secretKey) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify(error(401, "invalid_request_error", "api_key_invalid").body));
        return;
      }
      if (selected?.kind === "status-500" && selected.process !== true) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify(error(500, "api_error", "synthetic").body));
        return;
      }
      let result;
      if (key !== null && idempotency.has(key)) {
        const prior = idempotency.get(key);
        result =
          prior.fingerprint === request.method + " " + url.pathname + " " + raw
            ? prior.result
            : error(400, "idempotency_error", "idempotency_key_in_use");
        record.replayed = prior.fingerprint === request.method + " " + url.pathname + " " + raw;
      } else {
        result = handle(request.method, url.pathname, url.searchParams, new URLSearchParams(raw));
        if (key !== null && request.method === "POST")
          idempotency.set(key, {
            fingerprint: request.method + " " + url.pathname + " " + raw,
            result,
          });
      }
      if (selected?.kind === "drop-response") {
        // The request took effect; its answer is lost on the way back (the "lost create").
        request.socket.destroy();
        return;
      }
      if (selected?.kind === "delay-response")
        await new Promise((resolve) => setTimeout(resolve, selected.delayMs ?? 1000));
      if (selected?.kind === "status-500") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify(error(500, "api_error", "synthetic").body));
        return;
      }
      response.writeHead(result.status, {
        "content-type": "application/json",
        "request-id": token("req_", 14),
      });
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  /** Routes the adapters' fixed `https://api.stripe.com` origin to this loopback stand-in. */
  const fakeFetch = (input, init) => {
    const target = String(input);
    if (!target.startsWith(STRIPE_BASE + "/")) throw new Error("STRIPE_FAKE_UNEXPECTED_ORIGIN");
    return globalThis.fetch(url + target.slice(STRIPE_BASE.length), init);
  };
  function mustIntent(id) {
    const intent = intents.get(id);
    if (!intent) throw new Error("STRIPE_FAKE_INTENT_UNKNOWN");
    return intent;
  }
  return {
    url,
    fetch: fakeFetch,
    secretKey,
    webhookSecret,
    accountId,
    apiVersion,
    calls,
    events,
    intents,
    refunds,
    balance,
    /** Next matching request(s): "drop-response" | "delay-response" | "status-500". */
    injectFault({ method, path, kind, times = 1, delayMs, process }) {
      faults.push({ method, path, kind, times, delayMs, process });
    },
    /** The customer's card is confirmed in Stripe.js (succeeded, declined or failed 3-D Secure). */
    confirm(id, outcome = "succeeded") {
      const intent = mustIntent(id);
      if (
        !["requires_payment_method", "requires_confirmation", "requires_action"].includes(
          intent.status,
        )
      )
        throw new Error("STRIPE_FAKE_INTENT_NOT_CONFIRMABLE");
      if (outcome === "authentication_failed") {
        intent.status = "requires_payment_method";
        intent.last_payment_error = {
          type: "invalid_request_error",
          code: "payment_intent_authentication_failure",
        };
        return emit("payment_intent.payment_failed", intent);
      }
      const succeeded = outcome === "succeeded";
      const charge = {
        id: token("ch_", 20),
        object: "charge",
        amount: intent.amount,
        amount_captured: succeeded ? intent.amount : 0,
        amount_refunded: 0,
        captured: succeeded,
        created: seconds(),
        currency: "cad",
        livemode,
        paid: succeeded,
        payment_intent: intent.id,
        payment_method_details: { type: "card" },
        refunded: false,
        status: succeeded ? "succeeded" : "failed",
      };
      charges.set(charge.id, charge);
      intent.latest_charge = charge.id;
      if (succeeded) {
        intent.status = "succeeded";
        intent.amount_received = intent.amount;
        intent.last_payment_error = null;
        addBalance("charge", intent.amount, charge.id);
        return emit("payment_intent.succeeded", intent);
      }
      intent.status = "requires_payment_method";
      intent.last_payment_error = {
        type: "card_error",
        code: "card_declined",
        decline_code: "generic_decline",
      };
      return emit("payment_intent.payment_failed", intent);
    },
    /** A synthetic intent created outside this run (e.g. a seeded Payment attempt). */
    seedIntent({ id, amount, metadata = {}, created = seconds() }) {
      const intent = {
        id,
        object: "payment_intent",
        amount,
        amount_capturable: 0,
        amount_received: 0,
        canceled_at: null,
        cancellation_reason: null,
        capture_method: "automatic",
        client_secret: id + "_secret_" + token("", 20),
        confirmation_method: "automatic",
        created,
        currency: "cad",
        last_payment_error: null,
        latest_charge: null,
        livemode,
        metadata,
        payment_method_types: ["card"],
        status: "requires_payment_method",
      };
      intents.set(id, intent);
      return intent;
    },
    addWebhookEndpoint(endpoint) {
      endpoints.push({
        id: token("we_", 20),
        object: "webhook_endpoint",
        api_version: apiVersion,
        livemode,
        status: "enabled",
        ...endpoint,
      });
    },
    setWebhookTarget(target) {
      webhookTarget = target;
    },
    /**
     * Delivers one event to the webhook target, signed with `secret` at `timestamp`. Returns the
     * HTTP status. Redelivery of the same event (Stripe retries) re-signs the same body.
     */
    async deliver(event, { secret = webhookSecret, timestamp = seconds(), tamper = false } = {}) {
      if (webhookTarget === null) throw new Error("STRIPE_FAKE_NO_WEBHOOK_TARGET");
      const body = JSON.stringify(event);
      const header = signStripeWebhook(secret, body, timestamp);
      const response = await globalThis.fetch(webhookTarget, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "stripe-signature": header,
          "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
        },
        body: tamper ? body.replace('"livemode"', '"livemode" ') : body,
      });
      await response.arrayBuffer();
      return response.status;
    },
    eventsFor(id, type) {
      return events.filter(
        (e) => e.data.object.id === id && (type === undefined || e.type === type),
      );
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
