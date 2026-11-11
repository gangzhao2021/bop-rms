import { contentName, t } from "./i18n/i18n.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { serviceOperationReference } from "./service-control-client.js";
import { storeClockTime } from "./staff-pin-client.js";
import {
  createTableCartClient,
  TableCartError,
  type TableCart,
  type TableCartLine,
  type TableCartRemovalReason,
} from "./table-cart-client.js";

const reasonLabel = (reason: TableCartRemovalReason) =>
  reason === "GuestAsked"
    ? t("Guest asked")
    : reason === "GuestLeft"
      ? t("Guest left")
      : t("Can't make it");
const reasonOrder: readonly TableCartRemovalReason[] = ["GuestAsked", "GuestLeft", "CantMake"];

/**
 * WP-2423 shared-table-checkout (c) (sim M36): on the table page, the dishes guests put in the
 * table's shared cart and haven't sent yet, with which phone added each and whether that phone
 * left. Staff take a dish out with a reason (guest asked, guest left, can't make it); the guests'
 * phones are told. Not while a guest is paying for these dishes. Hidden when the cart is empty.
 */
export function TableCartPanel({
  diningSessionReference,
  csrf,
  locked,
  refreshKey,
  fetcher,
}: {
  readonly diningSessionReference: string;
  readonly csrf: string;
  readonly locked: boolean;
  readonly refreshKey: string;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createTableCartClient(fetcher), [fetcher]);
  const [cart, setCart] = useState<TableCart | null>(null);
  const [hidden, setHidden] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  // One reference per intended removal, kept until it is answered (pressing again never repeats it).
  const pending = useRef<{ readonly key: string; readonly reference: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .read(csrf, diningSessionReference, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setCart(next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof TableCartError && error.code === "PermissionDenied") setHidden(true);
        else setProblem(t("The table's cart could not be read. It is read again with the table."));
      });
    return () => controller.abort();
  }, [client, csrf, diningSessionReference, refreshKey, reads]);
  if (hidden) return null;
  if (cart === null || cart.lines.length === 0)
    return problem ? <p className="table-panel__notice">{problem}</p> : null;
  const remove = async (line: TableCartLine, reason: TableCartRemovalReason) => {
    if (busy) return;
    const key = line.cartItemReference + ":" + reason + ":" + String(cart.cartVersion);
    if (pending.current?.key !== key)
      pending.current = { key, reference: serviceOperationReference() };
    setBusy(true);
    setProblem(null);
    try {
      const next = await client.remove(csrf, {
        diningSessionReference,
        cartReference: cart.cartReference,
        cartItemReference: line.cartItemReference,
        expectedCartVersion: cart.cartVersion,
        reason,
        operationReference: pending.current.reference,
      });
      pending.current = null;
      setChoosing(null);
      setCart(next);
    } catch (error) {
      const code = error instanceof TableCartError ? error.code : "Unavailable";
      if (code === "Changed") {
        pending.current = null;
        setChoosing(null);
        setReads((n) => n + 1);
      }
      setProblem(
        code === "OutcomeUnknown"
          ? t("We couldn't confirm the result. Press the button again: it is never recorded twice.")
          : code === "GuestPaying"
            ? t("A guest is paying for these dishes now.")
            : code === "Changed"
              ? t("The cart changed. Here it is as it stands now.")
              : t("That didn't go through. Read the table again and retry."),
      );
    } finally {
      setBusy(false);
    }
  };
  const disabled = locked || busy || cart.guestPaying;
  return (
    <section className="table-phones table-cart" aria-label={t("In the cart (not ordered yet)")}>
      <header className="table-phones__head">
        <h3>{t("In the cart (not ordered yet)")}</h3>
      </header>
      {cart.guestPaying ? (
        <p className="table-phones__mode" role="note">
          {t("A guest is paying for these dishes now.")}
        </p>
      ) : cart.guestChoosing !== null ? (
        // v15 batch 7: a phone chose what it pays and hasn't paid yet. Staff may still take a
        // dish out; the phone is then asked to choose again, never charged for more.
        <p className="table-phones__mode" role="note">
          {cart.guestChoosing.phoneNumber === null
            ? t(
                "A guest is choosing which of these dishes to pay, until {time}. Taking a dish out ends their choice: their phone asks them to choose again.",
                { time: storeClockTime(cart.guestChoosing.until, undefined) },
              )
            : t(
                "Phone {number} is choosing which of these dishes to pay, until {time}. Taking a dish out ends their choice: their phone asks them to choose again.",
                {
                  number: String(cart.guestChoosing.phoneNumber),
                  time: storeClockTime(cart.guestChoosing.until, undefined),
                },
              )}
        </p>
      ) : null}
      <ul className="table-phones__list">
        {cart.lines.map((line) => {
          const name = contentName(line.names) ?? t("A dish no longer on the menu");
          const who =
            line.phoneNumber === null
              ? t("Staff")
              : t("Phone {number}", { number: String(line.phoneNumber) }) +
                (line.phoneLeft ? " · " + t("left") : "");
          return (
            <li key={line.cartItemReference}>
              <span>
                {name} × {line.quantity}
                {line.withOptions ? " · " + t("with options") : ""}
                {" · "}
                {who}
              </span>
              {choosing === line.cartItemReference ? (
                <span className="table-phones__confirm" role="group">
                  <span>{t("Why remove {dish}?", { dish: name })}</span>
                  {reasonOrder.map((reason) => (
                    <button
                      key={reason}
                      type="button"
                      className="table-phones__danger"
                      disabled={disabled}
                      onClick={() => void remove(line, reason)}
                    >
                      {reasonLabel(reason)}
                    </button>
                  ))}
                  <button type="button" onClick={() => setChoosing(null)}>
                    {t("Keep")}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setChoosing(line.cartItemReference)}
                >
                  {t("Remove from cart")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {problem ? (
        <p className="table-panel__notice" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
