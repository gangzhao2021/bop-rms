import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MemberJoinPanel } from "../member/MemberJoinPanel.js";
import { MemberPointsAtTable } from "../member/MemberPointsAtTable.js";
import { v7 as uuidv7 } from "uuid";
import { saidTable, t, wordGap, listSeparator } from "../i18n/i18n.js";
import { parseTipAmount } from "../checkout/tip-amount.js";
import { customTipCheck } from "../checkout/checkout-decisions.js";
import { formatMoney } from "../journey/format.js";
import { SlowWaitNote } from "../journey/SlowWaitNote.js";
import { paymentConfiguration } from "../payment/payment-configuration.js";
import { cardFormNotLoadedText, StripeCardForm } from "../payment/StripeCardForm.js";
import {
  createTablePaymentClient,
  TablePaymentClientError,
  type TablePaymentView,
  type TableTip,
} from "./table-payment-client.js";
import {
  initialPayScope,
  payDishCount,
  paySelection,
  type TablePayScope,
} from "./table-pay-choice.js";

const money = (amountMinor: string) => formatMoney(amountMinor, "CAD");
/** "0": no tip; "other": an amount the guest types; otherwise one of the Store's percentages. */
type TipChoice = string;
const OTHER = "other";
/** WP-2423 item 2: a payment still confirming after this long gets advice, not a longer wait. */
const confirmingTooLongMs = 60_000;
/** b39: reads of the bill that may fail in a row, re-read by themselves, before the guest is told. */
const transientReadFailures = 3;
/**
 * Batch 40 (v15 live b39): while this phone offers Pay, another phone may pay the whole table. The
 * bill is read again this often (only while the page is in view), so Pay goes away within seconds
 * of the table being paid, not at the table page's next regular read (15 s).
 */
export const tablePayOfferReadMs = 3000;
const tipOf = (choice: TipChoice, typedMinor: string | null): TableTip =>
  choice === "0"
    ? { kind: "None" }
    : choice === OTHER
      ? { kind: "Amount", amountMinor: typedMinor ?? "0" }
      : { kind: "Percent", percent: Number(choice) };
const tipMinor = (choice: TipChoice, subtotalMinor: string) =>
  ((BigInt(subtotalMinor) * BigInt(choice) + 50n) / 100n).toString();

/**
 * WP-2423 item 2: the guest's own tap on Pay failed. No card was offered for this start, so it can say
 * this payment wasn't charged (never "you": they may have paid for something else). What a failed read
 * says stays about the connection only.
 */
function startProblemText(error: unknown) {
  const code = error instanceof TablePaymentClientError ? error.code : "unavailable";
  return code === "unavailable"
    ? t(
        "We couldn’t start the payment just now. This payment hasn’t been charged. Try again, or ask a staff member to take payment.",
      )
    : problemText(error);
}

function problemText(error: unknown) {
  const code = error instanceof TablePaymentClientError ? error.code : "unavailable";
  switch (code) {
    case "not-checking-out":
      return t("Ask a staff member for the bill first; then you can pay it here.");
    case "already-paid":
      return t("This table has already been paid.");
    case "bill-changed":
      return t("The bill just changed. It has been read again: check it and pay again.");
    case "another-guest-paying":
      return t("Someone else at your table is paying the bill right now.");
    case "processing":
      return t("Your payment is still being processed. Check again in a moment.");
    case "not-found":
      return t("This phone isn’t part of the table any more. Ask a staff member for help.");
    case "tips-off":
      return t(
        "The restaurant has just stopped taking tips. Check the bill and pay it without a tip.",
      );
    case "tip-choices-changed":
      return t("The tip choices just changed. Choose a tip again to pay.");
    case "rounds-waiting":
      return t(
        "Some of your table’s dishes are waiting for staff to confirm them. Ask staff to confirm them, then pay.",
      );
    case "dishes-taken":
      return t("Someone at your table just started paying for some of these dishes. Check again.");
    case "split-by-staff":
      return t("Staff split this bill. Pay one of its parts.");
    default:
      return t("We couldn’t reach the payment service. Check your connection and try again.");
  }
}

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER S4: the guest pays the whole table here once staff started
 * checkout — the bill as it stands, the tip chosen once, one card payment. A declined card is
 * tried again; coming back finds the same payment; the receipt is the whole table's.
 */
/** What the table page needs to know: checking out (no more rounds), and paid in full. */
export interface TablePayStatus {
  readonly checkingOut: boolean;
  readonly paid: boolean;
  /** Batch 62: this section shows the table's receipt (one payment paid the whole bill). */
  readonly receipt?: boolean;
}
/**
 * Batch 42: the dishes one split part pays for, as the guest's language lists names ("2 × Har gow,
 * Soy milk" / "2 × 虾饺、豆浆"), with "(shared)" where asked.
 */
/**
 * The "only what I added" option, saying only what is true: what it comes to, or why it is off —
 * none of the bill's dishes came from this phone, theirs can't be priced right now (batch 50: still
 * unpaid, so staff can help), or nothing of theirs is left to pay.
 */
/**
 * The guest's tip choice for this bill, kept in this tab so leaving Your table and coming back (or
 * a reload) keeps it: only the option chosen and what the bill was then (its way of paying and
 * what was left), never an amount or a reference. Batch 63 (Figma 51:223 "小费（不预选）"): it is
 * given back only for that same bill; after a payment or a change of the bill's way of paying it
 * is forgotten, so no tip is ever chosen for the guest. A per-tab convenience the server never
 * relies on.
 */
