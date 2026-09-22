import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import { createCheckoutDetailsReadClient } from "./details-read-client.js";
const id = (n: number) => "01909994-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const selected = { cartReference: id(1), cartVersion: 4, orderType: "Pickup" as const };
const details = {
  detailsReference: id(2),
  detailsVersion: 2,
  cartReference: id(1),
  cartVersion: 3,
  quoteReference: id(3),
  quoteVersion: 2,
  pickupContact: { name: "Synthetic guest", channel: "Phone", value: "+12025550123" },
  receipt: { choice: "InSession", email: null },
  policies: [],
  recordedAt: "2026-09-11T00:00:00.000Z",
};
beforeEach(() => setCustomerCsrfCredential("c".repeat(43)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setCustomerCsrfCredential(null);
});
const response = (value: unknown = details) =>
  new Response(
    JSON.stringify({
      schemaVersion: 1,
      checkout: { ...selected, details: value },
    }),
    { status: 200 },
  );
it("loads the original form version without changing it to today's Cart version", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
  vi.stubGlobal("fetch", fetch);
  expect(await createCheckoutDetailsReadClient().read(selected)).toEqual({ ...selected, details });
  const init = fetch.mock.calls[0]?.[1];
  expect(init).toMatchObject({
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
  });
  expect(init?.headers).not.toHaveProperty("idempotency-key");
  expect(init?.body).toBe(JSON.stringify({ cartReference: id(1), cartVersion: 4 }));
});
it("loads an empty current state without inventing a details reference", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(null)),
  );
  expect(await createCheckoutDetailsReadClient().read(selected)).toEqual({
    ...selected,
    details: null,
  });
});
it.each([
  { cartReference: id(99) },
  { cartVersion: 5 },
  { detailsVersion: 0 },
  { guestSessionReference: id(99) },
  { pickupContact: null },
  { recordedAt: "invalid" },
])("refuses foreign, future or unprojected private history", async (change) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ ...details, ...change })),
  );
  await expect(createCheckoutDetailsReadClient().read(selected)).rejects.toMatchObject({
    code: "unknown",
  });
});
it("discards private read results after Guest context replacement", async () => {
  let finish: (value: Response) => void = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const pending = createCheckoutDetailsReadClient().read(selected);
  setCustomerCsrfCredential("d".repeat(43));
  finish(response());
  await expect(pending).rejects.toMatchObject({ code: "unknown" });
});
it("does not read without a Guest transaction context", async () => {
  setCustomerCsrfCredential(null);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(createCheckoutDetailsReadClient().read(selected)).rejects.toMatchObject({
    code: "denied",
  });
  expect(fetch).not.toHaveBeenCalled();
});
