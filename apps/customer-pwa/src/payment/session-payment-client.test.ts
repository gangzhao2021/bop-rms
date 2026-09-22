import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionPaymentClient } from "./session-payment-client.js";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
const id = (n: number) => "01909999-0000-7000-8000-" + n.toString(16).padStart(12, "0");
beforeEach(() => setCustomerCsrfCredential("c".repeat(43)));
afterEach(() => {
  vi.unstubAllGlobals();
  setCustomerCsrfCredential(null);
});
it.each([
  [201, "Created"],
  [200, "AlreadyCreated"],
  [202, "Processing"],
] as const)(
  "accepts creation HTTP%s without interpreting it as paid",
  async (status, creationStatus) => {
    const payment = {
      checkoutSessionReference: id(1),
      paymentIntentReference: id(2),
      orderReference: id(3),
      creationStatus,
      total: { amountMinor: "2200", currency: "CAD" },
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ schemaVersion: 1, payment }, { status }));
    vi.stubGlobal("fetch", fetch);
    expect(await createSessionPaymentClient().create(id(1), id(4), "200")).toEqual(payment);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      headers: { "idempotency-key": id(4) },
      body: JSON.stringify({ tip: { amountMinor: "200", currency: "CAD" } }),
    });
  },
);
it("reads an ephemeral credential only from a noncached response", async () => {
  const body = { schemaVersion: 1, clientSecret: "pi_SYNTHETIC000001_secret_SYNTHETICONLY" };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json(body, { headers: { "cache-control": "no-store" } })),
  );
  expect(await createSessionPaymentClient().handoff(id(1))).toBe(body.clientSecret);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
  await expect(createSessionPaymentClient().handoff(id(1))).rejects.toMatchObject({
    code: "unknown",
  });
});
it("rejects invalid exact tip before network and discards revoked-session credentials", async () => {
  const fetch = vi.fn(async () => {
    setCustomerCsrfCredential(null);
    return Response.json(
      { schemaVersion: 1, clientSecret: "pi_SYNTHETIC000001_secret_SYNTHETICONLY" },
      { headers: { "cache-control": "no-store" } },
    );
  });
  vi.stubGlobal("fetch", fetch);
  await expect(createSessionPaymentClient().create(id(1), id(4), "2.00")).rejects.toMatchObject({
    code: "invalid",
  });
  expect(fetch).not.toHaveBeenCalled();
  await expect(createSessionPaymentClient().handoff(id(1))).rejects.toMatchObject({
    code: "unknown",
  });
});

it("sends explicit simulation confirmation with the same selection and exact tip", async () => {
  const payment = {
    checkoutSessionReference: id(1),
    paymentIntentReference: id(2),
    orderReference: id(3),
    creationStatus: "AlreadyCreated",
    total: { amountMinor: "2260", currency: "CAD" },
  };
  const fetch = vi.fn().mockResolvedValue(Response.json({ schemaVersion: 1, payment }));
  vi.stubGlobal("fetch", fetch);
  expect(await createSessionPaymentClient().simulate(id(1), id(4), "0")).toEqual(payment);
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "/api/v1/checkout-sessions/" + id(1) + "/simulation-confirm",
  );
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    cache: "no-store",
    headers: { "idempotency-key": id(4), "x-bop-simulation-confirmation": "SIMULATE_CAPTURE" },
    body: JSON.stringify({ tip: { amountMinor: "0", currency: "CAD" } }),
  });
});
