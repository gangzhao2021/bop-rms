import assert from "node:assert/strict";
import { createCustomerPickupOrderSubmissionComposition } from "../../../apps/api/src/customer-pickup-order-submission-composition.ts";

/** Deferred wiring only; actual production transport and owner composition handle requests. */
export function prepareEntryPickupOrderHttp() {
  let service;
  return {
    port: {
      quoteVersion: 1,
      create(input) {
        if (!service) throw new Error("Pickup order submission not attached");
        return service.create(input);
      },
    },
    async exercise({ options, checkout, base, cookie, csrfToken, oldCookie }) {
      assert.equal(service, undefined);
      service = createCustomerPickupOrderSubmissionComposition(options);
      const validation = checkout.session.validation;
      const send = (selectedCookie = cookie) =>
        globalThis.fetch(base + "/api/v1/orders", {
          method: "POST",
          headers: {
            origin: "https://customer.invalid",
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
            cookie: selectedCookie,
            "x-csrf-token": csrfToken,
            "idempotency-key": checkout.session.submissionReference,
          },
          body: JSON.stringify({
            cartReference: validation.cartReference,
            cartVersion: validation.cartVersion,
            quoteReference: validation.quoteReference,
          }),
        });
      const first = await send();
      assert.equal(first.status, 201);
      assert.equal(first.headers.get("cache-control"), "no-store");
      assert.equal(first.headers.get("referrer-policy"), "no-referrer");
      const view = await first.json();
      const repeated = await send();
      assert.equal(repeated.status, 200);
      assert.deepEqual(await repeated.json(), view);
      const denied = await send(oldCookie);
      assert.equal(denied.status, 404);
      assert.equal((await denied.json()).error.code, "order_not_found");
      return view;
    },
  };
}
