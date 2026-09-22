import { useEffect, useRef, useState } from "react";
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

/** One current intent survives refresh and explicit retry, but never browser storage. */
export function useKitchenActions(input: {
  csrf: string | undefined;
  storeReference: string | undefined;
  view: KitchenBoardView | null;
  revision: number;
}) {
  const [state, setState] = useState<State>({ kind: "Idle" });
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
  const blocked =
    !authority || inFlight.current || !(state.kind === "Idle" || reflected || rejectedRefreshed);
  async function execute(attempt: Attempt) {
    const controller = lifetime.current;
    if (inFlight.current || !input.csrf || !controller || controller.signal.aborted) return;
    inFlight.current = true;
    setState({ kind: "Submitting", attempt });
    try {
      const result = await attempt.operation.execute(input.csrf, controller.signal);
      if (!controller.signal.aborted) setState({ kind: "Confirmed", attempt, result });
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
