import { Buffer } from "node:buffer";
import console from "node:console";
import { URL } from "node:url";
import {
  SesSnsEventError,
  readVerifiedSesFeedbackRoute,
} from "../../packages/bop/notification/src/index.ts";
import { parseStripeWebhookPaymentEvent } from "../../packages/rms/payment/src/index.ts";

/**
 * WP-2423 batch 34 (DEC-MULTI-MERCHANT-ONE-INSTALLATION): the requests that reach an installation
 * of several Stores carrying no guest Session and no Store in their address, and that a merchant's
 * customers or providers depend on. Each goes to the one served Store that claims it from its own
 * server-side facts, never by a guess; that Store's own API then verifies and records it exactly
 * as a single-Store installation does.
 *
 * - The one-time order link (`POST /api/v1/customer/order-recovery`): the Store whose own records
 *   hold the link's keyed hash (Identity's `issued`, each Store with its own pepper). Every served
 *   Store is asked, always all of them, so the answer and its timing say nothing about which
 *   Stores exist. A link no Store issued goes to the installation's own first Store, which spends
 *   its per-address budget and gives its own uniform "this link can't open your order", so
 *   guessing links is rate limited exactly as at one Store. Batch 35 (v15 b34 live): what is
 *   answered without a Store looking the token up (a malformed request from the app's own page,
 *   or one asked while a Store can't be read) spends that same first-Store budget here first, and
 *   once it is spent the answer is 429 with Retry-After; a request no page of this site sent
 *   (wrong Origin or Sec-Fetch-Site) asks no Store and goes to the first Store, which refuses it
 *   as one Store does.
 * - SES feedback (`POST /api/v1/provider/ses-feedback`): the SNS signature is verified first, then
 *   the signed topic names the Store whose notification.json subscribes it; Stores sharing a topic
 *   are told apart by the SES configuration set the sending Store named on the message.
 * - The Stripe webhook: the Store whose own webhook endpoint secret signed these bytes (each Stripe
 *   account has its own secret); Stores sharing one account are told apart by the payment
 *   operation in the intent metadata the Store set, held in that Store's own Payment records.
 *
 * A verified provider event no served Store claims is acknowledged (so the provider stops
 * resending it) and logged at level 40 with a code; while a Store named in stores.json is not
 * served, or a Store's facts cannot be read, the answer is a retryable 503 instead, so nothing is
 * lost. Logs carry codes only: never a body, token, signature, address or provider identifier.
 */
const ORDER_RECOVERY = /^\/api\/v1\/customer\/order-recovery(?:[?].*)?$/u;
const SES_FEEDBACK = /^\/api\/v1\/provider\/ses-feedback(?:[?].*)?$/u;
const STRIPE_WEBHOOK = /^\/api\/v1\/payment-provider\/stripe\/webhook(?:[?].*)?$/u;
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

/** Sent by the app's own page (what the Store's route checks before anything else). */
function fromOwnPage(headers, origin) {
  return (
    typeof origin === "string" &&
    headers.origin === origin &&
    headers["sec-fetch-site"] === "same-origin"
  );
}
/**
 * The token of a request the Store's route would look up (JSON, no query, exactly `{token}` with a
 * 43-character token), or null for one it refuses unread (malformed), which spends nothing there.
 */
function wellFormedLinkToken(url, headers, body) {
  const [type, ...parameters] = String(headers["content-type"] ?? "")
    .split(";")
    .map((part) => part.trim().toLowerCase());
  if (type !== "application/json" || parameters.some((p) => p !== "" && p !== "charset=utf-8"))
    return null;
  if (new URL(url, "https://route.invalid").searchParams.size !== 0) return null;
  const parsed = jsonBody(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  return keys.length === 1 &&
    keys[0] === "token" &&
    typeof parsed.token === "string" &&
    LINK_TOKEN.test(parsed.token)
    ? parsed.token
    : null;
}

/** How many body bytes a routed callback may carry (each route's own parser limit), or null. */
export function callbackBodyLimit(method, url) {
  if (method !== "POST" || typeof url !== "string") return null;
  if (ORDER_RECOVERY.test(url)) return 16 * 1024;
  if (SES_FEEDBACK.test(url)) return 128 * 1024;
  if (STRIPE_WEBHOOK.test(url)) return 1024 * 1024;
  return null;
}

/** What the route itself would answer, so an answer given here can't be told from the Store's. */
const answers = {
  orderLink: (status, retryAfterSeconds = 30) => ({
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...(status === 503 || status === 429 ? { "Retry-After": String(retryAfterSeconds) } : {}),
    },
    body: {
      schemaVersion: 1,
      error: {
        code:
          status === 429
            ? "order_link_rate_limited"
            : status === 503
              ? "order_link_service_unavailable"
              : "order_link_unavailable",
      },
    },
  }),
  ses: (status, outcome) => ({
    status,
    headers: { "Cache-Control": "no-store" },
    body: { outcome },
  }),
  stripe: (status) => ({
    status,
    headers: { "Cache-Control": "no-store", ...(status === 503 ? { "Retry-After": "30" } : {}) },
    body:
      status === 200
        ? { received: true }
        : {
            error: {
              code: status === 400 ? "webhook_rejected" : "webhook_unavailable",
              message: "The webhook could not be accepted.",
            },
          },
  }),
};

