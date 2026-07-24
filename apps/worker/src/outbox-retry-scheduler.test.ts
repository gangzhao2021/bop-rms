import { describe, expect, it, vi } from "vitest";
import { OutboxRetryScheduler } from "./outbox-retry-scheduler.js";

describe("OutboxRetryScheduler", () => {
  it("uses the accepted 100 total and 25 per-scope bounds with a rotating cursor", async () => {
    const schedule = vi
      .fn()
      .mockResolvedValueOnce(Array.from({ length: 25 }, () => ({ status: "applied" })))
      .mockResolvedValueOnce(Array.from({ length: 10 }, () => ({ status: "applied" })));
    const scheduler = new OutboxRetryScheduler({
      retries: { schedule },
      scopes: [
        { brandId: "018f1f48-7b5d-7a01-8a1b-123456789abc" },
        { brandId: "018f1f48-7b5d-7a02-8a1b-123456789abc" },
      ],
    });
    await expect(scheduler.runOnce()).resolves.toBe(35);
    expect(schedule).toHaveBeenNthCalledWith(1, expect.anything(), { batchSize: 25 });
    expect(schedule).toHaveBeenNthCalledWith(2, expect.anything(), { batchSize: 25 });
  });
});
