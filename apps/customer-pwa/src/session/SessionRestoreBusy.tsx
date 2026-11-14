import { useState } from "react";
import { t } from "../i18n/i18n.js";
import { CustomerPage } from "../journey/CustomerPage.js";

/**
 * WP-2423 (rush-reads-and-orders-changes review): the Store could not say yet whether this
 * browser's visit goes on (busy, or no answer in time). Whatever page the guest opened waits here
 * with the visit kept, asks again by itself, and never says to scan a QR code or that the session
 * ended. `retryNow` asks at once; a new one comes with each answer that was still busy.
 */
export function SessionRestoreBusy({
  retryNow,
  retryAfterSeconds,
}: {
  readonly retryNow: () => void;
  readonly retryAfterSeconds: number;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <CustomerPage step="other" navigationHeld>
      <section className="cart-state cart-state--warning" role="alert" aria-live="polite">
        <h2>{t("The store’s system is busy")}</h2>
        <p>
          {t(
            "Your order and cart are kept. This page loads again by itself in {seconds} seconds.",
            { seconds: retryAfterSeconds },
          )}
        </p>
        <div className="cart-state__actions">
          <button
            type="button"
            disabled={asking}
            onClick={() => {
              setAsking(true);
              retryNow();
            }}
          >
            {asking ? t("Trying again…") : t("Try again")}
          </button>
        </div>
      </section>
    </CustomerPage>
  );
}
