import { StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { createDiningSessionClient } from "./dining-session-client.js";
import { validSlipReference } from "./CardMachineRefundAction.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import { storeLocalInstant, storeTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
import {
  CounterOrderClientError,
  createCounterOrderClient,
  type CounterMenu,
  type CounterMenuItem,
  type CounterTip,
  type PlacedCounterOrder,
} from "./staff-order-entry.js";

const cad = (amountMinor: string) => orderMoney({ amountMinor, currencyCode: "CAD" });

interface Line {
  readonly key: string;
  readonly item: CounterMenuItem;
  readonly quantity: number;
  readonly options: readonly { optionReference: string; name: string; quantity: number }[];
  /** WP-2423 Q7 slice 2: the guest's note for the kitchen (table rounds only). */
  readonly note?: string | null;
}

/** What staff see for an item: about its base price plus chosen options (the order total decides). */
export function estimatedLineMinor(line: Line): bigint | null {
  if (line.item.priceMinor === null) return null;
  let each = BigInt(line.item.priceMinor);
  for (const chosen of line.options) {
    const option = line.item.rules
      .flatMap((rule) => rule.options)
      .find((candidate) => candidate.optionReference === chosen.optionReference);
    if (option?.priceMinor === null || option === undefined) return null;
    each += BigInt(option.priceMinor) * BigInt(chosen.quantity);
  }
  return each * BigInt(line.quantity);
}

/** Defaults pre-chosen per option group; a group of one choice is a single pick. */
function defaultChoices(item: CounterMenuItem) {
  return Object.fromEntries(
    item.rules.map((rule) => [
      rule.bindingReference,
      rule.options
        .filter((option) => option.selectedByDefault)
        .slice(0, Math.max(rule.maximumSelections, 0))
        .map((option) => option.optionReference),
    ]),
  ) as Record<string, string[]>;
}

export function choicesComplete(item: CounterMenuItem, choices: Record<string, string[]>) {
  return item.rules.every((rule) => {
    const picked = choices[rule.bindingReference]?.length ?? 0;
    return picked >= rule.minimumSelections && picked <= rule.maximumSelections;
  });
}

const menuError: Record<string, [string, string]> = {
  PermissionDenied: [
    "Counter orders are not available to you",
    "Taking an order for a customer needs the staff ordering permission at this store.",
  ],
  TableUnavailable: [
    "This table can't take an order now",
    "It may be marked unavailable or its session may be closing. Check it on the Tables page.",
  ],
  TableUnknown: ["Table not found", "Open the table from the Tables page to take its order."],
  Unavailable: [
    "The menu could not be loaded",
    "Check the connection and try again. If the system stays down, take the order on paper and record it here afterwards.",
  ],
};

function placeErrorText(
  error: CounterOrderClientError,
  lines: readonly Line[],
  table: string | null = null,
) {
  switch (error.code) {
    case "TableCartHasItems":
      return `Guests at this table have items in their shared cart that haven't been sent${
        error.pendingItems.length > 0
          ? ` (${error.pendingItems.map((item) => `${item.quantity} × ${item.name}`).join(", ")})`
          : ""
      }. Ask them to send or remove those items on their phone, then send this order again.`;
    case "TableCheckoutInProgress":
      return "A guest at this table is paying on their phone right now. Wait a minute, then send again.";
    case "TableUnavailable":
      return `${table ?? "This table"} can't take an order now (marked unavailable, or its session is closing). Check the table on the Tables page.`;
    case "ItemUnavailable": {
      const line = error.lineIndex === null ? undefined : lines[error.lineIndex];
      return line
        ? `${line.item.name} can't be sold right now (sold out or off the menu). Remove it and send again.`
        : "An item can't be sold right now. Check the order and send again.";
    }
    case "StoreNotTakingOrders":
      return table !== null
        ? "The store is closed, so no new table orders can be taken now. A paper order taken earlier can still be entered under Paper order."
        : "Pickup hours are over, so the counter can't take a new order now. A paper order taken earlier can still be entered under Paper order.";
    case "NotPriced":
      return "This order could not be priced. Check the items and options and send again.";
    case "NotFinished":
      return "This order didn't go through and nothing was charged. Send it again.";
    case "InProgress":
      return "This order is still being sent. Wait a moment, then send again to see it.";
    case "PermissionDenied":
      return "Your session can't take counter orders. Sign in again or ask a manager.";
    case "OutcomeUnknown":
      return "No answer from the system. Send again — the same order is never created twice.";
    default:
      return "The order could not be sent. Check the order and try again.";
  }
}

export function payErrorText(error: CounterOrderClientError) {
  switch (error.code) {
    case "AmountChanged":
      return error.totalMinor === null
        ? "The amount changed. Charge the new total before recording it."
        : `The amount to charge is now ${cad(error.totalMinor)}. Charge the difference, then record it.`;
    case "PaymentWindowClosed":
      return "The time to pay this order has ended and it was released. Refund the card machine payment and take the order again.";
    case "AlreadyPaid":
      return "This order is already paid. Check Orders before charging again.";
    case "NotPayable":
      return "This order can no longer be paid (released or changed). Refund the card machine payment if you charged it.";
    case "Invalid":
      return "Check the slip reference and the paid-at time.";
    case "PermissionDenied":
      return "Your session can't record payments. Sign in again or ask a manager.";
    case "OutcomeUnknown":
      return "No answer from the system. Record again — the same payment is never counted twice.";
    default:
      return "The payment could not be recorded. Try again.";
  }
}

/**
 * A date-time input value ("2026-10-13T14:05") read as Store time (WP-2423 Q21: the slip's time
 * where the Store is, not the device's zone) as an instant, or null.
 */
export function paidAtInstant(
  value: string,
  now = Date.now(),
  timeZone?: string | undefined,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const local = timeZone === undefined ? null : storeLocalInstant(value, timeZone);
  if (timeZone !== undefined && local === null) return null;
  const time = (local === null ? new Date(value) : new Date(local)).getTime();
  if (!Number.isFinite(time) || time > now || now - time > 72 * 60 * 60 * 1000) return null;
  return new Date(Math.floor(time / 1000) * 1000).toISOString();
}

/** WP-2423 item 5: minutes before the payment time ends when staff are warned urgently. */
export const paymentUrgentMinutes = 10;

/**
 * WP-2423 item 5 ("warn before timeouts"): what staff are told about the time left to record a
 * card-machine payment. A table round not recorded by then is cancelled automatically and never
 * reaches the kitchen; a counter order is released. Nothing is charged in the system either way.
 */
export function paymentWindowNotice(input: {
  readonly payBy: string;
  readonly now: number;
  readonly tableMode: boolean;
  readonly timeZone?: string | undefined;
}): { readonly tier: "warning" | "urgent"; readonly ended: boolean; readonly text: string } {
  const at = storeTime(input.payBy, input.timeZone);
  const remainingMs = Date.parse(input.payBy) - input.now;
  if (remainingMs <= 0)
    return {
      tier: "urgent",
      ended: true,
      text: input.tableMode
        ? `The time to pay this round ended at ${at}. It was not sent to the kitchen and is cancelled automatically; nothing was charged in the system. If you charged the card machine, refund it on the machine.`
        : `The time to pay this order ended at ${at}. It is released and its items go back to stock. If you charged the card machine, refund it on the machine.`,
    };
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (minutes <= paymentUrgentMinutes)
    return {
      tier: "urgent",
      ended: false,
      text: input.tableMode
        ? `${minutes} min left: record the payment by ${at} or this round is cancelled and its items go back to stock.`
        : `${minutes} min left: record the payment by ${at} or the order is released and its items go back to stock.`,
    };
  return {
    tier: "warning",
    ended: false,
    text: input.tableMode
      ? `Record the payment by ${at}. The kitchen starts this order once it is recorded here; if it isn't recorded by then, the round is cancelled.`
      : `Record the payment by ${at}. If it isn't paid by then the order is released and its items go back to stock.`,
  };
}

/**
 * WP-2423 Q7 (OPS-ORDER-ENTRY, DEC-COUNTER-PAYMENT-RECORD): staff take a pickup order at the
 * counter for a customer without a phone, or enter a paper order taken while the system was down.
 * The order uses the same menu, sold-out state, prices and tax as the customer app; the store's
 * own card machine takes the payment (no cash) and staff record it here.
 */
export function StaffOrderEntryPage({
  storeLabel,
  csrf,
  timeZone,
  fetcher,
}: {
  readonly storeLabel: string;
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createCounterOrderClient(csrf, fetcher), [csrf, fetcher]);
  // WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): opened from the Tables page for one table.
  const [searchParams] = useSearchParams();
  const requestedTable = searchParams.get("table");
  const tableReference =
    requestedTable !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(requestedTable)
      ? requestedTable
      : null;
  const tableMode = requestedTable !== null;
  const [tableLabel, setTableLabel] = useState<string | null>(null);
  const [menu, setMenu] = useState<
    { kind: "Loading" } | { kind: "Error"; code: string } | { kind: "Ready"; menu: CounterMenu }
  >({ kind: "Loading" });
  const [reload, setReload] = useState(0);
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [choosing, setChoosing] = useState<{
    item: CounterMenuItem;
    choices: Record<string, string[]>;
    quantity: number;
    note: string;
  } | null>(null);
  const [tip, setTip] = useState<"0" | "10" | "15" | "18" | "Custom">("0");
  const [customTip, setCustomTip] = useState("");
  const [paper, setPaper] = useState(false);
  const [paidAt, setPaidAt] = useState("");
  const [slip, setSlip] = useState("");
  const [placed, setPlaced] = useState<PlacedCounterOrder | null>(null);
  const [phase, setPhase] = useState<
    "Building" | "Sending" | "Charge" | "Recording" | "Paid" | "Accepted"
  >("Building");
  const [problem, setProblem] = useState<string | null>(null);
  const [paidNote, setPaidNote] = useState<string | null>(null);
  const placeOperation = useRef<string | null>(null);
  const payOperation = useRef<string | null>(null);
  const chargeHeading = useRef<HTMLHeadingElement>(null);
  // WP-2423 item 5: the clock behind the payment-time warning, ticking while payment is due.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase !== "Charge" && phase !== "Recording") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    const controller = new AbortController();
    setMenu({ kind: "Loading" });
    if (tableMode && tableReference === null) {
      setMenu({ kind: "Error", code: "TableUnknown" });
      return () => controller.abort();
    }
    const loadTable = async () => {
      if (tableReference === null) return;
      // The table's name as staff know it, from the Tables list (paged, at most 500 tables).
      const tables = createDiningSessionClient(fetcher);
      let after: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await tables.tables(csrf, after, controller.signal);
        const found = result.items.find((table) => table.tableReference === tableReference);
        if (found !== undefined) {
          if (found.lifecycle !== "Published" || found.operationalState !== "Available")
            throw new CounterOrderClientError("TableUnavailable");
          setTableLabel(found.stableLabel);
          return;
        }
        if (result.next === null) break;
        after = result.next;
      }
      throw new CounterOrderClientError("TableUnavailable");
    };
    Promise.all([client.loadMenu(controller.signal, tableMode ? "DineIn" : "Pickup"), loadTable()])
      .then(([value]) => {
        if (!controller.signal.aborted) setMenu({ kind: "Ready", menu: value });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMenu({
          kind: "Error",
          code:
            error instanceof CounterOrderClientError &&
            (error.code === "PermissionDenied" || error.code === "TableUnavailable")
              ? error.code
              : "Unavailable",
        });
      });
    return () => controller.abort();
  }, [client, reload, csrf, fetcher, tableMode, tableReference]);
  useEffect(() => {
    if (phase === "Charge") chargeHeading.current?.focus();
  }, [phase]);

  // Any change to what is ordered is a new order intent.
  const changeLines = (next: readonly Line[]) => {
    placeOperation.current = null;
    setProblem(null);
    setLines(next);
  };
  const tipChoice = (): CounterTip | null => {
    if (tip === "0") return { kind: "None" };
    if (tip !== "Custom") return { kind: "Percent", percent: Number(tip) as 10 | 15 | 18 };
    const match = /^(0|[1-9][0-9]{0,4})(?:\.([0-9]{1,2}))?$/u.exec(customTip.trim());
    if (!match) return null;
    return {
      kind: "Amount",
      amountMinor: String(Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"))),
    };
  };
  const paperInstant = paper ? paidAtInstant(paidAt, Date.now(), timeZone) : null;
  const estimate = lines.reduce<bigint | null>((sum, line) => {
    const value = estimatedLineMinor(line);
    return sum === null || value === null ? null : sum + value;
  }, 0n);
  const canSend =
    phase === "Building" &&
    lines.length > 0 &&
    tipChoice() !== null &&
    (!paper || paperInstant !== null);

  const send = async () => {
    const chosenTip = tipChoice();
    if (!canSend || chosenTip === null) return;
    placeOperation.current ??= serviceOperationReference();
    setPhase("Sending");
    setProblem(null);
    try {
      const chosen = lines.map((line) => ({
        sellableReference: line.item.sellableReference,
        quantity: line.quantity,
        optionSelections: line.options.map((option) => ({
          optionReference: option.optionReference,
          quantity: option.quantity,
        })),
      }));
      const order =
        tableReference !== null
          ? await client.placeTableRound({
              operationReference: placeOperation.current,
              tableReference,
              lines: chosen.map((line, index) => ({ ...line, note: lines[index]?.note ?? null })),
              tip: chosenTip,
              recordedAfterOutage: paper,
            })
          : await client.placeOrder({
              operationReference: placeOperation.current,
              lines: chosen,
              tip: chosenTip,
              recordedAfterOutage: paper,
            });
      setPlaced(order);
      payOperation.current = null;
      setPhase("Charge");
    } catch (error) {
      const failure =
        error instanceof CounterOrderClientError
          ? error
          : new CounterOrderClientError("Unavailable");
      // An unknown or still-running outcome keeps the same operation (a retry returns the same
      // order); anything else starts over as a new order.
      if (failure.code !== "OutcomeUnknown" && failure.code !== "InProgress")
        placeOperation.current = null;
      setProblem(
        placeErrorText(failure, lines, tableLabel === null ? null : `Table ${tableLabel}`),
      );
      setPhase("Building");
    }
  };

  const recordPayment = async (expectedTotalMinor: string) => {
    if (placed === null || phase !== "Charge" || !validSlipReference(slip.trim())) return;
    if (placed.recordedAfterOutage && paperInstant === null) return;
    payOperation.current ??= serviceOperationReference();
    setPhase("Recording");
    setProblem(null);
    let recorded;
    try {
      recorded = await client.recordPayment({
        operationReference: payOperation.current,
        orderReference: placed.orderReference,
        orderBatchReference: placed.orderBatchReference,
        expectedTotalMinor,
        slipReference: slip.trim() === "" ? null : slip.trim(),
        takenAt: placed.recordedAfterOutage ? paperInstant : null,
      });
    } catch (error) {
      const failure =
        error instanceof CounterOrderClientError
          ? error
          : new CounterOrderClientError("Unavailable");
      if (failure.code !== "OutcomeUnknown") payOperation.current = null;
      if (failure.code === "AmountChanged" && failure.totalMinor !== null)
        setPlaced({ ...placed, totalMinor: failure.totalMinor });
      setProblem(payErrorText(failure));
      setPhase("Charge");
      return;
    }
    // WP-2423 D1: the server accepts the paid order or round with the payment record (at the
    // Order's current version), so it reaches the kitchen even if this page is closed now.
    if (recorded.acceptance === "Accepted") {
      setPhase("Accepted");
      // A paper order was usually made and handed over already; it still goes through the list so
      // its records close, and nothing expires or is refunded by mistake.
      setPaidNote(
        tableMode
          ? placed.recordedAfterOutage
            ? "Recorded after the outage and added to the table's order. If it was already made and served, mark it ready in Kitchen and served on the order."
            : "Paid and sent to the kitchen. It shows on the table's order as entered by staff."
          : placed.recordedAfterOutage
            ? "Recorded after the outage and accepted. If it was already made and handed over, mark it ready in Kitchen and handed over in Pickup."
            : "Paid and sent to the kitchen.",
      );
      return;
    }
    setPhase("Paid");
    setPaidNote(
      "Paid, but not sent to the kitchen yet. Accept it in Orders now (or ask a manager to): an order that isn't accepted in time expires and must be refunded on the card machine.",
    );
  };

  const startOver = () => {
    setLines([]);
    setPlaced(null);
    setTip("0");
    setCustomTip("");
    setPaper(false);
    setPaidAt("");
    setSlip("");
    setProblem(null);
    setPaidNote(null);
    placeOperation.current = null;
    payOperation.current = null;
    setPhase("Building");
  };

  const pageTitle = tableMode
    ? tableLabel === null
      ? "Table order"
      : `Table ${tableLabel} order`
    : "Counter order";
  if (menu.kind === "Loading")
    return (
      <WorkspacePage title={pageTitle} meta={storeLabel}>
        <StatePanel heading="Loading the menu" status>
          <p>Loading what the store sells now…</p>
        </StatePanel>
      </WorkspacePage>
    );
  if (menu.kind === "Error") {
    const [heading, text] = menuError[menu.code] ?? (menuError.Unavailable as [string, string]);
    return (
      <WorkspacePage title={pageTitle} meta={storeLabel}>
        <StatePanel heading={heading} tone="error" status>
          <p>{text}</p>
          {menu.code === "Unavailable" ? (
            <button type="button" onClick={() => setReload((value) => value + 1)}>
              Try again
            </button>
          ) : tableMode ? (
            <Link to="/operations/dining">Back to Tables</Link>
          ) : (
            <Link to="/app">Back to home</Link>
          )}
        </StatePanel>
      </WorkspacePage>
    );
  }

  const ordering = phase === "Building" || phase === "Sending";
  return (
    <WorkspacePage
      title={pageTitle}
      meta={
        tableMode
          ? `${storeLabel} · Dine-in · added to the table's order · paid on the store's card machine`
          : `${storeLabel} · Pickup · paid on the store's card machine`
      }
      className="counter-order"
    >
      <div className="counter-order__layout">
        <section className="counter-order__menu" aria-labelledby="counter-menu-heading">
          <h2 id="counter-menu-heading">Menu</h2>
          {menu.menu.sections.map((section) => (
            <section key={section.sectionReference} aria-label={section.name}>
              <h3>{section.name}</h3>
              <ul className="counter-order__items">
                {section.items.map((item) => (
                  <li key={item.sellableReference} data-available={item.available}>
                    <span className="counter-order__item-name">{item.name}</span>
                    <span className="counter-order__item-price">
                      {item.available
                        ? item.priceMinor === null
                          ? "Price at checkout"
                          : cad(item.priceMinor)
                        : "Sold out"}
                    </span>
                    <button
                      type="button"
                      disabled={!item.available || !ordering || item.priceMinor === null}
                      aria-label={`Add ${item.name}`}
                      onClick={() =>
                        setChoosing({ item, choices: defaultChoices(item), quantity: 1, note: "" })
                      }
                    >
                      Add
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </section>

        <section className="counter-order__ticket store-card" aria-labelledby="counter-ticket">
          <h2 id="counter-ticket">Order</h2>
          {choosing !== null ? (
            <form
              className="counter-order__choose"
              aria-label={`Choose ${choosing.item.name}`}
              onSubmit={(event) => {
                event.preventDefault();
                if (!choicesComplete(choosing.item, choosing.choices)) return;
                const options = choosing.item.rules.flatMap((rule) =>
                  (choosing.choices[rule.bindingReference] ?? []).map((reference) => {
                    const option = rule.options.find(
                      (candidate) => candidate.optionReference === reference,
                    );
                    return {
                      optionReference: reference,
                      name: option?.name ?? "",
                      quantity: option?.defaultQuantity ?? 1,
                    };
                  }),
                );
                changeLines([
                  ...lines,
                  {
                    key: serviceOperationReference(),
                    item: choosing.item,
                    quantity: choosing.quantity,
                    options,
                    note: tableMode && choosing.note.trim() !== "" ? choosing.note.trim() : null,
                  },
                ]);
                setChoosing(null);
              }}
            >
              <h3>{choosing.item.name}</h3>
              {choosing.item.rules.map((rule) => {
                const single = rule.maximumSelections === 1;
                const picked = choosing.choices[rule.bindingReference] ?? [];
                return (
                  <fieldset key={rule.bindingReference}>
                    <legend>
                      {rule.name}
                      {rule.minimumSelections > 0 ? " (required)" : ""}
                    </legend>
                    {rule.options.map((option) => (
                      <label key={option.optionReference}>
                        <input
                          type={single ? "radio" : "checkbox"}
                          name={rule.bindingReference}
                          checked={picked.includes(option.optionReference)}
                          disabled={
                            !single &&
                            !picked.includes(option.optionReference) &&
                            picked.length >= rule.maximumSelections
                          }
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setChoosing({
                              ...choosing,
                              choices: {
                                ...choosing.choices,
                                [rule.bindingReference]: single
                                  ? [option.optionReference]
                                  : checked
                                    ? [...picked, option.optionReference]
                                    : picked.filter((value) => value !== option.optionReference),
                              },
                            });
                          }}
                        />
                        {option.name}
                        {option.priceMinor !== null && option.priceMinor !== "0"
                          ? ` +${cad(option.priceMinor)}`
                          : ""}
                      </label>
                    ))}
                  </fieldset>
                );
              })}
              <label className="counter-order__quantity">
                Quantity
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={99}
                  value={choosing.quantity}
                  onChange={(event) =>
                    setChoosing({
                      ...choosing,
                      quantity: Math.min(99, Math.max(1, Number(event.currentTarget.value) || 1)),
                    })
                  }
                />
              </label>
              {tableMode ? (
                <label className="counter-order__note">
                  Note for the kitchen (optional)
                  <input
                    value={choosing.note}
                    maxLength={140}
                    autoComplete="off"
                    onChange={(event) =>
                      setChoosing({ ...choosing, note: event.currentTarget.value })
                    }
                  />
                </label>
              ) : null}
              <div className="card-actions">
                <button type="submit" disabled={!choicesComplete(choosing.item, choosing.choices)}>
                  Add to order
                </button>
                <button type="button" onClick={() => setChoosing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
          {lines.length === 0 ? (
            <p className="bop-muted">Add items from the menu.</p>
          ) : (
            <ul className="counter-order__lines" aria-label="Items in this order">
              {lines.map((line) => {
                const each = estimatedLineMinor(line);
                return (
                  <li key={line.key}>
                    <span>
                      {line.quantity} × {line.item.name}
                      {line.options.length > 0 ? (
                        <span className="bop-muted">
                          {" "}
                          · {line.options.map((option) => option.name).join(", ")}
                        </span>
                      ) : null}
                      {line.note ? <span className="bop-muted"> · Note: {line.note}</span> : null}
                    </span>
                    <span>{each === null ? "" : cad(each.toString())}</span>
                    {/* WP-2423 D5: once sent, an item is changed by cancelling it on the order. */}
                    {ordering ? (
                      <button
                        type="button"
                        disabled={phase !== "Building"}
                        aria-label={`Remove ${line.item.name}`}
                        onClick={() => changeLines(lines.filter((other) => other.key !== line.key))}
                      >
                        Remove
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {estimate !== null && lines.length > 0 ? (
            <p className="counter-order__estimate">
              About {cad(estimate.toString())} before tax and tip. The final total comes when you
              send the order.
            </p>
          ) : null}
          <fieldset className="counter-order__tip" disabled={!ordering}>
            <legend>Tip</legend>
            {(["0", "10", "15", "18"] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="counter-tip"
                  checked={tip === value}
                  onChange={() => {
                    placeOperation.current = null;
                    setTip(value);
                  }}
                />
                {value === "0" ? "No tip" : `${value}%`}
              </label>
            ))}
            <label>
              <input
                type="radio"
                name="counter-tip"
                checked={tip === "Custom"}
                onChange={() => {
                  placeOperation.current = null;
                  setTip("Custom");
                }}
              />
              Other amount
            </label>
            {tip === "Custom" ? (
              <label className="counter-order__custom-tip">
                Tip amount ($)
                <input
                  inputMode="decimal"
                  value={customTip}
                  aria-invalid={tipChoice() === null}
                  onChange={(event) => {
                    placeOperation.current = null;
                    setCustomTip(event.currentTarget.value);
                  }}
                />
              </label>
            ) : null}
          </fieldset>
          <fieldset className="counter-order__paper" disabled={!ordering}>
            <legend>Paper order</legend>
            <label>
              <input
                type="checkbox"
                checked={paper}
                onChange={(event) => {
                  placeOperation.current = null;
                  setPaper(event.currentTarget.checked);
                }}
              />
              Recorded after an outage (taken on paper)
            </label>
            {paper ? (
              <label>
                Paid at (store time, from the paper order)
                <input
                  type="datetime-local"
                  value={paidAt}
                  aria-invalid={paperInstant === null}
                  aria-describedby="counter-paper-hint"
                  onChange={(event) => {
                    placeOperation.current = null;
                    setPaidAt(event.currentTarget.value);
                  }}
                />
              </label>
            ) : null}
            {paper ? (
              <p id="counter-paper-hint" className="field-hint">
                Within the last 3 days. The order is marked &ldquo;Recorded after outage&rdquo; and
                its payment counts on the day it was paid.
              </p>
            ) : null}
          </fieldset>
          {tableMode && ordering ? (
            <p className="field-hint">
              Sending gives this order its own table code, so a table code you handed out that
              hasn&apos;t been used yet stops working. Guests already at the table stay joined.
            </p>
          ) : null}
          {problem !== null && ordering ? <p role="alert">{problem}</p> : null}
          {ordering ? (
            <div className="card-actions">
              <button
                type="button"
                className="counter-order__primary"
                disabled={!canSend}
                onClick={() => void send()}
              >
                {phase === "Sending" ? "Sending…" : "Send order"}
              </button>
            </div>
          ) : null}
        </section>

        {placed !== null && !ordering ? (
          <section
            className="counter-order__charge store-card"
            aria-labelledby="counter-charge"
            data-phase={phase}
          >
            <h2 id="counter-charge" ref={chargeHeading} tabIndex={-1}>
              {phase === "Paid" || phase === "Accepted"
                ? tableMode
                  ? `Table ${placed.tableLabel ?? tableLabel ?? ""} order paid`
                  : `Order ${placed.orderNumber} paid`
                : `Charge ${cad(placed.totalMinor)} on the card machine`}
            </h2>
            <dl>
              <div>
                <dt>Order</dt>
                <dd>{placed.orderNumber}</dd>
              </div>
              <div>
                <dt>Order total incl. tax</dt>
                <dd>{cad(placed.orderMinor)}</dd>
              </div>
              <div>
                <dt>Tip</dt>
                <dd>{cad(placed.tipMinor)}</dd>
              </div>
              <div>
                <dt>To charge</dt>
                <dd>
                  <strong>{cad(placed.totalMinor)}</strong>
                </dd>
              </div>
            </dl>
            {phase === "Charge" || phase === "Recording" ? (
              <>
                {(() => {
                  const notice = paymentWindowNotice({
                    payBy: placed.payBy,
                    now,
                    tableMode,
                    timeZone,
                  });
                  return (
                    <p
                      className="order-accept-by"
                      data-tier={notice.tier}
                      role={notice.tier === "urgent" ? "alert" : "note"}
                    >
                      {notice.text}
                    </p>
                  );
                })()}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void recordPayment(placed.totalMinor);
                  }}
                >
                  <label>
                    Slip reference (optional)
                    <input
                      value={slip}
                      maxLength={40}
                      autoComplete="off"
                      aria-invalid={!validSlipReference(slip.trim())}
                      aria-describedby="counter-slip-hint"
                      onChange={(event) => setSlip(event.currentTarget.value)}
                    />
                  </label>
                  <p id="counter-slip-hint" className="field-hint">
                    The approval or reference code on the card machine slip, to match the
                    machine&apos;s day total. Never the card number.
                  </p>
                  {placed.recordedAfterOutage ? (
                    <p role="note">
                      Paper order paid at{" "}
                      {paperInstant === null
                        ? "— set the time above"
                        : storeTime(paperInstant, timeZone, true)}
                      .
                    </p>
                  ) : null}
                  {problem !== null ? <p role="alert">{problem}</p> : null}
                  <div className="card-actions">
                    <button
                      type="submit"
                      className="counter-order__primary"
                      disabled={
                        phase === "Recording" ||
                        !validSlipReference(slip.trim()) ||
                        (placed.recordedAfterOutage && paperInstant === null)
                      }
                    >
                      {phase === "Recording"
                        ? "Recording…"
                        : `Paid on card machine · ${cad(placed.totalMinor)}`}
                    </button>
                  </div>
                </form>
                <p className="bop-muted">
                  {tableMode
                    ? `Card declined? Try another card. Nothing goes to the kitchen until this is recorded; after ${storeTime(placed.payBy, timeZone)} it can no longer be paid here and must be sent again.`
                    : `Card declined? Try another card. Not paying? Leave it: the order is released at ${storeTime(placed.payBy, timeZone)}.`}
                </p>
              </>
            ) : (
              <>
                <p role="status">{paidNote ?? "Paid on the card machine."}</p>
                <div className="card-actions">
                  <button type="button" onClick={startOver}>
                    {tableMode ? "Another order for this table" : "New counter order"}
                  </button>
                  {tableMode ? <Link to="/operations/dining">Back to Tables</Link> : null}
                  <Link to="/operations/orders">Open Orders</Link>
                </div>
              </>
            )}
          </section>
        ) : null}
      </div>
    </WorkspacePage>
  );
}
