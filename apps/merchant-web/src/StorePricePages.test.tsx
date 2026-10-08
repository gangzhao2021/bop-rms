import { describe, expect, it } from "vitest";
import {
  createPriceClient,
  dollarsToMinor,
  minorToDollars,
  suggestPriceBookCode,
} from "./store-price-pages.js";

describe("WP-2423 price page helpers", () => {
  it("converts dollars and cents exactly", () => {
    expect(dollarsToMinor("4.5")).toBe("450");
    expect(dollarsToMinor("4.50")).toBe("450");
    expect(dollarsToMinor("4")).toBe("400");
    expect(dollarsToMinor("0.05")).toBe("5");
    expect(dollarsToMinor("4.505")).toBeNull();
    expect(dollarsToMinor("-1")).toBeNull();
    expect(dollarsToMinor("100000")).toBeNull();
    expect(minorToDollars("450")).toBe("4.50");
    expect(minorToDollars("5")).toBe("0.05");
    expect(minorToDollars("0")).toBe("0.00");
    expect(suggestPriceBookCode("2026-10-08")).toBe("PRICES-20261008");
  });
  it("carries the items a refusal names", async () => {
    const client = createPriceClient("csrf", () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "NotCovered", sellableReferences: ["a", 1] }), {
          status: 409,
        }),
      ),
    );
    await expect(client.load(null)).rejects.toMatchObject({
      code: "NotCovered",
      sellableReferences: ["a"],
    });
  });
});
