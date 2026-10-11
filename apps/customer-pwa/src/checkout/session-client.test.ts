import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import { createCheckoutSessionClient } from "./session-client.js";
const id = (n: number) => "01909999-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const selected = {
  cartReference: id(1),
  cartVersion: 3,
  quoteReference: id(2),
  quoteVersion: 2 as const,
};
const session = {
  ...selected,
  checkoutSessionReference: id(3),
  createdAt: "2026-09-11T21:00:00.000Z",
};
beforeEach(() => setCustomerCsrfCredential("c".repeat(43)));
afterEach(() => {
  vi.unstubAllGlobals();
  setCustomerCsrfCredential(null);
});
it("creates and retries with the same caller intent and minimal body", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ schemaVersion: 1, session }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ schemaVersion: 1, session }));
  vi.stubGlobal("fetch", fetch);
  const client = createCheckoutSessionClient();
  expect(await client.create(selected, id(4))).toEqual(session);
  expect(await client.create(selected, id(4))).toEqual(session);
  for (const [url, init] of fetch.mock.calls) {
    expect(url).toBe("/api/v1/carts/" + id(1) + "/checkout-sessions");
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { "idempotency-key": id(4), "x-csrf-token": "c".repeat(43) },
      body: JSON.stringify({ cartVersion: 3, quoteReference: id(2) }),
    });
  }
});
it("reads only the requested session", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(Response.json({ schemaVersion: 1, session })),
  );
  expect(await createCheckoutSessionClient().read(id(3))).toEqual(session);
});
it("rejects mismatched quote binding and undeclared sensitive fields", async () => {
  for (const change of [{ quoteReference: id(8) }, { clientSecret: "unexpected" }]) {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ schemaVersion: 1, session: { ...session, ...change } }),
        ),
    );
    await expect(createCheckoutSessionClient().create(selected, id(4))).rejects.toThrow();
  }
});
it("discards response after current session credentials change", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      setCustomerCsrfCredential(null);
      return Response.json({ schemaVersion: 1, session });
    }),
  );
  await expect(createCheckoutSessionClient().create(selected, id(4))).rejects.toMatchObject({
    code: "unknown",
  });
});
it("WP-2423 Q4: tells a closed Store apart from an ordinary conflict", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { schemaVersion: 1, error: { code: "checkout_session_store_closed" } },
        { status: 409 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json(
        { schemaVersion: 1, error: { code: "checkout_session_intent_conflict" } },
        { status: 409 },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const client = createCheckoutSessionClient();
  await expect(client.create(selected, id(4))).rejects.toMatchObject({ code: "store_closed" });
  await expect(client.create(selected, id(4))).rejects.toMatchObject({ code: "conflict" });
});
