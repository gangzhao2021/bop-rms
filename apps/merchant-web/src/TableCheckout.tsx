import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { SlowWaitNotice } from "./slow-wait.js";
import { t, saidTable } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createDiningSessionCloseClient,
  DiningSessionCloseClientError,
} from "./dining-session-close-client.js";
import { createDiningProgressClient } from "./dining-progress-client.js";
import { paidAtDayNote, paidAtInstant } from "./counter-payment.js";
import { storeTime } from "./StoreTime.js";
import {
  cashTotalMinor,
  createTableCheckoutClient,
  TableCheckoutError,
  type TableBill,
} from "./table-checkout-client.js";
import type { StaffDiningTable, StaffDiningTableSession } from "./dining-session-client.js";
import { compedText } from "./ItemCompAction.js";
import { TableHeldRounds } from "./TablePhones.js";
import { TableSplitControls } from "./TableSplit.js";
import { notConfirmedPressAgainText, paymentNotConfirmedText } from "./failure-words.js";
import { printRegion } from "./print-region.js";

const cad = (minor: string | bigint) =>
  orderMoney({ amountMinor: String(minor), currencyCode: "CAD" });
/** "0": no tip; one of the Store's percentages, as text; or an amount typed in. */
type Tip = string;
/** "12.50" → 1250; null when it isn't an amount of money. */

export function dollarsToMinor(value: string): bigint | null {
  const match = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]{1,2}))?$/u.exec(value.trim());
  if (!match) return null;
  return BigInt(match[1] as string) * 100n + BigInt((match[2] ?? "0").padEnd(2, "0"));
}

/** No answer, or a server failure: it may have been recorded, so the same operation goes again. */
function outcomeUnknown(error: unknown): boolean {
  return (
    error instanceof TableCheckoutError &&
    (error.code === "OutcomeUnknown" || error.code === "ServerProblem")
  );
}

/**
 * v15 2026-11-11: the longest one read of the bill may take before it is given up. A busy evening's
 * merged-table read took 7–8 s; a read still open after this is treated as lost.
 */
export const billReadCeilingMs = 25_000;

/**
 * v15 batch 11 review: the longest staff wait for the answer to stopping a phone payment. The stop
 * asks the payment company first (up to about 19 s on a loaded v15 host); a stop still unanswered
 * after this (Wi-Fi dropped mid-request) is given up as not known, and the bill is read again.
 */
export const stopPhoneCeilingMs = 30_000;

/** The stop of a phone payment had no answer within its ceiling. */
class StopNotAnswered extends Error {}

function errorText(error: unknown): string {
  const code =
    error instanceof TableCheckoutError
      ? error.code
      : error instanceof DiningSessionCloseClientError
        ? error.code === "Conflict" || error.code === "NotReady"
          ? "SessionChanged"
          : error.code === "Unavailable"
            ? "Unavailable"
            : error.code
        : "OutcomeUnknown";
  switch (code) {
    case "PermissionDenied":
      return t("Your access doesn't allow this. Ask an Owner or Store Manager.");
    case "NotStarted":
      return t("Start checkout first, so no more rounds are sent from this table.");
    case "NothingOwed":
      return t("This table owes nothing.");
    case "TipsOff":
      return t(
        "Tips are turned off for this store, so nothing was recorded. The bill has been read again: take the payment with no tip.",
      );
    case "TipChoicesChanged":
      return t(
        "The store's tip choices just changed, so nothing was recorded. The bill has been read again: choose the tip again.",
      );
    case "BillChanged":
      return t(
        "The bill changed (a round is still being sent, or something was changed). It has been read again: check it and try again.",
      );
    case "RoundsWaiting":
      return t(
        "A round is waiting for your OK and is not on this bill, so nothing was recorded. Send it to the kitchen or cancel it first. A round already served or charged is sent, never cancelled.",
      );
    case "TakenBeforeRecords":
      return t(
        "That paid-at time is before this store started recording sales in the system. Check when it was paid and enter it again.",
      );
    case "TakenBeforeOrdered":
      return t(
        "That paid-at time is more than 30 minutes before this table's last round was ordered in the system. A table pays after it orders: check the time on the paper slip and enter it again.",
      );
    case "TenderShort":
      return t("The cash received is less than the cash total.");
    case "AlreadyPaid":
      return t("This table has already paid.");
    case "GuestPaying":
      return t(
        "A guest is paying the whole table on their phone right now. Wait for it, or stop the phone payment if they gave up.",
      );
    case "NotReady":
      return t("Every dish must be served or cancelled first.");
    case "SessionChanged":
      return t("This table changed since it was shown. It has been read again: try again.");
    case "OutcomeUnknown":
      return t(
        "We couldn't confirm the result. Press the button again: it is never recorded twice.",
      );
    case "ServerProblem":
      return notConfirmedPressAgainText + " " + paymentNotConfirmedText;
    default:
      return t("This couldn't be done right now. Try again.");
  }
}

/**
 * WP-2423 item 8 ⑤ D4 (v15 Fireside Table 5): guest rounds waiting for staff OK are not on the
 * bill, and no payment is taken until staff decide them — right here, with the same "Send to
 * kitchen" / "Cancel this round" as on the table. A round already served or charged (on paper
 * during an outage too) is sent, so it is on the bill: cancelling it would leave a sale unrecorded.
 */
function WaitingRoundsAtCheckout({
  bill,
  table,
  csrf,
  timeZone,
  locked,
  fetcher,
  onChanged,
}: {
  readonly bill: TableBill;
  readonly table: StaffDiningTable;
  readonly csrf: string;
  readonly timeZone: string | undefined;
  readonly locked: boolean;
  readonly fetcher?: typeof fetch | undefined;
  readonly onChanged: () => void;
}) {
  const count = bill.waitingRounds.length;
  const total = bill.waitingRounds.reduce((sum, round) => sum + BigInt(round.totalMinor), 0n);
  const known = new Map(
    (table.heldRounds ?? []).map((round) => [round.orderBatchReference, round.roundNumber]),
  );
  return (
    <div className="table-checkout__waiting" role="alert">
      <p>
        {count === 1
          ? t(
              "1 round is waiting for your OK and is not on this bill ({amount}). Send it to the kitchen or cancel it before taking payment.",
              { amount: cad(total) },
            )
          : t(
              "{count} rounds are waiting for your OK and are not on this bill ({amount}). Send them to the kitchen or cancel them before taking payment.",
              { count: String(count), amount: cad(total) },
            )}
      </p>
      <p className="table-checkout__hint">
        {t(
          "A round the guests were already served or charged for (on paper during an outage too) is sent to the kitchen, so it is on the bill. Cancel only a round they did not get.",
        )}
      </p>
      <TableHeldRounds
        rounds={bill.waitingRounds.map((round) => ({
          orderReference: round.orderReference,
          orderBatchReference: round.orderBatchReference,
          roundNumber: known.get(round.orderBatchReference) ?? null,
          reason: round.reason,
          heldAt: round.heldAt,
        }))}
        csrf={csrf}
        timeZone={timeZone}
        locked={locked}
        onChanged={onChanged}
        fetcher={fetcher}
      />
    </div>
  );
}

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER (DIN-FLOOR-BOARD): a pay-later table pays once at the end. Staff
 * start checkout (no more rounds), read the bill, choose the tip, and record the table's payment —
 * on the card machine after it approved, or in cash (rounded to 5 cents, with the change). A manager
 * can record that the guests left without paying. The table is then closed as usual.
 */
