import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpDiningSessionClient,
  DiningSessionClientError,
  parseDiningSessionView,
} from "./dining-session-client.js";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";

const cad = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
function payload() {
  return {
    schemaVersion: 1,
    session: {
      tableLabel: "12",
      orderNumber: "1042",
      checkedAt: "2026-10-13T18:00:00.000Z",
      rounds: [
        {
          roundNumber: 1,
          orderedBy: "You",
          submittedAt: "2026-10-13T17:50:00.000Z",
          status: "Preparing",
          payment: "Paid",
          cancelsAt: null,
          storeCancellationReason: null,
          items: [
            {
              displayName: "Ramen",
              quantity: 2,
              servedQuantity: 0,
              cancelled: false,
              lineTotal: cad("3000"),
            },
          ],
          itemsTotal: cad("3000"),
        },
      ],
      summary: { paid: cad("3390"), refunded: cad("0"), refundPending: cad("0"), due: cad("0") },
    },
  };
}
afterEach(() => setCustomerCsrfCredential(null));
function firstRound(p: ReturnType<typeof payload>) {
  const round = p.session.rounds[0];
  if (round === undefined) throw new Error("fixture");
  return round;
}

describe("WP-2423 Q8 dining session client", () => {
  it("decodes the closed table view", () => {
    const view = parseDiningSessionView(payload());
    expect(view.rounds[0]?.orderedBy).toBe("You");
    expect(view.summary?.paid.amountMinor).toBe("3390");
  });

  it.each([
    ["an extra field", (p: ReturnType<typeof payload>) => Object.assign(p.session, { guest: "x" })],
    [
      "an unknown status",
      (p: ReturnType<typeof payload>) => Object.assign(firstRound(p), { status: "Lost" }),
    ],
    [
      "served beyond ordered",
      (p: ReturnType<typeof payload>) =>
        Object.assign(firstRound(p).items[0] as object, { servedQuantity: 3 }),
    ],
    [
      "a fractional amount",
      (p: ReturnType<typeof payload>) => Object.assign(firstRound(p), { itemsTotal: cad("30.00") }),
    ],
    [
      "a summary without rounds",
      (p: ReturnType<typeof payload>) => Object.assign(p.session, { rounds: [] }),
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = payload();
    mutate(value);
    expect(() => parseDiningSessionView(value)).toThrow(DiningSessionClientError);
  });

  it("sends only the CSRF header to the fixed route and maps refusals to not joined", async () => {
    setCustomerCsrfCredential("c".repeat(43));
    const request = vi.fn(async () => new Response(JSON.stringify(payload()), { status: 200 }));
    const client = createHttpDiningSessionClient(request as unknown as typeof fetch);
    await expect(client.load()).resolves.toMatchObject({ tableLabel: "12" });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/session");
    expect(init.headers).toEqual({ accept: "application/json", "x-csrf-token": "c".repeat(43) });
    request.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(client.load()).rejects.toMatchObject({ code: "not-joined" });
    request.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(client.load()).rejects.toMatchObject({ code: "unavailable" });
    request.mockRejectedValueOnce(new TypeError("offline"));
    await expect(client.load()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("does not call the server without this browser's session", async () => {
    const request = vi.fn();
    await expect(
      createHttpDiningSessionClient(request as unknown as typeof fetch).load(),
    ).rejects.toMatchObject({ code: "not-joined" });
    expect(request).not.toHaveBeenCalled();
  });
});
