import { t } from "./i18n/i18n.js";
import { notInKitchen } from "./current-order-queue-client.js";

/**
 * WP-2423 M04: a paid round staff accepted is on its way to the kitchen (the payment worker sends
 * it within seconds). A minute later it has not arrived: staff make it from the dishes listed with
 * the round and tell the manager, so the guest who paid is never forgotten. Polite live region: the
 * line changes on its own while staff look at the order.
 */
export function KitchenReleaseNotice({
  release,
  now,
}: {
  readonly release: {
    readonly state: "Sending" | "NotInKitchen";
    readonly acceptedAt: string;
  } | null;
  readonly now: number;
}) {
  if (release === null) return null;
  if (!notInKitchen(release, now))
    return (
      <p className="order-round__acceptance" role="status">
        {t("Sending to the kitchen…")}
      </p>
    );
  const minutes = Math.max(1, Math.floor((now - Date.parse(release.acceptedAt)) / 60_000));
  return (
    <p className="order-kitchen-late" role="status">
      <span className="order-accept-by" data-tier="warning">
        {t("Not in the kitchen yet")}
      </span>{" "}
      {t(
        "Paid and accepted {minutes} min ago, but the kitchen hasn't received it. Make it from the dishes listed here and tell the manager.",
        { minutes },
      )}
    </p>
  );
}

/**
 * WP-2423 M04: a paid pickup past its acceptance deadline is refunded by the System within seconds;
 * still here a minute later, it did not go through, and staff reject it to refund the guest.
 */
export function AutomaticRefundLateNotice({ late }: { readonly late: boolean }) {
  if (!late) return null;
  return (
    <p className="order-kitchen-late" role="status">
      <span className="order-accept-by" data-tier="urgent">
        {t("The automatic refund didn't go through.")}
      </span>{" "}
      {t("Reject the order to refund the guest in full.")}
    </p>
  );
}
