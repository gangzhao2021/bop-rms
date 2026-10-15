import { useEffect, useMemo, useRef, useState } from "react";
import {
  createKitchenWorkClient,
  KitchenWorkClientError,
  type KitchenAction,
} from "./kitchen-work-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import type { KitchenBoardItem, KitchenBoardView } from "./kitchen-board.js";

type Operation = ReturnType<ReturnType<typeof createKitchenWorkClient>["prepare"]>;
type Result = Awaited<ReturnType<Operation["execute"]>>;
interface Attempt {
  item: KitchenBoardItem;
  operation: Operation;
  revision: number;
}
type State =
  | { kind: "Idle" }
  | { kind: "Submitting"; attempt: Attempt }
  | { kind: "Unknown"; attempt: Attempt }
  | { kind: "Confirmed"; attempt: Attempt; result: Result }
  | { kind: "Rejected"; attempt: Attempt; code: KitchenWorkClientError["code"] };

/** A kitchen step the server confirmed, kept until the queue projection shows it. */
export interface KitchenConfirmedStep {
  readonly workItemReference: string;
  readonly ticketReference: string;
  readonly result: Result;
}

function behind(item: KitchenBoardItem, step: KitchenConfirmedStep): boolean {
  const execution = item.execution;
  return Boolean(
    execution &&
    (BigInt(execution.ticketVersion) < BigInt(step.result.ticketVersion) ||
      BigInt(execution.workItemVersion) < BigInt(step.result.workItemVersion)),
  );
}

/**
 * WP-2423: the board shows a kitchen step as soon as the server confirms it, instead of waiting for
 * the queue projection (which a background worker updates, and which can lag or stop). Only what
 * the server's result states is applied, and only while the projection is older than that result;
 * once the projection reaches the confirmed versions it is the source again. Other work on the same
 * ticket takes the confirmed ticket version, so its next step is not refused as out of date.
 */
export function applyConfirmedKitchenSteps(
  view: KitchenBoardView,
  steps: readonly KitchenConfirmedStep[],
): KitchenBoardView {
  const pending = steps.filter((step) =>
    view.items.some(
      (item) => item.workItemReference === step.workItemReference && behind(item, step),
    ),
  );
  if (pending.length === 0) return view;
  const items = view.items.map((item) => {
    const execution = item.execution;
    if (!execution) return item;
    const own = pending.find((step) => step.workItemReference === item.workItemReference);
    const ticketVersion = pending
      .filter((step) => step.ticketReference === item.ticketReference)
      .reduce(
        (latest, step) =>
          BigInt(step.result.ticketVersion) > BigInt(latest) ? step.result.ticketVersion : latest,
        execution.ticketVersion,
      );
    if (!own)
      return ticketVersion === execution.ticketVersion
        ? item
        : Object.freeze({
            ...item,
            execution: Object.freeze({ ...execution, ticketVersion }),
          });
    const { result } = own;
    return Object.freeze({
      ...item,
      status: result.workItemStatus,
      completedQuantity: result.completedQuantity,
      execution: Object.freeze({
        ...execution,
        ticketVersion,
        workItemVersion: result.workItemVersion,
        acceptedAt: result.outcome === "Accepted" ? result.occurredAt : execution.acceptedAt,
        readyAt:
          result.outcome === "CompletedAndOrderItemReady" || result.outcome === "OrderItemReady"
            ? result.occurredAt
            : execution.readyAt,
      }),
    });
  });
  return Object.freeze({ ...view, items: Object.freeze(items) });
}

/** WP-2423: what the cook just did, in their words ("Order 6 · Latte accepted."). */
export function kitchenStepText(
  orderLabel: string,
  item: Pick<KitchenBoardItem, "displayName" | "requiredQuantity">,
  result: Pick<Result, "outcome" | "completedQuantity">,
): string {
  const done = {
    Accepted: "accepted",
    Started: "started",
    ProgressRecorded: `${result.completedQuantity} of ${item.requiredQuantity} done`,
    Completed: "done",
    CompletedAndOrderItemReady: "done and ready",
    OrderItemReady: "ready",
  }[result.outcome];
  return `${orderLabel} · ${item.displayName} ${done}.`;
}

