import { useEffect, useRef, useState } from "react";
import {
  createTableClosePlanClient,
  resolvesOnConfirm,
  type TableClosePlan,
  type TableCloseRound,
} from "./dining-table-close-plan-client.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { storeTime } from "./StoreTime.js";

const cad = (minor: string | bigint) => {
  const value = BigInt(minor);
  return `CAD ${(value / 100n).toString()}.${(value % 100n).toString().padStart(2, "0")}`;
};
const items = (count: number) => `${String(count)} item${count === 1 ? "" : "s"}`;

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
  const name = `Round ${String(round.sequence)}`;
  const machine = round.refund?.method === "CardMachine";
  switch (round.state) {
    case "NotPaid":
      return round.cancelsAt === null
        ? `${name}: not paid, no money was taken. It is cancelled automatically when its payment time ends.`
        : Date.parse(round.cancelsAt) <= now
          ? `${name}: not paid, no money was taken. It is being cancelled automatically now; check again in a minute.`
          : `${name}: not paid, no money was taken. It is cancelled automatically at ${storeTime(round.cancelsAt, timeZone)}; the table can be closed after that.`;
    case "PaymentInProgress":
      return `${name}: the guest's online payment has no result yet. Check again in a few minutes.`;
    case "PaidNotSent":
      return machine
        ? `${name}: paid ${cad(round.refund?.amountMinor ?? "0")} on the card machine but never sent to the kitchen. It will be cancelled; then refund it on the card machine and record that on the Orders page.`
        : `${name}: paid ${cad(round.refund?.amountMinor ?? "0")} online but never sent to the kitchen. It will be cancelled and the guest refunded.`;
    case "AlreadyRefunded":
      return `${name}: never sent to the kitchen and already refunded in full. It will be closed; nothing more is refunded.`;
    case "NotStarted":
      // Refunded in full item by item already: nothing is left to refund or record.
      if (round.refund !== null && BigInt(round.refund.amountMinor) === 0n)
        return `${name}: ${items(round.openItemCount)} not started in the kitchen, already refunded in full. It will be cancelled; nothing is left to refund.`;
      return machine
        ? `${name}: ${items(round.openItemCount)} not started in the kitchen. It will be cancelled; then refund ${cad(round.refund?.amountMinor ?? "0")} on the card machine and record that on the Orders page.`
        : `${name}: ${items(round.openItemCount)} not started in the kitchen. It will be cancelled and ${cad(round.refund?.amountMinor ?? "0")} refunded to the guest.`;
    case "PartlyStarted":
      return (
        `${name}: ${items(round.cancellableItemReferences.length)} not started will be cancelled and ` +
        (partlyRefund === null ? "refunded" : `${cad(partlyRefund)} refunded`) +
        `. ${items(round.startedItemCount)} already being made: serve them, or mark them served on the Orders page.`
      );
    case "BeingMade":
      return `${name}: ${items(round.openItemCount)} already being made or paid on the card machine. Serve them, or mark them served on the Orders page.`;
    case "RefundOnCardMachine":
      return `${name}: cancelled. Refund ${cad(round.refund?.amountMinor ?? "0")} on the card machine and record it on the Orders page.`;
    case "Refunding":
      return `${name}: cancelled. The guest's online refund is still being made; check again in a few minutes.`;
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
}: {
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
  readonly onPlan: (plan: { open: number; blockers: readonly string[] } | null) => void;
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
        onPlanRef.current({ open: plan.rounds.length, blockers: plan.closeBlockers });
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

  if (load.kind === "Loading") return <p role="status">Checking which rounds are still open…</p>;
  if (load.kind === "Failed")
    return load.denied ? null : (
      <p role="status">
        Couldn&apos;t check the table&apos;s open rounds. Check the connection and try again.{" "}
        <button type="button" onClick={() => setReload((value) => value + 1)}>
          Check again
        </button>
      </p>
    );
  const plan = load.plan;
  if (plan.rounds.length === 0) return null;
  const now = Date.now();
  const actionable = plan.rounds.filter(resolvesOnConfirm);
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
    <section aria-label="Guests have left" className="dining-table-guests-left">
      <h5>If the guests have left</h5>
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
      {actionable.length > 0 ? (
        <>
          <p>
            Closing out{" "}
            {actionable.length === 1 ? "this round" : `these ${String(actionable.length)} rounds`}{" "}
            {online > 0n || unknownPartly ? (
              <>
                refunds {cad(online)} to the guest online
                {unknownPartly ? " plus the items not started" : ""}
                {machine > 0n ? ` and ${cad(machine)} to refund on the card machine` : ""}
              </>
            ) : machine > 0n ? (
              `leaves ${cad(machine)} to refund on the card machine`
            ) : (
              "refunds nothing more: what was paid has already been refunded"
            )}
            . The reason recorded is &ldquo;Guests left&rdquo;.
          </p>
          {run === "Unknown" || run === "FullSignInRequired" ? null : (
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={run === "Running" || locked}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              The guests at table {tableLabel} have left
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
              ? "Closing out the rounds…"
              : run === "Unknown" || run === "FullSignInRequired"
                ? "Try again"
                : actionable.length === 1
                  ? "Cancel the round and refund"
                  : `Cancel ${String(actionable.length)} rounds and refund`}
          </button>
        </>
      ) : null}
      {run === "FullSignInRequired" ? <FullSignInPrompt csrf={csrf} fetcher={fetcher} /> : null}
      {run === "Unknown" ? (
        <p role="alert">
          We couldn&apos;t confirm every round was closed out (the connection may have dropped). Try
          again; nothing is cancelled or refunded twice.
        </p>
      ) : run === "Denied" ? (
        <p role="alert">
          Your access doesn&apos;t allow cancelling rounds. Ask an Owner or Store Manager.
        </p>
      ) : run === "Refused" ? (
        <p role="alert">
          A round changed while closing out (for example the kitchen started it). The list above is
          up to date; check it and try again.
        </p>
      ) : null}
    </section>
  );
}
