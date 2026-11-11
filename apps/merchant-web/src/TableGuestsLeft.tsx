import { t, saidTable } from "./i18n/i18n.js";
import { KitchenMayHaveStartedNote, kitchenMayHaveStartedText } from "./kitchen-cancel-warning.js";
import { useEffect, useRef, useState } from "react";
import {
  createTableClosePlanClient,
  resolvesOnConfirm,
  type TableClosePlan,
  type TableCloseRound,
} from "./dining-table-close-plan-client.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { orderMoney } from "./order-money.js";
import { storeTime } from "./StoreTime.js";

/** The plan's amounts are the store's CAD minor units; the app's one money format ("$11.30"). */
const cad = (minor: string | bigint) =>
  orderMoney({ amountMinor: BigInt(minor).toString(), currencyCode: "CAD" });
const items = (count: number) =>
  t("{count} item{value}", { count: String(count), value: count === 1 ? "" : "s" });
/** Started items by kitchen readiness: still being made, or marked ready and waiting to be served. */
const startedText = (started: number, ready: number) =>
  ready === 0
    ? t("{started} already being made", { started: items(started) })
    : ready === started
      ? t("{ready} ready to serve", { ready: items(ready) })
      : t("{value} being made and {ready} ready to serve", {
          value: items(started - ready),
          ready: String(ready),
        });

/**
 * WP-2423 live minor 21: what closing out refunds when no money is left to refund, said from the
 * rounds themselves. A round never paid took no money; a round whose online payment hasn't
 * finished may still finish (it then stays open, see "PaymentInProgress" below), so for it staff
 * are told only that no payment has finished — never that no money was taken.
 */
export function nothingRefundedText(actionable: readonly TableCloseRound[]): string {
  const inProgress = actionable.some((round) => round.state === "PaymentInProgress");
  const paid = actionable.some(
    (round) => round.state !== "NotPaid" && round.state !== "PaymentInProgress",
  );
  if (!paid)
    return inProgress
      ? t("refunds nothing: no payment has finished")
      : t("refunds nothing: no money was taken");
  if (actionable.every((round) => round.state !== "NotPaid" && round.state !== "PaymentInProgress"))
    return t("refunds nothing more: what was paid has already been refunded");
  return inProgress
    ? t(
        "refunds nothing more: no payment has finished for the unpaid rounds, and what was paid has already been refunded",
      )
    : t(
        "refunds nothing more: the unpaid rounds took no money, and what was paid has already been refunded",
      );
}

/**
 * WP-2423 M123 (v15 live check): what closing out the rounds does, as whole sentences in the staff
 * language (the Chinese text was pieced from "Closing out" + "this round" + "refunds …" before).
 * `online`/`machine`: the amounts to refund, already as money text; null when there is none.
 */
export function closeOutSummaryText(
  actionable: readonly TableCloseRound[],
  amounts: {
    readonly online: string | null;
    readonly unknownPartly: boolean;
    readonly machine: string | null;
  },
): string {
  const rounds =
    actionable.length === 1
      ? t("this round")
      : t("these {length} rounds", { length: String(actionable.length) });
  const what =
    amounts.online !== null
      ? t("Closing out {rounds} refunds {online} to the guest online{value}{value2}.", {
          rounds,
          online: amounts.online,
          value: amounts.unknownPartly ? t(" plus the items not marked started") : "",
          value2:
            amounts.machine !== null
              ? t(" and {machine} to refund on the card machine", { machine: amounts.machine })
              : "",
        })
      : amounts.machine !== null
        ? t("Closing out {rounds} leaves {machine} to refund on the card machine.", {
            rounds,
            machine: amounts.machine,
          })
        : t("Closing out {rounds} {refunds}.", {
            rounds,
            refunds: nothingRefundedText(actionable),
          });
  return t("{what} The reason recorded is “Guests left”.", { what });
}

/**
 * WP-2423 M123: the close-out button says "and refund" only when a round took money; rounds that
 * were never paid (or are waiting for staff, or whose payment never finished) are only cancelled.
 */
