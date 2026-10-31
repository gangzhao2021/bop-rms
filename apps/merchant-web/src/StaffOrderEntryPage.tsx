import { t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { Link, useSearchParams } from "react-router";
import { createDiningSessionClient } from "./dining-session-client.js";
import { validSlipReference } from "./CardMachineRefundAction.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import { storeTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { CounterAwaitingPayment } from "./CounterAwaitingPayment.js";
import {
  paidAtInstant,
  payErrorText,
  paidNoteText,
  paymentUrgentMinutes,
  paymentWindowNotice,
} from "./counter-payment.js";
import {
  CounterOrderClientError,
  counterMenuFamilies,
  createCounterOrderClient,
  type CounterMenu,
  type CounterMenuItem,
  type CounterTip,
  type PlacedCounterOrder,
} from "./staff-order-entry.js";

export { paidAtInstant, payErrorText, paymentUrgentMinutes, paymentWindowNotice };

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
  PermissionDenied: [noAccessHeading, pageAccessDeniedText],
  TableUnavailable: [
    t("This table can't take an order now"),
    t("It may be marked unavailable or its session may be closing. Check it on the Tables page."),
  ],
  TableHasNoQr: [
    t("This table has no table QR code yet"),
    t(
      "Orders for a table use its code. Ask a manager to create one on the Table QR codes page, then take the order.",
    ),
  ],
  TableUnknown: [t("Table not found"), t("Open the table from the Tables page to take its order.")],
  Unavailable: [
    t("The menu could not be loaded"),
    t(
      "Check the connection and try again. If the system stays down, take the order on paper and record it here afterwards.",
    ),
  ],
};

