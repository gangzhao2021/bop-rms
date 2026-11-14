/**
 * WP-2423 M61: a shared Store tablet signed in with a PIN returns to the staff list after a few
 * minutes in which nobody touched it, so the next person signs in as themselves and the order
 * record names who really did each thing. Only staff input counts (pointer, touch, key): an
 * operational screen that keeps the sign-in alive on its own (Orders, Pickup, Tables) does not.
 *
 * The return must hold without the network. The sign-out is attempted at once; until the server
 * confirms it, this browser marks that sign-in as ended (a one-way digest of its CSRF value, never
 * the value), so going back or tapping a link never resumes the previous person's sign-in: the
 * app treats it as signed out and keeps retrying the sign-out until it succeeds or a new sign-in
 * (a new PIN) replaces it.
 */
export const IDLE_RETURN_WARNING_MS = 30_000;
const MARK_KEY = "bop.merchant.idleReturned";

export type IdleReturnNotice =
  | { readonly kind: "None" }
  | { readonly kind: "Warning"; readonly leftMs: number }
  | { readonly kind: "Return" };

/** What the screen shows now, from the last staff input (operational auto-activity excluded). */
export function idleReturnNotice(input: {
  readonly minutes: number | null;
  readonly lastInputAt: number;
  readonly now: number;
}): IdleReturnNotice {
  if (input.minutes === null) return { kind: "None" };
  const left = input.lastInputAt + input.minutes * 60_000 - input.now;
  if (left <= 0) return { kind: "Return" };
  if (left <= IDLE_RETURN_WARNING_MS) return { kind: "Warning", leftMs: left };
  return { kind: "None" };
}

/** "0:28" */
export function idleReturnLeft(leftMs: number): string {
  const seconds = Math.max(0, Math.ceil(leftMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface IdleReturnStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
function storage(): IdleReturnStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A one-way digest of the sign-in's CSRF value (the value itself is never stored). */
export async function signInDigest(csrf: string): Promise<string> {
  const bytes = new TextEncoder().encode("bop.idle-return:" + csrf);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function markSignInEnded(
  csrf: string,
  store: IdleReturnStorage | null = storage(),
): Promise<void> {
  try {
    store?.setItem(MARK_KEY, await signInDigest(csrf));
  } catch {
    // Storage blocked: the sign-out request below is then the only guard.
  }
}

/** Whether this browser ended this sign-in at an idle return (its sign-out not yet confirmed). */
export async function signInMarkedEnded(
  csrf: string,
  store: IdleReturnStorage | null = storage(),
): Promise<boolean> {
  try {
    const marked = store?.getItem(MARK_KEY) ?? null;
    return marked !== null && marked === (await signInDigest(csrf));
  } catch {
    return false;
  }
}

export function clearSignInMark(store: IdleReturnStorage | null = storage()): void {
  try {
    store?.removeItem(MARK_KEY);
  } catch {
    // Nothing kept.
  }
}

/**
 * Retries the sign-out of an ended sign-in until it succeeds: now, whenever the browser comes back
 * online, and every 30 seconds. Returns a stop function.
 */
export function retrySignOut(
  signOut: () => Promise<void>,
  options: {
    readonly onDone?: () => void;
    readonly intervalMs?: number;
    readonly target?: Pick<Window, "addEventListener" | "removeEventListener">;
  } = {},
): () => void {
  let stopped = false;
  let busy = false;
  const target = options.target ?? globalThis.window;
  const attempt = () => {
    if (stopped || busy) return;
    busy = true;
    void signOut().then(
      () => {
        busy = false;
        if (stopped) return;
        stop();
        options.onDone?.();
      },
      () => {
        busy = false;
      },
    );
  };
  const timer = setInterval(attempt, options.intervalMs ?? 30_000);
  target?.addEventListener("online", attempt);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    target?.removeEventListener("online", attempt);
  };
  attempt();
  return stop;
}