/** One current intent survives refresh and explicit retry, but never browser storage. */
export function useKitchenActions(input: {
  csrf: string | undefined;
  storeReference: string | undefined;
  view: KitchenBoardView | null;
  revision: number;
}) {
  const [state, setState] = useState<State>({ kind: "Idle" });
  const [confirmed, setConfirmed] = useState<readonly KitchenConfirmedStep[]>([]);
  // A confirmed step is dropped once the projection shows it (or no longer lists the work).
  useEffect(() => {
    const view = input.view;
    if (!view || confirmed.length === 0) return;
    const still = confirmed.filter((step) =>
      view.items.some(
        (item) => item.workItemReference === step.workItemReference && behind(item, step),
      ),
    );
    if (still.length !== confirmed.length) setConfirmed(still);
  }, [input.view, confirmed]);
  const view = useMemo(
    () => (input.view ? applyConfirmedKitchenSteps(input.view, confirmed) : null),
    [input.view, confirmed],
  );
  const inFlight = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const authority = Boolean(
    input.csrf &&
    input.storeReference &&
    input.view?.freshnessStatus === "Fresh" &&
    input.view.operatorStatus === "Named",
  );
  const reflected =
    state.kind === "Confirmed" &&
    Boolean(
      input.view?.items.some(
        (item) =>
          item.workItemReference === state.attempt.item.workItemReference &&
          item.execution &&
          BigInt(item.execution.ticketVersion) >= BigInt(state.result.ticketVersion) &&
          BigInt(item.execution.workItemVersion) >= BigInt(state.result.workItemVersion),
      ),
    );
  const rejectedRefreshed =
    state.kind === "Rejected" && input.revision > state.attempt.revision && authority;
  // A confirmed step no longer holds the board: the card already shows the confirmed result.
  const blocked =
    !authority ||
    inFlight.current ||
    !(state.kind === "Idle" || state.kind === "Confirmed" || rejectedRefreshed);
  async function execute(attempt: Attempt) {
    const controller = lifetime.current;
    if (inFlight.current || !input.csrf || !controller || controller.signal.aborted) return;
    inFlight.current = true;
    setState({ kind: "Submitting", attempt });
    try {
      const result = await attempt.operation.execute(input.csrf, controller.signal);
      if (!controller.signal.aborted) {
        setConfirmed((steps) => [
          ...steps.filter((step) => step.workItemReference !== attempt.item.workItemReference),
          {
            workItemReference: attempt.item.workItemReference,
            ticketReference: attempt.item.ticketReference,
            result,
          },
        ]);
        setState({ kind: "Confirmed", attempt, result });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = error instanceof KitchenWorkClientError ? error.code : "OutcomeUnknown";
        setState(
          code === "OutcomeUnknown"
            ? { kind: "Unknown", attempt }
            : { kind: "Rejected", attempt, code },
        );
      }
    } finally {
      inFlight.current = false;
    }
  }
  return {
    blocked,
    /** The board as the server last confirmed it: the projection plus confirmed steps it lacks. */
    view,
    state,
    reflected,
    rejectedRefreshed,
    act(item: KitchenBoardItem, action: KitchenAction) {
      if (blocked || inFlight.current || !input.storeReference) return;
      const operation = createKitchenWorkClient().prepare({
        action,
        item,
        storeReference: input.storeReference,
        idempotencyKey: serviceOperationReference(),
        correlationReference: serviceOperationReference(),
      });
      void execute({ item, operation, revision: input.revision });
    },
    retry() {
      if (state.kind === "Unknown" && authority) void execute(state.attempt);
    },
    canRetry: authority && state.kind === "Unknown",
  };
}
