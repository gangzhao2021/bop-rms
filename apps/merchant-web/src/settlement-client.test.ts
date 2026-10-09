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
