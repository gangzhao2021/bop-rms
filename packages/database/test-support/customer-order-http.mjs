import assert from "node:assert/strict";
import {
  createOrderSubmissionClient,
  createOrderSubmissionController,
} from "../../../apps/customer-pwa/src/checkout/order-submission.ts";
import {
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "../../../apps/customer-pwa/src/session/customer-transaction-context.ts";
import { createLocalCustomerRuntime } from "../../../apps/api/src/local-customer-runtime.ts";
import { createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import { createCustomerDiningSessionBinding } from "../../../apps/api/src/customer-dining-binding-composition.ts";
import { fixture } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";

/** Real HTTP over the supplied persisted owner composition; synthetic credentials only. */
export async function exerciseCustomerOrderHttp({
  journey,
  create,
  quoteVersion,
  input,
  expectedTotal,
  orderType,
  runtimeOptions,
}) {
  const origin = "https://customer.example";
  const { scope, sessionTransactions, cartTransactions, session, identity, now } = runtimeOptions;
  const entry = fixture().options;
  const currentSession =
    orderType === "DineIn"
      ? {
          ...identity.session,
          binding: createCustomerDiningSessionBinding({
            scope,
            binding: identity.session.binding,
            repository: identity.dining.current,
            contexts: identity.contexts,
            now,
          }),
        }
      : session;
  const port = { quoteVersion, create };
  const unusedPort = {
    quoteVersion,
    create: async () => {
      throw new Error("wrong order channel");
    },
  };
  if (journey) {
    assert.ok(journey.runtime?.server.listening);
    assert.deepEqual(journey.scope, scope);
    assert.equal(journey.mode, orderType);
    journey.orderPort = port;
  }
  const runtime =
    journey?.runtime ??
    createLocalCustomerRuntime({
      scope,
      entry: { ...entry, session: { ...entry.session, ...currentSession } },
      sessionTransactions,
      cartTransactions,
      menuTransactions: {
        run: async () => {
          throw new Error("unused menu route");
        },
      },
      menuStores: { resolvePublic: async () => null },
      channelOrderSubmission:
        orderType === "DineIn"
          ? { pickup: unusedPort, dining: port }
          : { pickup: port, dining: unusedPort },
      allowedOrigin: origin,
      now,
      uuidV7Factory: () => {
        throw new Error("unused menu reference");
      },
      runtime: { logger: createApiRuntimeLogger({ write: () => undefined }) },
    });
  const server = runtime.server;
  if (!journey) await runtime.listen();
  const nativeFetch = globalThis.fetch;
  const previousCsrf = getCustomerCsrfCredential();
  try {
    const send = async (csrf = input.csrfCredential) => {
      const response = await nativeFetch(
        "http://127.0.0.1:" + server.address().port + "/api/v1/orders",
        {
          method: "POST",
          headers: {
            origin,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
            "idempotency-key": input.submissionReference,
            "x-csrf-token": csrf,
            cookie: "__Host-bop-guest=" + input.sessionCredential,
          },
          body: JSON.stringify({
            cartReference: input.cartReference,
            cartVersion: input.expectedCartVersion,
            quoteReference: input.quoteReference,
          }),
        },
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await send("x".repeat(43))).status, 404);
    // Supply browser-owned headers only in this Node transport bridge; the client still
    // calls the real HTTP handler and persisted owner composition with its original body/key.
    globalThis.fetch = (url, init) => {
      assert.equal(url, "/api/v1/orders");
      return nativeFetch("http://127.0.0.1:" + server.address().port + url, {
        ...init,
        headers: {
          ...init.headers,
          origin,
          "sec-fetch-site": "same-origin",
          cookie: "__Host-bop-guest=" + input.sessionCredential,
        },
      });
    };
    setCustomerCsrfCredential(input.csrfCredential);
    const controller = createOrderSubmissionController(
      createOrderSubmissionClient(),
      () => input.submissionReference,
    );
    await controller.submit({
      cartReference: input.cartReference,
      cartVersion: input.expectedCartVersion,
      quoteReference: input.quoteReference,
      quoteVersion,
      orderType,
      total: { amountMinor: expectedTotal, currency: "CAD" },
    });
    assert.deepEqual(controller.getState(), { status: "unknown", canRetry: true });
    await controller.retry();
    assert.equal(controller.getState().status, "submitted");
    const recovered = await send();
    assert.equal(recovered.status, 200);
    assert.deepEqual(controller.getState().order, recovered.body.order);
    assert.equal(recovered.body.order.submissionReference, input.submissionReference);
    assert.equal(recovered.body.order.cartReference, input.cartReference);
    assert.equal(recovered.body.order.cartVersion, input.expectedCartVersion);
    assert.equal(recovered.body.order.quoteReference, input.quoteReference);
    assert.equal(recovered.body.order.quoteVersion, quoteVersion);
    assert.equal(recovered.body.order.paymentStatus, "NotReported");
    assert.equal(JSON.stringify(recovered).includes(input.sessionCredential), false);
    assert.equal(JSON.stringify(recovered).includes("optionPrices"), false);
    assert.deepEqual(await send(), recovered);
    return recovered.body.order;
  } finally {
    globalThis.fetch = nativeFetch;
    setCustomerCsrfCredential(previousCsrf);
    if (!journey) await runtime.shutdown("SIGTERM");
  }
}
