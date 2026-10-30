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
  it("WP-2423 item 8 ⑦ 4b-3: decodes the per-head tea on the bill, and rejects anything else", () => {
    const base = payload() as { session: { summary: Record<string, unknown> } };
    const withTea = structuredClone(base);
    withTea.session.summary.teaCharge = { perGuest: cad("150"), guests: 4 };
    expect(parseDiningSessionView(withTea).summary?.teaCharge).toEqual({
      perGuest: cad("150"),
      guests: 4,
    });
    for (const teaCharge of [
      { perGuest: cad("150"), guests: 0 },
      { perGuest: cad("150") },
      { perGuest: "1.50", guests: 4 },
    ]) {
      const value = structuredClone(base);
      value.session.summary.teaCharge = teaCharge;
      expect(() => parseDiningSessionView(value)).toThrow();
    }
  });

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

  it("WP-2423 item 8 ③ decision 13: decodes what Order again adds, and rejects anything else", () => {
    const reference = (n: number) => "018f8a30-0000-7000-8000-" + String(n).padStart(12, "0");
    const again = {
      sellableReference: reference(1),
      optionSelections: [{ optionReference: reference(2), quantity: 1 }],
    };
    const withAgain = payload();
    Object.assign(firstRound(withAgain).items[0] as object, { orderAgain: again });
    expect(parseDiningSessionView(withAgain).rounds[0]?.items[0]?.orderAgain).toEqual(again);
    for (const wrong of [
      { ...again, sellableReference: "not-a-reference" },
      { ...again, optionSelections: [{ optionReference: reference(2), quantity: 0 }] },
      { ...again, customerNote: "spicy" },
    ]) {
      const value = payload();
      Object.assign(firstRound(value).items[0] as object, { orderAgain: wrong });
      expect(() => parseDiningSessionView(value)).toThrow();
    }
  });

  it("WP-2423 Q26: decodes a dish the kitchen is making again, and rejects any other value", () => {
    const remade = payload();
    Object.assign(firstRound(remade).items[0] as object, { beingRemade: true });
    expect(parseDiningSessionView(remade).rounds[0]?.items[0]).toMatchObject({
      beingRemade: true,
    });
    expect(parseDiningSessionView(payload()).rounds[0]?.items[0]).not.toHaveProperty("beingRemade");
    for (const value of [false, "true", 1, null]) {
      const wrong = payload();
      Object.assign(firstRound(wrong).items[0] as object, { beingRemade: value });
      expect(() => parseDiningSessionView(wrong)).toThrow(DiningSessionClientError);
    }
  });

  it("does not call the server without this browser's session", async () => {
    const request = vi.fn();
    await expect(
      createHttpDiningSessionClient(request as unknown as typeof fetch).load(),
    ).rejects.toMatchObject({ code: "not-joined" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("WP-2423 D5 item prices before tax", () => {
  function priced() {
    const p = payload();
    const round = firstRound(p);
    const item = round.items[0];
    if (item === undefined) throw new Error("fixture");
    Object.assign(item, { priceBeforeTax: cad("2655") });
    Object.assign(round, { subtotal: cad("2655"), tax: cad("345") });
    Object.assign(p.session.summary, {
      ordered: { subtotal: cad("2655"), tax: cad("345"), total: cad("3000") },
    });
    return p;
  }

  it("decodes item prices before tax and the round and table subtotal and tax", () => {
    const view = parseDiningSessionView(priced());
    expect(view.rounds[0]?.items[0]?.priceBeforeTax).toEqual(cad("2655"));
    expect(view.rounds[0]?.items[0]?.lineTotal).toEqual(cad("3000"));
    expect(view.rounds[0]?.subtotal).toEqual(cad("2655"));
    expect(view.rounds[0]?.tax).toEqual(cad("345"));
    expect(view.rounds[0]?.itemsTotal).toEqual(cad("3000"));
    expect(view.summary?.ordered).toEqual({
      subtotal: cad("2655"),
      tax: cad("345"),
      total: cad("3000"),
    });
    // Without them (an older server) nothing before tax is invented.
    const plain = parseDiningSessionView(payload());
    expect(plain.rounds[0]).not.toHaveProperty("subtotal");
    expect(plain.summary).not.toHaveProperty("ordered");
  });

  it.each([
    [
      "a subtotal that is not the items before tax",
      (p: ReturnType<typeof priced>) => Object.assign(firstRound(p), { subtotal: cad("2600") }),
    ],
    [
      "a subtotal without tax",
      (p: ReturnType<typeof priced>) => {
        const round = firstRound(p) as Record<string, unknown>;
        delete round.tax;
      },
    ],
    [
      "an item without its price before tax",
      (p: ReturnType<typeof priced>) => {
        const item = firstRound(p).items[0] as Record<string, unknown>;
        delete item.priceBeforeTax;
      },
    ],
    [
      "a table breakdown with an unpriced round",
      (p: ReturnType<typeof priced>) => {
        const round = firstRound(p) as Record<string, unknown>;
        delete round.subtotal;
        delete round.tax;
        delete (firstRound(p).items[0] as Record<string, unknown>).priceBeforeTax;
      },
    ],
    [
      "a priced round without the table breakdown",
      (p: ReturnType<typeof priced>) => {
        delete (p.session.summary as Record<string, unknown>).ordered;
      },
    ],
    [
      "a negative tax",
      (p: ReturnType<typeof priced>) => Object.assign(firstRound(p), { tax: cad("-1") }),
    ],
  ])("refuses %s", (_label, change) => {
    const p = priced();
    change(p);
    expect(() => parseDiningSessionView(p)).toThrow(DiningSessionClientError);
  });
});

describe("WP-2423 item 8 ⑤ a round waiting for staff", () => {
  it("decodes the waiting round and why, and refuses an unknown reason", () => {
    const p = payload();
    Object.assign(firstRound(p), {
      status: "WaitingForStaff",
      payment: "NotCharged",
      waitingReason: "FirstOrder",
    });
    const round = parseDiningSessionView(p).rounds[0];
    expect(round?.status).toBe("WaitingForStaff");
    expect(round?.waitingReason).toBe("FirstOrder");
    Object.assign(firstRound(p), { waitingReason: "Suspicious" });
    expect(() => parseDiningSessionView(p)).toThrow();
  });
});
