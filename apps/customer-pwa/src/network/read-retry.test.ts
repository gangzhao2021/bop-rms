import { describe, expect, it, vi } from "vitest";
import { withReadRetry } from "./read-retry.js";

const answer = (status: number) => new Response("{}", { status });
describe("WP-2423 a guest's read in a burst", () => {
  it("is read again after a 503 or a failed connection, and the guest sees the answer", async () => {
    const read = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(answer(503))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(answer(200));
    expect((await withReadRetry(read, [1, 1])).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("stops at its limit, leaving the error and retry button to the page", async () => {
    const read = vi.fn<() => Promise<Response>>().mockResolvedValue(answer(503));
    expect((await withReadRetry(read, [1, 1])).status).toBe(503);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("doesn't repeat any other answer", async () => {
    const read = vi.fn<() => Promise<Response>>().mockResolvedValue(answer(404));
    expect((await withReadRetry(read, [1, 1])).status).toBe(404);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
