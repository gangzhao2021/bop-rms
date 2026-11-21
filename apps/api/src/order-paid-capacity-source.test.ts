import { describe, expect, it } from "vitest";
import { readOrderPaidCapacity } from "./order-paid-capacity-source.js";

const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };

/**
 * WP-2423 table-move-payment (v15 2026-11-06): accepting a moved paid round answered
 * ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE and the logs could not say why. The owner failure now
 * rides along as the error's cause (a code the log line prints); the answer is unchanged.
 */
describe("paid capacity source failures", () => {
  it("keeps the owner failure as a non-enumerable cause and still answers unavailable", async () => {
    const transaction = {
      query: async () => {
        throw new Error("never reached");
      },
    };
    const error = await readOrderPaidCapacity(
      transaction as never,
      scope,
      { not: "a payment" },
      "DineIn",
      "2026-11-06T10:00:00.000Z",
    ).then(
      () => null,
      (caught: unknown) => caught as Error & { code?: string; cause?: { code?: unknown } },
    );
    expect(error?.code).toBe("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
    expect(error?.cause).toBeInstanceOf(Error);
    expect(Object.keys(error ?? {})).not.toContain("cause");
    expect(JSON.stringify(error)).not.toContain("not");
  });
});
