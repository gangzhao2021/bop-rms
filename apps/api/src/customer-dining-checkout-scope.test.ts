import express from "express";
import { describe, expect, it } from "vitest";
import {
  CustomerDiningCheckoutScopeError,
  CustomerDiningCheckoutScopeHandler,
  customerDiningCheckoutScopeRoute,
  diningCheckoutHoldReaders,
  parseCustomerDiningCheckoutScopeCommand,
  type createCustomerDiningCheckoutScope,
} from "./customer-dining-checkout-scope.js";

const id = (n: number) => "01902520-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const origin = "https://guest.example.test";
const credential = "a".repeat(43);
const now = "2026-08-02T16:00:00.000Z";

async function serve(apply: (input: unknown) => Promise<unknown>) {
  const app = express();
  app.use(express.json());
  const port = { apply } as unknown as ReturnType<typeof createCustomerDiningCheckoutScope>;
  app.post(
    customerDiningCheckoutScopeRoute,
    new CustomerDiningCheckoutScopeHandler({
      allowedOrigin: origin,
      port,
      now: () => now,
    }).handler(),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    post: (body: unknown, headers: Record<string, string> = {}) =>
      fetch("http://127.0.0.1:" + address.port + customerDiningCheckoutScopeRoute, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "sec-fetch-site": "same-origin",
          cookie: "__Host-bop-guest=" + credential,
          "x-csrf-token": credential,
          "idempotency-key": id(99),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("WP-2423 shared-table-checkout (a): the payer at a pay-first table chooses this round's dishes", () => {
  it("reads only a closed command: Mine has no dishes, Chosen names each dish once with 1 to 999", () => {
    expect(
      parseCustomerDiningCheckoutScopeCommand({
        action: "Choose",
        cartReference: id(1),
        expectedCartVersion: 4,
        choice: "Chosen",
        lines: [{ cartItemReference: id(2), quantity: 2 }],
      }),
    ).toEqual({
      action: "Choose",
      cartReference: id(1),
      expectedCartVersion: 4,
      choice: "Chosen",
      lines: [{ cartItemReference: id(2), quantity: 2 }],
    });
    expect(parseCustomerDiningCheckoutScopeCommand({ action: "Cancel" })).toEqual({
      action: "Cancel",
    });
    for (const bad of [
      {
        action: "Choose",
        cartReference: id(1),
        expectedCartVersion: 4,
        choice: "Mine",
        lines: [{ cartItemReference: id(2), quantity: 1 }],
      },
      {
        action: "Choose",
        cartReference: id(1),
        expectedCartVersion: 4,
        choice: "Chosen",
        lines: [],
      },
      { action: "Choose", cartReference: id(1), expectedCartVersion: 0, choice: "Mine", lines: [] },
      {
        action: "Choose",
        cartReference: id(1),
        expectedCartVersion: 4,
        choice: "Everyone",
        lines: [],
      },
      {
        action: "Choose",
        cartReference: id(1),
        expectedCartVersion: 4,
        choice: "Chosen",
        lines: [
          { cartItemReference: id(2), quantity: 1 },
          { cartItemReference: id(2), quantity: 1 },
        ],
      },
      {
        action: "Choose",
        cartReference: id(1),
        expectedCartVersion: 4,
        choice: "Chosen",
        lines: [{ cartItemReference: id(2), quantity: 1000 }],
      },
      { action: "Return", participant: id(3) },
      { action: "Delete" },
    ])
      expect(() => parseCustomerDiningCheckoutScopeCommand(bad)).toThrow();
  });

  it("answers the choice; another phone paying is the table's ordinary 409 with Retry-After; an outage is 503", async () => {
    let answer: () => Promise<unknown> = async () => ({
      status: "Chosen",
      cartVersion: 5,
      expiresAt: "2026-08-02T16:05:00.000Z",
      setAsideUnits: 2,
    });
    const seen: unknown[] = [];
    const server = await serve(async (input) => {
      seen.push(input);
      return answer();
    });
    try {
      const chosen = await server.post({
        action: "Choose",
        cartReference: id(1),
        expectedCartVersion: 4,
        choice: "Mine",
        lines: [],
      });
      expect(chosen.status).toBe(200);
      expect(chosen.headers.get("cache-control")).toBe("no-store");
      expect(await chosen.json()).toEqual({
        schemaVersion: 1,
        status: "Chosen",
        cartVersion: 5,
        expiresAt: "2026-08-02T16:05:00.000Z",
        setAsideUnits: 2,
      });
      expect(seen[0]).toMatchObject({ operationReference: id(99), command: { choice: "Mine" } });

      answer = async () => {
        throw new CustomerDiningCheckoutScopeError("Held", "2026-08-02T16:04:00.000Z");
      };
      const held = await server.post({ action: "Return" });
      expect(held.status).toBe(409);
      expect(held.headers.get("retry-after")).toBe("240");
      expect(await held.json()).toMatchObject({ error: { code: "cart_checkout_in_progress" } });

      answer = async () => {
        throw new CustomerDiningCheckoutScopeError("Changed");
      };
      const changed = await server.post({ action: "Extend" });
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({ error: { code: "cart_version_conflict" } });

      answer = async () => {
        throw new CustomerDiningCheckoutScopeError("NotJoined");
      };
      expect((await server.post({ action: "Cancel" })).status).toBe(404);

      // An outage is never a refusal: the guest is told to try again.
      answer = async () => {
        throw new Error("database down");
      };
      const down = await server.post({ action: "Return" });
      expect(down.status).toBe(503);
      expect(down.headers.get("retry-after")).toBe("5");

      // No cookie, a foreign origin or a missing key: refused before anything is asked.
      const before = seen.length;
      expect((await server.post({ action: "Return" }, { "idempotency-key": "x" })).status).toBe(
        400,
      );
      expect(
        (await server.post({ action: "Return" }, { origin: "https://evil.test" })).status,
      ).toBe(400);
      expect((await server.post({ action: "Choose" })).status).toBe(400);
      expect(seen.length).toBe(before);
    } finally {
      await server.close();
    }
  });

  it("Back to cart and a give-back count the payer's own checkout hold: a payment in flight keeps the cart", async () => {
    const payer = id(7);
    // Dining's read leaves out the asker's own hold: here only the payer holds the cart.
    const asked: string[] = [];
    const holds = {
      read: async (input: { readonly participantReference: string }) => {
        asked.push(input.participantReference);
        return input.participantReference === payer
          ? null
          : { heldUntil: "2026-08-02T16:10:00.000Z" };
      },
    };
    const readers = diningCheckoutHoldReaders(holds, {
      diningSessionReference: id(8),
      participantReference: payer,
      readerReference: id(99),
      observedAt: now,
    });
    expect(await readers.heldByOther(id(1), 5)).toBeNull();
    expect(await readers.heldByAnyone(id(1), 5)).toBe("2026-08-02T16:10:00.000Z");
    expect(asked).toEqual([payer, id(99)]);
  });
});
