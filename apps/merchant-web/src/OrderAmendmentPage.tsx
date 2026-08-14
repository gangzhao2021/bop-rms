import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  OrderAmendmentClientError,
  parseOrderAmendmentRouteReference,
  parseOrderAmendmentView,
  unavailableOrderAmendmentClient,
  type OrderAmendmentClient,
  type OrderAmendmentClientErrorCode,
  type OrderAmendmentView,
} from "./order-amendment-page.js";
type State =
  | { readonly kind: "Loading" | OrderAmendmentClientErrorCode }
  | { readonly kind: "Found"; readonly view: OrderAmendmentView };
export function OrderAmendmentState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading the authorized Amendment impact…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Your Store scope does not allow Order Amendment.",
      "error",
    ],
    NotFound: [
      "Order unavailable",
      "The Order is unavailable in the authorized Store scope.",
      "neutral",
    ],
    FeatureDisabled: [
      "Amendment disabled",
      "This phase capability is disabled for the current Store.",
      "neutral",
    ],
    Stale: [
      "Impact is stale",
      "Refresh the Expected Version and pinned Quote before submitting.",
      "offline",
    ],
    Conflict: ["Order changed", "Reload the immutable Order snapshot before retrying.", "offline"],
    CommandFailed: [
      "Command failed",
      "No Amendment fact changed. Retry with the same idempotency reference.",
      "error",
    ],
    Offline: [
      "Offline read-only",
      "Impact may be viewed, but Amendment commands are disabled.",
      "offline",
    ],
    Unavailable: [
      "Amendment unavailable",
      "The authorized BFF is unavailable. No Order fact changed.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
      <Link to="/operations/orders">Return to Orders</Link>
    </StatePanel>
  );
}
export function OrderAmendmentScreen({ view }: { readonly view: OrderAmendmentView }) {
  const [reason, setReason] = useState(view.reasonOptions[0] ?? "");
  const [kind, setKind] = useState("Add Item");
  const [item, setItem] = useState(view.eligibleItems[0]?.orderItemReference ?? "");
  if (view.eligibleItems.length === 0)
    return (
      <StatePanel heading="No eligible Order items" status>
        <p>This Order has no item eligible for the selected Amendment.</p>
      </StatePanel>
    );
  return (
    <AppFrame
      title={`Amend Order ${view.orderNumber}`}
      description="OPS-ORDER-AMEND · query.ops_order_amend · merchant_order_amendment_v1"
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Expected Version {view.expectedOrderVersion}</p>
          <h2>Controlled Order Amendment</h2>
          <p className="bop-muted">As of {view.asOfUtc}</p>
        </div>
        <Link to={`/operations/orders/${view.orderReference}`}>Abort / return</Link>
      </header>
      <section className="detail-section" aria-labelledby="amend-change">
        <h3 id="amend-change">Reason and eligible change</h3>
        <div className="list-filters">
          <label>
            Reason
            <select value={reason} onChange={(event) => setReason(event.currentTarget.value)}>
              {view.reasonOptions.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Action
            <select value={kind} onChange={(event) => setKind(event.currentTarget.value)}>
              {[
                "Add Item",
                "Reduce Item",
                "Void Item",
                "Replace Item Configuration",
                "Update Note",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Order item
            <select value={item} onChange={(event) => setItem(event.currentTarget.value)}>
              {view.eligibleItems.map((value) => (
                <option key={value.orderItemReference} value={value.orderItemReference}>
                  {value.label} × {value.quantity}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p>
          Configuration:{" "}
          {
            view.eligibleItems.find((value) => value.orderItemReference === item)
              ?.configurationSummary
          }
        </p>
      </section>
      <section className="detail-section" aria-labelledby="amend-impact">
        <h3 id="amend-impact">Validated impact</h3>
        <dl>
          <div>
            <dt>Repricing</dt>
            <dd>
              {view.currencyCode} {view.originalTotalMinor} → {view.revisedTotalMinor}
            </dd>
          </div>
          <div>
            <dt>Tax delta</dt>
            <dd>{view.taxDeltaMinor} minor units</dd>
          </div>
          <div>
            <dt>Kitchen</dt>
            <dd>{view.kitchenImpact}</dd>
          </div>
          <div>
            <dt>Fulfillment</dt>
            <dd>{view.fulfillmentImpact}</dd>
          </div>
          <div>
            <dt>Payment / refund consequence</dt>
            <dd>{view.paymentRefundConsequence}</dd>
          </div>
          <div>
            <dt>Customer notice</dt>
            <dd>{view.customerNotice}</dd>
          </div>
          <div>
            <dt>Approval</dt>
            <dd>{view.approvalStatus}</dd>
          </div>
        </dl>
      </section>
      <div className="card-actions">
        <button disabled title="A command-capable Ordering BFF is not connected">
          Validate impact
        </button>
        <button disabled>Submit Amendment</button>
        <button disabled>Request approval</button>
      </div>
      <p className="bop-muted">
        Selection “{kind}” is local preview only. Staff cannot enter price, tax, refund or status
        values.
      </p>
    </AppFrame>
  );
}
export function OrderAmendmentPage({
  client = unavailableOrderAmendmentClient,
}: {
  readonly client?: OrderAmendmentClient;
}) {
  const route = useParams<{ id: string }>().id ?? "";
  const [state, setState] = useState<State>({ kind: "Loading" });
  const load = useCallback(
    async () =>
      parseOrderAmendmentView(await client.load(parseOrderAmendmentRouteReference(route))),
    [client, route],
  );
  useEffect(() => {
    let active = true;
    setState({ kind: "Loading" });
    void load()
      .then((view) => active && setState({ kind: "Found", view }))
      .catch(
        (error: unknown) =>
          active &&
          setState({
            kind: error instanceof OrderAmendmentClientError ? error.code : "Unavailable",
          }),
      );
    return () => {
      active = false;
    };
  }, [load]);
  return state.kind === "Found" ? (
    <OrderAmendmentScreen view={state.view} />
  ) : (
    <OrderAmendmentState state={state.kind} />
  );
}
