/**
 * Batch 36 (v15 b35 live): Home and the frame around it each read the same things when Home opens
 * (the Orders list for the refund warning and for Home, the refunds and staff roles waiting for the
 * Approvals badge and for Home, the Store's setup and service for Home and its panels), so the
 * merchant server answered about 29 reads where 21 say everything. Every read costs it the same
 * Session and permission check, it answers them one at a time, and Home waited for the last.
 *
 * `sharedRead` sends one request for identical reads asked while it is still on its way: the later
 * callers get the same answer (or the same failure). Nothing is kept once it has answered, so a
 * read asked afterwards is always sent again. A caller that stops waiting (its signal aborts) gets
 * an abort of its own; the request itself is stopped only when every caller has stopped waiting.
 *
 * Reads are kept apart by the fetcher they are sent with and by `key` (method, path, body and
 * anything else that changes the answer), never across sign-ins or Stores: the caller's key names
 * what it reads with.
 */
interface InFlight {
  readonly promise: Promise<unknown>;
  readonly controller: AbortController;
  waiting: number;
}
const inFlight = new WeakMap<object, Map<string, InFlight>>();

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The read was stopped.", "AbortError");
}

export function sharedRead<T>(
  /** The fetcher the read is sent with (requests of another fetcher are never shared). */
  owner: object,
  key: string,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  /** What a caller that stopped waiting is refused with (the client's own error); AbortError. */
  stopped: (signal: AbortSignal) => unknown = aborted,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(stopped(signal));
  let reads = inFlight.get(owner);
  if (reads === undefined) {
    reads = new Map();
    inFlight.set(owner, reads);
  }
  const map = reads;
  let entry = map.get(key);
  if (entry === undefined) {
    const controller = new AbortController();
    const created: InFlight = {
      promise: Promise.resolve()
        .then(() => run(controller.signal))
        .finally(() => {
          if (map.get(key) === created) map.delete(key);
        }),
      controller,
      waiting: 0,
    };
    map.set(key, created);
    entry = created;
  }
  const shared = entry;
  shared.waiting += 1;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const leave = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      shared.waiting -= 1;
      return true;
    };
    function onAbort() {
      if (!leave()) return;
      // Nobody waits for it any more: stop it, and let the next caller send a new one.
      if (shared.waiting === 0 && map.get(key) === shared) {
        map.delete(key);
        shared.controller.abort();
      }
      reject(stopped(signal as AbortSignal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    shared.promise.then(
      (value) => {
        if (leave()) resolve(value as T);
      },
      (error: unknown) => {
        if (leave()) reject(error);
      },
    );
  });
}
