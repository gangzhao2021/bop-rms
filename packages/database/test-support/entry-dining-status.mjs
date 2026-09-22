import assert from "node:assert/strict";

export function prepareEntryDiningStatusHttp(access, diningScope) {
  let paymentScope;
  return {
    options: {
      ...access,
      diningScope,
      allowedOrigin: "https://customer.invalid",
      get paymentScope() {
        assert(paymentScope, "Entry status payment scope must be attached");
        return paymentScope;
      },
    },
    attach(scope) {
      assert.equal(paymentScope, undefined);
      paymentScope = scope;
    },
  };
}

/** Read the same Entry Order through real Guest authorization and durable owner sources. */
export async function exerciseEntryDiningStatus({
  http,
  result,
  base,
  order,
  oldCookie,
  orderType = "DineIn",
  amountMinor = "5650",
}) {
  if (http) http.attach(result.terminalScope);
  const url = base + "/api/v1/orders/" + order.record.order.orderReference + "/status";
  const headers = {
    "sec-fetch-site": "same-origin",
    cookie: "__Host-bop-guest=" + order.input.sessionCredential,
    "x-csrf-token": order.input.csrfCredential,
  };
  const response = await globalThis.fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const { status } = await response.json();
  assert.equal(status.order.orderReference, order.record.order.orderReference);
  assert.equal(status.order.orderType, orderType);
  assert.deepEqual(
    status.order.batches
      .flatMap((batch) => batch.items.map((item) => item.orderItemReference))
      .sort(),
    order.record.items.map((item) => item.orderItemReference).sort(),
  );
  assert.deepEqual(
    status.sources.kitchen.batches.map((batch) => batch.status),
    ["Ready"],
  );
  assert.equal(status.sources.payments.length, 1);
  assert.equal(status.sources.payments[0].status, "Succeeded");
  assert.equal(status.sources.payments[0].amount.amountMinor, amountMinor);
  assert.equal(
    (await globalThis.fetch(url, { headers: { ...headers, cookie: oldCookie } })).status,
    404,
  );
  assert.equal(
    (await globalThis.fetch(url, { headers: { ...headers, "x-csrf-token": "z".repeat(43) } }))
      .status,
    404,
  );
  const read = async () => {
    const response = await globalThis.fetch(url, { headers });
    assert.equal(response.status, 200);
    return (await response.json()).status;
  };
  return { status, read };
}
