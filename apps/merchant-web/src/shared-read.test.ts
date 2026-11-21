import { expect, it, vi } from "vitest";
import { sharedRead } from "./shared-read.js";
import { createCurrentOrderQueueClient } from "./current-order-queue-client.js";
import { createRefundApprovalClient } from "./refund-approval-client.js";
import { createStoreKitchenSetupClient } from "./store-kitchen-setup-client.js";
import { createStorePublicProfileClient } from "./store-public-profile-client.js";
import { createServiceControlClient } from "./service-control-client.js";
import { createOwnNameClient } from "./OwnNamePrompt.js";
import { createStaffPageClient } from "./staff-administration-pages.js";
import { createRoleAdministrationPageClient } from "./role-administration-pages.js";

const A = { csrf: "a".repeat(43), storeReference: "store-a" };
const B = { csrf: "b".repeat(43), storeReference: "store-b" };

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
  const first = sharedRead(owner, A, "GET /a", undefined, run);
  const second = sharedRead(owner, A, "GET /a", new AbortController().signal, run);
  // Another key, or another fetcher, is never shared.
  const other = sharedRead(owner, A, "GET /b", undefined, async () => "b");
  const elsewhere = sharedRead({}, A, "GET /a", undefined, async () => "elsewhere");
  answer.resolve("a");
  await expect(Promise.all([first, second, other, elsewhere])).resolves.toEqual([
    "a",
    "a",
    "b",
    "elsewhere",
  ]);
  expect(run).toHaveBeenCalledOnce();
  // Nothing is kept once it answered: the next read is sent again.
  await expect(sharedRead(owner, A, "GET /a", undefined, async () => "fresh")).resolves.toBe(
    "fresh",
  );
});

it("batch 36: a read not asked to share is sent on its own", async () => {
  const owner = {};
  const run = vi.fn(async () => "own");
  const first = sharedRead(owner, A, "k", undefined, async () => "shared");
  await expect(sharedRead(owner, undefined, "k", undefined, run)).resolves.toBe("own");
  expect(run).toHaveBeenCalledOnce();
  await expect(first).resolves.toBe("shared");
});

it("batch 36: a failure reaches every caller, and the next read is sent again", async () => {
  const owner = {};
  const answer = later<string>();
  const run = vi.fn(() => answer.promise);
  const first = sharedRead(owner, A, "k", undefined, run);
  const second = sharedRead(owner, A, "k", undefined, run);
  answer.reject(new Error("Unavailable"));
  await expect(first).rejects.toThrow("Unavailable");
  await expect(second).rejects.toThrow("Unavailable");
  await expect(sharedRead(owner, A, "k", undefined, async () => "ok")).resolves.toBe("ok");
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
  const left = sharedRead(owner, A, "k", leaving.signal, run);
  const stayed = sharedRead(owner, A, "k", staying.signal, run);
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
  const only = sharedRead(owner, A, "h", alone.signal, (signal: AbortSignal) => {
    stopped = signal;
    return hanging.promise;
  });
  await Promise.resolve();
  alone.abort();
  await expect(only).rejects.toMatchObject({ name: "AbortError" });
  expect((stopped as unknown as AbortSignal).aborted).toBe(true);
  // A caller already stopped is refused at once and sends nothing.
  const run2 = vi.fn(async () => "x");
  await expect(sharedRead(owner, A, "h", alone.signal, run2)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(run2).not.toHaveBeenCalled();
});

it("batch 36: the frame's refund warning and Home read the Orders list once when Home opens", async () => {
  const pending = later<Response>();
  const fetcher = vi.fn(async () => pending.promise);
  const watch = createCurrentOrderQueueClient(fetcher as unknown as typeof fetch);
  const home = createCurrentOrderQueueClient(fetcher as unknown as typeof fetch);
  const a = watch.load(null, new AbortController().signal, A);
  const b = home.load(null, new AbortController().signal, A);
  // A read asked because something changed (Orders after a new paid order, a reread after a
  // command) never joins one sent before it.
  const fresh = home.load(null, new AbortController().signal);
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(2);
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
  await Promise.allSettled([fresh]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("batch 36 review: reads for another sign-in or Store are never shared", async () => {
  const owner = {};
  const run = vi.fn(() => later<string>().promise);
  void sharedRead(owner, A, "GET /a", undefined, run);
  // Same Store, new token (the Store switch answered); another Store; no Store at all.
  void sharedRead(owner, { ...A, csrf: B.csrf }, "GET /a", undefined, run);
  void sharedRead(owner, { ...A, storeReference: B.storeReference }, "GET /a", undefined, run);
  void sharedRead(owner, { ...A, storeReference: "" }, "GET /a", undefined, run);
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(4);
});

/**
 * Batch 36 review: App.switchStore switches in place (no reload) and gives a new token. A Home
 * opened under Store A whose opening reads are still on their way when the switch answers must not
 * hand them to the Home that opens under Store B, or B would show A's orders, approvals or setup.
 */
it("batch 36 review: an opening read still on its way for Store A is not joined after a switch to B", async () => {
  const replies: { url: string; resolve: (response: Response) => void }[] = [];
  const fetcher = vi.fn(
    (url: RequestInfo | URL) =>
      new Promise<Response>((resolve) => replies.push({ url: String(url), resolve })),
  ) as unknown as typeof fetch;
  const opening = (scope: typeof A) => {
    const signal = new AbortController().signal;
    return [
      createCurrentOrderQueueClient(fetcher).load(null, signal, scope),
      createRefundApprovalClient(fetcher).approvals(signal, scope),
      createStoreKitchenSetupClient({ csrf: scope.csrf, fetcher }).load(scope),
      createStorePublicProfileClient({ csrf: scope.csrf, fetcher }).load(scope),
      createServiceControlClient(fetcher).load(scope.storeReference, signal, scope),
      createOwnNameClient(scope.csrf, fetcher).read(scope),
      createStaffPageClient(scope.csrf, fetcher).roleRequests(scope),
      createRoleAdministrationPageClient(scope.csrf, fetcher).waiting(scope),
    ].map((read) => Promise.resolve(read).catch(() => "refused"));
  };
  const atA = opening(A);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sentForA = replies.length;
  expect(sentForA).toBe(8);
  // The switch answered (new token, Store B) while every read for A is still on its way.
  const atB = opening(B);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(replies.length).toBe(sentForA * 2);
  expect(replies.slice(sentForA).map((reply) => reply.url)).toEqual(
    replies.slice(0, sentForA).map((reply) => reply.url),
  );
  // Home under A opening twice (its frame and Home) still sends each read once.
  const again = opening(A);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(replies.length).toBe(sentForA * 2);
  for (const reply of replies) reply.resolve(new Response(null, { status: 503 }));
  await Promise.all([...atA, ...atB, ...again]);
});