export function placeErrorText(
  error: CounterOrderClientError,
  lines: readonly Line[],
  table: string | null = null,
  canCreateTableCode = false,
) {
  switch (error.code) {
    case "TableCartHasItems": {
      const value =
        error.pendingItems.length > 0
          ? ` (${error.pendingItems.map((item) => `${item.quantity} × ${item.name}`).join(", ")})`
          : "";
      // WP-2423 item 8 ⑦ (v15 finding t): staff add them to this round; asking the guests only
      // while they can still send (not after last orders).
      if (error.tableCart !== null)
        return error.tableCart.guestsCanSend
          ? t(
              "Guests at this table have items in their shared cart that haven't been sent{value}. Add them to this round, or ask the guests to send or remove them on their phone.",
              { value },
            )
          : t(
              "Guests at this table have items in their shared cart that haven't been sent{value}, and guests can no longer send them after last orders. Add them to this round to order them.",
              { value },
            );
      return t(
        "Guests at this table have items in their shared cart that haven't been sent{value}. Ask them to send or remove those items on their phone, then send this order again.",
        { value },
      );
    }
    case "TableCheckoutInProgress":
      return t(
        "A guest at this table is paying on their phone right now. Wait a minute, then send again.",
      );
    case "TableUnavailable":
      return t(
        "{value} can't take an order now (marked unavailable, or its session is closing). Check the table on the Tables page.",
        { value: table ?? "This table" },
      );
    case "TableHasNoQr":
      return t(
        "{value} has no table QR code, so orders can't be taken for it yet. Nothing was sent or charged. {value2}",
        {
          value: table ?? "This table",
          value2: canCreateTableCode
            ? "Create one on Table QR codes (it can be printed later), then send the order again."
            : "Ask a manager to create one on the Table QR codes page, then send the order again.",
        },
      );
    case "ItemUnavailable": {
      const line = error.lineIndex === null ? undefined : lines[error.lineIndex];
      // WP-2423: each item could be made on its own, but not together (they share an ingredient).
      if (line && error.sharedStock)
        return t(
          "There isn't enough left to make {name} with the rest of this order (other items use the same ingredients). Remove {name2} or change the other items, then send again. Nothing was sent or charged.",
          { name: line.item.name, name2: line.item.name },
        );
      return line
        ? t(
            "{name} can't be sold right now (sold out or off the menu). Remove it and send again. Nothing was sent or charged.",
            { name: line.item.name },
          )
        : t(
            "An item can't be sold right now (it may have just sold out). Check the order and send again. Nothing was sent or charged.",
          );
    }
    case "ItemShort": {
      // v15 run: name the short item and how many are left; the order stays as entered.
      const line = error.lineIndex === null ? undefined : lines[error.lineIndex];
      const left = error.available ?? 0;
      if (line === undefined)
        return t(
          "An item has only {left} left. Remove it and add {left2} back, then send again. Nothing was sent or charged.",
          { left: left, left2: left },
        );
      // WP-2423: short only because other items in the order use the same ingredients.
      if (error.sharedStock)
        return t(
          "Only {left} {name} can be made with the rest of this order (other items use the same ingredients). Lower {name2} to {left2} or change the other items, then send again. Nothing was sent or charged.",
          { left: left, name: line.item.name, name2: line.item.name, left2: left },
        );
      const options = (entry: Line) =>
        JSON.stringify(
          entry.options.map((option) => [option.optionReference, option.quantity]).sort(),
        );
      const ordered = lines
        .filter(
          (other) =>
            other.item.sellableReference === line.item.sellableReference &&
            options(other) === options(line),
        )
        .reduce((sum, other) => sum + other.quantity, 0);
      return t(
        "Only {left} {name} left, {ordered} in this order. Remove {name2} and add {left2} back, then send again. Nothing was sent or charged.",
        { left: left, name: line.item.name, ordered: ordered, name2: line.item.name, left2: left },
      );
    }
    case "StoreNotTakingOrders":
      return table !== null
        ? t(
            "The store is closed, so no new table orders can be taken now. A paper order taken earlier can still be entered under Paper order.",
          )
        : t(
            "Pickup hours are over, so the counter can't take a new order now. A paper order taken earlier can still be entered under Paper order.",
          );
    case "TipsOff":
      return t(
        "Tips are turned off for this store, so nothing was sent or charged. Send it again with no tip.",
      );
    case "TipChoicesChanged":
      return t(
        "The store's tip choices just changed, so nothing was sent or charged. Choose the tip again and send.",
      );
    case "CounterOrderingOff":
      return t(
        "Counter ordering is turned off for this store, so nothing was sent or charged. The owner can turn it back on in Store features.",
      );
    case "NotPriced":
      return t("This order could not be priced. Check the items and options and send again.");
    case "NotFinished":
      return t("This order didn't go through and nothing was charged. Send it again.");
    case "InProgress":
      return t("This order is still being sent. Wait a moment, then send again to see it.");
    case "PermissionDenied":
      return t("Your session can't take counter orders. Sign in again or ask a manager.");
    case "OutcomeUnknown":
      return t("No answer from the system. Send again — the same order is never created twice.");
    case "NoPickupTimes":
      return t(
        "Pickup times have run out in the system, so no pickup order can be entered right now. Nothing was sent or charged. Take this order on paper and charge it on the card machine, then enter it under Paper order once pickup times are back. Tell a manager — Home shows the alert.",
      );
    case "SystemProblem":
      return table !== null
        ? t(
            "The system couldn't send this round for {table} (a problem on our side, not with the order). Nothing was sent to the kitchen or charged. Send it once more. If it fails again, take the order on paper, charge it on the card machine and enter it under Paper order later. Home shows any alert.",
            { table: table },
          )
        : t(
            "The system couldn't place this order (a problem on our side, not with the order). Nothing was charged. Send it once more. If it fails again, take the order on paper, charge it on the card machine and enter it under Paper order later. Home shows any alert.",
          );
    default:
      // WP-2423: e.g. no order can be priced right now; Home shows the alert and what to do.
      return t(
        "The order could not be sent. Check the order and try again. If it keeps failing, check Home for an alert and take the order on paper.",
      );
  }
}

