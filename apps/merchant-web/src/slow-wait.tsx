import { t } from "./i18n/i18n.js";
import { useEffect, useState } from "react";

/** merchant-outage-recovery M68: how long a wait runs before staff are told it is still going. */
export const SLOW_WAIT_MS = 3_000;

/**
 * True once a busy spell has lasted `afterMs`, false as soon as it ends. Long waits during a busy
 * spell otherwise show only "Accepting…", and staff tap again or give up.
 */
export function useSlowWait(busy: boolean, afterMs = SLOW_WAIT_MS): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(timer);
  }, [busy, afterMs]);
  return busy && slow;
}

export const slowWaitText = t(
  "Still working; the system is busy. No need to tap again, this finishes by itself.",
);

/** The line shown under a button whose command is taking longer than a few seconds. */
export function SlowWaitNotice({ busy }: { readonly busy: boolean }) {
  const slow = useSlowWait(busy);
  return slow ? (
    <p className="slow-wait-notice" role="status">
      {slowWaitText}
    </p>
  ) : null;
}
