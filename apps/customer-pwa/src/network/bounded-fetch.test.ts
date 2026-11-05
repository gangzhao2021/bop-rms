import { describe, expect, it, vi } from "vitest";
import { boundedFetch, boundedJsonFetch, browserRequestTimeoutMs } from "./bounded-fetch.js";

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

describe("boundedJsonFetch", () => {
  it("reads the whole answer, and a body that isn't JSON as nothing", async () => {
    const answer = await boundedJsonFetch(async () => new Response('{"a":1}'), "/x");
    expect(answer.payload).toEqual({ a: 1 });
    const text = await boundedJsonFetch(async () => new Response("<html>"), "/x");
    expect(text.response.status).toBe(200);
    expect(text.payload).toBeNull();
  });

  it("gives up on a body that stalls after the headers arrived", async () => {
    vi.useFakeTimers();
    try {
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"a":'));
        },
      });
      let settled: unknown = "waiting";
      void boundedJsonFetch(async () => new Response(stalled), "/x").then(
        () => (settled = "answered"),
        (error: unknown) => (settled = (error as DOMException).name),
      );
      await vi.advanceTimersByTimeAsync(browserRequestTimeoutMs - 1);
      expect(settled).toBe("waiting");
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe("TimeoutError");
    } finally {
      vi.useRealTimers();
    }
  });
});