const TIP_KEY = "bop-table-tip-choice";
const savedTip = (basis: string): string | null => {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(TIP_KEY) ?? "null") as unknown;
    if (value === null || typeof value !== "object") return null;
    const { basis: was, tip } = value as { basis?: unknown; tip?: unknown };
    return was === basis && typeof tip === "string" && /^(0|[1-9][0-9]?)$/u.test(tip) ? tip : null;
  } catch {
    return null;
  }
};
const saveTip = (basis: string | null, tip: string | null) => {
  try {
    if (basis === null || tip === null) window.sessionStorage.removeItem(TIP_KEY);
    else window.sessionStorage.setItem(TIP_KEY, JSON.stringify({ basis, tip }));
  } catch {
    /* A private window may refuse storage; the guest just chooses again after a reload. */
  }
};

export function onlyMineText(
  choices: Pick<NonNullable<TablePaymentView["choices"]>, "mine" | "addedAny" | "mineUnavailable">,
): string {
  if (choices.mine !== null)
    return t("Only what I added ({count} · {amount})", {
      count: String(choices.mine.count),
      amount: money(choices.mine.amountMinor),
    });
  if (choices.mineUnavailable === true)
    return t("Only what I added (can’t be worked out right now — please ask staff)");
  return choices.addedAny === false
    ? t("Only what I added (you have no dishes on the bill)")
    : t("Only what I added (nothing of yours is left to pay)");
}

export function splitPartDishesText(
  dishes: readonly {
    readonly displayName: string;
    readonly quantity: number;
    readonly shared?: boolean;
  }[],
  markShared: boolean,
): string {
  return dishes
    .map(
      (dish) =>
        (dish.quantity > 1 ? `${dish.quantity} × ` : "") +
        dish.displayName +
        (markShared && dish.shared === true ? ` (${t("shared")})` : ""),
    )
    .join(listSeparator());
}

