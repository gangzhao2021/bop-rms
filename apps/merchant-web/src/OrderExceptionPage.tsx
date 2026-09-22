import { ReconciliationFollowUpAction } from "./ReconciliationFollowUpAction.js";
import { CompensationReconciliationAction } from "./CompensationReconciliationAction.js";
import { createOrderExceptionClient } from "./order-exception-client.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useRef, useState, type Ref } from "react";

export interface OrderExceptionItem {
  readonly exceptionReference: string;
  readonly orderReference: string | null;
  readonly kind:
    | "DiningUnpaidBatch"
    | "PaymentReconciliationDifference"
    | "CaptureDeadlineExceeded"
    | "PaidWithoutFulfillableOrder";
  readonly severity: "High" | "Critical";
  readonly status: "Open" | "Acknowledged" | "Assigned" | "Resolved";
  readonly providerState: "NotApplicable" | "Pending" | "Unknown" | "Confirmed";
  readonly compensationStatus: "NotRequested" | "Pending" | "Completed";
  readonly sourceOwner: "Dining" | "Payment";
  readonly createdAt: string;
  readonly dueAt: string;
  readonly ownerStatus: "Unassigned" | "Assigned";
  readonly sourceFinal: boolean;
}

export interface OrderExceptionView {
  readonly screenId: "OPS-ORDER-EXCEPTION";
  readonly projectionName: "merchant_order_exception_v1";
  readonly storeLabel: string;
  readonly businessDate: string;
  readonly projectedAt: string;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly items: readonly OrderExceptionItem[];
}
export interface OrderExceptionClient {
  load(signal?: AbortSignal): Promise<unknown>;
}
const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE = /^[^\p{Cc}\p{Cf}]{1,100}$/u;
function exact(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("ORDER_EXCEPTION_INVALID");
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("ORDER_EXCEPTION_INVALID");
    output[key] = descriptor.value;
  }
  return output;
}
function ref(value: unknown) {
  if (typeof value !== "string" || !REF.test(value)) throw new Error("ORDER_EXCEPTION_INVALID");
  return value;
}
function instant(value: unknown) {
  if (typeof value !== "string" || !INSTANT.test(value) || new Date(value).toISOString() !== value)
    throw new Error("ORDER_EXCEPTION_INVALID");
  return value;
}
export function parseOrderExceptionView(value: unknown): OrderExceptionView {
  const input = exact(value, [
    "screenId",
    "projectionName",
    "storeLabel",
    "businessDate",
    "projectedAt",
    "freshnessStatus",
    "items",
  ]);
  if (
    input.screenId !== "OPS-ORDER-EXCEPTION" ||
    input.projectionName !== "merchant_order_exception_v1" ||
    typeof input.storeLabel !== "string" ||
    !SAFE.test(input.storeLabel) ||
    typeof input.businessDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.businessDate) ||
    !["Fresh", "Stale"].includes(String(input.freshnessStatus)) ||
    !Array.isArray(input.items) ||
    input.items.length > 500
  )
    throw new Error("ORDER_EXCEPTION_INVALID");
  const items = Object.freeze(
    input.items.map((value) => {
      const row = exact(value, [
        "exceptionReference",
        "orderReference",
        "kind",
        "severity",
        "status",
        "providerState",
        "compensationStatus",
        "sourceOwner",
        "createdAt",
        "dueAt",
        "ownerStatus",
        "sourceFinal",
      ]);
      if (
        ![
          "DiningUnpaidBatch",
          "PaymentReconciliationDifference",
          "CaptureDeadlineExceeded",
          "PaidWithoutFulfillableOrder",
        ].includes(String(row.kind)) ||
        !["High", "Critical"].includes(String(row.severity)) ||
        !["Open", "Acknowledged", "Assigned", "Resolved"].includes(String(row.status)) ||
        !["NotApplicable", "Pending", "Unknown", "Confirmed"].includes(String(row.providerState)) ||
        !["NotRequested", "Pending", "Completed"].includes(String(row.compensationStatus)) ||
        !["Dining", "Payment"].includes(String(row.sourceOwner)) ||
        !["Unassigned", "Assigned"].includes(String(row.ownerStatus)) ||
        typeof row.sourceFinal !== "boolean" ||
        (row.status === "Resolved") !== row.sourceFinal
      )
        throw new Error("ORDER_EXCEPTION_INVALID");
      return Object.freeze({
        ...row,
        exceptionReference: ref(row.exceptionReference),
        orderReference:
          row.orderReference === null &&
          row.kind === "PaymentReconciliationDifference" &&
          row.sourceOwner === "Payment"
            ? null
            : ref(row.orderReference),
        createdAt: instant(row.createdAt),
        dueAt: instant(row.dueAt),
      }) as unknown as OrderExceptionItem;
    }),
  );
  if (new Set(items.map((item) => item.exceptionReference)).size !== items.length)
    throw new Error("ORDER_EXCEPTION_INVALID");
  return Object.freeze({
    screenId: "OPS-ORDER-EXCEPTION",
    projectionName: "merchant_order_exception_v1",
    storeLabel: input.storeLabel,
    businessDate: input.businessDate,
    projectedAt: instant(input.projectedAt),
    freshnessStatus: input.freshnessStatus as "Fresh" | "Stale",
    items,
  });
}
export function OrderExceptionScreen({
  view,
  onRefresh,
  refreshButtonRef,
  csrf,
}: {
  readonly view: OrderExceptionView;
  readonly onRefresh?: () => void;
  readonly refreshButtonRef?: Ref<HTMLButtonElement>;
  readonly csrf?: string | undefined;
}) {
  const readOnly = view.freshnessStatus !== "Fresh";
  return (
    <AppFrame
      title="Order Exception Workbench"
      description={`OPS-ORDER-EXCEPTION · ${view.storeLabel} · ${view.businessDate}`}
    >
      <header className="screen-heading">
        <div>
          <h2>Server-authorized exceptions</h2>
          <p>
            {view.freshnessStatus} · {view.projectedAt}
          </p>
        </div>
        <button ref={refreshButtonRef} disabled={!onRefresh} onClick={onRefresh}>
          Refresh source
        </button>
      </header>
      <p className="muted">
        Fresh describes current source data, not how quickly an exception first appeared. The alert
        deadline remains shown on each exception; first-alert timing is not certified here.
      </p>
      {readOnly ? (
        <StatePanel heading="Stale workbench — read-only" tone="offline" status>
          <p>Refresh every owning source before an action.</p>
        </StatePanel>
      ) : null}
      {view.items.length === 0 ? (
        <StatePanel heading="No exceptions in this view" tone="neutral" status>
          <p>
            No exceptions were returned for the selected Store. Source freshness is shown above.
          </p>
        </StatePanel>
      ) : null}
      <div className="store-card-grid">
        {view.items.map((item) => (
          <article className="store-card" key={item.exceptionReference}>
            <header>
              <div>
                <p className="bop-eyebrow">
                  {item.severity} · due {item.dueAt}
                </p>
                <h3>{item.kind}</h3>
              </div>
              <strong>{item.status}</strong>
            </header>
            <dl>
              <div>
                <dt>Order</dt>
                <dd>{item.orderReference ?? "Order reference unavailable"}</dd>
              </div>
              <div>
                <dt>Provider state</dt>
                <dd>{item.providerState}</dd>
              </div>
              <div>
                <dt>Compensation</dt>
                <dd>{item.compensationStatus}</dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd>{item.ownerStatus}</dd>
              </div>
            </dl>
            {csrf &&
            item.kind === "PaidWithoutFulfillableOrder" &&
            item.sourceOwner === "Payment" &&
            item.orderReference !== null ? (
              <CompensationReconciliationAction
                orderReference={item.orderReference}
                caseReference={item.exceptionReference}
                csrf={csrf}
                readOnly={readOnly}
              />
            ) : null}
            {csrf &&
            item.kind === "PaymentReconciliationDifference" &&
            item.sourceOwner === "Payment" ? (
              <ReconciliationFollowUpAction
                key={item.exceptionReference + ":" + csrf}
                exceptionReference={item.exceptionReference}
                csrf={csrf}
                readOnly={readOnly || item.sourceFinal}
              />
            ) : null}
            {item.orderReference === null ? (
              <p>
                No linked order is available. This payment difference requires reconciliation
                review.
              </p>
            ) : null}
            <p className="muted">
              General acknowledgment, assignment, compensation requests and closure are not
              available in this workbench yet. Any available source-specific action is shown
              separately above.
            </p>
            <div className="card-actions">
              <button disabled>Acknowledge</button>
              <button disabled>Assign</button>
              <button disabled>Request owning-domain compensation / retry</button>
              <button disabled>Resolve from final source evidence</button>
            </div>
          </article>
        ))}
      </div>
    </AppFrame>
  );
}
const defaultExceptionClient = createOrderExceptionClient();
export function OrderExceptionPage({
  client = defaultExceptionClient,
  csrf,
}: {
  readonly client?: OrderExceptionClient;
  readonly csrf?: string | undefined;
}) {
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const [generation, setGeneration] = useState(0);
  const refresh = () => setGeneration((current) => current + 1);
  const [state, setState] = useState<{
    client: OrderExceptionClient;
    generation: number;
    view: OrderExceptionView | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void client
      .load(controller.signal)
      .then(parseOrderExceptionView)
      .then((view) => {
        if (active) setState({ client, generation, view });
      })
      .catch(() => {
        if (active) setState({ client, generation, view: null });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, generation]);
  useEffect(() => {
    if (
      generation > 0 &&
      state?.client === client &&
      state.generation === generation &&
      document.activeElement === document.body
    )
      recoveryButton.current?.focus();
  }, [client, generation, state]);
  if (state?.client !== client || state.generation !== generation)
    return (
      <StatePanel heading="Loading Order Exception Workbench" tone="neutral" status>
        <p>Reading the selected Store's authorized exceptions.</p>
      </StatePanel>
    );
  return state.view ? (
    <OrderExceptionScreen
      view={state.view}
      onRefresh={refresh}
      refreshButtonRef={recoveryButton}
      csrf={csrf}
    />
  ) : (
    <StatePanel heading="Order Exception Workbench unavailable" tone="error" status>
      <p>No exception or Provider finality is inferred. No action was sent.</p>
      <button ref={recoveryButton} onClick={refresh}>
        Retry loading exceptions
      </button>
    </StatePanel>
  );
}
