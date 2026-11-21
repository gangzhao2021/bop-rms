import { useEffect, useState, type ReactNode } from "react";

/**
 * WP-2423 item 2: a wait that has gone on longer than it should says so, instead of a spinner a guest
 * reads as "did it charge me twice?". Nothing is shown for an ordinary wait.
 */
export function SlowWaitNote({
  active,
  afterMs = 8_000,
  children,
}: {
  readonly active: boolean;
  readonly afterMs?: number;
  readonly children: ReactNode;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!active) return;
    const timer = window.setTimeout(() => setSlow(true), afterMs);
    return () => window.clearTimeout(timer);
  }, [active, afterMs]);
  return active && slow ? (
    <p className="slow-wait-note" role="status">
      {children}
    </p>
  ) : null;
}
