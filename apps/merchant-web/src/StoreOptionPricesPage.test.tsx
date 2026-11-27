import { describe, expect, it } from "vitest";
import {
  OptionPricePageError,
  createOptionPriceClient,
  moneyText,
  parseMoney,
  parseOptionPriceView,
} from "./store-option-prices-page.js";

describe("WP-2423 option price page helpers", () => {
  it("reads and writes money in minor units without floating point", () => {
    expect(parseMoney("0.75", 2)).toBe("75");
    expect(parseMoney(".5", 2)).toBe("50");
    expect(parseMoney("1", 2)).toBe("100");
    expect(parseMoney("0", 2)).toBe("0");
    expect(parseMoney("1.005", 2)).toBeNull();
    expect(parseMoney("-1", 2)).toBeNull();
    expect(parseMoney("", 2)).toBeNull();
    expect(moneyText("75", 2)).toBe("0.75");
    expect(moneyText("0", 2)).toBe("0.00");
    expect(moneyText("1250", 2)).toBe("12.50");
  });
  it("accepts only option price views", () => {
    expect(() => parseOptionPriceView({ screenId: "PRICE-BOOK-LIST" })).toThrow();
    expect(
      parseOptionPriceView({
        screenId: "PRICE-OPTION-LIST",
        products: [],
        currency: { code: "CAD", minorUnitExponent: 2 },
      }).products,
    ).toEqual([]);
  });
  it("maps a PIN sign-in refusal apart from a missing permission", async () => {
    const answer = (status: number, body: unknown) =>
      createOptionPriceClient("synthetic-csrf", () =>
        Promise.resolve(new Response(JSON.stringify(body), { status })),
      ).command?.({ action: "Publish", operationReference: "op", rules: [] });
    const code = (promise: Promise<unknown> | undefined) =>
      (promise ?? Promise.resolve()).then(
        () => "ok",
        (error: unknown) => (error instanceof OptionPricePageError ? error.code : "other"),
      );
    expect(await code(answer(403, { error: "full_sign_in_required" }))).toBe("FullSignInRequired");
    expect(await code(answer(403, { error: "request_denied" }))).toBe("PermissionDenied");
    expect(await code(answer(503, { error: "full_sign_in_required" }))).toBe("Unavailable");
    // WP-2423 sole operator: why publishing alone was refused.
    expect(await code(answer(409, { error: "SoleOperatorNotInEffect" }))).toBe(
      "SoleOperatorNotInEffect",
    );
    expect(await code(answer(409, { error: "NeedsReverification" }))).toBe("NeedsReverification");
  });
  it("reads whether the author may publish their own prices alone", () => {
    const view = (soleOperator: unknown) =>
      parseOptionPriceView({
        screenId: "PRICE-OPTION-LIST",
        products: [],
        currency: { code: "CAD", minorUnitExponent: 2 },
        soleOperator,
      }).soleOperator;
    expect(view(null)).toBeNull();
    expect(view(undefined)).toBeNull();
    expect(
      view({ status: "Effective", otherApprovers: [], verifiedUntil: "2026-10-16T18:00:00.000Z" }),
    ).toEqual({
      status: "Effective",
      otherApprovers: [],
      verifiedUntil: "2026-10-16T18:00:00.000Z",
    });
    expect(() => view({ status: "Maybe", otherApprovers: [], verifiedUntil: null })).toThrow();
  });
});