export function closeOutButtonText(actionable: readonly TableCloseRound[]): string {
  const tookMoney = actionable.some(
    (round) =>
      round.state !== "NotPaid" &&
      round.state !== "PaymentInProgress" &&
      round.state !== "WaitingForStaff",
  );
  if (actionable.length === 1)
    return tookMoney ? t("Cancel the round and refund") : t("Cancel the round");
  const length = String(actionable.length);
  return tookMoney
    ? t("Cancel {length} rounds and refund", { length })
    : t("Cancel {length} rounds", { length });
}

/**
 * DEC-TABLE-CLOSE-GUESTS-LEFT: one round of a table whose guests left, in staff words — what it is
 * and what closing the table does with it. `partlyRefund`: the line refund the item cancellation
 * previewed (PartlyStarted).
 */
export function guestsLeftRoundText(
  round: TableCloseRound,
  timeZone: string | undefined,
  now: number,
  partlyRefund: string | null = null,
): string {
  const name = t("Round {sequence}", { sequence: String(round.sequence) });
  const machine = round.refund?.method === "CardMachine";
  switch (round.state) {
    case "NotPaid":
      return round.cancelsAt !== null && Date.parse(round.cancelsAt) <= now
        ? t(
            "{name}: not paid, no money was taken. It is being cancelled automatically now; check again in a minute.",
            { name: name },
          )
        : t(
            "{name}: not paid, no money was taken. It will be cancelled now (otherwise automatically{value}); nothing is refunded.",
            {
              name: name,
              value: round.cancelsAt === null ? "" : " at " + storeTime(round.cancelsAt, timeZone),
            },
          );
    case "WaitingForStaff":
      // WP-2423 item 8 ⑤: never sent to the kitchen, never cancelled by time; closing cancels it.
      return t(
        "{name}: waiting for your OK, never sent to the kitchen, nothing paid. It will be cancelled now; nothing is refunded.",
        { name: name },
      );
    case "PaymentInProgress":
      // WP-2423 abandoned payment: the guest started paying online and didn't finish.
      return t(
        "{name}: the guest started paying online but hasn't finished. It will be cancelled now and their unfinished payment stopped, so they can't be charged for it. If it was in fact paid, it stays open and shows here again.",
        { name: name },
      );
    case "PaidNotSent":
      return machine
        ? t(
            "{name}: paid {value} on the card machine but never sent to the kitchen. It will be cancelled; then refund it on the card machine and record that on the Orders page.",
            { name: name, value: cad(round.refund?.amountMinor ?? "0") },
          )
        : t(
            "{name}: paid {value} online but never sent to the kitchen. It will be cancelled and the guest refunded.",
            { name: name, value: cad(round.refund?.amountMinor ?? "0") },
          );
    case "AlreadyRefunded":
      return t(
        "{name}: never sent to the kitchen and already refunded in full. It will be closed; nothing more is refunded.",
        { name: name },
      );
    case "NotStarted":
      // Refunded in full item by item already: nothing is left to refund or record.
      if (round.refund !== null && BigInt(round.refund.amountMinor) === 0n)
        return t(
          "{name}: {openItemCount} not marked started in the kitchen, already refunded in full. It will be cancelled; nothing is left to refund.",
          { name: name, openItemCount: items(round.openItemCount) },
        );
      return machine
        ? t(
            "{name}: {openItemCount} not marked started in the kitchen. It will be cancelled; then refund {value} on the card machine and record that on the Orders page.",
            {
              name: name,
              openItemCount: items(round.openItemCount),
              value: cad(round.refund?.amountMinor ?? "0"),
            },
          )
        : t(
            "{name}: {openItemCount} not marked started in the kitchen. It will be cancelled and {value} refunded to the guest.",
            {
              name: name,
              openItemCount: items(round.openItemCount),
              value: cad(round.refund?.amountMinor ?? "0"),
            },
          );
    case "PartlyStarted":
      return (
        t("{name}: {length} not marked started will be cancelled and ", {
          name: name,
          length: items(round.cancellableItemReferences.length),
        }) +
        (partlyRefund === null
          ? "refunded"
          : t("{partlyRefund} refunded", { partlyRefund: cad(partlyRefund) })) +
        `. ${startedText(round.startedItemCount, round.readyItemCount)}: serve them, or mark them served on the Orders page.`
      );
    case "BeingMade":
      // Paid on the card machine, items not started yet cannot be cancelled one by one.
      return round.startedItemCount === round.openItemCount
        ? t("{name}: {openItemCount}. Serve them, or mark them served on the Orders page.", {
            name: name,
            openItemCount: startedText(round.openItemCount, round.readyItemCount),
          })
        : round.readyItemCount === 0
          ? t(
              "{name}: {openItemCount} already being made or paid on the card machine. Serve them, or mark them served on the Orders page.",
              { name: name, openItemCount: items(round.openItemCount) },
            )
          : t(
              "{name}: {value} being made or paid on the card machine and {readyItemCount} ready to serve. Serve them, or mark them served on the Orders page.",
              {
                name: name,
                value: items(round.openItemCount - round.readyItemCount),
                readyItemCount: String(round.readyItemCount),
              },
            );
    case "OnTableBill":
      // v15 2026-10-28: a round of a table that pays at the end, not paid yet.
      return t(
        "{name}: {openItemCount} not served yet. Serve them when they're ready (Serve all on the table). Dishes the kitchen hasn't marked started can come off the bill before the table pays.",
        { name: name, openItemCount: items(round.openItemCount) },
      );
    case "PaidWithTable":
      // v15 2026-10-28: paid with the table's one payment; dishes still to come.
      return t(
        "{name}: paid with the table, {openItemCount} not served yet. Serve them when they're ready, then close the table. If the guests left without them, a manager gives the money back from the table's payment.",
        { name: name, openItemCount: items(round.openItemCount) },
      );
    case "RefundOnCardMachine":
      return t(
        "{name}: cancelled. Refund {value} on the card machine and record it on the Orders page.",
        { name: name, value: cad(round.refund?.amountMinor ?? "0") },
      );
    case "Refunding":
      return t(
        "{name}: cancelled. The guest's online refund is still being made; check again in a few minutes.",
        { name: name },
      );
  }
}

