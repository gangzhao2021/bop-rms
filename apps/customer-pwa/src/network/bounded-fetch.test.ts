import { describe, expect, it, vi } from "vitest";
import { boundedFetch, browserRequestTimeoutMs } from "./bounded-fetch.js";

function pendingRequest() {
  return vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
}

describe("boundedFetch", () => {
  it("aborts a request at the finite browser deadline", async () => {
    const request = pendingRequest();
    await expect(boundedFetch(request, "/slow", {}, 1)).rejects.toBeDefined();
    expect(request).toHaveBeenCalledWith(
      "/slow",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(browserRequestTimeoutMs).toBe(15_000);
  });

  it("preserves caller cancellation", async () => {
    const request = pendingRequest();
    const caller = new AbortController();
    const result = boundedFetch(request, "/cancelled", { signal: caller.signal });
    caller.abort(new Error("caller cancelled"));
    await expect(result).rejects.toThrow("caller cancelled");
  });
});
