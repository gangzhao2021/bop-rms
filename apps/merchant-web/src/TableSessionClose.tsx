import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  createDiningProgressClient,
  DiningProgressError,
  type DiningProgress,
} from "./dining-progress-client.js";
import {
  createDiningOrderCloseClient,
  DiningOrderCloseClientError,
} from "./dining-order-close-client.js";
import {
  createDiningSessionCloseClient,
  DiningSessionCloseClientError,
} from "./dining-session-close-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { TableGuestsLeft } from "./TableGuestsLeft.js";
import { closeReasonTexts } from "./dining-close-reasons.js";
import type { StaffDiningTable, StaffDiningTableSession } from "./dining-session-client.js";

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

/**
 * WP-2423 D4: what still stops a table's session from being closed, in staff words, each with
 * what to do. Empty when the table can be closed. The closing commands check the same facts
 * (every round served or cancelled, the Order paid and closed) and refuse otherwise.
 */
export function tableCloseBlockers(
  table: Pick<StaffDiningTable, "staffRoundsAwaitingPayment">,
  progress: Pick<DiningProgress, "items"> | null,
): readonly string[] {
  const blockers: string[] = [];
  const awaiting = table.staffRoundsAwaitingPayment.length;
  if (awaiting > 0)
    blockers.push(
      `${plural(awaiting, "round", "rounds")} entered by staff still ${awaiting === 1 ? "waits" : "wait"} for card-machine payment. Record the payment on the Orders page, or cancel the round there.`,
    );
  const open = (progress?.items ?? []).filter((item) => item.remainingQuantity > 0);
  const waiting = open.filter((item) => item.phase === "Submitted").length;
  const unserved = open.filter((item) =>
    ["Accepted", "InProgress", "Ready"].includes(item.phase),
  ).length;
  if (waiting > 0)
    blockers.push(
      `${plural(waiting, "item is", "items are")} waiting for payment or for the kitchen to accept ${waiting === 1 ? "it" : "them"}. Take the payment or cancel the round on the Orders page.`,
    );
  if (unserved > 0)
    blockers.push(
      `${plural(unserved, "item hasn't", "items haven't")} been served yet. Mark ${unserved === 1 ? "it" : "them"} served or cancel ${unserved === 1 ? "it" : "them"} on the Orders page.`,
    );
  return blockers;
}

/** One operation per closing step; an unconfirmed result is retried with the same ones. */
export interface TableClosePlan {
  begin?: ReturnType<ReturnType<typeof createDiningSessionCloseClient>["prepare"]>;
  order?: ReturnType<ReturnType<typeof createDiningOrderCloseClient>["prepare"]>;
  finalize?: ReturnType<ReturnType<typeof createDiningSessionCloseClient>["prepare"]>;
  readonly done: Set<"begin" | "order" | "finalize">;
}

/**
 * WP-2423 D4: close a table's session with the existing commands, in order — stop new orders
 * (Begin), close its completed Order, then release the table (Finalize). Steps already confirmed
 * are not sent again; a step whose result was lost is resent with the same operation.
 */
export async function closeTableSession(input: {
  readonly diningSessionReference: string;
  readonly session: StaffDiningTableSession;
  readonly progress: DiningProgress | null;
  readonly plan: TableClosePlan;
  readonly csrf: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch | undefined;
}): Promise<void> {
  const { plan, session, progress, csrf, signal } = input;
  const sessions = createDiningSessionCloseClient(input.fetcher);
  let version = session.version;
  if (session.phase === "Active") {
    plan.begin ??= sessions.prepare({
      operationReference: serviceOperationReference(),
      diningSessionReference: input.diningSessionReference,
      action: "Begin",
      expectedSessionVersion: version,
    });
    if (!plan.done.has("begin")) {
      await plan.begin.execute(csrf, signal);
      plan.done.add("begin");
    }
    version += 1;
  }
  // WP-2423 item 2: an Order whose every round was cancelled is closed too (nothing was served).
  if (
    progress !== null &&
    progress.closureStatus === "Open" &&
    (progress.phase === "Fulfilled" || progress.phase === "Cancelled")
  ) {
    plan.order ??= createDiningOrderCloseClient(input.fetcher).prepare({
      operationReference: serviceOperationReference(),
      orderReference: progress.orderReference,
      expectedOrderVersion: progress.currentOrderVersion,
      expectedClosureVersion: progress.closureVersion,
      reasonCode: progress.phase === "Cancelled" ? "ORDER_CANCELLED" : "ORDER_COMPLETED",
    });
    if (!plan.done.has("order")) {
      await plan.order.execute(csrf, signal);
      plan.done.add("order");
    }
  }
  plan.finalize ??= sessions.prepare({
    operationReference: serviceOperationReference(),
    diningSessionReference: input.diningSessionReference,
    action: "Finalize",
    expectedSessionVersion: version,
  });
  await plan.finalize.execute(csrf, signal);
  plan.done.add("finalize");
}