export function TablePayPanel({
  client: provided,
  ownReceipt = null,
  ownPaid = null,
  onStatus,
  readKey,
  onBillChanged,
  onGone,
}: {
  readonly client?: ReturnType<typeof createTablePaymentClient>;
  /**
   * Batch 62 (v15 b61 live, G61 E): this phone's own payment and its refunds, said inside the
   * table's receipt when one payment paid the whole bill (null: nothing to add).
   */
  readonly ownReceipt?: ReactNode;
  /**
   * Batch 63 (design review D62B-01, F02): this phone's own payments while the table still owes
   * the rest ("You paid $23.07 (tip $1.88) · Online by phone" and its lines), said first in Pay
   * the bill once this phone paid a part or some dishes. Read again after each payment.
   */
  readonly ownPaid?: ReactNode;
  /** Called when checkout or payment changes, so the table page reads itself again. */
  readonly onStatus?: (status: TablePayStatus) => void;
  /** A new value reads the table's payment state again. */
  readonly readKey?: number | undefined;
  /** v15 2026-11-02: the bill changed here (points used): the table's page reads it at once too. */
  readonly onBillChanged?: () => void;
  /**
   * b39: this phone may no longer be at an open table (the bill read said so, or kept failing):
   * the table page reads itself again.
   */
  readonly onGone?: () => void;
}) {
  const [client] = useState(() => provided ?? createTablePaymentClient());
  const [view, setView] = useState<TablePaymentView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Owner 2026-11-03: the page says payment is paused while offline, so the button agrees.
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  // AGENTS.md (customer respect): no tip is chosen for the guest; every option, "No tip"
  // included, is offered alike and the guest chooses before paying.
  const [tip, setTip] = useState<TipChoice | null>(null);
  // WP-2423 item 8 ⑦: the amount typed for "Other amount" (never kept across a reload).
  const [typed, setTyped] = useState("");
  /** WP-2423 M132: the large typed tip the guest confirmed (its amount). */
  const [confirmedTip, setConfirmedTip] = useState<string | null>(null);
  // WP-2423 item 8 ④: the part of a split bill this guest pays (null: the next one to pay).
  const [part, setPart] = useState<number | null>(null);
  // WP-2423 同桌结账: which dishes this phone pays (null: what the Store starts with), and how many
  // of each dish when the guest chooses.
  // Batch 63: "Unchosen" once a payment changed the bill: the guest chooses again.
  const [scope, setScope] = useState<TablePayScope | "Unchosen" | null>(null);
  const [quantities, setQuantities] = useState<ReadonlyMap<string, number>>(new Map());
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  // WP-2423 item 2: the card form's one-time value couldn't be read; the guest asks again.
  const [handoffFailed, setHandoffFailed] = useState(false);
  const [handoffAttempt, setHandoffAttempt] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  // One reference is one phone payment: a lost answer is asked again with it, and once that
  // payment is over (paid, declined, or stopped by staff) a new tap is a new payment.
  const operation = useRef<{ key: string; reference: string; opened: boolean } | null>(null);
  const configuration = paymentConfiguration();

  // v15 sweep 38 (b39): a read that fails for a moment (the table being paid or closed right then,
  // the store's side busy) is read again by itself; the guest is told only when it keeps failing.
  const readFailures = useRef(0);
  const [readRetry, setReadRetry] = useState(0);
  const gone = useRef<{ report?: (() => void) | undefined; told: boolean }>({ told: false });
  gone.current.report = onGone;
  const read = useCallback(async (): Promise<TablePaymentView | null> => {
    try {
      const next = await client.read();
      if (next.state === "Paying" && operation.current !== null) operation.current.opened = true;
      readFailures.current = 0;
      gone.current.told = false;
      setView(next);
      setProblem(null);
      return next;
    } catch (error) {
      const code = error instanceof TablePaymentClientError ? error.code : "unavailable";
      // This phone is no longer at an open table (staff closed it): the table page reads itself
      // again and shows how the meal ended, never an error about payment.
      if (code === "not-found") {
        if (!gone.current.told) {
          gone.current.told = true;
          gone.current.report?.();
        }
        return null;
      }
      if (code === "unavailable" || code === "processing") {
        readFailures.current += 1;
        // b39 review: a bill read that keeps failing right after the table was paid or closed
        // asks the table page to read itself too (from the second failure in a row, once per
        // retry), so a table that ended shows its end at once, not after its next regular read.
        if (readFailures.current >= 2) gone.current.report?.();
        if (readFailures.current < transientReadFailures) {
          setReadRetry((value) => value + 1);
          return null;
        }
        setProblem(t("We couldn’t check the bill just now. This page tries again by itself."));
        setReadRetry((value) => value + 1);
        return null;
      }
      setProblem(problemText(error));
      return null;
    }
  }, [client]);
  useEffect(() => {
    void read();
  }, [read, readKey]);
  useEffect(() => {
    if (readRetry === 0) return;
    const timer = window.setTimeout(
      () => void read(),
      Math.min(2000 * readFailures.current, 10_000),
    );
    return () => window.clearTimeout(timer);
  }, [readRetry, read]);
  // Batch 63 (design review D62B-01, Figma 51:223 "小费（不预选）"): nothing is chosen for the
  // guest. Once the bill's way of paying or what is left of it changes (a payment here or by
  // another guest, staff splitting it another way), the part, the dishes and the tip chosen before
  // are cleared, so Pay waits for the guest's own new choice and never offers to pay again with a
  // part and tip picked for the earlier payment.
  const basis =
    view === null
      ? null
      : JSON.stringify([
          view.split?.mode ?? "Whole",
          view.split?.parts.length ?? 0,
          view.split?.paidParts ?? 0,
          view.owed.totalMinor,
          view.split?.remainingMinor ?? null,
        ]);
  const seenBasis = useRef<string | null>(null);
  const settled =
    view !== null && (!view.checkingOut || view.state === "Paid" || view.state === "Closed");
  useEffect(() => {
    if (settled) saveTip(null, null);
  }, [settled]);
  useEffect(() => {
    if (basis === null) return;
    const before = seenBasis.current;
    seenBasis.current = basis;
    if (before === basis) return;
    if (before === null) {
      // The same bill as when the guest chose: their tip is theirs again (never another bill's).
      const saved = savedTip(basis);
      if (saved !== null) setTip(saved);
      return;
    }
    saveTip(null, null);
    setTip(null);
    setTyped("");
    setConfirmedTip(null);
    setPart(null);
    setScope("Unchosen");
    setQuantities(new Map());
  }, [basis]);
  // The table page (its total, its "order more") follows checkout and payment.
  const status =
    view === null
      ? null
      : {
          checkingOut: view.checkingOut,
          paid: view.state === "Paid",
          receipt: view.state === "Paid" && view.receipt !== null,
        };
  // Batch 51 (v15 b50 live): a part of the bill paid (by this phone or another) changes neither
  // fact above, so the table's total lower on the page kept "Paid so far $0.00" until its next
  // 15 s read while this section already said "1 paid so far". What has been paid is part of what
  // is reported, so the page reads its total again as soon as this section learns of a payment.
  const paidSoFar = view?.split?.paidParts ?? 0;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (status === null) return;
    const key = JSON.stringify([status, paidSoFar]);
    if (reported.current === key) return;
    reported.current = key;
    onStatus?.(status);
  }, [status, paidSoFar, onStatus]);
  // After the card was submitted (or while another guest pays), the result is read again.
  useEffect(() => {
    if (view?.state !== "Paying" && view?.state !== "AnotherGuestPaying") return;
    if (view.state === "Paying" && !submitted && configuration?.mode !== "simulation") return;
    const timer = window.setInterval(() => void read(), 3000);
    return () => window.clearInterval(timer);
  }, [view?.state, submitted, configuration?.mode, read]);
  // v15 b12: while the bill is being changed (a comp, a round being sent, a split staff are doing
  // again) nothing can be paid; it is read again until it can, so the guest never has to reload.
  const settling =
    view !== null &&
    (view.state === "NotPaid" || view.state === "Failed") &&
    (!view.consistent || view.split?.stale === true);
  useEffect(() => {
    if (!settling) return;
    const timer = window.setInterval(() => void read(), 5000);
    return () => window.clearInterval(timer);
  }, [settling, read]);
  // Batch 40: Pay is offered here; another phone (or staff) may pay the table meanwhile.
  const offering =
    view !== null &&
    view.checkingOut &&
    (view.state === "NotPaid" || view.state === "Failed") &&
    !settling;
  useEffect(() => {
    if (!offering) return;
    const timer = window.setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void read();
    }, tablePayOfferReadMs);
    return () => window.clearInterval(timer);
  }, [offering, read]);
  // The secure card form's one-time value, once this guest's payment is open (Stripe only).
  useEffect(() => {
    if (view?.state !== "Paying" || configuration?.mode !== "stripe" || clientSecret !== null)
      return;
    let stopped = false;
    setHandoffFailed(false);
    client
      .handoff()
      .then((secret) => {
        if (!stopped) setClientSecret(secret);
      })
      .catch(() => {
        if (!stopped) setHandoffFailed(true);
      });
    return () => {
      stopped = true;
    };
  }, [view?.state, configuration?.mode, clientSecret, client, handoffAttempt]);

  if (view === null) return problem ? <p role="status">{problem}</p> : null;
  if (!view.checkingOut && view.state !== "Paid") return null;

  // WP-2423 item 8 ⑦: the Store's own tip percentages; with tips off the guest pays no tip and is
  // asked nothing. A choice the Store no longer offers counts as not chosen.
  const tipOptions = view.tips.enabled ? ["0", ...view.tips.tierPercents.map(String), OTHER] : [];
  const chosenTip: TipChoice | null = !view.tips.enabled
    ? "0"
    : tip !== null && tipOptions.includes(tip)
      ? tip
      : null;

  // WP-2423 同桌结账: guests paying by dish choose their dishes; a bill staff split, a part.
  const choices = view.choices;
  const byDish = choices !== null && (view.split === null || view.split.mode === "ByGuests");
  const payScope: TablePayScope | null =
    !byDish || choices === null
      ? "Whole"
      : scope === "Unchosen"
        ? null
        : scope === "Mine" && choices.mine === null
          ? null
          : (scope ?? initialPayScope(choices));
  const selection = byDish && payScope !== null ? paySelection(view, payScope, quantities) : null;
  const toPay = view.split?.parts.filter((entry) => entry.status === "ToPay") ?? [];
  const chosen =
    view.split === null || byDish
      ? null
      : // Batch 63: never a part the guest didn't choose (Figma 51:223: 已选 is the guest's).
        (toPay.find((entry) => entry.partNumber === part) ?? null);
  // A split bill: the chosen part's own amount, and its tip on its own share before tax.
  const subtotal = selection
    ? selection.subtotalMinor
    : chosen
      ? chosen.subtotalMinor
      : view.owed.subtotalMinor;
  const amountDue = selection
    ? selection.amountMinor
    : chosen
      ? chosen.amountMinor
      : view.owed.totalMinor;
  // A typed tip is whole cents, and never more than the bill before tax (the server agrees).
  const typedMinor = chosenTip === OTHER ? parseTipAmount(typed.trim()) : null;
  const typedTooHigh = typedMinor !== null && BigInt(typedMinor) > BigInt(subtotal);
  // WP-2423 M132: a typed tip above 30 % of the bill before tax is confirmed before paying.
  const largeTip =
    chosenTip === OTHER &&
    typedMinor !== null &&
    !typedTooHigh &&
    customTipCheck(typedMinor, subtotal) === "confirm";
  const chosenTipMinor =
    chosenTip === null
      ? null
      : chosenTip === OTHER
        ? typedMinor === null || typedTooHigh || (largeTip && confirmedTip !== typedMinor)
          ? null
          : typedMinor
        : tipMinor(chosenTip, subtotal);
  const pay = async () => {
    if (busy || chosenTipMinor === null || chosenTip === null) return;
    if (byDish ? selection === null : view.split !== null && chosen === null) return;
    const key = `${chosenTip}:${chosenTipMinor}:${chosen?.partNumber ?? "table"}:${JSON.stringify(
      selection?.choice ?? null,
    )}`;
    // A failed payment is followed by a new one; a lost answer is retried with the same one.
    // v15 batch 8: so is a payment staff stopped (this page saw it open, and it is no longer).
    const reused = !(
      operation.current?.key !== key ||
      view.state === "Failed" ||
      (operation.current.opened && view.state !== "Paying")
    );
    if (!reused || operation.current === null)
      operation.current = { key, reference: uuidv7(), opened: false };
    const current = operation.current;
    setBusy(true);
    setProblem(null);
    setSubmitted(false);
    setClientSecret(null);
    const startWith = (reference: string) =>
      client.start(
        reference,
        tipOf(chosenTip, typedMinor),
        chosen?.partNumber ?? null,
        selection?.choice ?? null,
      );
    try {
      let started = await startWith(current.reference);
      // v15 batch 8: the reference asked again belonged to a payment already over (staff stopped
      // it before this page heard back). Nothing was charged on it, and the guest pressed Pay
      // to pay now: a new payment, once.
      if (
        reused &&
        started.state !== "Paying" &&
        started.state !== "Paid" &&
        started.state !== "AnotherGuestPaying" &&
        started.checkingOut
      ) {
        operation.current = { key, reference: uuidv7(), opened: false };
        started = await startWith(operation.current.reference);
      }
      if (started.state === "Paying" && operation.current !== null) operation.current.opened = true;
      setView(started);
    } catch (error) {
      // The bill is read again first (its answer clears old messages), then this one is said.
      const again =
        error instanceof TablePaymentClientError && error.code !== "unavailable"
          ? await read()
          : null;
      // Batch 40: the table was paid in full (the read shows its receipt) or closed meanwhile (the
      // table page reads itself again and shows how the meal ended): nothing went wrong to say.
      if (
        error instanceof TablePaymentClientError &&
        (error.code === "not-found" || (error.code === "already-paid" && again?.state === "Paid"))
      ) {
        setProblem(null);
        return;
      }
      // v15 batch 7: another phone started paying some dishes, and what is left can be paid
      // now: the bill changed (read again), never "someone is paying" as if this guest must wait.
      setProblem(
        error instanceof TablePaymentClientError &&
          error.code === "another-guest-paying" &&
          again !== null &&
          again.state !== "AnotherGuestPaying"
          ? problemText(new TablePaymentClientError("bill-changed"))
          : startProblemText(error),
      );
    } finally {
      setBusy(false);
    }
  };
  const simulate = async (outcome: "approve" | "decline") => {
    setBusy(true);
    try {
      setView(await client.simulate(outcome));
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(false);
    }
  };

  if (view.state === "Paid" && view.receipt !== null) {
    const receipt = view.receipt;
    return (
      <section
        className="order-status__card dining-session__receipt"
        aria-labelledby="table-receipt"
      >
        <h2 id="table-receipt">{t("Receipt")}</h2>
        <dl className="order-status__money">
          <div>
            <dt>{t("Your table’s order")}</dt>
            <dd>{money(receipt.roundsMinor)}</dd>
          </div>
          {receipt.pointsUsedMinor !== "0" ? (
            <div>
              <dt>{t("Points used (already taken off)")}</dt>
              <dd>{money(receipt.pointsUsedMinor)}</dd>
            </div>
          ) : null}
          {receipt.tipMinor !== "0" ? (
            <div>
              <dt>{t("Tip")}</dt>
              <dd>{money(receipt.tipMinor)}</dd>
            </div>
          ) : null}
          {receipt.roundingMinor !== "0" ? (
            <div>
              <dt>{t("Cash rounding")}</dt>
              <dd>{money(receipt.roundingMinor)}</dd>
            </div>
          ) : null}
          {/* Batch 61 (v15 b60 live): once some of it went back, what was paid, what went back and
              what was paid after refunds, each named once (实付 never the gross). */}
          {view.refundedMinor === "0" ? (
            <div>
              <dt>{t("Total paid")}</dt>
              <dd>{money(receipt.totalMinor)}</dd>
            </div>
          ) : (
            <>
              <div>
                <dt>{t("Paid")}</dt>
                <dd>{money(receipt.totalMinor)}</dd>
              </div>
              <div>
                <dt>{t("Refunded")}</dt>
                <dd>−{money(view.refundedMinor)}</dd>
              </div>
              <div>
                <dt>{t("Total paid after refunds")}</dt>
                <dd>
                  {money(
                    (BigInt(receipt.totalMinor) > BigInt(view.refundedMinor)
                      ? BigInt(receipt.totalMinor) - BigInt(view.refundedMinor)
                      : 0n
                    ).toString(),
                  )}
                </dd>
              </div>
            </>
          )}
          <div>
            <dt>{t("Paid by")}</dt>
            <dd>
              {receipt.method === "Online"
                ? t("Online by phone")
                : receipt.method === "Cash"
                  ? t("Cash")
                  : t("Card at the table")}
            </dd>
          </div>
        </dl>
        {ownReceipt}
        {/* Batch 62 (v15 b61 live, G61 E): staff since gave some of it back: settled, with a
            refund, never "paid in full" beside it (as the by-dish and split bills say). */}
        <p>
          {view.refundedMinor !== "0"
            ? t("The bill is settled. Staff have since made a refund.")
            : t("Thank you! Your table is paid in full.")}
        </p>
        <MemberJoinPanel />
      </section>
    );
  }
  if (view.state === "Closed") return null;
  // Batch 63 (F02): what this phone paid of a bill paid part by part (or by dish), read again
  // after each of its payments; said first in Pay the bill.
  const paidByYou = view.split?.parts.filter((entry) => entry.byYou).length ?? 0;
  const youPaid =
    paidByYou === 0 || ownPaid === null ? null : (
      <Fragment key={`${paidByYou}:${view.split?.paidParts ?? 0}`}>{ownPaid}</Fragment>
    );
  // WP-2423 item 8 ④: a split bill paid part by part — every part is paid.
  if (view.state === "Paid" && view.split !== null)
    return (
      <section className="order-status__card dining-session__table-pay" aria-labelledby="table-pay">
        <h2 id="table-pay">{t("Pay the bill")}</h2>
        <p role="status">
          {/* Batch 61 (v15 b60 live, CRT60 B/C): staff since gave back some of it: settled, with
              a refund, never "everything is paid" (the payer's own receipt says how much). */}
          {view.refundedMinor !== "0"
            ? view.split.mode === "ByGuests"
              ? t("The bill is settled ({count} payments). Staff have since made a refund.", {
                  count: String(view.split.parts.length),
                })
              : t("The bill is settled ({count} parts). Staff have since made a refund.", {
                  count: String(view.split.parts.length),
                })
            : view.split.mode === "ByGuests"
              ? t("Everything on the bill is paid ({count} payments). Thank you!", {
                  count: String(view.split.parts.length),
                })
              : t("Every part of the bill is paid ({count} parts). Thank you!", {
                  count: String(view.split.parts.length),
                })}
        </p>
        {/* Batch 63 (F06): this phone's own payments, once, with their total. After a refund the
            table page shows the payer's receipt on its own. */}
        {view.refundedMinor === "0" ? youPaid : null}
        <MemberJoinPanel />
      </section>
    );

  // v15 b12: comps (or the guests' points) took off the whole bill — nothing to pay, no tip and no
  // part to choose. Only once the bill matches the Order: while it is being changed it can read $0
  // for a moment, and the panel waits (it is read again by itself).
  if (
    (view.state === "NotPaid" || view.state === "Failed") &&
    view.owed.totalMinor === "0" &&
    (view.consistent || (view.split?.stale === true && view.matchesOrderApartFromSplit)) &&
    (view.split === null || view.split.paidParts === 0)
  )
    return (
      <section className="order-status__card dining-session__table-pay" aria-labelledby="table-pay">
        <h2 id="table-pay">{t("Pay the bill")}</h2>
        <p role="status">{t("There is nothing left to pay on this bill.")}</p>
      </section>
    );
  // v15 b12: the bill changed after it was split (and nothing could split it the same way again):
  // the old parts are never offered; staff split it again, and the panel follows by itself.
  if ((view.state === "NotPaid" || view.state === "Failed") && view.split?.stale === true)
    return (
      <section className="order-status__card dining-session__table-pay" aria-labelledby="table-pay">
        <h2 id="table-pay">{t("Pay the bill")}</h2>
        <p role="status">
          {t(
            "The bill changed after it was split, so the parts are being worked out again. The table now owes {amount}. Ask a staff member to split it again; this page updates by itself.",
            { amount: money(view.owed.totalMinor) },
          )}
        </p>
      </section>
    );

  const total =
    chosenTipMinor === null ? null : (BigInt(amountDue) + BigInt(chosenTipMinor)).toString();
  return (
    <section className="order-status__card dining-session__table-pay" aria-labelledby="table-pay">
      <h2 id="table-pay">{t("Pay the bill")}</h2>
      {view.state === "AnotherGuestPaying" ? (
        <p role="status">{t("Someone else at your table is paying the bill right now.")}</p>
      ) : view.state === "Paying" && view.attempt !== null ? (
        <>
          <p>
            {view.attempt.partNumber !== null && view.split?.mode === "ByGuests"
              ? view.attempt.tipMinor === "0"
                ? t("Paying {amount} for the dishes you chose.", {
                    amount: money(view.attempt.totalMinor),
                  })
                : t("Paying {amount} for the dishes you chose, tip included.", {
                    amount: money(view.attempt.totalMinor),
                  })
              : view.attempt.partNumber === null
                ? view.attempt.tipMinor === "0"
                  ? t("Paying {amount} for the whole table.", {
                      amount: money(view.attempt.totalMinor),
                    })
                  : t("Paying {amount} for the whole table, tip included.", {
                      amount: money(view.attempt.totalMinor),
                    })
                : view.attempt.tipMinor === "0"
                  ? t("Paying {amount} for part {number}.", {
                      amount: money(view.attempt.totalMinor),
                      number: String(view.attempt.partNumber),
                    })
                  : t("Paying {amount} for part {number}, tip included.", {
                      amount: money(view.attempt.totalMinor),
                      number: String(view.attempt.partNumber),
                    })}
          </p>
          {configuration?.mode === "simulation" ? (
            <div className="payment-retry__simulated">
              <button type="button" disabled={busy} onClick={() => void simulate("approve")}>
                {t("Confirm simulated payment")}
              </button>{" "}
              <button type="button" disabled={busy} onClick={() => void simulate("decline")}>
                {t("Decline simulated payment")}
              </button>
            </div>
          ) : configuration?.mode === "stripe" && clientSecret !== null ? (
            submitted ? (
              <>
                <p role="status">{t("Confirming your payment…")}</p>
                <SlowWaitNote active afterMs={confirmingTooLongMs}>
                  {t(
                    "This is taking longer than usual. Don’t pay again: ask a staff member to check this payment.",
                  )}
                </SlowWaitNote>
              </>
            ) : (
              <StripeCardForm
                publishableKey={configuration.publishableKey}
                returnUrl={configuration.returnUrl}
                clientSecret={clientSecret}
                wallets={configuration.wallets}
                onSubmitted={() => setSubmitted(true)}
              />
            )
          ) : configuration === null ? (
            <p role="alert">
              {t(
                "Card payment isn’t available on this phone. Ask a staff member to take the payment.",
              )}
            </p>
          ) : handoffFailed ? (
            // A reload loses "submitted": a card may be confirming, so nothing is said about money.
            <div role="alert">
              <p>{cardFormNotLoadedText()}</p>
              <button
                type="button"
                disabled={!online}
                onClick={() => {
                  setHandoffFailed(false);
                  setHandoffAttempt((count) => count + 1);
                }}
              >
                {t("Try again")}
              </button>
            </div>
          ) : (
            <p role="status">{t("Preparing the secure card form…")}</p>
          )}
        </>
      ) : (
        <>
          {youPaid}
          <MemberPointsAtTable
            onBillChanged={() => {
              void read();
              onBillChanged?.();
            }}
          />
          {view.state === "Failed" ? (
            <p role="alert">
              {t(
                "The payment didn’t go through and nothing was charged. Try again, use another card, or ask a staff member.",
              )}
            </p>
          ) : null}
          {byDish && choices !== null ? (
            <TablePayDishes
              view={view}
              choices={choices}
              scope={payScope}
              quantities={quantities}
              onScope={(next) => {
                setScope(next);
                saveTip(null, null);
                setTip(null);
                setTyped("");
                setConfirmedTip(null);
              }}
              onQuantity={(reference, quantity) =>
                setQuantities((current) => new Map(current).set(reference, quantity))
              }
              selectionMinor={selection?.amountMinor ?? null}
            />
          ) : view.split !== null ? (
            <div className="dining-session__split">
              <p>
                {view.split.mode === "Even"
                  ? t("Your table split the bill evenly in {count} parts.", {
                      count: String(view.split.parts.length),
                    })
                  : view.split.mode === "ByItems"
                    ? t("Your table split the bill by dish, in {count} parts.", {
                        count: String(view.split.parts.length),
                      })
                    : t("Your table split the bill by rounds, in {count} parts.", {
                        count: String(view.split.parts.length),
                      })}
                {wordGap()}
                {t("Pay one part; you can pay another one after it.")}
              </p>
              {/* Batch 63 (Figma 51:223): each part as a dot and dark words — paid (green), being
                  paid (grey), the one this guest chose (accent); a part still to pay is chosen by
                  the guest, never for them. */}
              <fieldset className="dining-session__parts">
                <legend>{t("Which part you pay")}</legend>
                {view.split.parts.map((entry) => {
                  const state =
                    entry.status === "Paid"
                      ? entry.byYou
                        ? "PaidByYou"
                        : "Paid"
                      : entry.status === "Paying" || entry.status === "Mine"
                        ? "Paying"
                        : chosen?.partNumber === entry.partNumber
                          ? "Chosen"
                          : "ToPay";
                  return (
                    <label key={entry.partNumber} data-status={entry.status} data-state={state}>
                      <input
                        type="radio"
                        name="table-part"
                        className="dining-session__choice-input"
                        disabled={entry.status !== "ToPay"}
                        checked={chosen?.partNumber === entry.partNumber}
                        onChange={() => {
                          setPart(entry.partNumber);
                          saveTip(null, null);
                          setTip(null);
                          setTyped("");
                          setConfirmedTip(null);
                        }}
                      />
                      <span className="dining-session__part-dot" aria-hidden="true" />
                      <span className="dining-session__part-words">
                        {t("Part {number} · {amount}", {
                          number: String(entry.partNumber),
                          amount: money(entry.amountMinor),
                        })}
                        {state === "PaidByYou"
                          ? ` · ${t("paid by you")}`
                          : state === "Paid"
                            ? ` · ${t("paid")}`
                            : state === "Paying"
                              ? ` · ${t("being paid")}`
                              : state === "Chosen"
                                ? ` · ${t("chosen")}`
                                : ""}
                      </span>
                      {entry.tables.length === 0 ? null : (
                        // b39: after a merge, which table's rounds this part pays.
                        <small className="dining-session__split-dishes">
                          {t("Table {table} · rounds {rounds}", {
                            table: entry.tables.map(saidTable).join(" + "),
                            rounds: entry.roundNumbers.join(listSeparator()),
                          })}
                        </small>
                      )}
                      {entry.dishes.length === 0 ? null : (
                        <small className="dining-session__split-dishes">
                          {splitPartDishesText(entry.dishes, true)}
                        </small>
                      )}
                    </label>
                  );
                })}
              </fieldset>
              <p>
                {t("{paid} of {count} parts paid · {amount} to go", {
                  paid: String(view.split.paidParts),
                  count: String(view.split.parts.length),
                  amount: money(view.split.remainingMinor),
                })}
              </p>
            </div>
          ) : (
            <dl className="order-status__money">
              <div>
                <dt>{t("Subtotal")}</dt>
                <dd>{money(view.owed.subtotalMinor)}</dd>
              </div>
              {/* v15 b11 (DEC-TAX-WHOLE-RECEIPT): one tax, the bill's own (worked out once on the
                  whole bill), as the receipt and the restaurant's paid bill state it. */}
              <div>
                <dt>{t("Tax")}</dt>
                <dd>{money(view.owed.taxMinor)}</dd>
              </div>
            </dl>
          )}
          {tipOptions.length === 0 ? null : (
            <fieldset className="dining-session__tip">
              <legend>
                {byDish && selection?.choice !== null && selection !== null
                  ? t("Tip (for the dishes you pay)")
                  : view.split !== null && !byDish
                    ? t("Tip (for your part)")
                    : t("Tip (once, for the whole table)")}
              </legend>
              {/* Batch 63 (D62B-04, Figma 51:223): one row of 44 px options, none chosen at
                  first; the amount each comes to is in "You pay" below, once chosen. */}
              <div className="dining-session__tip-row">
                {tipOptions.map((choice) => (
                  <label key={choice} data-chosen={chosenTip === choice ? "" : undefined}>
                    <input
                      type="radio"
                      name="table-tip"
                      className="dining-session__choice-input"
                      // "Other" on screen; said in full to a screen reader (label in name).
                      {...(choice === OTHER ? { "aria-label": t("Other amount") } : {})}
                      value={choice}
                      checked={chosenTip === choice}
                      onChange={() => {
                        setTip(choice);
                        // The typed amount is not kept: after a reload the guest types it again.
                        saveTip(basis, choice === OTHER ? null : choice);
                      }}
                    />
                    {choice === "0" ? t("No tip") : choice === OTHER ? t("Other") : `${choice}%`}
                  </label>
                ))}
              </div>
              <p className="dining-session__tip-basis">
                {t("Based on {amount} before tax", { amount: money(subtotal) })}
              </p>
              {chosenTip === OTHER ? (
                <div className="dining-session__tip-amount">
                  <label htmlFor="table-tip-amount">{t("Tip ({symbol})", { symbol: "$" })}</label>
                  <input
                    id="table-tip-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    aria-invalid={typed.trim() !== "" && chosenTipMinor === null}
                    aria-describedby="table-tip-amount-help"
                  />
                  {largeTip && typedMinor !== null ? (
                    <div role="alert" className="checkout-tip__confirm">
                      <p>
                        {t("Tip {tip} on a {subtotal} order?", {
                          tip: money(typedMinor),
                          subtotal: money(subtotal),
                        })}
                      </p>
                      <button
                        type="button"
                        aria-pressed={confirmedTip === typedMinor}
                        onClick={() => setConfirmedTip(typedMinor)}
                      >
                        {t("Yes, tip {tip}", { tip: money(typedMinor) })}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmedTip(null);
                          document.getElementById("table-tip-amount")?.focus();
                        }}
                      >
                        {t("Change tip")}
                      </button>
                    </div>
                  ) : null}
                  <p id="table-tip-amount-help">
                    {typedTooHigh
                      ? t("A tip can be at most the bill before tax ({amount}).", {
                          amount: money(subtotal),
                        })
                      : typed.trim() !== "" && typedMinor === null
                        ? t("Enter a valid amount with up to two decimal places.")
                        : t("Enter an amount in dollars.")}
                  </p>
                </div>
              ) : null}
            </fieldset>
          )}
          {total === null || chosenTipMinor === null ? null : (
            // Batch 63 (D62B-04, Figma 51:223 你付): what is paid, the tip with its percentage and
            // the total, before the button that takes it.
            <section className="dining-session__you-pay" aria-labelledby="table-you-pay">
              <h3 id="table-you-pay">{t("You pay")}</h3>
              <dl className="order-status__money">
                <div>
                  <dt>
                    {byDish
                      ? payScope === "Whole" && (view.split?.parts.length ?? 0) === 0
                        ? t("Your table’s whole bill")
                        : payScope === "Whole"
                          ? t("The rest of the table")
                          : payScope === "Mine"
                            ? t("What you added")
                            : t("The dishes you chose")
                      : chosen !== null
                        ? t("Part {number}", { number: String(chosen.partNumber) })
                        : t("Your table’s whole bill")}
                  </dt>
                  <dd>{money(amountDue)}</dd>
                </div>
                {chosenTipMinor === "0" ? null : (
                  <div>
                    <dt>
                      {chosenTip === OTHER
                        ? t("Tip")
                        : t("Tip {percent}%", { percent: chosenTip ?? "0" })}
                    </dt>
                    <dd>{money(chosenTipMinor)}</dd>
                  </div>
                )}
                <div className="dining-session__you-pay-total">
                  <dt>{t("Total")}</dt>
                  <dd>{money(total)}</dd>
                </div>
              </dl>
            </section>
          )}
          <button
            type="button"
            className="dining-session__pay-button"
            disabled={
              busy ||
              !online ||
              chosenTipMinor === null ||
              !view.consistent ||
              view.owed.totalMinor === "0" ||
              (byDish ? selection === null : view.split !== null && chosen === null)
            }
            onClick={() => void pay()}
          >
            {busy
              ? t("Starting your payment…")
              : byDish && selection === null
                ? t("Choose the dishes you pay for")
                : !byDish && view.split !== null && chosen === null
                  ? t("Choose the part you pay")
                  : total === null
                    ? chosenTip === OTHER
                      ? t("Enter the tip to pay")
                      : t("Choose a tip to pay")
                    : t("Pay {amount}", { amount: money(total) })}
          </button>
          {view.consistent ? null : (
            // v15 b12: the button never waits without a reason.
            <p role="status">
              {t("The bill is being updated. This page updates by itself in a moment.")}
            </p>
          )}
        </>
      )}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}

