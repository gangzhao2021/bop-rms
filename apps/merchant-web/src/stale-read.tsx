import { useContext, useEffect, useRef } from "react";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { StatePanel } from "@bop-rms/ui";
import { StoreTimeZoneContext, storeTime } from "./StoreTime.js";

/**
 * IDR-0039 (Handoff §87.11.1): when a re-read fails, a work screen keeps the last data it loaded in
 * an explicit stale, read-only mode and keeps trying on its own. Nothing is queued offline: every
 * action stays disabled until a fresh read succeeds.
 */
export type ReadFailure =
  "PermissionDenied" | "NotFound" | "Offline" | "Conflict" | "CommandFailed" | "Unavailable";

export interface StaleRead {
  readonly reason: ReadFailure;
  /** When this device last loaded the data still on screen (UTC instant). */
  readonly lastLoadedAt: string;
  /** Consecutive failed reads since then. */
  readonly attempts: number;
}

/** A denial or a missing scope must not leave data on screen the reader may no longer see. */
export function replacesLastRead(reason: ReadFailure): boolean {
  return reason === "PermissionDenied" || reason === "NotFound";
}

/** Retry backoff after consecutive failed reads: 5 s, 10 s, 20 s, then every 30 s. */
export const staleRetryDelaysMs = [5_000, 10_000, 20_000, 30_000] as const;
export function staleRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), staleRetryDelaysMs.length) - 1;
  return staleRetryDelaysMs[index] as number;
}

/**
 * Re-reads after a failure with backoff, and at once when the browser reports the network is back.
 * `attempts` null means the last read succeeded (or the failure is not retryable): nothing runs.
 */
export function useStaleRetry(attempts: number | null, retry: () => void): void {
  const retryRef = useRef(retry);
  retryRef.current = retry;
  // v15 cbff9d6f: no retries with a sign-in that has ended; they resume if it is still live.
  const live = useStaffSessionLive();
  useEffect(() => {
    if (attempts === null || !live || typeof window === "undefined") return;
    const timer = window.setTimeout(() => retryRef.current(), staleRetryDelayMs(attempts));
    const online = () => retryRef.current();
    window.addEventListener("online", online);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", online);
    };
  }, [attempts, live]);
}

/** True when the browser itself reports no network; a command must not be sent then. */
export function browserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * A request that never got an answer is "Offline" only when the browser itself has no network;
 * otherwise the store system did not answer (host down, timeout): "Connection lost".
 */
export function readFailureReason(code: ReadFailure): ReadFailure {
  return code === "Offline" && !browserOffline() ? "Unavailable" : code;
}

/** Calls `onOffline` as soon as the browser reports the network is gone, before any read fails. */
export function useBrowserOffline(onOffline: () => void): void {
  const handler = useRef(onOffline);
  handler.current = onOffline;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const offline = () => handler.current();
    window.addEventListener("offline", offline);
    return () => window.removeEventListener("offline", offline);
  }, []);
}

/** The stale-mode notice: what is on screen, from when, and that actions wait for the connection. */
export function StaleReadNotice({
  stale,
  className,
}: {
  readonly stale: StaleRead;
  readonly className?: string;
}) {
  const timeZone = useContext(StoreTimeZoneContext);
  const offline = stale.reason === "Offline";
  return (
    <div className={className ?? "stale-read-notice"} data-stale-reason={stale.reason}>
      <StatePanel heading="Read-only until reconnected" tone="offline" status>
        <p>
          {offline ? "Offline" : "Connection lost"} — showing the last update from{" "}
          <time dateTime={stale.lastLoadedAt}>{storeTime(stale.lastLoadedAt, timeZone)}</time>.
          Actions are paused until the connection returns.
        </p>
        <p>Trying again automatically.</p>
      </StatePanel>
    </div>
  );
}