type Check =
  | { readonly kind: "Checking" }
  | { readonly kind: "Ready"; readonly progress: DiningProgress | null }
  | { readonly kind: "Failed"; readonly denied: boolean; readonly missing?: boolean };
type Outcome =
  | null
  | "Unknown"
  | "Refused"
  | "Denied"
  | { readonly kind: "NotReady"; readonly reasons: readonly string[] };

/**
 * WP-2423 D4 (DIN-FLOOR-BOARD): close a table's dining session from the Tables page — stop new
 * orders, close its completed Order and release the table — with the existing closing commands.
 * The table's rounds are checked first; anything unpaid or unserved is explained with what to do,
 * and nothing is offered until it is resolved. A result that is not confirmed is retried with the
 * same requests; a refusal re-checks the table.
 */
export function TableSessionClose({
  table,
  session,
  csrf,
  locked,
  onBusy,
  onClosed,
  onRefresh,
  fetcher,
  timeZone,
}: {
  /** The Store's time zone, for when an unpaid round is cancelled automatically. */
  readonly timeZone?: string | undefined;
  readonly table: StaffDiningTable;
  readonly session: StaffDiningTableSession;
  readonly csrf: string;
  readonly locked: boolean;
  readonly onBusy: (busy: boolean) => void;
  /** After the table was released: refresh the tables. */
  readonly onClosed: () => void;
  /** After a refusal: re-read the tables (a step may have stopped ordering already). */
  readonly onRefresh: () => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const [check, setCheck] = useState<Check>(
    session.orderReference === null ? { kind: "Ready", progress: null } : { kind: "Checking" },
  );
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<AbortController | null>(null);
  // One operation per step and intent; an unconfirmed result is retried with the same ones.
  const steps = useRef<TableClosePlan>({ done: new Set() });
  const orderReference = session.orderReference;
  useEffect(() => {
    if (orderReference === null) {
      setCheck({ kind: "Ready", progress: null });
      return;
    }
    const controller = new AbortController();
    setCheck({ kind: "Checking" });
    createDiningProgressClient(fetcher)
      .load(orderReference, csrf, controller.signal)
      .then((progress) => {
        if (!controller.signal.aborted) setCheck({ kind: "Ready", progress });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setCheck({
            kind: "Failed",
            denied: error instanceof DiningProgressError && error.code === "PermissionDenied",
            missing: error instanceof DiningProgressError && error.code === "NotFound",
          });
      });
    return () => controller.abort();
  }, [orderReference, csrf, fetcher, session.version, attempt]);
  useEffect(() => () => pending.current?.abort(), []);

  const progress = check.kind === "Ready" ? check.progress : null;
  // DEC-TABLE-CLOSE-GUESTS-LEFT: rounds still open and what else stops the Order closing, from the
  // server's close evaluation (undefined while read, null when unknown).
  const [plan, setPlan] = useState<
    { readonly open: number; readonly blockers: readonly string[] } | null | undefined
  >(orderReference === null ? { open: 0, blockers: [] } : undefined);
  // A re-check reads the plan again: never show the previous answer meanwhile.
  useEffect(() => {
    setPlan(orderReference === null ? { open: 0, blockers: [] } : undefined);
  }, [orderReference, session.version, attempt]);
  const openRounds = plan === undefined ? undefined : plan === null ? null : plan.open;
  const blockers =
    check.kind === "Ready"
      ? [
          ...tableCloseBlockers(table, progress),
          // WP-2423 (B759): when no round is left to close out, the close evaluation's own reasons.
          ...(plan && plan.open === 0 ? closeReasonTexts(plan.blockers) : []),
        ]
      : [];
  const guestsLeft =
    orderReference !== null && check.kind === "Ready" ? (
      <TableGuestsLeft
        orderReference={orderReference}
        diningSessionReference={table.currentDiningSessionReference as string}
        tableLabel={table.stableLabel}
        csrf={csrf}
        timeZone={timeZone}
        locked={locked || submitting}
        attempt={attempt}
        onPlan={setPlan}
        onResolved={() => {
          setAttempt((value) => value + 1);
          onRefresh();
        }}
        fetcher={fetcher}
      />
    ) : null;
  // The rounds the plan lists keep the table open even when no item is waiting (refunds).
  const planBlocks = typeof openRounds === "number" && openRounds > 0;
  const ordersLink =
    orderReference === null ? null : (
      <Link to={`/operations/orders/${orderReference}`}>Open this table&apos;s order</Link>
    );

  const close = async () => {
    if (pending.current || check.kind !== "Ready" || blockers.length > 0 || planBlocks) return;
    if (outcome !== "Unknown" && (!confirmed || locked)) return;
    const controller = new AbortController();
    pending.current = controller;
    setSubmitting(true);
    setOutcome(null);
    onBusy(true);
    try {
      await closeTableSession({
        diningSessionReference: table.currentDiningSessionReference as string,
        session,
        progress,
        plan: steps.current,
        csrf,
        signal: controller.signal,
        fetcher,
      });
      steps.current = { done: new Set() };
      if (!controller.signal.aborted) {
        onBusy(false);
        onClosed();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const code =
        error instanceof DiningSessionCloseClientError ||
        error instanceof DiningOrderCloseClientError
          ? error.code
          : "OutcomeUnknown";
      if (code === "OutcomeUnknown") {
        setOutcome("Unknown");
        return;
      }
      // Refused: start over from what the table shows now. Steps already done (ordering stopped)
      // are read back from the table, so pressing Close again continues from there.
      steps.current = { done: new Set() };
      setConfirmed(false);
      setOutcome(
        code === "PermissionDenied"
          ? "Denied"
          : code === "NotReady" && error instanceof DiningOrderCloseClientError
            ? { kind: "NotReady", reasons: error.reasons }
            : "Refused",
      );
      onBusy(false);
      setAttempt((value) => value + 1);
      onRefresh();
    } finally {
      if (pending.current === controller) pending.current = null;
      setSubmitting(false);
    }
  };

  return (
    <section aria-label="Close this table" className="dining-table-close">
      <h4>Close the table</h4>
      {check.kind === "Checking" ? (
        <p role="status">Checking this table&apos;s orders…</p>
      ) : check.kind === "Failed" ? (
        <p role="status">
          {check.denied
            ? "You can't check this table's orders with your current access. Ask an Owner or Store Manager to close it."
            : check.missing
              ? "This table's order wasn't found at this store. Refresh the tables and try again."
              : "Couldn't check this table's orders. Check the connection and try again."}{" "}
          {check.denied ? null : (
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Check again
            </button>
          )}
        </p>
      ) : blockers.length > 0 || planBlocks ? (
        <div role="note">
          {blockers.length > 0 ? (
            <>
              <p>This table can&apos;t be closed yet:</p>
              <ul>
                {blockers.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>This table can&apos;t be closed yet. Close out its open rounds first.</p>
          )}
          {guestsLeft}
          <p>
            {ordersLink}{" "}
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Check again
            </button>
          </p>
        </div>
      ) : openRounds === undefined ? (
        guestsLeft
      ) : (
        <>
          <p>
            When the guests have left and everything is paid, close the table. Ordering at this
            table stops, its order is closed and the table is free for the next party.
          </p>
          {outcome === "Unknown" ? null : (
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={submitting || locked}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              The guests at table {table.stableLabel} have left
            </label>
          )}
          <button
            type="button"
            disabled={submitting || (outcome !== "Unknown" && (!confirmed || locked))}
            onClick={() => void close()}
          >
            {submitting
              ? "Closing the table…"
              : outcome === "Unknown"
                ? "Try closing again"
                : `Close table ${table.stableLabel}`}
          </button>
        </>
      )}
      {outcome === "Unknown" ? (
        <p role="alert">
          We couldn&apos;t confirm the table was closed (the connection may have dropped). Try
          closing again; nothing is done twice.
        </p>
      ) : outcome === "Denied" ? (
        <p role="alert">
          Your access doesn&apos;t allow closing tables. Ask an Owner or Store Manager to close it.
        </p>
      ) : outcome === "Refused" ? (
        <p role="alert">
          The table wasn&apos;t closed: it changed while it was being closed (for example a payment
          or refund came in). It has been checked again; review it and try again. {ordersLink}
        </p>
      ) : typeof outcome === "object" && outcome !== null ? (
        <div role="alert">
          <p>The table wasn&apos;t closed yet:</p>
          <ul>
            {closeReasonTexts(outcome.reasons.length > 0 ? outcome.reasons : ["UNKNOWN"]).map(
              (text) => (
                <li key={text}>{text}</li>
              ),
            )}
          </ul>
          <p>{ordersLink}</p>
        </div>
      ) : null}
    </section>
  );
}
