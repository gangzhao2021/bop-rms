import { useEffect, useRef, useState } from "react";

/** Waits before reading again a read that failed while this device says it is online. */
const settleDelays = [3_000, 10_000, 30_000] as const;

/**
 * b24 (v15 live check of b23): a read that failed while the connection was gone is made again by
 * itself once the connection is back, so staff are never left with "could not be loaded" on a page
 * that is online again. `failed` says whether the last read failed because the service could not be
 * reached (Unavailable or offline), never because it was refused (Denied, FullSignInRequired and the
 * like): a refusal is not read again by itself. `readAgain` reads it again.
 * A read that fails just as the connection comes back (the network is not quite there yet) is
 * tried again a few times, a little later each time; after that the section's own Try again stays.
 * Returns whether this device is online, so a section can leave an outage to the page's offline
 * line instead of saying its read failed.
 */
export function useReadAgainWhenOnline(failed: boolean, readAgain: () => void): boolean {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const latest = useRef({ failed, readAgain });
  latest.current = { failed, readAgain };
  const attempts = useRef(0);
  useEffect(() => {
    const back = () => {
      setOnline(true);
      attempts.current = 0;
      if (latest.current.failed) latest.current.readAgain();
    };
    const gone = () => setOnline(false);
    window.addEventListener("online", back);
    window.addEventListener("offline", gone);
    return () => {
      window.removeEventListener("online", back);
      window.removeEventListener("offline", gone);
    };
  }, []);
  useEffect(() => {
    // Counted from the connection coming back (a read in progress is not a success).
    if (!failed) return;
    const delay = settleDelays[attempts.current];
    if (!online || delay === undefined) return;
    const timer = setTimeout(() => {
      attempts.current += 1;
      if (latest.current.failed && navigator.onLine) latest.current.readAgain();
    }, delay);
    return () => clearTimeout(timer);
  }, [failed, online]);
  return online;
}
