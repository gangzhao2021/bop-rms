import { describe, expect, it, vi } from "vitest";
import { withPaidBatchAcceptance } from "./merchant-card-machine-payment.js";

const paid = {
  status: "Recorded" as const,
  orderReference: "0198a7c0-0000-7000-8000-000000000001",
  orderBatchReference: "0198a7c0-0000-7000-8000-000000000002",
  amountMinor: "2560",
  recordingReason: "AtCounter" as const,
  takenAt: "2026-10-15T18:00:00.000Z",
  recordedAt: "2026-10-15T18:00:00.000Z",
};
const input = { sessionCookie: "cookie", csrf: "csrf", command: { any: true } };

describe("WP-2423 D1: server-side acceptance with the card-machine payment record", () => {
  it("accepts the paid batch at the Order's current version, as the staff member", async () => {
    const record = vi.fn(async () => paid);
    let n = 0;
    const accept = vi.fn(async () => ({ status: "Created" as const, acceptedOrderVersion: 12 }));
    const result = await withPaidBatchAcceptance(record, {
      accept,
      nextReference: () => `0198a7c0-0000-7000-8000-00000000010${n++}`,
    })(input);
    expect(result).toEqual({ ...paid, acceptance: "Accepted" });
    expect(record).toHaveBeenCalledWith(input);
    expect(accept).toHaveBeenCalledWith(
      {
        sessionCookie: "cookie",
        csrf: "csrf",
        command: {
          acceptanceReference: "0198a7c0-0000-7000-8000-000000000100",
          operationReference: "0198a7c0-0000-7000-8000-000000000101",
          orderReference: paid.orderReference,
          orderBatchReference: paid.orderBatchReference,
        },
      },
      "CurrentVersion",
    );
  });

  it("reads again after a lost race and reports the acceptance already made", async () => {
    const accept = vi
      .fn()
      .mockRejectedValueOnce(new Error("unique violation"))
      .mockResolvedValueOnce({ status: "AlreadyCommitted", acceptedOrderVersion: 12 });
    const result = await withPaidBatchAcceptance(async () => paid, {
      accept,
      nextReference: () => "0198a7c0-0000-7000-8000-000000000100",
    })(input);
    expect(result.acceptance).toBe("Accepted");
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it("keeps the payment when the order cannot be accepted now, and says so", async () => {
    const reported: unknown[] = [];
    const notAcceptable = Object.assign(new Error("no"), {
      code: "ORDER_ACCEPTANCE_NOT_ACCEPTABLE",
    });
    const accept = vi.fn().mockRejectedValue(notAcceptable);
    const result = await withPaidBatchAcceptance(async () => paid, {
      accept,
      nextReference: () => "0198a7c0-0000-7000-8000-000000000100",
      onNotAccepted: (error) => reported.push(error),
    })(input);
    expect(result).toEqual({ ...paid, acceptance: "NotAccepted" });
    expect(accept).toHaveBeenCalledTimes(1);
    expect(reported).toEqual([notAcceptable]);
  });

  it("never accepts when the payment was not recorded", async () => {
    const accept = vi.fn();
    await expect(
      withPaidBatchAcceptance(
        async () => {
          throw new Error("CARD_MACHINE_NOT_PAYABLE");
        },
        { accept, nextReference: () => "x" },
      )(input),
    ).rejects.toThrow("CARD_MACHINE_NOT_PAYABLE");
    expect(accept).not.toHaveBeenCalled();
  });
});
