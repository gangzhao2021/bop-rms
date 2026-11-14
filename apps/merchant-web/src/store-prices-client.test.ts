import { describe, expect, it } from "vitest";
import {
  centsFromDollars,
  chargedHere,
  createStorePricesClient,
  parseStorePricesView,
  StorePriceError,
} from "./store-prices-client.js";

const sku = "01909a7f-0000-7000-8000-000000000010";
describe("DEC-BRAND-MULTI-STORE segment 9: this Store's own prices", () => {
  it("reads typed dollars as cents, and nothing else", () => {
    expect(centsFromDollars("7.25")).toBe("725");
    expect(centsFromDollars("$7")).toBe("700");
    expect(centsFromDollars(" 7.5 ")).toBe("750");
    expect(centsFromDollars("0.05")).toBe("5");
    for (const bad of ["", "7.255", "-1", "seven", "1e3", "123456"])
      expect(centsFromDollars(bad), bad).toBeNull();
  });
  it("charges the Store's own price, else the Brand price", () => {
    const view = parseStorePricesView({
      multiStore: true,
      permissions: { mayChange: true },
      prices: [{ sellableReference: sku, brandPriceMinor: "650", storePriceMinor: "725" }],
      changes: [
        {
          sellableReference: sku,
          previousAmountMinor: "650",
          amountMinor: "725",
          changedBy: "01909a7f-0000-7000-8000-000000000005",
          changedAt: "2026-10-31T12:00:00.000Z",
        },
      ],
    });
    expect(chargedHere(view.prices.get(sku))).toBe("725");
    expect(
      chargedHere({ sellableReference: sku, brandPriceMinor: "650", storePriceMinor: null }),
    ).toBe("650");
    expect(chargedHere(undefined)).toBeNull();
    expect(() => parseStorePricesView({ multiStore: true })).toThrow(StorePriceError);
  });
  it("says why a change was refused, and a PIN sign-in must confirm first", async () => {
    const answer = (status: number, body: unknown) =>
      createStorePricesClient("csrf", async () => new Response(JSON.stringify(body), { status }));
    const command = {
      action: "ChangeStorePrice" as const,
      operationReference: "019a0004-0000-7000-8000-000000007001",
      sellableReference: sku,
      expectedAmountMinor: "650",
      amountMinor: "725",
    };
    await expect(answer(409, { error: "Changed" }).command(command)).rejects.toMatchObject({
      code: "Changed",
    });
    await expect(
      answer(403, { error: "full_sign_in_required" }).command(command),
    ).rejects.toMatchObject({ code: "FullSignInRequired" });
    await expect(answer(500, {}).command(command)).rejects.toMatchObject({ code: "Unavailable" });
  });
});
