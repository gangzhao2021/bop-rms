import { describe, expect, it, vi } from "vitest";
import { createSettlementClient, parseSettlementView } from "./settlement-client.js";
import { settlementViewFixture } from "./settlement.fixtures.js";

describe("WP-2423 P1 settlement client", () => {
  it("parses the day-end view strictly", () => {
    const view = parseSettlementView(settlementViewFixture());
    expect(view.captured?.amountMinor).toBe("123450");
    expect(view.reconciliation?.differences[0]?.differenceReason).toBe("RefundMismatch");
    for (const corrupt of [
      { screenId: "OPS-ORDER-QUEUE" },
      { businessDate: "2026/09/21" },
      { captured: { count: 1, amountMinor: "12.5", currencyCode: "CAD" } },
      { window: { ...settlementViewFixture().window, status: "Pending" } },
      { extra: true },
    ])
      expect(() => parseSettlementView({ ...settlementViewFixture(), ...corrupt })).toThrow();
    expect(
      parseSettlementView({ ...settlementViewFixture(), reconciliation: null }).reconciliation,
    ).toBeNull();
  });
  it("reads with the same-origin, no-store contract and maps denial", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/merchant/settlement?businessDate=2026-09-21");
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("same-origin");
      return new Response(JSON.stringify(settlementViewFixture()), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    });
    const client = createSettlementClient(fetcher as unknown as typeof fetch);
    const view = await client.load("2026-09-21", new AbortController().signal);
    expect(view.businessDate).toBe("2026-09-21");
    const denied = createSettlementClient(
      (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch,
    );
    await expect(denied.load(null, new AbortController().signal)).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    const busy = createSettlementClient((async () =>
      Response.json({ error: "settlement_busy" }, { status: 503 })) as unknown as typeof fetch);
    await expect(busy.load(null, new AbortController().signal)).rejects.toMatchObject({
      code: "Busy",
    });
    const down = createSettlementClient(
      (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch,
    );
    await expect(down.load(null, new AbortController().signal)).rejects.toMatchObject({
      code: "Unavailable",
    });
    const cached = createSettlementClient(
      (async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );
    await expect(cached.load(null, new AbortController().signal)).rejects.toMatchObject({
      code: "Unavailable",
    });
    await expect(client.load("21-09-2026", new AbortController().signal)).rejects.toMatchObject({
      code: "Unavailable",
    });
  });
});

describe("WP-2423 settlement re-check and unmatched charges", () => {
  const withRecheck = (count: number, runReference?: string) => {
    const view = settlementViewFixture();
    const settlement = view.reconciliation.settlement;
    const first = settlement.checks[0];
    if (!first) throw Error("fixture");
    const run = runReference ?? "018f7700-0000-7000-8000-0000000000b1";
    return {
      ...view,
      reconciliation: {
        ...view.reconciliation,
        settlement: {
          ...settlement,
          recheck: {
            run: { ...settlement.run, runReference: run },
            check: {
              ...first,
              checkReference: "018f7700-0000-7000-8000-0000000000b2",
              runReference: run,
            },
            count,
          },
        },
      },
      unmatchedProviderCharges: {
        captured: { count: 1, amountMinor: "2260", currencyCode: "CAD" },
        refunded: { count: 0, amountMinor: "0", currencyCode: "CAD" },
      },
    };
  };
  it("reads the day's re-check and the unmatched charges", () => {
    const view = parseSettlementView(withRecheck(2));
    expect(view.reconciliation?.settlement?.recheck?.count).toBe(2);
    expect(view.unmatchedProviderCharges?.captured.amountMinor).toBe("2260");
    // Older servers send neither; the day still reads.
    expect(
      parseSettlementView(settlementViewFixture()).reconciliation?.settlement?.recheck,
    ).toBeNull();
  });
  it("refuses a re-check without a count, of the same run, or a malformed unmatched total", () => {
    expect(() => parseSettlementView(withRecheck(0))).toThrow("Unavailable");
    const fixture = settlementViewFixture();
    expect(() =>
      parseSettlementView(withRecheck(1, fixture.reconciliation.settlement.run.runReference)),
    ).toThrow("Unavailable");
    expect(() =>
      parseSettlementView({
        ...withRecheck(1),
        unmatchedProviderCharges: { captured: null, refunded: null },
      }),
    ).toThrow("Unavailable");
  });
});