/**
 * The exact amount, then what a guest is likely to hand over (M146): the next $5, $10 and $20, two
 * twenties more, the next $50 and the next $100 above the amount due — up to four, smallest first.
 * $57.55 offers $60, $80 and $100, not only $100.
 */
export function cashQuickAmounts(due: bigint): readonly bigint[] {
  const above = (step: bigint) => (due / step + 1n) * step;
  const candidates = [
    above(500n),
    above(1000n),
    above(2000n),
    above(2000n) + 2000n,
    above(5000n),
    above(10000n),
  ];
  const distinct = [...new Set(candidates)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [due, ...distinct.slice(0, 4)];
}

export function TableCheckout({
  table,
  session,
  csrf,
  locked,
  canStart,
  canWriteOff = false,
  onChanged,
  onSettled,
  fetcher,
  timeZone,
  storeLabel,
}: {
  /** The Store's name, printed at the top of the paid bill. */
  readonly storeLabel?: string | undefined;
  /** WP-2423 item 8 ①: may record that the guests left without paying (a manager). */
  readonly canWriteOff?: boolean;
  /** The Store's time zone (a paper payment's time is Store time). */
  readonly timeZone?: string | undefined;
  readonly table: StaffDiningTable;
  readonly session: StaffDiningTableSession;
  readonly csrf: string;
  readonly locked: boolean;
  /** Whether this person may start checkout (stop the table's ordering). */
  readonly canStart: boolean;
  readonly onChanged: () => void;
  /** What was just taken, said in words on the page. */
  readonly onSettled?: (message: string) => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createTableCheckoutClient(fetcher), [fetcher]);
  const sessionReference = table.currentDiningSessionReference as string;
  const [bill, setBill] = useState<TableBill | null>(null);
  const [reload, setReload] = useState(0);
  /** True while a read of the bill is on its way (the periodic re-read waits for it). */
  const billReading = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  // merchant-outage-recovery M100: why the bill could not be read again, apart from what an action
  // said. The next read that works clears it.
  const [readProblem, setReadProblem] = useState<string | null>(null);
  // M89: said once a phone payment was stopped, until the next action.
  const [stoppedPhone, setStoppedPhone] = useState(false);
  // v15 batch 11: while a phone payment is being stopped, the payment company is asked; the bill's
  // own re-reads wait (they only slowed the stop), and an answer read before the stop is not shown.
  const [stoppingPhone, setStoppingPhone] = useState(false);
  // Counts each stop's start and end: odd while a stop is on its way.
  const stops = useRef(0);
  const stopController = useRef<AbortController | null>(null);
  useEffect(() => () => stopController.current?.abort(), []);
  const [busy, setBusy] = useState(false);
  // WP-2423 item 8 ① (Owner 2026-10-27): no tip is chosen for the guests; staff ask and choose.
  const [tip, setTip] = useState<Tip | null>(null);
  // Money is confirmed: the amounts are shown once more before the payment is recorded.
  const [reviewing, setReviewing] = useState(false);
  const [otherTip, setOtherTip] = useState("");
  const [method, setMethod] = useState<"CardMachine" | "Cash">("CardMachine");
  const [slip, setSlip] = useState("");
  const [received, setReceived] = useState("");
  const [leaving, setLeaving] = useState(false);
  // Operating continuity: a table paid while the system was down is entered afterwards from paper.
  const [paper, setPaper] = useState(false);
  // WP-2423 item 8 ④: the part of a split bill being collected (null: the whole table).
  const [part, setPart] = useState<number | null>(null);
  const [paidAt, setPaidAt] = useState("");
  const paperInstant = paper ? paidAtInstant(paidAt, Date.now(), timeZone) : null;
  // WP-2423 (v15 fabf0261): the server refused the paid-at itself; staff correct it in its field.
  const [paidAtRefused, setPaidAtRefused] = useState(false);
  const [focusPaidAt, setFocusPaidAt] = useState(0);
  const paidAtInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusPaidAt === 0) return;
    paidAtInput.current?.focus();
    paidAtInput.current?.select?.();
  }, [focusPaidAt]);
  // One operation per intent: a lost answer is resent with the same one.
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const beginOperation = useRef<string | null>(null);
  const guestPaid = useRef(false);

  useEffect(() => {
    if (session.phase !== "Closing") {
      setBill(null);
      return;
    }
    const controller = new AbortController();
    const stopsBefore = stops.current;
    billReading.current = true;
    // A read that never settles (Wi-Fi dropped mid-request, a socket gone silent) has a ceiling:
    // it is given up, staff are told, and the next 5 s tick reads again.
    const ceiling = window.setTimeout(() => {
      controller.abort();
      billReading.current = false;
      // While a phone payment is being stopped no re-read runs, so "trying again" is not said then.
      if (stops.current === stopsBefore && stops.current % 2 === 0)
        setReadProblem(t("The bill couldn't be read just now. Trying again by itself."));
    }, billReadCeilingMs);
    client
      .bill(csrf, sessionReference, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || stops.current !== stopsBefore) return;
        setBill(value);
        setReadProblem(null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && stops.current === stopsBefore)
          setReadProblem(errorText(error));
      })
      .finally(() => {
        window.clearTimeout(ceiling);
        if (!controller.signal.aborted) billReading.current = false;
      });
    return () => {
      window.clearTimeout(ceiling);
      controller.abort();
      billReading.current = false;
    };
  }, [client, csrf, sessionReference, session.phase, session.version, reload]);

  // S4: while a guest pays on their phone, the bill is read again until it ends.
  const paidNow = bill?.settlement != null || (bill?.split != null && bill.split.paidInFull);
  // Owner 2026-11-03 walkthrough: a guest can start or finish paying (a part too) at any moment,
  // so an open bill keeps being read while the table checks out.
  useEffect(() => {
    if (session.phase !== "Closing" || paidNow || bill?.writeOff != null || stoppingPhone) return;
    // v15 2026-11-11: a read still running is never cut off by the next one. On a busy evening a
    // merged table's bill took 7–8 s, so restarting every 5 s left staff on "Reading the bill…"
    // until one read happened to finish in time (and each cut-off read still loaded the server).
    const timer = window.setInterval(() => {
      if (!billReading.current) setReload((value) => value + 1);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [session.phase, paidNow, bill?.writeOff, stoppingPhone]);
  // M100: once the table has paid, a warning left by an earlier lost answer no longer applies.
  useEffect(() => {
    if (paidNow) setProblem(null);
  }, [paidNow]);
  // …and once it is paid, the table's close check reads again.
  const notified = useRef(false);
  useEffect(() => {
    if (paidNow && guestPaid.current && !notified.current) {
      notified.current = true;
      onChanged();
    }
    guestPaid.current = !paidNow && bill !== null;
  }, [paidNow, bill, onChanged]);

  // WP-2423 同桌结账: guests paying by dish; staff take the rest at the counter (no part chosen).
  const byGuests = bill?.split?.mode === "ByGuests";
  const selected = byGuests
    ? null
    : (bill?.split?.parts.find((entry) => entry.partNumber === part) ?? null);
  // WP-2423 (v15 fabf0261): when the last round this payment covers was sent in the system (rounds
  // taken on paper aside). A paper paid-at a little before it is warned about (a card machine's
  // clock drifts, a written time is approximate); the server refuses one well before it.
  const lastLiveOrderedAt = (() => {
    if (bill === null) return null;
    const covered = bill.rounds.filter((round) =>
      selected === null
        ? !round.paid && round.totalMinor !== "0"
        : selected.roundNumbers.includes(round.roundNumber),
    );
    const times = covered
      .map((round) => round.liveOrderedAt ?? null)
      .filter((at): at is string => at !== null)
      .map((at) => Date.parse(at));
    return times.length === 0 ? null : new Date(Math.max(...times)).toISOString();
  })();
  const paidBeforeOrdered =
    paperInstant !== null &&
    lastLiveOrderedAt !== null &&
    Date.parse(paperInstant) < Date.parse(lastLiveOrderedAt);
  const paidAtNotes = [
    paidBeforeOrdered && lastLiveOrderedAt !== null
      ? t(
          "This is before this table's last round was ordered in the system ({at}). A card machine's clock can be a few minutes off: check the time on the slip before you confirm.",
          { at: storeTime(lastLiveOrderedAt, timeZone, true) },
        )
      : null,
    paidAtDayNote(paperInstant, Date.now(), timeZone),
  ].filter((note): note is string => note !== null);
  // A part's own share before tax (its tip) and its amount; otherwise what the table owes.
  const subtotal = selected
    ? BigInt(selected.subtotalMinor)
    : byGuests
      ? BigInt(bill?.split?.restSubtotalMinor ?? "0")
      : bill
        ? BigInt(bill.owed.subtotalMinor)
        : 0n;
  const owed = selected
    ? BigInt(selected.amountMinor)
    : byGuests
      ? BigInt(bill?.split?.restMinor ?? "0")
      : bill
        ? BigInt(bill.owed.totalMinor)
        : 0n;
  // WP-2423 item 8 ⑦ (Owner decision 11): the Store's own percentages; with tips off, staff are
  // asked nothing and no tip is taken. A percentage the Store no longer offers is chosen again.
  const tipOptions =
    bill === null || !bill.tips.enabled ? [] : ["0", ...bill.tips.tierPercents.map(String)];
  const chosenTip: Tip | null =
    bill !== null && !bill.tips.enabled
      ? "0"
      : tip !== null && (tip === "Other" || tipOptions.includes(tip))
        ? tip
        : null;
  const tipMinor =
    chosenTip === null
      ? null
      : chosenTip === "Other"
        ? dollarsToMinor(otherTip)
        : (subtotal * BigInt(chosenTip) + 50n) / 100n;
  const due = tipMinor === null ? null : owed + tipMinor;
  const cashDue = due === null ? null : cashTotalMinor(due);
  const receivedMinor = dollarsToMinor(received);
  const change = cashDue !== null && receivedMinor !== null ? receivedMinor - cashDue : null;
  const slipValid = slip.trim() === "" || /^[A-Za-z0-9][A-Za-z0-9 #./-]{0,39}$/u.test(slip.trim());
  const canPay =
    bill !== null &&
    bill.settlement === null &&
    bill.consistent &&
    // WP-2423 item 8 ⑤ D4: rounds waiting for staff OK are decided before any payment.
    bill.waitingRounds.length === 0 &&
    (bill.split === null ||
      byGuests ||
      (selected !== null && selected.payment === null && !selected.guestPaying)) &&
    owed > 0n &&
    due !== null &&
    !busy &&
    !locked &&
    (method === "CardMachine" ? slipValid : change !== null && change >= 0n) &&
    (!paper || paperInstant !== null);

  // A phone joining changes the table's version without changing the bill, so a refusal for that
  // alone is not staff's to deal with: read the table and try once more with its new version. The
  // server still checks the table on that try. If nothing newer arrives, staff are told.
  const [beginRetry, setBeginRetry] = useState<{
    readonly from: number;
    readonly problem: string;
  } | null>(null);
  const start = async (retrying = false) => {
    if ((busy || locked) && !retrying) return;
    setBusy(true);
    setProblem(null);
    beginOperation.current ??= serviceOperationReference();
    try {
      await createDiningSessionCloseClient(fetcher)
        .prepare({
          operationReference: beginOperation.current,
          diningSessionReference: sessionReference,
          action: "Begin",
          expectedSessionVersion: session.version,
        })
        .execute(csrf);
      beginOperation.current = null;
      onChanged();
      setBusy(false);
    } catch (error) {
      // As for cancelling: a refused try reads the table again, so the next one can succeed.
      if (!(error instanceof DiningSessionCloseClientError && error.code === "OutcomeUnknown"))
        beginOperation.current = null;
      if (error instanceof DiningSessionCloseClientError && error.code !== "OutcomeUnknown")
        onChanged();
      if (
        error instanceof DiningSessionCloseClientError &&
        error.code === "Conflict" &&
        !retrying
      ) {
        setBeginRetry({ from: session.version, problem: errorText(error) });
        return;
      }
      setProblem(errorText(error));
      setBusy(false);
    }
  };
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (beginRetry === null) return;
    if (session.version !== beginRetry.from) {
      setBeginRetry(null);
      void startRef.current(true);
      return;
    }
    const timer = setTimeout(() => {
      setBeginRetry(null);
      setProblem(beginRetry.problem);
      setBusy(false);
    }, 5000);
    return () => clearTimeout(timer);
  }, [beginRetry, session.version]);

  // DEC-DINE-IN-PAY-LATER (rule 3): the guests want more after asking for the bill — back to
  // ordering, recorded with who did it. Only while nothing is paid.
  const cancelOperation = useRef<string | null>(null);
  const cancelCheckout = async () => {
    if (busy || locked) return;
    setBusy(true);
    setProblem(null);
    cancelOperation.current ??= serviceOperationReference();
    try {
      await createDiningSessionCloseClient(fetcher)
        .prepare({
          operationReference: cancelOperation.current,
          diningSessionReference: sessionReference,
          action: "Cancel",
          expectedSessionVersion: session.version,
        })
        .execute(csrf);
      cancelOperation.current = null;
      onChanged();
    } catch (error) {
      if (!(error instanceof DiningSessionCloseClientError && error.code === "OutcomeUnknown"))
        cancelOperation.current = null;
      setProblem(errorText(error));
      if (error instanceof DiningSessionCloseClientError && error.code !== "OutcomeUnknown")
        onChanged();
    } finally {
      setBusy(false);
    }
  };

  // S4: stop a phone payment the guest gave up on (the Provider is asked first).
  const stopPhone = async () => {
    if (busy || locked) return;
    setBusy(true);
    setStoppingPhone(true);
    stops.current += 1;
    setProblem(null);
    // A stop that never answers is given up: what happened is not known, and the bill's re-reads
    // (paused while it was on its way) start again, so a guest who did pay still reads paid.
    const controller = new AbortController();
    stopController.current = controller;
    let ceiling = 0;
    const givenUp = new Promise<never>((_, reject) => {
      ceiling = window.setTimeout(() => {
        controller.abort();
        reject(new StopNotAnswered());
      }, stopPhoneCeilingMs);
    });
    try {
      const stopped = await Promise.race([
        client.stopOnlinePayment(csrf, sessionReference, controller.signal),
        givenUp,
      ]);
      if (stopped === null) setReload((value) => value + 1);
      else setBill(stopped);
      setStoppedPhone(true);
      onChanged();
    } catch (error) {
      if (stopController.current !== controller || controller.signal.aborted) {
        if (!(error instanceof StopNotAnswered)) return; // the panel was closed meanwhile
        setProblem(
          t(
            "No answer came about stopping the phone payment, so it isn't known whether it stopped or whether the guest paid. The bill is being read again: check it before taking the payment another way.",
          ),
        );
      } else setProblem(errorText(error));
      setReload((value) => value + 1);
    } finally {
      window.clearTimeout(ceiling);
      if (stopController.current === controller) stopController.current = null;
      stops.current += 1;
      setBusy(false);
      setStoppingPhone(false);
    }
  };

  const pay = async () => {
    if (!canPay || bill === null || tipMinor === null) return;
    setReviewing(false);
    const intent = JSON.stringify([
      part,
      method,
      chosenTip,
      tipMinor.toString(),
      received,
      slip.trim(),
      paperInstant,
    ]);
    if (operation.current?.key !== intent)
      operation.current = { key: intent, reference: serviceOperationReference() };
    setBusy(true);
    setProblem(null);
    try {
      const result = await client.settle(csrf, {
        operationReference: operation.current.reference,
        diningSessionReference: sessionReference,
        method,
        tip:
          chosenTip === "0" || chosenTip === null
            ? { kind: "None" }
            : chosenTip === "Other"
              ? { kind: "Amount", amountMinor: tipMinor.toString() }
              : { kind: "Percent", percent: Number(chosenTip) },
        tenderedMinor: method === "Cash" ? String(receivedMinor) : null,
        slipReference: method === "CardMachine" && slip.trim() !== "" ? slip.trim() : null,
        takenAt: paper ? paperInstant : null,
        partNumber: bill.split === null || byGuests ? null : part,
        // What staff saw and charged: refused if the bill changed meanwhile.
        owedMinor: owed.toString(),
      });
      operation.current = null;
      setPaidAtRefused(false);
      setPart(null);
      setTip(null);
      setReceived("");
      setBill(result.bill);
      // Owner 2026-11-03 walkthrough: said in words, with the change to hand back.
      onSettled?.(
        method === "Cash" && change !== null
          ? t("Table {table}: {amount} cash received. Change {change}.", {
              table: saidTable(table.stableLabel),
              amount: cad(cashDue ?? 0n),
              change: cad(change),
            })
          : t("Table {table}: {amount} received on the card machine.", {
              table: saidTable(table.stableLabel),
              amount: cad(due ?? 0n),
            }),
      );
      onChanged();
    } catch (error) {
      if (!outcomeUnknown(error)) operation.current = null;
      setProblem(errorText(error));
      const timeRefused =
        error instanceof TableCheckoutError &&
        (error.code === "TakenBeforeRecords" || error.code === "TakenBeforeOrdered");
      setPaidAtRefused(timeRefused);
      if (timeRefused) setFocusPaidAt((value) => value + 1);
      if (
        error instanceof TableCheckoutError &&
        (error.code === "BillChanged" ||
          error.code === "RoundsWaiting" ||
          error.code === "TipsOff" ||
          error.code === "TipChoicesChanged")
      )
        setReload((value) => value + 1);
    } finally {
      setBusy(false);
    }
  };

  const leftWithoutPaying = async () => {
    if (busy || locked || session.orderReference === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const progress = await createDiningProgressClient(fetcher).load(session.orderReference, csrf);
      operation.current ??= { key: "left", reference: serviceOperationReference() };
      await client.leftWithoutPaying(csrf, {
        orderReference: session.orderReference,
        operationReference: operation.current.reference,
        expectedOrderVersion: progress.currentOrderVersion,
        expectedClosureVersion: progress.closureVersion,
      });
      operation.current = null;
      setLeaving(false);
      // The table's session is unchanged by a write-off: read the bill again here as well.
      setReload((value) => value + 1);
      onChanged();
    } catch (error) {
      if (!outcomeUnknown(error)) operation.current = null;
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  if (session.phase === "Active")
    return (
      <section aria-label={t("Checkout")} className="table-checkout">
        <h3 id="table-checkout-title">{t("Checkout")}</h3>
        <p>
          {t(
            "This table pays once at the end. When the guests ask for the bill, start checkout: no more rounds can be sent from the table.",
          )}
        </p>
        {canStart ? (
          <button
            type="button"
            className="table-checkout__primary"
            disabled={busy || locked}
            onClick={() => void start()}
          >
            {busy ? t("Starting checkout…") : t("Start checkout")}
          </button>
        ) : (
          <p role="note">{t("An Owner or Store Manager starts checkout.")}</p>
        )}
        {problem ? <p role="alert">{problem}</p> : null}
      </section>
    );
  if (session.phase !== "Closing") return null;
  return (
    <section aria-label={t("Checkout")} className="table-checkout">
      <h3 id="table-checkout-title">
        {bill?.writeOff
          ? t("Written off")
          : bill?.settlement || (bill?.split && bill.split.paidInFull)
            ? t("Paid")
            : t("Checkout")}
      </h3>
      {readProblem !== null ? (
        <p className="table-checkout__stale" role="status">
          {bill === null
            ? readProblem
            : t(
                "The bill could not be read again; showing the last update. Trying again by itself.",
              )}
        </p>
      ) : null}
      {bill === null ? (
        problem || readProblem !== null ? null : (
          <>
            <p role="status">{t("Reading the bill…")}</p>
            {/* v15 2026-11-11: on a busy evening a merged table's bill took 7–8 s to read, with only
                "Reading the bill…" shown. After a few seconds staff are told it is still coming. */}
            <SlowWaitNotice busy />
          </>
        )
      ) : (
        <>
          <ol className="table-checkout__rounds">
            {bill.rounds.map((round) => (
              <li key={round.roundNumber}>
                <span>{t("Round {number}", { number: String(round.roundNumber) })}</span>
                {/* v15 b11 (DEC-TAX-WHOLE-RECEIPT): checkout reads as the paper the guests get:
                    each round as the bill charges it (its tax holds its share of the bill's
                    rounding, as the split by rounds), so the rounds add up to the total. */}
                <span>{cad(round.totalMinor)}</span>
                <ul>
                  {round.items.map((item, index) => (
                    <li key={index}>
                      <span>
                        {item.displayName}
                        {item.reduction ? (
                          // WP-2423 item 8 ① segment 2: what a manager took off this dish.
                          <span className="table-checkout__comp">
                            {" · "}
                            {item.reduction.points === true
                              ? t("Points used")
                              : compedText(item.reduction.kind, item.reduction.percent)}{" "}
                            <span className="table-checkout__comp-amount">
                              −{cad(item.reduction.amountMinor)}
                            </span>
                          </span>
                        ) : null}
                      </span>
                      <span>{cad(item.subtotalMinor)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          {bill.writeOff === null && bill.onlinePayment?.status === "InProgress" ? (
            // DEC-DINE-IN-PAY-LATER S4: a guest is paying on their phone; nothing else is taken.
            <div className="table-checkout__phone-payment" role="status">
              <p>
                {t("A guest is paying the whole table on their phone: {amount}.", {
                  amount: cad(bill.onlinePayment.totalMinor),
                })}
              </p>
              <p>
                {t(
                  "If the guest gave up, stop the phone payment to take it here. A payment they did finish is kept.",
                )}
              </p>
              <button type="button" disabled={busy || locked} onClick={() => void stopPhone()}>
                {stoppingPhone
                  ? t("Stopping the phone payment…")
                  : busy
                    ? t("Checking…")
                    : t("Stop the phone payment")}
              </button>
              {stoppingPhone ? (
                <p>
                  {t(
                    "Asking the payment company whether the guest finished paying. Don't take the payment another way until it answers.",
                  )}
                </p>
              ) : null}
            </div>
          ) : bill.writeOff !== null ? (
            // DEC-DINE-IN-PAY-LATER (rule 14): the guests left without paying; nothing to take.
            <div className="table-checkout__written-off" role="status">
              <p>
                {t(
                  "The guests left without paying. {amount} was written off. The reports list it apart; it isn't counted as sales or as money received.",
                  { amount: cad(bill.writeOff.amountMinor) },
                )}
              </p>
              <p>{t("Close the table when it has been cleared.")}</p>
            </div>
          ) : bill.settlement === null ? (
            <>
              {bill.waitingRounds.length > 0 ? (
                <WaitingRoundsAtCheckout
                  bill={bill}
                  table={table}
                  csrf={csrf}
                  timeZone={timeZone}
                  locked={locked || busy}
                  fetcher={fetcher}
                  onChanged={() => {
                    setReload((value) => value + 1);
                    onChanged();
                  }}
                />
              ) : null}
              <TableSplitControls
                bill={bill}
                csrf={csrf}
                client={client}
                disabled={busy || locked}
                selectedPart={part}
                onSelectPart={(value) => {
                  setPart(value);
                  setTip(null);
                  setReceived("");
                  setReviewing(false);
                }}
                onBill={setBill}
                onProblem={setProblem}
              />
              <TableReceipt
                bill={bill}
                tableLabel={table.stableLabel}
                storeLabel={storeLabel}
                timeZone={timeZone}
              />
              {bill.split !== null && selected === null && !(byGuests && owed > 0n) ? null : (
                <>
                  {byGuests ? (
                    <h4 className="table-checkout__part-title">
                      {t("Take the rest at the counter")}
                    </h4>
                  ) : null}
                  {selected ? (
                    <h4 className="table-checkout__part-title">
                      {t("Collect part {number} of {count}", {
                        number: String(selected.partNumber),
                        count: String(bill.split?.parts.length ?? 0),
                      })}
                    </h4>
                  ) : null}
                  <dl className="table-checkout__totals">
                    <div>
                      <dt>{t("Subtotal")}</dt>
                      {/* Owner 2026-11-03 walkthrough: a part's lines add up to the part. */}
                      <dd>
                        {cad(
                          selected
                            ? (BigInt(selected.amountMinor) - BigInt(selected.taxMinor)).toString()
                            : byGuests
                              ? subtotal.toString()
                              : bill.owed.subtotalMinor,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("Tax")}</dt>
                      <dd>
                        {cad(
                          selected
                            ? selected.taxMinor
                            : byGuests
                              ? (owed - subtotal).toString()
                              : // v15 b11 (DEC-TAX-WHOLE-RECEIPT): one tax, the bill's own (worked
                                // out once on the whole bill), as the printed paid bill: $2.93 on
                                // $22.50, never "Tax $2.92" and a separate "Tax rounding $0.01".
                                bill.owed.taxMinor,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>
                        {selected
                          ? t("This part with tax")
                          : byGuests
                            ? t("The rest with tax")
                            : t("Total with tax")}
                      </dt>
                      <dd>
                        {cad(
                          selected
                            ? selected.amountMinor
                            : byGuests
                              ? owed.toString()
                              : bill.owed.totalMinor,
                        )}
                      </dd>
                    </div>
                  </dl>
                  {!bill.consistent ? (
                    <p role="alert">
                      {t(
                        "A round is still being sent or was just changed. Wait a moment and read the bill again.",
                      )}{" "}
                      <button type="button" onClick={() => setReload((value) => value + 1)}>
                        {t("Read the bill again")}
                      </button>
                    </p>
                  ) : null}
                  {tipOptions.length === 0 ? null : (
                    <fieldset className="table-checkout__tip" disabled={busy || locked}>
                      <legend>{t("Tip")}</legend>
                      {tipOptions.map((value) => (
                        <label key={value}>
                          <input
                            type="radio"
                            name="table-tip"
                            checked={chosenTip === value}
                            onChange={() => setTip(value)}
                          />
                          {value === "0"
                            ? t("No tip")
                            : `${value}% · ${cad((subtotal * BigInt(value) + 50n) / 100n)}`}
                        </label>
                      ))}
                      <label>
                        <input
                          type="radio"
                          name="table-tip"
                          checked={chosenTip === "Other"}
                          onChange={() => setTip("Other")}
                        />
                        {t("Other amount")}
                      </label>
                      {chosenTip === "Other" ? (
                        <input
                          aria-label={t("Tip amount")}
                          inputMode="decimal"
                          value={otherTip}
                          aria-invalid={dollarsToMinor(otherTip) === null}
                          onChange={(event) => setOtherTip(event.currentTarget.value)}
                        />
                      ) : null}
                    </fieldset>
                  )}
                  <fieldset className="table-checkout__method" disabled={busy || locked}>
                    <legend>{t("How the table pays")}</legend>
                    <label>
                      <input
                        type="radio"
                        name="table-method"
                        checked={method === "CardMachine"}
                        onChange={() => setMethod("CardMachine")}
                      />
                      {t("Card machine")}
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="table-method"
                        checked={method === "Cash"}
                        onChange={() => setMethod("Cash")}
                      />
                      {t("Cash")}
                    </label>
                  </fieldset>
                  {method === "CardMachine" ? (
                    <label className="table-checkout__field">
                      {t("Slip reference (optional)")}
                      <input
                        value={slip}
                        maxLength={40}
                        autoComplete="off"
                        aria-invalid={!slipValid}
                        onChange={(event) => setSlip(event.currentTarget.value)}
                      />
                      <small>
                        {t(
                          "The approval or reference code on the card machine slip. Never the card number.",
                        )}
                      </small>
                    </label>
                  ) : (
                    <>
                      <p className="table-checkout__cash-due">
                        {cashDue === null
                          ? null
                          : t("Cash total {amount} (rounded to 5 cents)", { amount: cad(cashDue) })}
                      </p>
                      <label className="table-checkout__field">
                        {t("Cash received")}
                        <input
                          inputMode="decimal"
                          value={received}
                          aria-invalid={received !== "" && receivedMinor === null}
                          onChange={(event) => setReceived(event.currentTarget.value)}
                        />
                      </label>
                      {/* Owner 2026-11-03 walkthrough: the usual amounts are one tap. */}
                      {cashDue === null ? null : (
                        <div
                          className="table-checkout__cash-quick"
                          role="group"
                          aria-label={t("Quick cash amounts")}
                        >
                          {cashQuickAmounts(cashDue).map((amount, index) => (
                            <button
                              key={amount.toString()}
                              type="button"
                              disabled={busy || locked}
                              onClick={() => setReceived((Number(amount) / 100).toFixed(2))}
                            >
                              {index === 0
                                ? t("Exact {amount}", { amount: cad(amount) })
                                : cad(amount)}
                            </button>
                          ))}
                        </div>
                      )}
                      {change !== null ? (
                        <p className="table-checkout__change" aria-live="polite">
                          {change >= 0n
                            ? t("Change {amount}", { amount: cad(change) })
                            : t("{amount} short", { amount: cad(-change) })}
                        </p>
                      ) : null}
                    </>
                  )}
                  <fieldset className="table-checkout__paper" disabled={busy || locked}>
                    <legend>{t("Paper payment")}</legend>
                    <label>
                      <input
                        type="checkbox"
                        checked={paper}
                        onChange={(event) => setPaper(event.currentTarget.checked)}
                      />
                      {t("Paid while the system was down (enter it from paper now)")}
                    </label>
                    {paper ? (
                      <label className="table-checkout__field">
                        {t("Paid at (store time)")}
                        <input
                          ref={paidAtInput}
                          type="datetime-local"
                          value={paidAt}
                          aria-invalid={paperInstant === null || paidAtRefused}
                          aria-describedby={
                            paidAtRefused ? "table-checkout-paid-at-refused" : undefined
                          }
                          onChange={(event) => {
                            setPaidAt(event.currentTarget.value);
                            if (paidAtRefused) {
                              setPaidAtRefused(false);
                              setProblem(null);
                            }
                          }}
                        />
                        <small>
                          {t("Within the last 3 days. It counts on the day it was paid.")}
                        </small>
                      </label>
                    ) : null}
                    {paper && paidAtRefused && problem ? (
                      <p id="table-checkout-paid-at-refused" role="alert">
                        {problem}
                      </p>
                    ) : null}
                    {paper
                      ? paidAtNotes.map((note) => (
                          <p
                            key={note}
                            className="table-checkout__hint"
                            data-tier="warning"
                            role="note"
                          >
                            {note}
                          </p>
                        ))
                      : null}
                  </fieldset>
                  {reviewing && canPay && due !== null && tipMinor !== null ? (
                    // Money is confirmed (Owner decision 2): the amounts once more, then record.
                    <div
                      role="alertdialog"
                      aria-labelledby="table-checkout-confirm"
                      className="table-checkout__confirm"
                    >
                      <h4 id="table-checkout-confirm">{t("Confirm the payment")}</h4>
                      <dl className="table-checkout__totals">
                        <div>
                          <dt>{t("Table {table}", { table: saidTable(table.stableLabel) })}</dt>
                          <dd>{method === "Cash" ? t("Cash") : t("Card machine")}</dd>
                        </div>
                        <div>
                          <dt>{t("Bill")}</dt>
                          <dd>{cad(owed)}</dd>
                        </div>
                        <div>
                          <dt>{t("Tip")}</dt>
                          <dd>{cad(tipMinor)}</dd>
                        </div>
                        {paper && paperInstant !== null ? (
                          <div>
                            <dt>{t("Paid at")}</dt>
                            <dd>{storeTime(paperInstant, timeZone, true)}</dd>
                          </div>
                        ) : null}
                        {method === "Cash" && cashDue !== null && change !== null ? (
                          <>
                            <div className="table-checkout__total">
                              <dt>{t("Cash due (rounded to 5 cents)")}</dt>
                              <dd>{cad(cashDue)}</dd>
                            </div>
                            <div>
                              <dt>{t("Cash received")}</dt>
                              <dd>{cad(receivedMinor ?? 0n)}</dd>
                            </div>
                            <div className="table-checkout__total">
                              <dt>{t("Change to give")}</dt>
                              <dd>{cad(change)}</dd>
                            </div>
                          </>
                        ) : (
                          <div className="table-checkout__total">
                            <dt>{t("Charged on the card machine")}</dt>
                            <dd>{cad(due)}</dd>
                          </div>
                        )}
                      </dl>
                      {paper
                        ? paidAtNotes.map((note) => (
                            <p key={note} data-tier="warning" role="note">
                              {note}
                            </p>
                          ))
                        : null}
                      <p>
                        {method === "Cash"
                          ? t("Count the cash first. Once recorded, only a manager can refund it.")
                          : t(
                              "Check the card machine shows Approved first. Once recorded, only a manager can refund it.",
                            )}
                      </p>
                      <div className="table-checkout__confirm-actions">
                        <button type="button" onClick={() => setReviewing(false)}>
                          {t("Back")}
                        </button>
                        <button
                          type="button"
                          className="table-checkout__primary"
                          disabled={!canPay}
                          onClick={() => void pay()}
                        >
                          {method === "Cash"
                            ? t("Confirm {amount} cash received", { amount: cad(cashDue ?? due) })
                            : t("Confirm {amount} paid", { amount: cad(due) })}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="table-checkout__primary"
                      disabled={!canPay}
                      onClick={() => setReviewing(true)}
                    >
                      {busy
                        ? t("Recording…")
                        : bill.waitingRounds.length > 0
                          ? t("Decide the rounds waiting for your OK first")
                          : chosenTip === null
                            ? t("Choose a tip to take payment")
                            : due === null
                              ? t("Record payment")
                              : method === "Cash"
                                ? t("Cash received · {amount}", { amount: cad(cashDue ?? due) })
                                : t("Paid on card machine · {amount}", { amount: cad(due) })}
                    </button>
                  )}
                  <SlowWaitNotice busy={busy} />
                </>
              )}
              {/* v15 2026-10-28 b: only while something is unpaid — for a split bill, the parts
                  still unpaid, and it says so. */}
              {/* Owner 2026-11-04 walkthrough: staff who can't record it are told who can. */}
              {!canWriteOff ? (
                <p className="table-checkout__hint">
                  {t("Guests left without paying? A manager or the owner records it here.")}
                </p>
              ) : null}
              {canWriteOff && (bill.split === null || !bill.split.paidInFull) ? (
                leaving ? (
                  <div
                    role="group"
                    aria-label={t("Guests left without paying")}
                    className="table-checkout__leaving"
                  >
                    <p>
                      {bill.split?.mode === "ByGuests" && bill.split.paidParts > 0
                        ? t(
                            "Record that the guests at table {table} left without paying the dishes still unpaid ({amount})? What guests already paid stays paid. It is recorded under your name and stays in the reports as written off.",
                            {
                              table: saidTable(table.stableLabel),
                              amount: cad(bill.owed.totalMinor),
                            },
                          )
                        : bill.split !== null && bill.split.paidParts > 0
                          ? t(
                              "Record that the guests at table {table} left without paying the {count} parts still unpaid ({amount})? The parts already paid stay paid. It is recorded under your name and stays in the reports as written off.",
                              {
                                table: saidTable(table.stableLabel),
                                count: String(bill.split.parts.length - bill.split.paidParts),
                                amount: cad(bill.owed.totalMinor),
                              },
                            )
                          : t(
                              "Record that the guests at table {table} left without paying {amount}? It is recorded under your name and stays in the reports as written off.",
                              {
                                table: saidTable(table.stableLabel),
                                amount: cad(bill.owed.totalMinor),
                              },
                            )}
                    </p>
                    <button
                      type="button"
                      disabled={busy || locked}
                      onClick={() => void leftWithoutPaying()}
                    >
                      {t("Yes, they left without paying")}
                    </button>{" "}
                    <button type="button" disabled={busy} onClick={() => setLeaving(false)}>
                      {t("Cancel")}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="table-checkout__secondary"
                    disabled={busy || locked || BigInt(bill.owed.totalMinor) === 0n}
                    onClick={() => setLeaving(true)}
                  >
                    {bill.split !== null && bill.split.paidParts > 0
                      ? t("Guests left without paying the rest")
                      : t("Guests left without paying")}
                  </button>
                )
              ) : null}
            </>
          ) : (
            <TableReceipt
              bill={bill}
              tableLabel={table.stableLabel}
              storeLabel={storeLabel}
              timeZone={timeZone}
            />
          )}
        </>
      )}
      {canStart &&
      bill !== null &&
      bill.settlement === null &&
      bill.writeOff === null &&
      bill.onlinePayment?.status !== "InProgress" &&
      // v15 2026-10-28: a split table that paid (or is paying) a part can't go back either; the
      // server refuses it too.
      (bill.split === null ||
        (bill.split.paidParts === 0 &&
          !bill.split.parts.some((part) => part.guestPaying) &&
          // WP-2423 同桌结账: guests who chose dishes are paying for them; the server refuses too.
          !(bill.split.mode === "ByGuests" && bill.split.parts.length > 0))) ? (
        // DEC-DINE-IN-PAY-LATER (rule 3): the guests want to order more — back to ordering.
        <p className="table-checkout__cancel">
          <button type="button" disabled={busy || locked} onClick={() => void cancelCheckout()}>
            {t("Cancel checkout")}
          </button>{" "}
          <small>{t("The table can order again; checkout is started again later.")}</small>
        </p>
      ) : null}
      {stoppedPhone && bill?.onlinePayment?.status !== "InProgress" && bill?.settlement === null ? (
        <p role="status">{t("Phone payment stopped. Take the payment here.")}</p>
      ) : null}
      {problem && !(paper && paidAtRefused) ? <p role="alert">{problem}</p> : null}
    </section>
  );
}

/**
 * DEC-DINE-IN-PAY-LATER rule 5: one receipt for the whole table — every round's dishes, tax, tip,
 * cash rounding, total and how it was paid — never split by round.
 */
function TableReceipt({
  bill,
  tableLabel,
  storeLabel,
  timeZone,
}: {
  readonly bill: TableBill;
  readonly tableLabel: string;
  readonly storeLabel?: string | undefined;
  readonly timeZone?: string | undefined;
}) {
  // Owner 2026-11-03 walkthrough: a split bill has its receipt too, once every part is paid.
  const parts = bill.split?.parts ?? [];
  const payments: readonly {
    readonly part: number | null;
    readonly paid:
      NonNullable<TableBill["settlement"]> | NonNullable<(typeof parts)[number]["payment"]>;
  }[] =
    bill.settlement !== null
      ? [{ part: null, paid: bill.settlement }]
      : bill.split?.paidInFull === true && parts.every((entry) => entry.payment !== null)
        ? parts.map((entry) => ({
            part: entry.partNumber,
            paid: entry.payment as NonNullable<typeof entry.payment>,
          }))
        : [];
  const region = useRef<HTMLDivElement>(null);
  if (payments.length === 0) return null;
  const add = (pick: (paid: (typeof payments)[number]["paid"]) => string) =>
    payments.reduce((sum, entry) => sum + BigInt(pick(entry.paid)), 0n);
  const cashRounding = add((paid) => paid.roundingMinor);
  const subtotal = bill.rounds.reduce((sum, round) => sum + BigInt(round.subtotalMinor), 0n);
  // v15 batch 9 (DEC-TAX-WHOLE-RECEIPT): the paper is one receipt, so its tax is the bill's tax,
  // worked out once over the whole bill (each round's tax holds its share of the rounding): $2.93
  // on $22.50 at 13%, never "Tax $2.92" and a separate "Tax rounding $0.01".
  const tax = bill.rounds.reduce((sum, round) => sum + BigInt(round.taxMinor), 0n);
  // v15 batch 7 (M50): the paper the guests get says where, which table, when, and what they had.
  const paidAt = payments
    .map((entry) => entry.paid.recordedAt)
    .reduce((latest, at) => (at > latest ? at : latest), "");
  const dishes = bill.rounds.flatMap((round) => round.items);
  return (
    <div
      ref={region}
      className="table-receipt"
      aria-label={t("Paid bill for table {table}", { table: saidTable(tableLabel) })}
    >
      <header className="table-receipt__head" data-print-only="">
        {storeLabel ? <p className="table-receipt__store">{storeLabel}</p> : null}
        <p>{t("Table {table}", { table: saidTable(tableLabel) })}</p>
        {paidAt !== "" ? (
          <p>{t("Paid {time}", { time: storeTime(paidAt, timeZone, true) })}</p>
        ) : null}
      </header>
      <ul className="table-receipt__dishes" data-print-only="">
        {dishes.map((item) => (
          <li key={item.orderItemReference}>
            <span>
              {item.quantity} × {item.displayName}
            </span>
            <span>{cad(item.subtotalMinor)}</span>
            {item.reduction ? (
              // v15 batch 7 review: on paper each dish and its comp are before tax, like the
              // Subtotal under them, so the dishes less the comps add up to the Subtotal.
              <span className="table-receipt__reduction">
                {item.reduction.points === true
                  ? t("Points used")
                  : compedText(item.reduction.kind, item.reduction.percent)}
                {item.reduction.netMinor === null ? null : <> −{cad(item.reduction.netMinor)}</>}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <dl className="table-checkout__totals">
        <div>
          <dt>{t("Subtotal")}</dt>
          <dd>{cad(subtotal)}</dd>
        </div>
        <div>
          <dt>{t("Tax")}</dt>
          <dd>{cad(tax)}</dd>
        </div>
        <div>
          <dt>{t("Tip")}</dt>
          <dd>{cad(add((paid) => paid.tipMinor))}</dd>
        </div>
        {cashRounding !== 0n ? (
          <div>
            <dt>{t("Cash rounding")}</dt>
            <dd>{cad(cashRounding)}</dd>
          </div>
        ) : null}
        <div className="table-checkout__total">
          <dt>{t("Total paid")}</dt>
          <dd>{cad(add((paid) => paid.totalMinor))}</dd>
        </div>
        {payments.map(({ part, paid }) => (
          <Fragment key={part ?? "whole"}>
            <div>
              <dt>
                {part === null
                  ? t("Paid by")
                  : t("Part {number} paid by", { number: String(part) })}
              </dt>
              <dd>
                {paid.method === "Cash"
                  ? t("Cash")
                  : paid.method === "Online"
                    ? t("Guest's phone")
                    : t("Card machine")}
              </dd>
            </div>
            {paid.tenderedMinor !== null ? (
              <div>
                <dt>{t("Cash received")}</dt>
                <dd>{cad(paid.tenderedMinor)}</dd>
              </div>
            ) : null}
            {paid.changeMinor !== null ? (
              <div>
                <dt>{t("Change to give")}</dt>
                <dd>{cad(paid.changeMinor)}</dd>
              </div>
            ) : null}
          </Fragment>
        ))}
      </dl>
      <p role="status" data-print-hide="">
        {t("Paid in full. Close the table when the guests have left.")}
      </p>
      {/* M50: only this paid bill prints, never the staff panel around it. It is not yet a tax
          receipt (no business number), so it is not called one (M48 is still open). */}
      <button
        type="button"
        onClick={() => {
          if (region.current !== null) printRegion(region.current, "table-bill");
        }}
      >
        {t("Print paid bill")}
      </button>
    </div>
  );
}
