import { Link } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { contentName, saidTable, t } from "./i18n/i18n.js";
import { createTableCartClient, type TableCartLine } from "./table-cart-client.js";
import { staffRoundRefusedShortText, type StaffRoundOffer } from "./staff-round-offer.js";

/**
 * Batch 66 (v15 b65 live, guest-cart-and-payments): a guest pressed "Ask staff to add these" on
 * the Cart at checkout, and staff answering read only "Asked for staff · A problem with their
 * order": the dishes were in the table's cart, under "Manage this table", folded away. While a
 * guest's call is open, the dishes guests put in the table's cart and didn't send are listed
 * under the call (the table's own cart read, Ordering's; never a guest's note), with the one step
 * that adds them: a staff round, which opens with them already in it (staff check and send). A
 * table checking out takes no round, so it says what to do first instead.
 */
export function useCallUnsentDishes(input: {
  readonly open: boolean;
  readonly diningSessionReference: string | null;
  readonly csrf: string;
  readonly refreshKey: string;
  readonly fetcher?: typeof fetch | undefined;
}): readonly TableCartLine[] {
  const client = useMemo(() => createTableCartClient(input.fetcher), [input.fetcher]);
  const [lines, setLines] = useState<{
    readonly session: string;
    readonly lines: readonly TableCartLine[];
  } | null>(null);
  const { open, diningSessionReference: session, csrf, refreshKey } = input;
  useEffect(() => {
    if (!open || session === null) return;
    const controller = new AbortController();
    client.read(csrf, session, controller.signal).then(
      (cart) => {
        if (!controller.signal.aborted) setLines({ session, lines: cart?.lines ?? [] });
      },
      // The list is a help to the call, never in its way: a failed read leaves it out (the
      // table's cart under "Manage this table" says it could not be read).
      () => undefined,
    );
    return () => controller.abort();
  }, [client, open, session, csrf, refreshKey]);
  return open && lines !== null && lines.session === session ? lines.lines : [];
}

export function StaffCallUnsentDishes({
  lines,
  tableReference,
  tableLabel,
  roundOffer,
  canTakeOrders,
  paymentStarted,
  fullyRefunded,
}: {
  readonly lines: readonly TableCartLine[];
  readonly tableReference: string;
  readonly tableLabel: string;
  readonly roundOffer: StaffRoundOffer;
  readonly canTakeOrders: boolean;
  readonly paymentStarted: boolean;
  readonly fullyRefunded: boolean;
}) {
  if (lines.length === 0) return null;
  return (
    <section className="table-call-dishes" aria-labelledby="table-call-dishes-heading">
      <h3 id="table-call-dishes-heading">{t("Not sent to the kitchen")}</h3>
      <ul>
        {lines.map((line) => (
          <li key={line.cartItemReference}>
            <span>
              {contentName(line.names) ?? t("A dish no longer on the menu")} × {line.quantity}
            </span>
            <span className="table-call-dishes__who">
              {[
                line.withOptions ? t("with options") : null,
                line.phoneNumber === null
                  ? t("Staff")
                  : t("Phone {number}", { number: String(line.phoneNumber) }) +
                    (line.phoneLeft ? " · " + t("left") : ""),
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      {!canTakeOrders ? null : roundOffer === "Offered" ? (
        <Link
          className="table-panel__text-step"
          to={`/operations/order-entry?table=${encodeURIComponent(tableReference)}`}
        >
          {t("Order these for table {stableLabel}", { stableLabel: saidTable(tableLabel) })}
        </Link>
      ) : roundOffer === "CheckingOut" || roundOffer === "Paid" ? (
        <p className="table-panel__notice">
          {staffRoundRefusedShortText(roundOffer, paymentStarted, fullyRefunded)}
        </p>
      ) : null}
    </section>
  );
}