/** v15 run: how often the counter menu re-reads what the store can sell while staff build an order. */
export const MENU_REFRESH_MS = 30_000;

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
  tableQrHref,
  fetcher,
}: {
  readonly storeLabel: string;
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  /** Where staff who can create table QR codes do so (same rule as the Tables page), if allowed. */
  readonly tableQrHref?: string | undefined;
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
  // DEC-DINE-IN-PAY-LATER: the table pays once at the end — no tip and no charge per round.
  const [tablePaysLater, setTablePaysLater] = useState(false);
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
  // "0": no tip; a percentage the Store offers, as text; or an amount typed in.
  const [tip, setTip] = useState<string>("0");
  const [customTip, setCustomTip] = useState("");
  const [paper, setPaper] = useState(false);
  const [paidAt, setPaidAt] = useState("");
  const [slip, setSlip] = useState("");
  const [placed, setPlaced] = useState<PlacedCounterOrder | null>(null);
  const [phase, setPhase] = useState<
    "Building" | "Sending" | "Charge" | "Recording" | "Paid" | "Accepted" | "Sent"
  >("Building");
  const [problem, setProblem] = useState<string | null>(null);
  const [problemNeedsTableCode, setProblemNeedsTableCode] = useState(false);
  // WP-2423 item 8 ⑦: the guests' unsent items the server named, to add to this round.
  const [tableCartOffer, setTableCartOffer] = useState<number | null>(null);
  const [paidNote, setPaidNote] = useState<string | null>(null);
  // WP-2423 (v15 751dd768): re-read the sent, unpaid counter orders after a send or a payment.
  const [awaitingKey, setAwaitingKey] = useState(0);
  const placeOperation = useRef<string | null>(null);
  const payOperation = useRef<string | null>(null);
  const chargeHeading = useRef<HTMLHeadingElement>(null);
  const ticketHeading = useRef<HTMLHeadingElement>(null);
  const chooseHeading = useRef<HTMLHeadingElement>(null);
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
          if (found.qrCodeValidUntil === null) throw new CounterOrderClientError("TableHasNoQr");
          setTableLabel(found.stableLabel);
          setTablePaysLater(found.paymentTiming === "PayLater");
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
            (error.code === "PermissionDenied" ||
              error.code === "TableUnavailable" ||
              error.code === "TableHasNoQr")
              ? error.code
              : "Unavailable",
        });
      });
    return () => controller.abort();
  }, [client, reload, csrf, fetcher, tableMode, tableReference]);
  useEffect(() => {
    if (phase === "Charge" || phase === "Sent") chargeHeading.current?.focus();
  }, [phase]);
  // The item's options open beside the menu (a sheet on a phone); move focus there.
  const choosingItem = choosing?.item.sellableReference ?? null;
  useEffect(() => {
    if (choosingItem !== null) chooseHeading.current?.focus();
  }, [choosingItem]);

  // v15 run: what the store can sell changes with every order (stock used, items sold out), so
  // the menu is re-read quietly after each send or payment, every 30 s while staff build an
  // order, and when the screen comes back into view. A failed re-read keeps the last menu (the
  // server still refuses an item that ran out, naming it); it never blanks the order in progress.
  const menuRefresh = useRef<AbortController | null>(null);
  const refreshMenu = useCallback(() => {
    menuRefresh.current?.abort();
    const controller = new AbortController();
    menuRefresh.current = controller;
    client
      .loadMenu(controller.signal, tableMode ? "DineIn" : "Pickup")
      .then((value) => {
        if (!controller.signal.aborted)
          setMenu((current) =>
            current.kind === "Ready" ? { kind: "Ready", menu: value } : current,
          );
      })
      .catch(() => undefined);
  }, [client, tableMode]);
  useEffect(() => () => menuRefresh.current?.abort(), []);
  const menuReady = menu.kind === "Ready";
  // v15 cbff9d6f: no menu re-reads once this screen's sign-in has ended.
  const live = useStaffSessionLive();
  useEffect(() => {
    if (!menuReady || !live || phase !== "Building") return;
    const timer = setInterval(refreshMenu, MENU_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshMenu();
    };
    window.addEventListener("focus", refreshMenu);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshMenu);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, menuReady, phase, refreshMenu]);

  // Any change to what is ordered is a new order intent.
  const changeLines = (next: readonly Line[]) => {
    placeOperation.current = null;
    setProblem(null);
    setProblemNeedsTableCode(false);
    setLines(next);
  };
  const itemPrice = (item: CounterMenuItem) =>
    item.available
      ? item.priceMinor === null
        ? t("Price at checkout")
        : cad(item.priceMinor)
      : t("Sold out");
  const canAdd = (item: CounterMenuItem) => item.available && ordering && item.priceMinor !== null;
  // At the counter an item with nothing to choose goes straight onto the order (one more of the
  // same line); one with options, or any item for a table (its line can carry a note for the
  // kitchen), opens its choices first, as before.
  const add = (item: CounterMenuItem) => {
    if (item.rules.length > 0 || tableMode) {
      setChoosing({ item, choices: defaultChoices(item), quantity: 1, note: "" });
      return;
    }
    const same = lines.find(
      (line) =>
        line.item.sellableReference === item.sellableReference &&
        line.options.length === 0 &&
        (line.note ?? null) === null,
    );
    changeLines(
      same
        ? lines.map((line) =>
            line.key === same.key ? { ...line, quantity: line.quantity + 1 } : line,
          )
        : [
            ...lines,
            { key: serviceOperationReference(), item, quantity: 1, options: [], note: null },
          ],
    );
  };
  // WP-2423 item 8 ⑦ (Owner decision 11): the Store's own percentages; with tips off, no tip.
  const tips = menu.kind === "Ready" ? menu.menu.tips : null;
  const tipOptions = tips === null || !tips.enabled ? [] : ["0", ...tips.tierPercents.map(String)];
  useEffect(() => {
    if (tip !== "Custom" && tip !== "0" && tips !== null && !tipOptions.includes(tip)) setTip("0");
  }, [tip, tips, tipOptions]);
  const tipChoice = (): CounterTip | null => {
    if (tip === "0" || tablePaysLater || tips?.enabled === false) return { kind: "None" };
    if (tip !== "Custom") return { kind: "Percent", percent: Number(tip) };
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
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const canSend =
    phase === "Building" &&
    lines.length > 0 &&
    tipChoice() !== null &&
    (!paper || tablePaysLater || paperInstant !== null);

  const send = async (includeTableCart: number | null = null) => {
    const chosenTip = tipChoice();
    if (!canSend || chosenTip === null) return;
    placeOperation.current ??= serviceOperationReference();
    setPhase("Sending");
    setProblem(null);
    setProblemNeedsTableCode(false);
    setTableCartOffer(null);
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
              ...(includeTableCart === null
                ? {}
                : { includeTableCart: { expectedCartVersion: includeTableCart } }),
            })
          : await client.placeOrder({
              operationReference: placeOperation.current,
              lines: chosen,
              tip: chosenTip,
              recordedAfterOutage: paper,
            });
      setPlaced(order);
      payOperation.current = null;
      setPhase(order.payLater ? "Sent" : "Charge");
      setAwaitingKey((value) => value + 1);
      refreshMenu();
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
        placeErrorText(
          failure,
          lines,
          tableLabel === null ? null : t("Table {tableLabel}", { tableLabel: tableLabel }),
          tableQrHref !== undefined,
        ),
      );
      setProblemNeedsTableCode(failure.code === "TableHasNoQr");
      setTableCartOffer(
        failure.code === "TableCartHasItems" && failure.tableCart !== null
          ? failure.tableCart.cartVersion
          : null,
      );
      if (
        failure.code === "ItemUnavailable" ||
        failure.code === "ItemShort" ||
        failure.code === "TipsOff" ||
        failure.code === "TipChoicesChanged"
      )
        refreshMenu();
      setPhase("Building");
    }
  };

  const recordPayment = async (expectedTotalMinor: string) => {
    if (placed === null || phase !== "Charge" || !validSlipReference(slip.trim())) return;
    if (placed.recordedAfterOutage && paperInstant === null) return;
    payOperation.current ??= serviceOperationReference();
    setPhase("Recording");
    setProblem(null);
    setProblemNeedsTableCode(false);
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
    refreshMenu();
    setAwaitingKey((value) => value + 1);
    // WP-2423 D1: the server accepts the paid order or round with the payment record (at the
    // Order's current version), so it reaches the kitchen even if this page is closed now.
    setPhase(recorded.acceptance === "Accepted" ? "Accepted" : "Paid");
    setPaidNote(
      paidNoteText({
        tableMode,
        recordedAfterOutage: placed.recordedAfterOutage,
        acceptance: recorded.acceptance,
      }),
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
    setProblemNeedsTableCode(false);
    setPaidNote(null);
    placeOperation.current = null;
    payOperation.current = null;
    setPhase("Building");
  };

  const pageTitle = tableMode
    ? tableLabel === null
      ? t("Table order")
      : t("Table {tableLabel} order", { tableLabel: tableLabel })
    : t("Counter order");
  if (menu.kind === "Loading")
    return (
      <WorkspacePage title={pageTitle} meta={storeLabel}>
        <StatePanel heading={t("Loading the menu")} status>
          <p>{t("Loading what the store sells now…")}</p>
        </StatePanel>
      </WorkspacePage>
    );
  if (menu.kind === "Error") {
    const [heading, text] = menuError[menu.code] ?? (menuError.Unavailable as [string, string]);
    const createCode = menu.code === "TableHasNoQr" ? tableQrHref : undefined;
    return (
      <WorkspacePage title={pageTitle} meta={storeLabel}>
        <StatePanel heading={heading} tone="error" status>
          {createCode ? (
            // Same rule as the Tables page: staff who can create codes get the link.
            <p>
              {t("Orders for a table use its code. Create one on")}{" "}
              <Link to={createCode}>{t("Table QR codes")}</Link>{" "}
              {t("(it can be printed later), then take the order.")}
            </p>
          ) : (
            <p>{text}</p>
          )}
          {menu.code === "Unavailable" ? (
            <button type="button" onClick={() => setReload((value) => value + 1)}>
              {t("Try again")}
            </button>
          ) : tableMode ? (
            <Link to="/operations/dining">{t("Back to Tables")}</Link>
          ) : (
            <Link to="/app">{t("Back to home")}</Link>
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
          ? tablePaysLater
            ? t("{store} · Dine-in · added to the table's bill · the table pays at the end", {
                store: storeLabel,
              })
            : t(
                "{store} · Dine-in · added to the table's order · paid on the store's card machine",
                {
                  store: storeLabel,
                },
              )
          : t("{store} · Pickup · paid on the store's card machine", { store: storeLabel })
      }
      className="counter-order"
    >
      {/* WP-2423 (v15 751dd768): sent counter orders not paid yet, from the server. */}
      {tableMode ? null : (
        <CounterAwaitingPayment
          csrf={csrf}
          timeZone={timeZone}
          fetcher={fetcher}
          refreshKey={awaitingKey}
          excludeOrderReference={
            placed !== null && (phase === "Charge" || phase === "Recording")
              ? placed.orderReference
              : null
          }
        />
      )}
      <div className="counter-order__layout">
        <section className="counter-order__menu" aria-labelledby="counter-menu-heading">
          <h2 id="counter-menu-heading">{t("Menu")}</h2>
          {menu.menu.sections.length > 1 ? (
            // Square/Toast-style category jump bar: stays at the top while the menu scrolls.
            <nav className="counter-order__categories" aria-label={t("Menu categories")}>
              {menu.menu.sections.map((section) => (
                <button
                  key={section.sectionReference}
                  type="button"
                  onClick={() =>
                    document
                      .getElementById(
                        t("counter-section-{sectionReference}", {
                          sectionReference: section.sectionReference,
                        }),
                      )
                      ?.scrollIntoView({ block: "start" })
                  }
                >
                  {section.name}
                </button>
              ))}
            </nav>
          ) : null}
          {menu.menu.sections.length === 0 ? (
            <p className="counter-order__menu-empty">
              {t(
                "Nothing is on the menu right now. Check the menu's hours and items on the Menus page.",
              )}
            </p>
          ) : null}
          {menu.menu.sections.map((section) => (
            <section
              key={section.sectionReference}
              id={`counter-section-${section.sectionReference}`}
              className="counter-order__section"
              aria-label={section.name}
            >
              <h3>{section.name}</h3>
              <ul className="counter-order__items">
                {counterMenuFamilies(section.items).map((family) => {
                  const single = family.sizes.length === 1 ? family.sizes[0]?.item : undefined;
                  if (single !== undefined)
                    return (
                      <li key={family.key} data-available={single.available}>
                        <span className="counter-order__item-name">{single.name}</span>
                        <span className="counter-order__item-price">{itemPrice(single)}</span>
                        {/* The Add button covers the whole tile (CSS), so the tile is the tap target. */}
                        <button
                          type="button"
                          disabled={!canAdd(single)}
                          aria-label={t("Add {name}", { name: single.name })}
                          onClick={() => add(single)}
                        >
                          {t("Add")}
                        </button>
                      </li>
                    );
                  // Owner 2026-10-26: one tile per drink; a tap on a size adds that size.
                  return (
                    <li
                      key={family.key}
                      className="counter-order__family"
                      data-available={family.sizes.some((size) => size.item.available)}
                    >
                      <span className="counter-order__item-name">{family.name}</span>
                      <span className="counter-order__sizes" role="group" aria-label={family.name}>
                        {family.sizes.map((size) => (
                          <button
                            key={size.item.sellableReference}
                            type="button"
                            disabled={!canAdd(size.item)}
                            aria-label={t("Add {name}", { name: size.item.name })}
                            data-available={size.item.available}
                            onClick={() => add(size.item)}
                          >
                            <span>{size.label}</span>
                            <span className="counter-order__item-price">
                              {itemPrice(size.item)}
                            </span>
                          </button>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </section>

        <section
          id="counter-order-ticket"
          className="counter-order__ticket store-card"
          aria-labelledby="counter-ticket"
        >
          <header className="counter-order__ticket-header">
            <h2 id="counter-ticket" ref={ticketHeading} tabIndex={-1}>
              {t("Order")}
            </h2>
            {itemCount > 0 ? (
              <span className="counter-order__count">
                {itemCount === 1 ? t("1 item") : t("{itemCount} items", { itemCount: itemCount })}
              </span>
            ) : null}
          </header>
          {choosing !== null ? (
            <form
              className="counter-order__choose"
              aria-label={t("Choose {name}", { name: choosing.item.name })}
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
              <h3 ref={chooseHeading} tabIndex={-1}>
                {choosing.item.name}
              </h3>
              {choosing.item.rules.map((rule) => {
                const single = rule.maximumSelections === 1;
                const picked = choosing.choices[rule.bindingReference] ?? [];
                return (
                  <fieldset key={rule.bindingReference}>
                    <legend>
                      {rule.name}
                      {rule.minimumSelections > 0 ? t(" (required)") : ""}
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
                {t("Quantity")}
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
                  {t("Note for the kitchen (optional)")}
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
                  {t("Add to order")}
                </button>
                <button type="button" onClick={() => setChoosing(null)}>
                  {t("Cancel")}
                </button>
              </div>
            </form>
          ) : null}
          {lines.length === 0 ? (
            <div className="counter-order__empty">
              <p className="counter-order__empty-title">{t("No items yet")}</p>
              <p className="bop-muted">{t("Add items from the menu.")}</p>
            </div>
          ) : (
            <ul className="counter-order__lines" aria-label={t("Items in this order")}>
              {lines.map((line) => {
                const each = estimatedLineMinor(line);
                const setQuantity = (quantity: number) =>
                  changeLines(
                    lines.map((other) => (other.key === line.key ? { ...other, quantity } : other)),
                  );
                return (
                  <li key={line.key}>
                    <span className="counter-order__line-name">
                      {line.quantity} × {line.item.name}
                      {line.options.length > 0 ? (
                        <span className="bop-muted">
                          {" "}
                          · {line.options.map((option) => option.name).join(", ")}
                        </span>
                      ) : null}
                      {line.note ? (
                        <span className="bop-muted">
                          {" "}
                          {t("· Note: {note}", { note: line.note })}
                        </span>
                      ) : null}
                    </span>
                    <span className="counter-order__line-price">
                      {each === null ? "" : cad(each.toString())}
                    </span>
                    {/* WP-2423 D5: once sent, an item is changed by cancelling it on the order. */}
                    {ordering ? (
                      <span className="counter-order__line-actions">
                        <button
                          type="button"
                          className="counter-order__step"
                          disabled={phase !== "Building" || line.quantity <= 1}
                          aria-label={t("One less {name}", { name: line.item.name })}
                          onClick={() => setQuantity(line.quantity - 1)}
                        >
                          −
                        </button>
                        <button
                          type="button"
                          className="counter-order__step"
                          disabled={phase !== "Building" || line.quantity >= 99}
                          aria-label={t("One more {name}", { name: line.item.name })}
                          onClick={() => setQuantity(line.quantity + 1)}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          className="counter-order__remove"
                          disabled={phase !== "Building"}
                          aria-label={t("Remove {name}", { name: line.item.name })}
                          onClick={() =>
                            changeLines(lines.filter((other) => other.key !== line.key))
                          }
                        >
                          {t("Remove")}
                        </button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {estimate !== null && lines.length > 0 ? (
            <div className="counter-order__totals">
              <p className="counter-order__subtotal">
                <span>{t("Subtotal")}</span>
                <span>{cad(estimate.toString())}</span>
              </p>
              <p className="counter-order__estimate">
                {placed !== null && !ordering
                  ? placed.payLater
                    ? t("Sent to the kitchen. {totalMinor} with tax goes on the table's bill.", {
                        totalMinor: cad(placed.totalMinor),
                      })
                    : phase === "Paid" || phase === "Accepted"
                      ? t("Sent and paid: {totalMinor} with tax and tip.", {
                          totalMinor: cad(placed.totalMinor),
                        })
                      : t("Sent. Charge {totalMinor} with tax and tip on the card machine.", {
                          totalMinor: cad(placed.totalMinor),
                        })
                  : tablePaysLater
                    ? t(
                        "About {value} before tax. It goes on the table's bill; the table pays once at the end.",
                        { value: cad(estimate.toString()) },
                      )
                    : t(
                        "About {value} before tax and tip. The final total comes when you send the order.",
                        { value: cad(estimate.toString()) },
                      )}
              </p>
            </div>
          ) : null}
          {tablePaysLater || tipOptions.length === 0 ? null : (
            <fieldset className="counter-order__tip" disabled={!ordering}>
              <legend>{t("Tip")}</legend>
              {tipOptions.map((value) => (
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
                  {value === "0" ? t("No tip") : `${value}%`}
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
                {t("Other amount")}
              </label>
              {tip === "Custom" ? (
                <label className="counter-order__custom-tip">
                  {t("Tip amount ($)")}
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
          )}
          <fieldset className="counter-order__paper" disabled={!ordering}>
            <legend>{t("Paper order")}</legend>
            <label>
              <input
                type="checkbox"
                checked={paper}
                onChange={(event) => {
                  placeOperation.current = null;
                  setPaper(event.currentTarget.checked);
                }}
              />
              {t("Recorded after an outage (taken on paper)")}
            </label>
            {paper && !tablePaysLater ? (
              <label>
                {t("Paid at (store time, from the paper order)")}
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
            {paper && !tablePaysLater ? (
              <p id="counter-paper-hint" className="field-hint">
                {t(
                  "Within the last 3 days. The order is marked “Recorded after outage” and its payment counts on the day it was paid.",
                )}
              </p>
            ) : null}
          </fieldset>
          {tableMode && ordering ? (
            <p className="field-hint">
              {t(
                "Sending gives this order its own table code, so a table code you handed out that hasn't been used yet stops working. Guests already at the table stay joined.",
              )}
            </p>
          ) : null}
          {problem !== null && ordering ? <p role="alert">{problem}</p> : null}
          {problem !== null && ordering && tableCartOffer !== null ? (
            <p>
              <button
                type="button"
                className="counter-order__primary"
                disabled={!canSend}
                onClick={() => void send(tableCartOffer)}
              >
                {t("Add them to this round")}
              </button>
            </p>
          ) : null}
          {problem !== null && ordering && problemNeedsTableCode && tableQrHref !== undefined ? (
            <p>
              <Link to={tableQrHref}>{t("Table QR codes")}</Link>
            </p>
          ) : null}
          {ordering ? (
            <div className="card-actions counter-order__send">
              <button
                type="button"
                className="counter-order__primary"
                disabled={!canSend}
                onClick={() => void send()}
              >
                {phase === "Sending" ? t("Sending…") : t("Send order")}
              </button>
            </div>
          ) : null}
        </section>

        {ordering && lines.length > 0 ? (
          // Phone layout only (CSS): the ticket sits below the menu, so a bottom bar keeps the
          // order's count and estimate in view and takes staff to it to send.
          <div className="counter-order__summary-bar">
            <span className="counter-order__summary-text">
              <span>
                {itemCount === 1 ? t("1 item") : t("{itemCount} items", { itemCount: itemCount })}
              </span>
              {estimate !== null ? <strong>{cad(estimate.toString())}</strong> : null}
            </span>
            <button
              type="button"
              className="counter-order__primary"
              onClick={() => {
                document
                  .getElementById("counter-order-ticket")
                  ?.scrollIntoView({ block: "start", behavior: "smooth" });
                ticketHeading.current?.focus({ preventScroll: true });
              }}
            >
              {t("View order")}
            </button>
          </div>
        ) : null}

        {placed !== null && !ordering && placed.payLater ? (
          <section
            className="counter-order__charge store-card"
            aria-labelledby="counter-charge"
            data-phase={phase}
          >
            <h2 id="counter-charge" ref={chargeHeading} tabIndex={-1}>
              {t("Table {value} round sent to the kitchen", {
                value: placed.tableLabel ?? tableLabel ?? "",
              })}
            </h2>
            <dl>
              <div>
                <dt>{t("Order")}</dt>
                <dd>{placed.orderNumber}</dd>
              </div>
              <div>
                <dt>{t("Round total incl. tax")}</dt>
                <dd>
                  <strong>{cad(placed.orderMinor)}</strong>
                </dd>
              </div>
            </dl>
            <p role="status">
              {t(
                "Nothing to charge now. The round is on the table's bill; the table pays once at the end, tip included.",
              )}
            </p>
            <div className="card-actions">
              <button type="button" onClick={startOver}>
                {t("Another order for this table")}
              </button>
              <Link to="/operations/dining">{t("Back to Tables")}</Link>
              <Link to="/operations/orders">{t("Open Orders")}</Link>
            </div>
          </section>
        ) : placed !== null && !ordering ? (
          <section
            className="counter-order__charge store-card"
            aria-labelledby="counter-charge"
            data-phase={phase}
          >
            <h2 id="counter-charge" ref={chargeHeading} tabIndex={-1}>
              {phase === "Paid" || phase === "Accepted"
                ? tableMode
                  ? t("Table {value} order paid", { value: placed.tableLabel ?? tableLabel ?? "" })
                  : t("Order {orderNumber} paid", { orderNumber: placed.orderNumber })
                : t("Charge {totalMinor} on the card machine", {
                    totalMinor: cad(placed.totalMinor),
                  })}
            </h2>
            <dl>
              <div>
                <dt>{t("Order")}</dt>
                <dd>{placed.orderNumber}</dd>
              </div>
              <div>
                <dt>{t("Order total incl. tax")}</dt>
                <dd>{cad(placed.orderMinor)}</dd>
              </div>
              <div>
                <dt>{t("Tip")}</dt>
                <dd>{cad(placed.tipMinor)}</dd>
              </div>
              <div>
                <dt>{t("To charge")}</dt>
                <dd>
                  <strong>{cad(placed.totalMinor)}</strong>
                </dd>
              </div>
            </dl>
            {phase === "Charge" || phase === "Recording" ? (
              <>
                {(() => {
                  const notice = paymentWindowNotice({
                    payBy: placed.payBy ?? "",
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
                    {t("Slip reference (optional)")}
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
                    {t(
                      "The approval or reference code on the card machine slip, to match the machine's day total. Never the card number.",
                    )}
                  </p>
                  {placed.recordedAfterOutage ? (
                    <p role="note">
                      {t("Paper order paid at {value}.", {
                        value:
                          paperInstant === null
                            ? t("— set the time above")
                            : storeTime(paperInstant, timeZone, true),
                      })}
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
                        ? t("Recording…")
                        : t("Paid on card machine · {totalMinor}", {
                            totalMinor: cad(placed.totalMinor),
                          })}
                    </button>
                  </div>
                </form>
                <p className="bop-muted">
                  {tableMode
                    ? t(
                        "Card declined? Try another card. Nothing goes to the kitchen until this is recorded; after {payBy} it can no longer be paid here and must be sent again.",
                        { payBy: storeTime(placed.payBy ?? "", timeZone) },
                      )
                    : t(
                        "Card declined? Try another card. Not paying? Leave it: the order is released at {payBy}.",
                        { payBy: storeTime(placed.payBy ?? "", timeZone) },
                      )}
                </p>
              </>
            ) : (
              <>
                <p role="status">{paidNote ?? t("Paid on the card machine.")}</p>
                <div className="card-actions">
                  <button type="button" onClick={startOver}>
                    {tableMode ? t("Another order for this table") : t("New counter order")}
                  </button>
                  {tableMode ? <Link to="/operations/dining">{t("Back to Tables")}</Link> : null}
                  <Link to="/operations/orders">{t("Open Orders")}</Link>
                </div>
              </>
            )}
          </section>
        ) : null}
      </div>
    </WorkspacePage>
  );
}
