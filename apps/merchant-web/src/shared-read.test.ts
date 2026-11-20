import { expect, it, vi } from "vitest";
import { sharedRead } from "./shared-read.js";
import { createCurrentOrderQueueClient } from "./current-order-queue-client.js";

/** Batch 36: identical reads asked while one is on its way share its request, nothing more. */
const later = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
};

it("batch 36: identical reads in flight send one request and all get its answer", async () => {
  const owner = {};
  const answer = later<string>();
  const run = vi.fn(() => answer.promise);
  const first = sharedRead(owner, "GET /a", undefined, run);
  const second = sharedRead(owner, "GET /a", new AbortController().signal, run);
  // Another key, or another fetcher, is never shared.
  const other = sharedRead(owner, "GET /b", undefined, async () => "b");
  const elsewhere = sharedRead({}, "GET /a", undefined, async () => "elsewhere");
  answer.resolve("a");
  await expect(Promise.all([first, second, other, elsewhere])).resolves.toEqual([
    "a",
    "a",
    "b",
    "elsewhere",
  ]);
  expect(run).toHaveBeenCalledOnce();
  // Nothing is kept once it answered: the next read is sent again.
  await expect(sharedRead(owner, "GET /a", undefined, async () => "fresh")).resolves.toBe("fresh");
});

it("batch 36: a failure reaches every caller, and the next read is sent again", async () => {
  const owner = {};
  const answer = later<string>();
  const run = vi.fn(() => answer.promise);
  const first = sharedRead(owner, "k", undefined, run);
  const second = sharedRead(owner, "k", undefined, run);
  answer.reject(new Error("Unavailable"));
  await expect(first).rejects.toThrow("Unavailable");
  await expect(second).rejects.toThrow("Unavailable");
  await expect(sharedRead(owner, "k", undefined, async () => "ok")).resolves.toBe("ok");
});

it("batch 36: one caller stopping leaves the others' request running; all stopping stops it", async () => {
  const owner = {};
  const answer = later<string>();
  let sent: AbortSignal | null = null;
  const run = (signal: AbortSignal) => {
    sent = signal;
    return answer.promise;
  };
  const leaving = new AbortController();
  const staying = new AbortController();
  const left = sharedRead(owner, "k", leaving.signal, run);
  const stayed = sharedRead(owner, "k", staying.signal, run);
  await Promise.resolve();
  leaving.abort();
  await expect(left).rejects.toMatchObject({ name: "AbortError" });
  expect(sent).not.toBeNull();
  expect((sent as unknown as AbortSignal).aborted).toBe(false);
  answer.resolve("a");
  await expect(stayed).resolves.toBe("a");

  const hanging = later<string>();
  let stopped: AbortSignal | null = null;
  const alone = new AbortController();
  const only = sharedRead(owner, "h", alone.signal, (signal) => {
    stopped = signal;
    return hanging.promise;
  });
  await Promise.resolve();
  alone.abort();
  await expect(only).rejects.toMatchObject({ name: "AbortError" });
  expect((stopped as unknown as AbortSignal).aborted).toBe(true);
  // A caller already stopped is refused at once and sends nothing.
  const run2 = vi.fn(async () => "x");
  await expect(sharedRead(owner, "h", alone.signal, run2)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(run2).not.toHaveBeenCalled();
});

it("batch 36: the frame's refund warning and Home read the Orders list once when Home opens", async () => {
  const pending = later<Response>();
  const fetcher = vi.fn(async () => pending.promise);
  const watch = createCurrentOrderQueueClient(fetcher as unknown as typeof fetch);
  const home = createCurrentOrderQueueClient(fetcher as unknown as typeof fetch);
  const a = watch.load(null, new AbortController().signal);
  const b = home.load(null, new AbortController().signal);
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledOnce();
  pending.resolve(
    new Response(
      JSON.stringify({ items: [], earlierDayItems: [], nextAfterOrderReference: null }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      },
    ),
  );
  const [x, y] = await Promise.allSettled([a, b]);
  expect(x.status).toBe(y.status);
  expect(fetcher).toHaveBeenCalledOnce();
});
