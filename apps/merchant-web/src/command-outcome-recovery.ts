/**
 * WP-2423: when a command's answer is lost (timeout, dropped connection, unreadable reply) the
 * same operation is sent again a few times, so the server answers with what actually happened
 * (an operation it already applied is reported as applied, never done twice). Staff then see the
 * real result; "couldn't confirm" remains only when the server can't be reached at all.
 */
export interface CommandOutcomeRecovery {
  /** Waits before each re-check of a lost answer; empty sends the operation once. */
  readonly delaysMs: readonly number[];
  /** How long one re-check waits for its answer. */
  readonly recheckTimeoutMs: number;
}
export const defaultCommandOutcomeRecovery: CommandOutcomeRecovery = Object.freeze({
  delaysMs: Object.freeze([1000, 3000]),
  recheckTimeoutMs: 10000,
});
/** First send waits `firstTimeoutMs`; each lost answer is re-checked with the same operation. */
export async function withCommandOutcomeRecovery<T>(input: {
  readonly recovery: CommandOutcomeRecovery;
  readonly firstTimeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly send: (timeoutMs: number) => Promise<T>;
  readonly lost: (error: unknown) => boolean;
}): Promise<T> {
  const { recovery, signal } = input;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await input.send(attempt === 0 ? input.firstTimeoutMs : recovery.recheckTimeoutMs);
    } catch (error) {
      const delay = recovery.delaysMs[attempt];
      if (!input.lost(error) || delay === undefined || signal?.aborted) throw error;
      const waited = await new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(false);
        const stop = () => {
          clearTimeout(timer);
          resolve(false);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", stop);
          resolve(true);
        }, delay);
        signal?.addEventListener("abort", stop, { once: true });
      });
      if (!waited) throw error;
    }
  }
}