/** One level-40 line: the code, the route's provider and a closed reason word only. */
export function logCallbackRouting(
  { code, provider, reason },
  { write = (line) => console.log(line), now = Date.now } = {},
) {
  try {
    write(
      JSON.stringify({
        level: 40,
        time: new Date(now()).toISOString(),
        event: "customer_callback_routing",
        code,
        provider,
        reason,
      }),
    );
  } catch {
    // Observability never changes an answer.
  }
}

/** Asks every Store at once (no early answer); `unreadable` when any of them failed. */
async function askAll(stores, ask) {
  const settled = await Promise.allSettled(stores.map((store) => ask(store)));
  return {
    claims: stores.filter((_, index) => settled[index].value === true),
    unreadable: settled.some((result) => result.status === "rejected"),
  };
}
function jsonBody(body) {
  try {
    return JSON.parse(Buffer.from(body ?? "").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * `stores`: the served Stores, the installation's own first, each { tenantReference, port,
 * issuedOrderLink(token) → Promise<boolean> | undefined, spendOrderLinkAttempt({ peerAddress }) →
 * Promise<{ status: "Allowed" } | { status: "RateLimited", retryAfterSeconds }> | undefined,
 * feedbackRoute: { topicArn, configurationSetName } | null, stripeWebhook: { verifies(input),
 * holdsOperation(reference) } | null }. `everyStoreServed`: every Store stores.json names is served now. `snsSignatures`: the SNS
 * signature verifier (`verifyVersion2`). `orderLinkOrigin`: the customer app's exact origin.
 */
export function createCustomerCallbackRouting({
  stores,
  everyStoreServed,
  snsSignatures,
  orderLinkOrigin,
  now = () => new Date().toISOString(),
  log = logCallbackRouting,
}) {
  if (!Array.isArray(stores) || stores.length < 1)
    throw new Error("CUSTOMER_CALLBACK_ROUTING_INVALID");
  // What no Store issued: the first Store answers it, spending its per-address budget, as a
  // single-Store installation does (never an unbudgeted answer here that a guesser could repeat).
  const unowned = stores[0];
  const answer = (value) => ({ answer: value });
  const to = (store) => ({ store });

  /**
   * Batch 35: spends the first Store's budget for links no Order holds (the bucket its own route
   * spends for an unknown token); the 429 once spent, `otherwise` while allowed. A Store without
   * order messaging answers every link 503 itself; a budget that can't be checked is a retry.
   */
  async function spendThen(peerAddress, otherwise) {
    if (typeof unowned.spendOrderLinkAttempt !== "function") return otherwise;
    let budget;
    try {
      budget = await unowned.spendOrderLinkAttempt({ peerAddress });
    } catch {
      return answer(answers.orderLink(503));
    }
    if (budget?.status === "Allowed") return otherwise;
    if (budget?.status === "RateLimited")
      return answer(answers.orderLink(429, budget.retryAfterSeconds ?? 3600));
    return answer(answers.orderLink(503));
  }

  async function orderLink(url, body, headers, peerAddress) {
    // Not sent by the app's page: the first Store refuses it before reading it, as one Store does.
    if (!fromOwnPage(headers, orderLinkOrigin)) return to(unowned);
    const token = wellFormedLinkToken(url, headers, body);
    if (token === null) return spendThen(peerAddress, to(unowned));
    const { claims, unreadable } = await askAll(
      stores.filter((store) => typeof store.issuedOrderLink === "function"),
      (store) => store.issuedOrderLink(token),
    );
    if (claims.length === 1) return to(claims[0]);
    if (claims.length > 1) {
      log({ code: "PILOT_CALLBACK_UNCLAIMED", provider: "order-link", reason: "Ambiguous" });
      return spendThen(peerAddress, answer(answers.orderLink(400)));
    }
    // The Store that issued it may be the one not answering now: try again, never "expired".
    if (unreadable || !everyStoreServed)
      return spendThen(peerAddress, answer(answers.orderLink(503)));
    return to(unowned);
  }

  async function sesFeedback(body, headers) {
    if (body.length > 131_072) return answer(answers.ses(413, "rejected"));
    const parsed = jsonBody(body);
    const type = headers["x-amz-sns-message-type"];
    if (
      parsed === undefined ||
      (typeof type === "string" &&
        (parsed === null || typeof parsed !== "object" || parsed.Type !== type))
    )
      return answer(answers.ses(400, "rejected"));
    let route;
    try {
      route = await readVerifiedSesFeedbackRoute(parsed, snsSignatures);
    } catch (error) {
      const code = error instanceof SesSnsEventError ? error.code : "SES_SNS_SIGNATURE_INVALID";
      log({ code: "PILOT_CALLBACK_REFUSED", provider: "ses", reason: code });
      return answer(answers.ses(code === "SES_SNS_INPUT_INVALID" ? 400 : 403, "rejected"));
    }
    const subscribed = stores.filter((store) => store.feedbackRoute?.topicArn === route.topicArn);
    // Stores sharing the topic: the one whose configuration set sent the message. Confirming the
    // subscription is the same act for each of them (the topic, this address): the first.
    const claims =
      subscribed.length <= 1 || route.type === "SubscriptionConfirmation"
        ? subscribed.slice(0, 1)
        : subscribed.filter(
            (store) =>
              route.configurationSetName !== null &&
              store.feedbackRoute.configurationSetName === route.configurationSetName,
          );
    if (claims.length === 1) return to(claims[0]);
    if (claims.length === 0 && !everyStoreServed) return answer(answers.ses(503, "retry"));
    log({
      code: "PILOT_CALLBACK_UNCLAIMED",
      provider: "ses",
      reason:
        claims.length > 1 ? "Ambiguous" : subscribed.length > 1 ? "NoConfigurationSet" : "NoStore",
    });
    return answer(answers.ses(200, "Ignored"));
  }

  async function stripeWebhook(body, headers) {
    const signatureHeader = headers["stripe-signature"];
    if (
      typeof signatureHeader !== "string" ||
      signatureHeader.length < 1 ||
      signatureHeader.length > 8192 ||
      body.length < 1
    )
      return answer(answers.stripe(400));
    const receivedAt = now();
    const rawBody = new Uint8Array(body);
    const verified = await askAll(
      stores.filter((store) => store.stripeWebhook != null),
      (store) => store.stripeWebhook.verifies({ signatureHeader, rawBody, receivedAt }),
    );
    if (verified.claims.length === 1) return to(verified.claims[0]);
    if (verified.claims.length === 0) {
      if (verified.unreadable || !everyStoreServed) return answer(answers.stripe(503));
      log({ code: "PILOT_CALLBACK_REFUSED", provider: "stripe", reason: "NoStoreSecret" });
      return answer(answers.stripe(400));
    }
    // One Stripe account (and secret) for several Stores: the payment operation the Store set.
    let event;
    try {
      event = parseStripeWebhookPaymentEvent(rawBody);
    } catch {
      log({ code: "PILOT_CALLBACK_REFUSED", provider: "stripe", reason: "EventInvalid" });
      return answer(answers.stripe(400));
    }
    const operation = event.kind === "IntentOutcome" ? event.paymentOperationReference : null;
    if (operation === null) {
      log({ code: "PILOT_CALLBACK_UNCLAIMED", provider: "stripe", reason: "NoPaymentOperation" });
      return answer(answers.stripe(200));
    }
    const held = await askAll(verified.claims, (store) =>
      store.stripeWebhook.holdsOperation(operation),
    );
    if (held.claims.length === 1) return to(held.claims[0]);
    if (held.claims.length === 0 && (held.unreadable || !everyStoreServed))
      return answer(answers.stripe(503));
    log({
      code: "PILOT_CALLBACK_UNCLAIMED",
      provider: "stripe",
      reason: held.claims.length > 1 ? "Ambiguous" : "NoStore",
    });
    return answer(answers.stripe(200));
  }

  /** { store } to send it to, or { answer: { status, headers, body } } to give here. */
  // `peerAddress`: the guest's address as the Store's own route keys its budget.
  return async function callbackStoreOf({
    url,
    headers = {},
    body = Buffer.alloc(0),
    peerAddress = "127.0.0.1",
  }) {
    if (ORDER_RECOVERY.test(url)) return orderLink(url, body, headers, peerAddress);
    if (SES_FEEDBACK.test(url)) return sesFeedback(body, headers);
    if (STRIPE_WEBHOOK.test(url)) return stripeWebhook(body, headers);
    throw new Error("CUSTOMER_CALLBACK_ROUTE_UNKNOWN");
  };
}
