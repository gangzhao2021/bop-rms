import { describe, expect, it, vi } from "vitest";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import { createRoundWithdrawClient } from "./round-withdraw-client.js";

const key = "01900000-0000-7000-8000-000000000001";
describe("WP-2423 M38: Don't pay. Put the dishes back", () => {
  it("sends only the round's number with the same operation, and reads each answer", async () => {
    setCustomerCsrfCredential("c".repeat(43));
    const answers: [number, unknown][] = [
      [200, { schemaVersion: 1, status: "Returned" }],
      [200, { schemaVersion: 1, status: "AlreadyReturned" }],
      [200, { schemaVersion: 1, status: "Paid" }],
      [200, { schemaVersion: 1, status: "PaymentPending" }],
      [200, { schemaVersion: 1, status: "NotWithdrawable" }],
      [200, { schemaVersion: 1, status: "TableClosed" }],
      [404, { schemaVersion: 1 }],
      [503, { schemaVersion: 1 }],
    ];
    const fetcher = vi.fn(async () => {
      const [status, body] = answers.shift() ?? [500, {}];
      return new Response(JSON.stringify(body), { status });
    });
    const client = createRoundWithdrawClient(fetcher as never, () => key);
    const outcomes = [];
    for (let n = 0; n < 8; n += 1) outcomes.push(await client.withdraw(key, 2));
    expect(outcomes).toEqual([
      "Returned",
      "Returned",
      "Paid",
      "PaymentPending",
      "NotWithdrawable",
      "TableClosed",
      "NotWithdrawable",
      "Unknown",
    ]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/rounds/withdraw");
    expect(init.body).toBe(JSON.stringify({ roundNumber: 2 }));
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe(key);
    // No connection: the outcome is unknown and the same tap may be repeated.
    const offline = createRoundWithdrawClient(
      (async () => {
        throw new TypeError("offline");
      }) as never,
      () => key,
    );
    expect(await offline.withdraw(key, 2)).toBe("Unknown");
  });
});