type Load =
  | { readonly kind: "Loading" }
  | { readonly kind: "Ready"; readonly plan: TableClosePlan }
  | { readonly kind: "Failed"; readonly denied: boolean };
type Run = null | "Running" | "Unknown" | "Refused" | "Denied" | "FullSignInRequired";

/**
 * DEC-TABLE-CLOSE-GUESTS-LEFT (DIN-FLOOR-BOARD close dialog): a manager closing a table whose
 * guests left sees every round still open, what closing does with each (cancel and refund through
 * the existing staff cancellations with the reason "Guests left", or what is left to do by hand)
 * and the refunds before confirming. Each round keeps one operation, so a lost answer is retried
 * without doing anything twice; the plan is read again after each step.
 */
/**
 * DEC-KITCHEN-ONE-TAP: the not-started round the kitchen has had long enough that it may already be
 * making it, so the note names that round's wait (not the first round's, which may be fresh).
 */
export function kitchenMayHaveStartedRound(
  rounds: readonly TableCloseRound[],
  now: number,
): TableCloseRound | undefined {
  return rounds.find(
    (round) =>
      (round.state === "NotStarted" || round.state === "PartlyStarted") &&
      kitchenMayHaveStartedText(round.kitchenReceivedAt, now) !== null,
  );
}

