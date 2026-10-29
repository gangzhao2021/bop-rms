import { t } from "./i18n/i18n.js";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { DiningOrderCloseAction } from "./DiningOrderCloseAction.js";
import { DiningSessionCloseAction } from "./DiningSessionCloseAction.js";
import { readyToServe, serveReadySummary } from "./dining-serve-ready.js";
import {
  createDiningProgressClient,
  DiningProgressError,
  servableQuantity,
  type DiningProgress,
} from "./dining-progress-client.js";
import { createDiningServeClient, DiningServeClientError } from "./dining-serve-client.js";
import {
  createDiningServeReadyClient,
  DINING_SERVE_READY_MAX_LINES,
  DiningServeReadyClientError,
} from "./dining-serve-ready-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { ComboPartClientError, markComboPartServed } from "./combo-part-client.js";
import type { ComboPartView } from "./combo-parts.js";

/**
 * Orders v3 (Owner 2026-10-26, "订单这里看到多轮接单，但是看不到每一轮的明细"; "查看上桌进度展开以后无法合上"):
 * a table's order reads round by round — each round's dishes, when it was sent, its kitchen or
 * serving state and its amount — and serving progress is always there, under each round. There is
 * no "View serving progress" switch: the progress is read with the order and again whenever the
 * page's own refresh brings a newer order. Serving is not money, so it asks no confirmation: "Served"
 * beside a dish, "All served" on a round (Owner 2026-10-26, DEC-DINE-IN-PAY-LATER step 2).
 */
type Item = DiningProgress["items"][number];

export interface DiningRoundsProgress {
  readonly view: DiningProgress | null;
  /** Unreadable (no permission, or the read failed): rounds show without serving state. */
  readonly unavailable: "PermissionDenied" | "Unavailable" | null;
  readonly busy: boolean;
  readonly serveItem: (item: Item) => void;
  readonly serveRound: (sequence: number) => void;
  /** WP-2423 item 8 ⑥ part 4: one dish of a combo served; the last one serves the combo. */
  readonly serveComboPart: (item: Item, part: ComboPartView) => void;
  /** The item or round whose last step's answer was lost; its button retries the same request. */
  readonly retrying: ReadonlySet<string>;
}

export const DiningRoundsContext = createContext<DiningRoundsProgress | null>(null);
export const useDiningRounds = () => useContext(DiningRoundsContext);

/** Dish states in staff words (the same words as the kitchen's and the guest's). */
export const diningItemPhaseText: Readonly<Record<string, string>> = {
  Submitted: t("Waiting for staff"),
  Accepted: t("Sent to the kitchen"),
  InProgress: t("Being made"),
  Ready: t("Ready to serve"),
  Fulfilled: t("Served"),
  Rejected: t("Not accepted"),
  Cancelled: t("Cancelled"),
};

/** A round's dishes served so far, of all it ordered (cancelled dishes leave the count). */
export function roundServedCount(
  items: readonly Item[],
  sequence: number,
): { readonly served: number; readonly ordered: number } | null {
  const round = items.filter(
    (item) =>
      item.batchSequence === sequence && item.phase !== "Cancelled" && item.phase !== "Rejected",
  );
  if (round.length === 0) return null;
  return {
    served: round.reduce((sum, item) => sum + item.deliveredQuantity, 0),
    ordered: round.reduce((sum, item) => sum + item.orderedQuantity, 0),
  };
}

/** Where a round as a whole is, from its dishes: the least advanced open dish names it. */
export function roundStateText(items: readonly Item[], sequence: number): string | null {
  const open = items.filter(
    (item) =>
      item.batchSequence === sequence && item.phase !== "Cancelled" && item.phase !== "Rejected",
  );
  if (open.length === 0) return null;
  if (open.every((item) => item.phase === "Fulfilled")) return t("All served");
  const ready = open.filter((item) => item.phase === "Ready" && servableQuantity(item) > 0).length;
  for (const phase of ["Submitted", "Accepted", "InProgress"] as const)
    if (open.some((item) => item.phase === phase)) {
      const text = diningItemPhaseText[phase] ?? null;
      return ready > 0 && text !== null
        ? t("{text} · {count} ready to serve", { text, count: ready })
        : text;
    }
  return ready > 0 ? t("{count} ready to serve", { count: ready }) : null;
}

/**
 * Reads the order's serving progress with the order (and again when `refreshKey` changes, which
 * the page's own refresh does), and serves dishes and rounds in one tap. Children render the rounds
 * (`CurrentOrderLines` with rounds); the table's close steps follow them, as before.
 */