/**
 * WP-2423 同桌结账 (DEC-OWNER-DEFAULTS-2026-11-06): which dishes this phone pays — the whole table
 * (or what is left of it), only what it added, or dishes the guest chooses (also for others). What
 * others at the table paid is listed without naming them; this phone's own payments say so.
 */
function TablePayDishes({
  view,
  choices,
  scope,
  quantities,
  onScope,
  onQuantity,
  selectionMinor,
}: {
  readonly view: TablePaymentView;
  readonly choices: NonNullable<TablePaymentView["choices"]>;
  readonly scope: TablePayScope | null;
  readonly quantities: ReadonlyMap<string, number>;
  readonly onScope: (scope: TablePayScope) => void;
  readonly onQuantity: (orderItemReference: string, quantity: number) => void;
  readonly selectionMinor: string | null;
}) {
  const parts = view.split?.parts ?? [];
  const started = parts.length > 0;
  const wholeMinor = paySelection(view, "Whole", quantities)?.amountMinor ?? view.owed.totalMinor;
  const allCount = payDishCount(choices, false);
  return (
    <div className="dining-session__split dining-session__pay-dishes">
      {started ? (
        <>
          <p>
            {t("Your table is paying by dish: {paid} paid so far · {amount} to go.", {
              paid: String(parts.filter((entry) => entry.status === "Paid").length),
              amount: money(view.owed.totalMinor),
            })}
          </p>
          <ul className="dining-session__paid-parts">
            {parts.map((entry) => (
              <li key={entry.partNumber} data-status={entry.status}>
                {splitPartDishesText(entry.dishes, false)} · {money(entry.amountMinor)} ·{" "}
                {entry.status === "Paid"
                  ? entry.byYou
                    ? t("you paid")
                    : t("paid")
                  : t("being paid")}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <fieldset className="dining-session__pay-scope">
        <legend>{t("Which dishes are you paying for?")}</legend>
        <label>
          <input
            type="radio"
            name="table-pay-scope"
            checked={scope === "Whole"}
            onChange={() => onScope("Whole")}
          />{" "}
          {allCount === 1
            ? started
              ? t("The rest of the table (1 dish · {amount})", { amount: money(wholeMinor) })
              : t("The whole table (1 dish · {amount})", { amount: money(wholeMinor) })
            : started
              ? t("The rest of the table ({count} dishes · {amount})", {
                  count: String(allCount),
                  amount: money(wholeMinor),
                })
              : t("The whole table ({count} dishes · {amount})", {
                  count: String(allCount),
                  amount: money(wholeMinor),
                })}
        </label>
        <label>
          <input
            type="radio"
            name="table-pay-scope"
            checked={scope === "Mine"}
            disabled={choices.mine === null}
            onChange={() => onScope("Mine")}
          />{" "}
          {onlyMineText(choices)}
        </label>
        <label>
          <input
            type="radio"
            name="table-pay-scope"
            checked={scope === "Chosen"}
            onChange={() => onScope("Chosen")}
          />{" "}
          {t("Choose dishes to pay for")}
        </label>
        {scope === "Chosen" ? (
          <ul className="dining-session__pay-choose">
            {choices.dishes.map((dish) => {
              const quantity = Math.min(
                quantities.get(dish.orderItemReference) ?? 0,
                dish.unitMinor.length,
              );
              const name = dish.displayName || t("A dish");
              return (
                <li key={dish.orderItemReference}>
                  <span className="dining-session__pay-dish">
                    {name}
                    {dish.mine ? <small> · {t("you added")}</small> : null}
                    <small>
                      {" "}
                      · {money(dish.unitMinor[0] ?? "0")}
                      {dish.unitMinor.length > 1
                        ? ` · ${t("{count} left", { count: String(dish.unitMinor.length) })}`
                        : ""}
                    </small>
                  </span>
                  <span className="dining-session__pay-stepper">
                    <button
                      type="button"
                      aria-label={t("One less {dish}", { dish: name })}
                      disabled={quantity === 0}
                      onClick={() => onQuantity(dish.orderItemReference, quantity - 1)}
                    >
                      −
                    </button>
                    <output aria-live="polite">{quantity}</output>
                    <button
                      type="button"
                      aria-label={t("One more {dish}", { dish: name })}
                      disabled={quantity >= dish.unitMinor.length}
                      onClick={() => onQuantity(dish.orderItemReference, quantity + 1)}
                    >
                      +
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <p className="dining-session__pay-note">
          {scope === "Whole"
            ? t("Amounts include tax.")
            : t("Dishes you don’t choose stay for the others at your table. Amounts include tax.")}
          {scope === "Chosen" && selectionMinor !== null
            ? ` ${t("Chosen: {amount}", { amount: money(selectionMinor) })}`
            : ""}
        </p>
      </fieldset>
    </div>
  );
}
