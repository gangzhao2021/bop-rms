import { StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { validSlipReference } from "./CardMachineRefundAction.js";
import { createOrderAcceptanceClient } from "./order-acceptance-client.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import { storeTime } from "./StoreTime.js";
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
  Unavailable: [
    "The menu could not be loaded",
    "Check the connection and try again. If the system stays down, take the order on paper and record it here afterwards.",
  ],
};

function placeErrorText(error: CounterOrderClientError, lines: readonly Line[]) {
  switch (error.code) {
    case "ItemUnavailable": {
      const line = error.lineIndex === null ? undefined : lines[error.lineIndex];
      return line
        ? `${line.item.name} can't be sold right now (sold out or off the menu). Remove it and send again.`
        : "An item can't be sold right now. Check the order and send again.";
    }
    case "StoreNotTakingOrders":
      return "Pickup hours are over, so the counter can't take a new order now. A paper order taken earlier can still be entered under Paper order.";
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

function payErrorText(error: CounterOrderClientError) {
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

/** A local date-time input value ("2026-10-13T14:05") as an instant, or null. */
export function paidAtInstant(value: string, now = Date.now()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const at = new Date(value);
  const time = at.getTime();
  if (!Number.isFinite(time) || time > now || now - time > 72 * 60 * 60 * 1000) return null;
  return new Date(Math.floor(time / 1000) * 1000).toISOString();
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
  const [menu, setMenu] = useState<
    { kind: "Loading" } | { kind: "Error"; code: string } | { kind: "Ready"; menu: CounterMenu }
  >({ kind: "Loading" });
  const [reload, setReload] = useState(0);
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [choosing, setChoosing] = useState<{
    item: CounterMenuItem;
    choices: Record<string, string[]>;
    quantity: number;
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

  useEffect(() => {
    const controller = new AbortController();
    setMenu({ kind: "Loading" });
    client
      .loadMenu(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setMenu({ kind: "Ready", menu: value });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMenu({
          kind: "Error",
          code:
            error instanceof CounterOrderClientError && error.code === "PermissionDenied"
              ? "PermissionDenied"
              : "Unavailable",
        });
      });
    return () => controller.abort();
  }, [client, reload]);
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
  const paperInstant = paper ? paidAtInstant(paidAt) : null;
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
      const order = await client.placeOrder({
        operationReference: placeOperation.current,
        lines: lines.map((line) => ({
          sellableReference: line.item.sellableReference,
          quantity: line.quantity,
          optionSelections: line.options.map((option) => ({
            optionReference: option.optionReference,
            quantity: option.quantity,
          })),
        })),
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
      setProblem(placeErrorText(failure, lines));
      setPhase("Building");
    }
  };

  const recordPayment = async (expectedTotalMinor: string) => {
    if (placed === null || phase !== "Charge" || !validSlipReference(slip.trim())) return;
    if (placed.recordedAfterOutage && paperInstant === null) return;
    payOperation.current ??= serviceOperationReference();
    setPhase("Recording");
    setProblem(null);
    try {
      await client.recordPayment({
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
    setPhase("Paid");
    try {
      await createOrderAcceptanceClient(fetcher)
        .prepare({
          acceptanceReference: serviceOperationReference(),
          operationReference: serviceOperationReference(),
          orderReference: placed.orderReference,
          orderBatchReference: placed.orderBatchReference,
          expectedOrderVersion: placed.orderVersion,
        })
        .execute(csrf);
      setPhase("Accepted");
      // A paper order was usually made and handed over already; it still goes through the list so
      // its records close, and nothing expires or is refunded by mistake.
      setPaidNote(
        placed.recordedAfterOutage
          ? "Recorded after the outage and accepted. If it was already made and handed over, mark it ready in Kitchen and handed over in Pickup."
          : "Paid and sent to the kitchen.",
      );
    } catch {
      setPaidNote(
        "Paid. Accept it in Orders now: an order that isn't accepted in time expires and must be refunded on the card machine.",
      );
    }
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

  if (menu.kind === "Loading")
    return (
      <WorkspacePage title="Counter order" meta={storeLabel}>
        <StatePanel heading="Loading the menu" status>
          <p>Loading what the store sells now…</p>
        </StatePanel>
      </WorkspacePage>
    );
  if (menu.kind === "Error") {
    const [heading, text] = menuError[menu.code] ?? (menuError.Unavailable as [string, string]);
    return (
      <WorkspacePage title="Counter order" meta={storeLabel}>
        <StatePanel heading={heading} tone="error" status>
          <p>{text}</p>
          {menu.code === "Unavailable" ? (
            <button type="button" onClick={() => setReload((value) => value + 1)}>
              Try again
            </button>
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
      title="Counter order"
      meta={`${storeLabel} · Pickup · paid on the store's card machine`}
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
                        setChoosing({ item, choices: defaultChoices(item), quantity: 1 })
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
                    </span>
                    <span>{each === null ? "" : cad(each.toString())}</span>
                    <button
                      type="button"
                      disabled={!ordering}
                      aria-label={`Remove ${line.item.name}`}
                      onClick={() => changeLines(lines.filter((other) => other.key !== line.key))}
                    >
                      Remove
                    </button>
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
                ? `Order ${placed.orderNumber} paid`
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
                <p className="order-accept-by" data-tier="warning" role="note">
                  Record the payment by {storeTime(placed.payBy, timeZone)}. If it isn&apos;t paid
                  by then the order is released and its items go back to stock.
                </p>
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
                  Card declined? Try another card. Not paying? Leave it: the order is released at{" "}
                  {storeTime(placed.payBy, timeZone)}.
                </p>
              </>
            ) : (
              <>
                <p role="status">{paidNote ?? "Paid on the card machine."}</p>
                <div className="card-actions">
                  <button type="button" onClick={startOver}>
                    New counter order
                  </button>
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