export function DiningRoundsProvider({
  orderReference,
  csrf,
  refreshKey,
  locked = false,
  onBusy,
  onChanged,
  fetcher,
  children,
  closeActions = true,
}: {
  /** The order's and table's close steps after the rounds (the Tables page has its own). */
  readonly closeActions?: boolean;
  readonly orderReference: string;
  readonly csrf: string;
  /** Changes when the page has read a newer order (its observed time or version). */
  readonly refreshKey: string;
  readonly locked?: boolean;
  readonly onBusy?: ((busy: boolean) => void) | undefined;
  /** A dish or round was served, or the order or table closed: the page rereads the order. */
  readonly onChanged?: (() => void) | undefined;
  readonly fetcher?: typeof fetch | undefined;
  readonly children: ReactNode;
}) {
  const [view, setView] = useState<DiningProgress | null>(null);
  const [unavailable, setUnavailable] = useState<DiningRoundsProgress["unavailable"]>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const reading = useRef<AbortController | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  // A lost answer is retried with the very same request, so nothing is served twice.
  const pending = useRef(
    new Map<string, { execute: (csrf: string, signal?: AbortSignal) => Promise<unknown> }>(),
  );
  const busyRef = useRef(false);
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      reading.current?.abort();
      // A command still in flight when the order is closed never reports back: release the
      // page's pause on its background reread.
      if (busyRef.current) onBusyRef.current?.(false);
    };
  }, []);
  const load = async () => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    try {
      const next = await createDiningProgressClient(fetcher).load(
        orderReference,
        csrf,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setView(next);
        setUnavailable(null);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setUnavailable(
          error instanceof DiningProgressError && error.code === "PermissionDenied"
            ? "PermissionDenied"
            : "Unavailable",
        );
    }
  };
  useEffect(() => {
    void load();
    // The progress follows the page's order reads; a new read of the same order rereads it.
  }, [orderReference, csrf, refreshKey]);
  const markBusy = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
    onBusy?.(value);
  };
  const changed = () => {
    void load();
    onChanged?.();
  };
  const run = async (
    key: string,
    prepare: () => { execute: (csrf: string, signal?: AbortSignal) => Promise<unknown> },
    done: (result: unknown) => string | null,
    refused: (error: unknown) => string,
  ) => {
    const controller = lifetime.current;
    if (busyRef.current || controller === null || controller.signal.aborted) return;
    const operation = pending.current.get(key) ?? prepare();
    pending.current.set(key, operation);
    markBusy(true);
    setNotice(null);
    try {
      const result = await operation.execute(csrf, controller.signal);
      if (controller.signal.aborted) return;
      pending.current.delete(key);
      setRetrying((current) => without(current, key));
      setNotice(done(result));
      markBusy(false);
      changed();
    } catch (error) {
      if (controller.signal.aborted) return;
      const lost =
        (error instanceof DiningServeClientError || error instanceof DiningServeReadyClientError) &&
        error.code === "OutcomeUnknown";
      if (lost) setRetrying((current) => new Set(current).add(key));
      else {
        pending.current.delete(key);
        setRetrying((current) => without(current, key));
      }
      setNotice(
        lost
          ? t(
              "We could not confirm it was recorded. Tap it again: the same request is sent, so nothing is served twice.",
            )
          : refused(error),
      );
      markBusy(false);
      if (!lost) void load();
    }
  };
  const refusedServe = (error: unknown) =>
    (error instanceof DiningServeClientError || error instanceof DiningServeReadyClientError) &&
    error.code === "PermissionDenied"
      ? t("Nothing was marked served. Your access may have changed.")
      : t("Nothing was marked served. This table has changed; check it and try again.");
  const progress: DiningRoundsProgress = {
    view,
    unavailable,
    busy: busy || locked,
    retrying,
    serveItem: (item) => {
      if (view === null) return;
      void run(
        "item:" + item.orderItemReference,
        () =>
          createDiningServeClient(fetcher).prepare({
            operationReference: serviceOperationReference(),
            orderReference: view.orderReference,
            orderItemReference: item.orderItemReference,
            quantity: servableQuantity(item),
            expectedOrderVersion: view.orderVersion,
            expectedItemServiceVersion: item.itemServiceVersion,
            expectedSessionVersion: view.sessionVersion,
            expectedTableAssignmentVersion: view.tableAssignmentVersion,
          }),
        () => null,
        refusedServe,
      );
    },
    serveComboPart: (item, part) => {
      if (view === null) return;
      const orderReference = view.orderReference;
      void run(
        "part:" + item.orderItemReference + ":" + part.optionReference,
        () => ({
          execute: (token: string) =>
            markComboPartServed(
              token,
              {
                orderReference,
                orderItemReference: item.orderItemReference,
                optionReference: part.optionReference,
              },
              fetcher,
            ),
        }),
        (allServed) => {
          // The last dish served: the combo is served with the existing command.
          if (allServed === true && item.phase === "Ready" && servableQuantity(item) > 0)
            window.setTimeout(() => progress.serveItem(item), 0);
          return null;
        },
        (error) =>
          error instanceof ComboPartClientError && error.code === "NotReady"
            ? t("That dish is not done in the kitchen yet.")
            : refusedServe(error),
      );
    },
    serveRound: (sequence) => {
      if (view === null) return;
      const lines = readyToServe(view, sequence).slice(0, DINING_SERVE_READY_MAX_LINES);
      if (lines.length === 0) return;
      void run(
        "round:" + sequence,
        () =>
          createDiningServeReadyClient(fetcher).prepare({
            operationReference: serviceOperationReference(),
            orderReference: view.orderReference,
            expectedOrderVersion: view.orderVersion,
            expectedSessionVersion: view.sessionVersion,
            expectedTableAssignmentVersion: view.tableAssignmentVersion,
            lines: lines.map((item) => ({
              orderItemReference: item.orderItemReference,
              quantity: servableQuantity(item),
              expectedItemServiceVersion: item.itemServiceVersion,
            })),
          }),
        (result) => serveReadySummary(result as Parameters<typeof serveReadySummary>[0]),
        refusedServe,
      );
    },
  };
  return (
    <DiningRoundsContext.Provider value={progress}>
      {children}
      <p role="status" className="dining-rounds__status">
        {notice ??
          (unavailable === "PermissionDenied"
            ? t("Your current permissions do not allow serving progress.")
            : unavailable === "Unavailable"
              ? t("Serving progress could not be read. It is read again with the order.")
              : null)}
      </p>
      {view?.closureStatus === "Closed" ? (
        <p className="dining-rounds__table" role="note">
          {t("Order closed. Serving history is read-only.")}
        </p>
      ) : null}
      {view === null || view.sessionPhase === "Active" ? null : (
        // The table is checking out (dishes still served, no new rounds), or closed.
        <p className="dining-rounds__table" role="status">
          {view.sessionPhase === "Closing" ? t("Table closing") : t("Table closed")}
        </p>
      )}
      {view === null || !closeActions ? null : (
        <>
          <DiningOrderCloseAction
            key={view.orderReference + ":" + view.currentOrderVersion + ":" + view.closureVersion}
            view={view}
            csrf={csrf}
            locked={busy || locked}
            onBusy={markBusy}
            onClosed={changed}
          />
          <DiningSessionCloseAction
            key={view.diningSessionReference + ":" + view.sessionVersion}
            view={view}
            csrf={csrf}
            locked={busy || locked}
            onBusy={markBusy}
            onClosed={changed}
          />
        </>
      )}
    </DiningRoundsContext.Provider>
  );
}

