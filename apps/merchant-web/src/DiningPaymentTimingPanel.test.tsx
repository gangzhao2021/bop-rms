import { describe, expect, it, vi } from "vitest";
import {
  createDiningPaymentTimingClient,
  DiningPaymentTimingError,
  parseDiningPaymentTimingView,
} from "./DiningPaymentTimingPanel.js";

const csrf = "a".repeat(43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

describe("DEC-DINE-IN-PAY-LATER: the Store's dine-in payment setting", () => {
  it("reads exactly the Store's choice, its version and when it changed", () => {
    expect(
      parseDiningPaymentTimingView({ paymentTiming: "PayFirst", version: 0, changedAt: null }),
    ).toEqual({ paymentTiming: "PayFirst", version: 0, changedAt: null });
    for (const bad of [
      { paymentTiming: "Tab", version: 0, changedAt: null },
      { paymentTiming: "PayLater", version: -1, changedAt: null },
      { paymentTiming: "PayLater", version: 1, changedAt: "yesterday" },
      { paymentTiming: "PayLater", version: 1, changedAt: null, actor: "x" },
    ])
      expect(() => parseDiningPaymentTimingView(bad)).toThrow(DiningPaymentTimingError);
  });

  it("changes it with the version it saw, and says when someone changed it meanwhile", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          status: "Conflict",
          timing: { paymentTiming: "PayLater", version: 2, changedAt: "2026-10-27T10:00:00.000Z" },
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 403 }));
    const client = createDiningPaymentTimingClient(fetcher);
    const result = await client.change(csrf, {
      operationReference: "01909968-0000-7000-8000-000000000001",
      paymentTiming: "PayFirst",
      expectedVersion: 1,
    });
    expect(result.status).toBe("Conflict");
    expect(result.timing.version).toBe(2);
    const [path, init] = fetcher.mock.calls[0] ?? [];
    expect(path).toBe("/merchant/dining/payment-timing/change");
    expect(JSON.parse(String(init?.body))).toEqual({
      operationReference: "01909968-0000-7000-8000-000000000001",
      paymentTiming: "PayFirst",
      expectedVersion: 1,
    });
    await expect(client.load(csrf)).rejects.toMatchObject({ code: "PermissionDenied" });
  });
});
