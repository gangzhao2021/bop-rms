import { afterEach, describe, expect, it, vi } from "vitest";
import {
  counterAnswerWaitMs,
  createCounterOrderClient,
  CounterOrderClientError,
} from "./staff-order-entry.js";
import { placeErrorText } from "./StaffOrderEntryPage.js";

/**
 * WP-2423 (rush-reads-and-orders-changes, v15 2026-11-13): a counter Send took about 35 s on a
 * loaded host while the page said "Still working ... this finishes by itself". It did finish, but
 * nothing bounded the wait: a connection that never answered would have said so for ever.
 */
const id = (n: number) => "018f8905-0000-7000-8000-" + n.toString(16).padStart(12, "0");
afterEach(() => vi.useRealTimers());

describe("a counter send waits for its answer at most 40 s", () => {
  it("says there was no answer after 40 s, so the same order is sent again (never twice)", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    // The system never answers; the request is dropped only when the page stops waiting.
    const fetcher = vi.fn(
      (_path: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const client = createCounterOrderClient("a".repeat(43), fetcher as unknown as typeof fetch);
    const sent = client
      .placeOrder({
        operationReference: id(1),
        lines: [],
        tip: { kind: "None" },
        recordedAfterOutage: false,
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(counterAnswerWaitMs - 1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const failure = await sent;
    expect(counterAnswerWaitMs).toBe(40_000);
    expect(failure).toBeInstanceOf(CounterOrderClientError);
    expect(failure).toMatchObject({ code: "OutcomeUnknown" });
    expect(placeErrorText(failure as CounterOrderClientError, [])).toBe(
      "No answer from the system. Send again — the same order is never created twice.",
    );
  });

  it("never cuts an answer that came: a slow answer within 40 s is read in full", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ error: "counter_order_in_progress" }), {
                  status: 409,
                }),
              ),
            35_000,
          ),
        ),
    );
    const client = createCounterOrderClient("a".repeat(43), fetcher as unknown as typeof fetch);
    const sent = client
      .placeOrder({
        operationReference: id(2),
        lines: [],
        tip: { kind: "None" },
        recordedAfterOutage: false,
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(35_000);
    // The system's own answer, not "no answer".
    expect(await sent).toMatchObject({ code: "InProgress" });
    // The wait ended with the answer: nothing is cut later.
    await vi.advanceTimersByTimeAsync(10_000);
  });
});
