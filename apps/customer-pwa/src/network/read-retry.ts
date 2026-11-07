/**
 * WP-2423 (burst 2026-11-02): a guest's read that fails for a moment, when a whole table scans at
 * once, is read again before anyone sees an error. Only reads, a bounded number of times; the
 * caller shows its error and retry button if they still fail.
 */
export const guestReadRetryWaitsMs = Object.freeze([400, 1200]);
const wait = (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));
export async function withReadRetry(
  read: () => Promise<Response>,
  waits: readonly number[] = guestReadRetryWaitsMs,
): Promise<Response> {
  for (const ms of waits) {
    try {
      const response = await read();
      if (response.status !== 503) return response;
    } catch {
      /* Tried again below; the last attempt's failure is the caller's. */
    }
    await wait(ms);
  }
  return read();
}
