import { deferredCheckoutPayment } from "./deferred-checkout-payment.mjs";
import { createCheckoutPolicyClient } from "../../../apps/customer-pwa/src/checkout/policy-client.ts";
import { createCheckoutDetailsReadClient } from "../../../apps/customer-pwa/src/checkout/details-read-client.ts";
import {
  createCheckoutDetailsClient,
  createCheckoutDetailsController,
} from "../../../apps/customer-pwa/src/checkout/details-client.ts";
import {
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "../../../apps/customer-pwa/src/session/customer-transaction-context.ts";
import assert from "node:assert/strict";
import { createLocalCustomerRuntime } from "../../../apps/api/src/local-customer-runtime.ts";
import { createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import { createCustomerDiningSessionBinding } from "../../../apps/api/src/customer-dining-binding-composition.ts";
import { fixture } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";

export async function exerciseCustomerCheckoutDetailsHttp({
  journey,
  service,
  input,
  quoteVersion,
  changePolicy,
  runtimeOptions,
}) {
  const origin = "https://customer.example";
  const nativeFetch = globalThis.fetch;
  const priorCsrf = getCustomerCsrfCredential();
  let original;
  const { mode, scope, sessionTransactions, cartTransactions, session, identity, now } =
    runtimeOptions;
  const ownerPort = {
    quoteVersion,
    read: (command) => service.read(command),
    policy: (command) => service.policy(command),
    save: async (command) => {
      const result = await service.save(command);
      if (original === undefined) {
        original = result;
        throw new Error("synthetic response loss after committed detail save");
      }
      return result;
    },
  };
  const wrong = async () => {
    throw new Error("wrong checkout channel");
  };
  const unusedPort = { quoteVersion, read: wrong, policy: wrong, save: wrong };
  const entry = fixture().options;
  const currentSession =
    mode === "DineIn"
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
  const deferredOrder = {
    quoteVersion,
    create: async (command) => {
      if (!journey?.orderPort) throw new Error("Order composition not attached");
      assert.equal(journey.orderPort.quoteVersion, quoteVersion);
      return journey.orderPort.create(command);
    },
  };
  const unusedOrder = { quoteVersion, create: wrong };
  const existingRuntime = journey?.runtime;
  if (existingRuntime) {
    assert.deepEqual(journey.scope, scope);
    assert.equal(journey.mode, mode);
    assert.equal(journey.origin, origin);
    assert(existingRuntime.server.listening);
    journey.detailsPort = ownerPort;
  }
  const downstream = journey && !existingRuntime ? deferredCheckoutPayment(journey, scope) : null;
  if (downstream) journey.attachPayment = (options) => downstream.attach(options);
  const runtime =
    existingRuntime ??
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
      channelCheckoutDetails:
        mode === "DineIn"
          ? { pickup: unusedPort, dining: ownerPort }
          : { pickup: ownerPort, dining: unusedPort },
      ...(journey
        ? {
            channelOrderSubmission:
              mode === "DineIn"
                ? { pickup: unusedOrder, dining: deferredOrder }
                : { pickup: deferredOrder, dining: unusedOrder },
          }
        : {}),
      ...(downstream
        ? {
            payment: downstream.payment,
            receipt: downstream.receipt,
            orderStatus: downstream.orderStatus,
          }
        : {}),
      allowedOrigin: origin,
      now: () => (journey?.paymentOptions ? journey.paymentOptions.payment.access.now() : now()),
      uuidV7Factory: () => {
        throw new Error("unused menu reference");
      },
      runtime: { logger: createApiRuntimeLogger({ write: () => undefined }) },
    });
  if (journey && !existingRuntime) {
    assert.equal(journey.runtime, undefined);
    journey.runtime = runtime;
    journey.scope = scope;
    journey.mode = mode;
    journey.origin = origin;
  }
  const server = runtime.server;
  if (!existingRuntime) await runtime.listen();
  try {
    const url = "http://127.0.0.1:" + server.address().port + "/bff/customer/checkout-details";
    const { operationReference, ...body } = input.command;
    const headers = {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "idempotency-key": operationReference,
      "x-csrf-token": input.csrfCredential,
      cookie: "__Host-bop-guest=" + input.sessionCredential,
    };
    const send = async (payload = body, overrides = {}) => {
      const response = await nativeFetch(url, {
        method: "POST",
        headers: { ...headers, ...overrides },
        body: JSON.stringify(payload),
      });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await send(body, { "x-csrf-token": "x".repeat(43) })).status, 404);
    if (body.pickupContact !== null) {
      assert.equal(
        (await send({ ...body, pickupContact: { ...body.pickupContact, value: "invalid" } }))
          .status,
        422,
      );
    }
    const query = { cartReference: body.cartReference, cartVersion: body.cartVersion };
    const deniedRead = await nativeFetch(url + "/current", {
      method: "POST",
      headers: { ...headers, "x-csrf-token": "x".repeat(43) },
      body: JSON.stringify(query),
    });
    assert.equal(deniedRead.status, 404);
    await deniedRead.arrayBuffer();
    assert.equal(original, undefined);
    setCustomerCsrfCredential(input.csrfCredential);
    globalThis.fetch = (target, init) => {
      assert.ok(
        [
          "/bff/customer/checkout-details",
          "/bff/customer/checkout-details/current",
          "/bff/customer/checkout-details/policy",
        ].includes(target),
      );
      if (target.endsWith("/current") || target.endsWith("/policy")) {
        assert.equal(init.headers["idempotency-key"], undefined);
        assert.equal(init.method, "POST");
        assert.deepEqual(JSON.parse(init.body), query);
      }
      return nativeFetch(url + target.slice("/bff/customer/checkout-details".length), {
        ...init,
        headers: {
          ...init.headers,
          origin,
          "sec-fetch-site": "same-origin",
          cookie: headers.cookie,
        },
      });
    };
    const selection = {
      cartReference: body.cartReference,
      cartVersion: body.cartVersion,
      orderType: body.pickupContact === null ? "DineIn" : "Pickup",
    };
    const policyClient = createCheckoutPolicyClient();
    setCustomerCsrfCredential("x".repeat(43));
    await assert.rejects(policyClient.read(selection), { code: "denied" });
    setCustomerCsrfCredential(input.csrfCredential);
    for (const invalid of ["Missing", "Foreign", "Expired", "Changed"]) {
      changePolicy(invalid);
      await assert.rejects(policyClient.read(selection), { code: "unknown" });
    }
    changePolicy("Ready");
    const policy = await policyClient.read(selection);
    assert.deepEqual(policy.documents, []);
    assert.equal(policy.cartReference, selection.cartReference);
    assert.equal(policy.cartVersion, selection.cartVersion);
    assert.equal(policy.orderType, selection.orderType);
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.documents));
    assert.equal(original, undefined);
    const reader = createCheckoutDetailsReadClient();
    assert.deepEqual(await reader.read(selection), { ...selection, details: null });
    const controller = createCheckoutDetailsController(
      createCheckoutDetailsClient(),
      () => operationReference,
    );
    await controller.save({
      ...body,
      orderType: body.pickupContact === null ? "DineIn" : "Pickup",
    });
    assert.deepEqual(controller.getState(), { status: "unknown", canRetry: true });
    await controller.retry();
    assert.equal(controller.getState().status, "saved");

    assert.equal(original?.status, "Saved");
    const currentDetails = await reader.read(selection);
    assert.equal(currentDetails.details.detailsVersion, 1);
    assert.deepEqual(currentDetails.details.pickupContact, body.pickupContact);
    assert.deepEqual(currentDetails.details.receipt, body.receipt);

    const replay = await send();
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, {
      schemaVersion: 1,
      details: {
        operationReference,
        detailsReference: body.detailsReference,
        detailsVersion: body.expectedVersion + 1,
        cartReference: body.cartReference,
        cartVersion: body.cartVersion,
        quoteReference: body.quoteReference,
        quoteVersion,
        orderType: original.snapshot.orderType,
        receiptChoice: original.snapshot.receipt.choice,
        recordedAt: original.snapshot.recordedAt,
      },
    });
    for (const value of [
      original.snapshot.guestSessionReference,
      original.snapshot.brandReference,
      original.snapshot.storeReference,
      original.snapshot.pickupContact?.value,
      original.snapshot.receipt.email,
    ].filter((value) => value !== undefined && value !== null)) {
      assert.equal(JSON.stringify(replay.body).includes(value), false);
    }
    return original;
  } finally {
    globalThis.fetch = nativeFetch;
    setCustomerCsrfCredential(priorCsrf);
    if (!journey) await runtime.shutdown("SIGTERM");
  }
}