function without(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

/** A dish's serving state and its one-tap "Served", inside a round. */
export function DiningRoundItemState({
  orderItemReference,
}: {
  readonly orderItemReference: string;
}) {
  const rounds = useDiningRounds();
  const item = rounds?.view?.items.find((entry) => entry.orderItemReference === orderItemReference);
  if (rounds === null || rounds.view === null || item === undefined) return null;
  // A table checking out (Closing) still gets its last dishes served before it closes.
  const open =
    (rounds.view.sessionPhase === "Active" || rounds.view.sessionPhase === "Closing") &&
    rounds.view.closureStatus === "Open";
  const servable = servableQuantity(item);
  const remaking = (item.remakingQuantity ?? 0) > 0;
  const key = "item:" + item.orderItemReference;
  return (
    <span className="dining-round-item" data-phase={item.phase}>
      <span className="dining-round-item__state">
        {item.phase === "Ready" && remaking && servable === 0
          ? t("Being remade")
          : (diningItemPhaseText[item.phase] ?? t("Checking"))}
        {item.deliveredQuantity > 0 && item.remainingQuantity > 0
          ? t(" · {served} of {ordered} served", {
              served: item.deliveredQuantity,
              ordered: item.orderedQuantity,
            })
          : ""}
      </span>
      {remaking ? (
        // WP-2423 (2026-10-18): never serve or promise a dish the kitchen is making again.
        <span className="dining-progress-remaking" role="note">
          {t("Remaking — don't serve it until the kitchen marks the remake done.")}
        </span>
      ) : null}
      {item.comboParts !== undefined ? (
        <ul className="dining-round-item__combo" aria-label={t("Dishes in this combo")}>
          {item.comboParts.map((part) => {
            const label = part.nameZh || part.name;
            const served = part.served || item.phase === "Fulfilled";
            const partKey = "part:" + item.orderItemReference + ":" + part.optionReference;
            return (
              <li key={part.optionReference}>
                <span lang={part.nameZh ? "zh-Hans" : "en"}>{label}</span>
                <span className="dining-round-item__state">
                  {served ? t("Served") : part.done ? t("Ready to serve") : t("Being made")}
                </span>
                {open && part.done && !served ? (
                  <button
                    type="button"
                    className="dining-round-item__serve"
                    disabled={rounds.busy && !rounds.retrying.has(partKey)}
                    aria-label={t("Mark {displayName} served", { displayName: label })}
                    onClick={() => rounds.serveComboPart(item, part)}
                  >
                    {rounds.retrying.has(partKey) ? t("Try again") : t("Mark served")}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {open &&
      item.phase === "Ready" &&
      servable > 0 &&
      // A combo is served dish by dish (its last dish serves it).
      (item.comboParts === undefined || item.comboParts.every((part) => part.served)) ? (
        <button
          type="button"
          className="dining-round-item__serve"
          disabled={rounds.busy && !rounds.retrying.has(key)}
          aria-label={t("Mark {quantity} × {displayName} served", {
            quantity: servable,
            displayName: item.displayName,
          })}
          onClick={() => rounds.serveItem(item)}
        >
          {rounds.retrying.has(key) ? t("Try again") : t("Mark served")}
        </button>
      ) : null}
    </span>
  );
}

/** A round's "served x of y" and state for its header; null until the progress is read. */
export function DiningRoundSummary({ sequence }: { readonly sequence: number }) {
  const rounds = useDiningRounds();
  if (rounds?.view == null) return null;
  const count = roundServedCount(rounds.view.items, sequence);
  const state = roundStateText(rounds.view.items, sequence);
  return (
    <span className="dining-round__progress">
      {count === null
        ? null
        : t("Served {served}/{ordered}", { served: count.served, ordered: count.ordered })}
      {state !== null && state !== t("All served") ? (
        <span className="dining-round__state">{state}</span>
      ) : null}
    </span>
  );
}

/** "All served" for a round: every dish of it the kitchen has ready, in one tap. */
export function DiningRoundServeAll({ sequence }: { readonly sequence: number }) {
  const rounds = useDiningRounds();
  if (rounds?.view == null) return null;
  const ready = readyToServe(rounds.view, sequence);
  if (ready.length < 2) return null;
  const open = rounds.view.items.filter(
    (item) =>
      item.batchSequence === sequence &&
      item.phase !== "Cancelled" &&
      item.phase !== "Rejected" &&
      item.phase !== "Fulfilled",
  );
  const key = "round:" + sequence;
  return (
    <button
      type="button"
      className="dining-round__serve-all"
      disabled={rounds.busy && !rounds.retrying.has(key)}
      onClick={() => rounds.serveRound(sequence)}
    >
      {rounds.retrying.has(key)
        ? t("Try again")
        : ready.length === open.length
          ? t("All served")
          : t("Serve the {count} ready", { count: ready.length })}
    </button>
  );
}

/**
 * A round's dishes from the serving progress alone, for when the order's items could not be read:
 * staff can still see and serve what the kitchen made.
 */
export function DiningRoundProgressItems({ sequence }: { readonly sequence: number }) {
  const rounds = useDiningRounds();
  if (rounds?.view == null) return null;
  const items = rounds.view.items.filter((item) => item.batchSequence === sequence);
  if (items.length === 0) return null;
  return (
    <>
      <DiningRoundSummary sequence={sequence} />
      <ul>
        {items.map((item) => (
          <li key={item.orderItemReference}>
            <span className="order-line-quantity">{item.orderedQuantity} ×</span>
            <span className="order-line-name">
              <span className="order-line-title">{item.displayName}</span>
              {(item.details?.options.length ?? 0) > 0 ? (
                <span className="order-line-options">
                  {(item.details?.options ?? [])
                    .map((option) =>
                      option.quantity > 1 ? `${option.name} × ${option.quantity}` : option.name,
                    )
                    .join(" · ")}
                </span>
              ) : null}
              {item.details?.customerNote ? (
                <span className="order-line-note">
                  {t("Note: {customerNote}", { customerNote: item.details.customerNote })}
                </span>
              ) : null}
            </span>
            <span />
            <DiningRoundItemState orderItemReference={item.orderItemReference} />
          </li>
        ))}
      </ul>
      <DiningRoundServeAll sequence={sequence} />
    </>
  );
}
