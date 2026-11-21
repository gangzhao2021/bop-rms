import { t } from "./i18n/i18n.js";
import { useEffect, useState } from "react";

/**
 * merchant-outage-recovery M68 (the customer app's own copy; apps share no source): true once a
 * wait has lasted `afterMs`, false as soon as it ends.
 */
export function useSlowWait(busy: boolean, afterMs = 3_000): boolean {
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

/** Under Add to cart while the restaurant's system is slow: the button stays off meanwhile. */
export function SlowAddNotice({ busy }: { readonly busy: boolean }) {
  const slow = useSlowWait(busy);
  return slow ? (
    <p className="slow-wait-notice" role="status">
      {t("Still adding; the restaurant's system is busy. No need to tap again.")}
    </p>
  ) : null;
}
