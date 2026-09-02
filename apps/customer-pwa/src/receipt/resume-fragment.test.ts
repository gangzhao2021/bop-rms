import { describe, expect, it, vi } from "vitest";
import { extractAndClearReceiptResumeFragment } from "./resume-fragment.js";

const order = "018f8a00-0000-7000-8000-000000000001";
const token = "a".repeat(43);

describe("receipt resume fragment recovery", () => {
  it("clears the fragment before returning the in-memory exchange input", () => {
    const replaceCleanUrl = vi.fn();
    const result = extractAndClearReceiptResumeFragment({
      url: `https://customer.example.test/orders/${order}/receipt#resume=${token}`,
      replaceCleanUrl,
    });
    expect(replaceCleanUrl).toHaveBeenCalledWith(`/orders/${order}/receipt`);
    expect(result).toEqual({ orderReference: order, plaintextToken: token });
    expect(replaceCleanUrl.mock.invocationCallOrder[0]).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    `https://customer.example.test/orders/${order}/receipt?resume=${token}`,
    `https://customer.example.test/orders/${order}/receipt#resume=${token}&extra=x`,
    `https://customer.example.test/orders/not-a-reference/receipt#resume=${token}`,
    `https://customer.example.test/orders/${order}/receipt#resume=short`,
  ])("rejects non-canonical token transport", (url) => {
    const replaceCleanUrl = vi.fn();
    expect(extractAndClearReceiptResumeFragment({ url, replaceCleanUrl })).toBeNull();
    expect(replaceCleanUrl).not.toHaveBeenCalled();
  });
});
