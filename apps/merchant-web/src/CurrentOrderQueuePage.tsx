import { OrderPaymentLinks } from "./RefundPaymentPage.js";
import { DiningOrderProgress } from "./DiningOrderProgress.js";
import { OrderAcceptanceAction } from "./OrderAcceptanceAction.js";
import { createOrderAcceptanceClient } from "./order-acceptance-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useRef, useState } from "react";
import {
  createCurrentOrderQueueClient,
  CurrentOrderQueueError,
  type CurrentOrderQueue,
} from "./current-order-queue-client.js";

type State =
  | { kind: "Loading" | "PermissionDenied" | "Unavailable" }
  | { kind: "Ready"; view: CurrentOrderQueue };
const client = createCurrentOrderQueueClient();
export function CurrentOrderQueueRows({
  view,
  action,
  detail,
}: {
  readonly view: CurrentOrderQueue;
  readonly detail?: (order: CurrentOrderQueue["items"][number]) => React.ReactNode;
  readonly action?: (
    order: CurrentOrderQueue["items"][number],
    batch: CurrentOrderQueue["items"][number]["batches"][number],
  ) => React.ReactNode;
}) {
  return view.items.length === 0 ? (
    <StatePanel heading="No orders on this page" status>
      <p>No orders were returned for this page.</p>
    </StatePanel>
  ) : (
    <div className="detail-section-grid">
      {view.items.map((order) => (
        <article className="store-card" key={order.orderReference}>
          <header>
            <h2>{order.orderNumber}</h2>
            <strong>{order.currentPhase ?? "Status unavailable"}</strong>
          </header>
          <dl>
            <div>
              <dt>Order type</dt>
              <dd>{order.orderType}</dd>
            </div>
            <div>
              <dt>Channel</dt>
              <dd>{order.sourceChannel}</dd>
            </div>
            <div>
              <dt>Current version</dt>
              <dd>{order.currentVersion ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt>Submitted</dt>
              <dd>
                <time dateTime={order.submittedAt}>{order.submittedAt}</time>
              </dd>
            </div>
            <div>
              <dt>Last checked</dt>
              <dd>
                <time dateTime={order.observedAt}>{order.observedAt}</time>
              </dd>
            </div>
          </dl>
          {detail?.(order)}
          {order.batches.map((batch) => (
            <section key={batch.orderBatchReference} aria-label={"Batch " + batch.sequence}>
              <h3>
                Batch {batch.sequence}
                {batch.sequence === 1 ? " · Initial" : " · Additional"}
              </h3>
              <p>
                {batch.acceptanceStatus === "Cancelled"
                  ? "Batch cancelled"
                  : "Acceptance: " +
                    (batch.acceptanceStatus === "Accepted" ? "Accepted" : "Not accepted")}
              </p>
              {action?.(order, batch)}
            </section>
          ))}
        </article>
      ))}
    </div>
  );
}
export function CurrentOrderDetails({
  order,
  csrf,
  locked,
  onBusy,
}: {
  readonly order: CurrentOrderQueue["items"][number];
  readonly csrf: string;
  readonly locked: boolean;
  readonly onBusy: (busy: boolean) => void;
}) {
  return (
    <>
      <OrderPaymentLinks orderReference={order.orderReference} csrf={csrf} />
      {order.orderType === "DineIn" && order.currentPhase !== "Cancelled" ? (
        <DiningOrderProgress
          orderReference={order.orderReference}
          csrf={csrf}
          locked={locked}
          onBusy={onBusy}
        />
      ) : null}
    </>
  );
}

export function CurrentOrderQueuePage({
  storeLabel,
  csrf,
}: {
  readonly storeLabel: string;
  readonly csrf: string;
}) {
  const operations = useRef(
    new Map<string, ReturnType<ReturnType<typeof createOrderAcceptanceClient>["prepare"]>>(),
  );
  const servingOrders = useRef(new Set<string>());
  const [servingBusy, setServingBusy] = useState(false);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [after, setAfter] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "Loading" });
    void client
      .load(after, controller.signal)
      .then((view) => {
        if (!controller.signal.aborted) setState({ kind: "Ready", view });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({ kind: error instanceof CurrentOrderQueueError ? error.code : "Unavailable" });
      });
    return () => controller.abort();
  }, [after, refresh]);
  useEffect(() => {
    if (state.kind !== "Loading" && restoreFocus.current) {
      restoreFocus.current = false;
      refreshButton.current?.focus();
    }
  }, [state]);
  const reload = (cursor: string | null) => {
    if (servingOrders.current.size > 0) return;
    restoreFocus.current = true;
    setState({ kind: "Loading" });
    setAfter(cursor);
    setRefresh((value) => value + 1);
  };
  return (
    <AppFrame title="Order Queue" description={"OPS-ORDER-QUEUE · " + storeLabel}>
      <div className="card-actions">
        <button
          ref={refreshButton}
          onClick={() => reload(null)}
          disabled={state.kind === "Loading" || servingBusy}
        >
          Refresh orders
        </button>
        {after !== null ? (
          <button onClick={() => reload(null)} disabled={state.kind === "Loading" || servingBusy}>
            First page
          </button>
        ) : null}
      </div>
      {state.kind === "Ready" ? (
        <>
          <CurrentOrderQueueRows
            view={state.view}
            detail={(order) => (
              <CurrentOrderDetails
                order={order}
                csrf={csrf}
                locked={servingBusy}
                onBusy={(busy) => {
                  if (busy) servingOrders.current.add(order.orderReference);
                  else servingOrders.current.delete(order.orderReference);
                  setServingBusy(servingOrders.current.size > 0);
                }}
              />
            )}
            action={(order, batch) =>
              batch.canRequestAcceptance ? (
                <fieldset disabled={servingBusy}>
                  <OrderAcceptanceAction
                    key={batch.orderBatchReference}
                    csrf={csrf}
                    orderNumber={
                      batch.sequence === 1
                        ? order.orderNumber
                        : order.orderNumber + " · batch " + batch.sequence
                    }
                    operation={() => {
                      let operation = operations.current.get(batch.orderBatchReference);
                      if (!operation) {
                        operation = createOrderAcceptanceClient().prepare({
                          acceptanceReference: serviceOperationReference(),
                          operationReference: serviceOperationReference(),
                          orderReference: order.orderReference,
                          orderBatchReference: batch.orderBatchReference,
                          expectedOrderVersion: order.currentVersion ?? 0,
                        });
                        operations.current.set(batch.orderBatchReference, operation);
                      }
                      return operation;
                    }}
                    onRejected={() => operations.current.delete(batch.orderBatchReference)}
                    onAccepted={() => {
                      operations.current.delete(batch.orderBatchReference);
                      reload(after);
                    }}
                  />
                </fieldset>
              ) : null
            }
          />
          {state.view.nextAfterOrderReference !== null ? (
            <button
              disabled={servingBusy}
              onClick={() => reload(state.view.nextAfterOrderReference)}
            >
              Next page
            </button>
          ) : null}
        </>
      ) : (
        <StatePanel
          heading={
            state.kind === "Loading"
              ? "Loading orders"
              : state.kind === "PermissionDenied"
                ? "Permission denied"
                : "Orders unavailable"
          }
          status
        >
          <p>
            {state.kind === "Loading"
              ? "Reading current orders…"
              : state.kind === "PermissionDenied"
                ? "Your current session or Store permissions do not allow this queue."
                : "Orders could not be refreshed. Check your connection and try again."}
          </p>
        </StatePanel>
      )}
    </AppFrame>
  );
}