export function TableGuestsLeft({
  orderReference,
  diningSessionReference,
  tableLabel,
  csrf,
  timeZone,
  locked,
  attempt,
  onPlan,
  onResolved,
  fetcher,
  canResolve = true,
}: {
  /**
   * WP-2423 item 8 ①: closing out rounds cancels and refunds them (money), so only a manager is
   * offered it; a server sees what is still open and whom to ask.
   */
  readonly canResolve?: boolean;
  readonly orderReference: string;
  readonly diningSessionReference: string;
  readonly tableLabel: string;
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  readonly locked: boolean;
  /** Re-read when the parent re-checks the table. */
  readonly attempt: number;
  /**
   * How many rounds still keep the table open and what else stops its Order closing (server codes
   * of the close evaluation); null: unknown, the plan could not be read.
   */
  /**
   * The plan's open rounds and other reasons, and (v15 2026-10-28) whether every open round was
   * paid with the table, whose own guidance replaces the generic "serve or cancel" line.
   */
  readonly onPlan: (
    plan: { open: number; blockers: readonly string[]; paidWithTable: boolean } | null,
  ) => void;
  /** After rounds were cancelled: re-check the table. */
  readonly onResolved: () => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const [load, setLoad] = useState<Load>({ kind: "Loading" });
  const [reload, setReload] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [run, setRun] = useState<Run>(null);
  const [previews, setPreviews] = useState<ReadonlyMap<string, string | null>>(new Map());
  const operations = useRef(new Map<string, string>());
  const onPlanRef = useRef(onPlan);
  onPlanRef.current = onPlan;
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: "Loading" });
    const client = createTableClosePlanClient(fetcher);
    client
      .load({ orderReference, diningSessionReference }, csrf, controller.signal)
      .then(async (plan) => {
        if (controller.signal.aborted) return;
        const next = new Map<string, string | null>();
        for (const round of plan.rounds)
          if (round.state === "PartlyStarted")
            next.set(round.orderBatchReference, await client.previewItems(plan, round, csrf));
        if (controller.signal.aborted) return;
        setPreviews(next);
        setLoad({ kind: "Ready", plan });
        onPlanRef.current({
          open: plan.rounds.length,
          blockers: plan.closeBlockers,
          paidWithTable:
            plan.rounds.length > 0 && plan.rounds.every((round) => round.state === "PaidWithTable"),
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({
          kind: "Failed",
          denied: (error as { code?: unknown } | null)?.code === "PermissionDenied",
        });
        onPlanRef.current(null);
      });
    return () => controller.abort();
  }, [orderReference, diningSessionReference, csrf, fetcher, attempt, reload]);

  if (load.kind === "Loading")
    return <p role="status">{t("Checking which rounds are still open…")}</p>;
  if (load.kind === "Failed")
    return load.denied ? null : (
      <p role="status">
        {t("Couldn't check the table's open rounds. Try again.")}{" "}
        <button type="button" onClick={() => setReload((value) => value + 1)}>
          {t("Check again")}
        </button>
      </p>
    );
  const plan = load.plan;
  if (plan.rounds.length === 0) return null;
  // v15 2026-10-28: a table that pays at the end — what staff do is serve its dishes (nothing to
  // cancel or refund round by round here), so everyone sees it, not "Check again".
  if (
    plan.rounds.every((round) => round.state === "OnTableBill" || round.state === "PaidWithTable")
  )
    return (
      <section aria-label={t("Dishes still to serve")} className="dining-table-guests-left">
        <ul>
          {plan.rounds.map((round) => (
            <li key={round.orderBatchReference} data-round-state={round.state}>
              {guestsLeftRoundText(round, timeZone, Date.now(), null)}
            </li>
          ))}
        </ul>
      </section>
    );
  if (!canResolve)
    return (
      <p role="note" className="dining-table-guests-left">
        {t(
          "If the guests have left, a manager closes out the open rounds (cancelling or refunding them).",
        )}
      </p>
    );
  const now = Date.now();
  const actionable = plan.rounds.filter(resolvesOnConfirm);
  const kitchenHasIt = kitchenMayHaveStartedRound(actionable, now);
  const partly = plan.rounds
    .filter((round) => round.state === "PartlyStarted")
    .map((round) => previews.get(round.orderBatchReference) ?? null);
  const online =
    BigInt(plan.totals.onlineMinor) +
    partly.reduce((sum, value) => sum + (value === null ? 0n : BigInt(value)), 0n);
  const machine = BigInt(plan.totals.cardMachineMinor);
  const unknownPartly = partly.some((value) => value === null);

  const confirm = async () => {
    if (run === "Running" || (!confirmed && run !== "Unknown" && run !== "FullSignInRequired"))
      return;
    setRun("Running");
    const client = createTableClosePlanClient(fetcher);
    let current = plan;
    // One round at a time, from the plan as it is now (each cancellation moves the Order version).
    for (let step = 0; step < 50; step += 1) {
      const round = current.rounds.find(resolvesOnConfirm);
      if (round === undefined) break;
      const key = `${round.orderBatchReference}:${round.state}`;
      let operation = operations.current.get(key);
      if (operation === undefined) {
        operation = client.newOperation();
        operations.current.set(key, operation);
      }
      const outcome = await client.resolve(current, round, operation, csrf);
      if (outcome === "Unknown" || outcome === "FullSignInRequired") {
        setRun(outcome);
        // Show what is actually still open (rounds closed out before the failure are gone); the
        // same operation is kept for this round, so trying again never repeats it. The table
        // itself is re-checked once the close-out finishes (this dialog stays as it is meanwhile).
        setReload((value) => value + 1);
        return;
      }
      operations.current.delete(key);
      if (outcome === "Denied" || outcome === "Refused") {
        setRun(outcome);
        setConfirmed(false);
        setReload((value) => value + 1);
        onResolved();
        return;
      }
      try {
        current = await client.load({ orderReference, diningSessionReference }, csrf);
      } catch {
        break;
      }
    }
    setRun(null);
    setConfirmed(false);
    setReload((value) => value + 1);
    onResolved();
  };

  return (
    <section aria-label={t("Guests have left")} className="dining-table-guests-left">
      <h5>{t("If the guests have left")}</h5>
      <ul>
        {plan.rounds.map((round) => (
          <li key={round.orderBatchReference} data-round-state={round.state}>
            {guestsLeftRoundText(
              round,
              timeZone,
              now,
              previews.get(round.orderBatchReference) ?? null,
            )}
          </li>
        ))}
      </ul>
      {kitchenHasIt ? (
        <KitchenMayHaveStartedNote receivedAt={kitchenHasIt.kitchenReceivedAt} now={now} />
      ) : null}
      {actionable.length > 0 ? (
        <>
          <p>
            {closeOutSummaryText(actionable, {
              online: online > 0n || unknownPartly ? cad(online) : null,
              unknownPartly,
              machine: machine > 0n ? cad(machine) : null,
            })}
          </p>
          {run === "Unknown" || run === "FullSignInRequired" ? null : (
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={run === "Running" || locked}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {t("The guests at table {tableLabel} have left", {
                tableLabel: saidTable(tableLabel),
              })}
            </label>
          )}
          <button
            type="button"
            data-variant="destructive"
            disabled={
              run === "Running" ||
              (run !== "Unknown" && run !== "FullSignInRequired" && (!confirmed || locked))
            }
            onClick={() => void confirm()}
          >
            {run === "Running"
              ? t("Closing out the rounds…")
              : run === "Unknown" || run === "FullSignInRequired"
                ? t("Try again")
                : closeOutButtonText(actionable)}
          </button>
        </>
      ) : null}
      {run === "FullSignInRequired" ? <FullSignInPrompt csrf={csrf} fetcher={fetcher} /> : null}
      {run === "Unknown" ? (
        <p role="alert">
          {t(
            "We couldn't confirm every round was closed out (the connection may have dropped). Try again; nothing is cancelled or refunded twice.",
          )}
        </p>
      ) : run === "Denied" ? (
        <p role="alert">
          {t("Your access doesn't allow cancelling rounds. Ask an Owner or Store Manager.")}
        </p>
      ) : run === "Refused" ? (
        <p role="alert">
          {t(
            "A round changed while closing out (for example the kitchen started it). The list above is up to date; check it and try again.",
          )}
        </p>
      ) : null}
    </section>
  );
}
