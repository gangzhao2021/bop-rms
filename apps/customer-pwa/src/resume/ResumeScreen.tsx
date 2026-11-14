import { useEffect, useRef, useState } from "react";
import { orderRecoveryText } from "../journey/messages.js";
import { redeemOrderRecovery, type OrderRecoveryOutcome } from "./order-recovery.js";

/**
 * DEC-PILOT-NOTIFICATIONS R1: the page a one-time order link opens. It sends the token once; on
 * success it opens the order on this phone, otherwise it says plainly what to do next. A failed
 * network attempt may be retried with the same in-memory token (the server consumes it only once).
 */
export function ResumeScreen({
  token,
  fetcher,
  open,
}: {
  readonly token: string | null;
  readonly fetcher: typeof globalThis.fetch;
  readonly open: (path: string) => void;
}) {
  const [state, setState] = useState<OrderRecoveryOutcome | { kind: "Opening" }>(
    token === null ? { kind: "Expired" } : { kind: "Opening" },
  );
  const held = useRef(token);
  const started = useRef(false);
  const redeem = async () => {
    const value = held.current;
    if (value === null) return;
    setState({ kind: "Opening" });
    const outcome = await redeemOrderRecovery(fetcher, value);
    // Only a network or service failure keeps the token for one more try.
    if (outcome.kind !== "TryAgain") held.current = null;
    if (outcome.kind === "Open") open(outcome.path);
    else setState(outcome);
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void redeem();
  }, []);
  return (
    <main id="main-content" className="order-status" aria-labelledby="order-recovery-heading">
      <section className="order-status__card">
        {state.kind === "Opening" || state.kind === "Open" ? (
          <>
            <h1 id="order-recovery-heading">{orderRecoveryText.openingHeading}</h1>
            <p role="status">{orderRecoveryText.opening}</p>
          </>
        ) : state.kind === "TryAgain" ? (
          <>
            <h1 id="order-recovery-heading">{orderRecoveryText.tryAgainHeading}</h1>
            <p role="alert">{orderRecoveryText.tryAgain}</p>
            <button type="button" className="order-status__retry" onClick={() => void redeem()}>
              {orderRecoveryText.tryAgainButton}
            </button>
          </>
        ) : (
          <>
            <h1 id="order-recovery-heading">{orderRecoveryText.expiredHeading}</h1>
            <p role="alert">
              {state.kind === "TooManyTries"
                ? orderRecoveryText.tooManyTries
                : orderRecoveryText.expired}
            </p>
            <p>{orderRecoveryText.staff}</p>
            <a className="order-status__retry" href="/">
              {orderRecoveryText.start}
            </a>
          </>
        )}
      </section>
    </main>
  );
}
