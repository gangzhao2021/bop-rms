import { useEffect, useRef, useState } from "react";

/**
 * b24 (v15 live check of b23): a read that failed while the connection was gone is made again by
 * itself once the connection is back, so staff are never left with "could not be loaded" on a page
 * that is online again. `failed` says whether the last read failed; `readAgain` reads it again.
 * Returns whether this device is online, so a section can leave an outage to the page's offline
 * line instead of saying its read failed.
 */
export function useReadAgainWhenOnline(failed: boolean, readAgain: () => void): boolean {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const latest = useRef({ failed, readAgain });
  latest.current = { failed, readAgain };
  useEffect(() => {
    const back = () => {
      setOnline(true);
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
  return online;
}
