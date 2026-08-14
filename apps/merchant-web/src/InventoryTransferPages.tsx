import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  InventoryTransferClientError,
  parseInventoryTransferDetailView,
  parseInventoryTransferListView,
  unavailableInventoryTransferClient,
  type InventoryTransferClientErrorCode,
  type InventoryTransferDetailView,
  type InventoryTransferListView,
  type InventoryTransferProjectionClient,
} from "./inventory-transfer-pages.js";

type LoadState<T> =
  | { readonly kind: "Loading" | InventoryTransferClientErrorCode }
  | { readonly kind: "Found"; readonly view: T };
export function InventoryTransferState({
  state,
}: {
  readonly state: Exclude<LoadState<never>["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Transfer facts…", "neutral"],
    Empty: ["No transfers", "No Transfer matches this scoped view.", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Both source and destination access are required.",
      "error",
    ],
    NotFound: [
      "Transfer not found",
      "The Transfer is not available in the authorized Scopes.",
      "neutral",
    ],
    FeatureDisabled: ["Transfer disabled", "This Store does not enable Stock Transfer.", "neutral"],
    Stale: ["Projection stale", "Refresh before dispatching or receiving.", "offline"],
    Conflict: ["Transfer changed", "Refresh the immutable timeline before retrying.", "offline"],
    CommandFailed: [
      "Transfer command failed",
      "No dispatch, receipt or Ledger fact was inferred.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached Transfer facts cannot authorize a mutation.", "offline"],
    Unavailable: ["Transfer unavailable", "No quantity or discrepancy is inferred.", "error"],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}
export function InventoryTransferList({ view }: { readonly view: InventoryTransferListView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-TRANSFER-LIST · Inventory</p>
          <h1>Stock Transfers</h1>
          <p>
            {view.stockScope.scopeType} · {view.stockScope.scopeLabel} · {view.freshness} ·{" "}
            {view.asOfUtc}
          </p>
        </div>
        <button disabled>Create transfer</button>
      </header>
      {view.freshness !== "Current" || view.partial ? (
        <InventoryTransferState state="Stale" />
      ) : null}
      <div className="list-filters">
        <label>
          Transfer ref / Item
          <input disabled placeholder="Exact reference, item or barcode" />
        </label>
        <label>
          State / source / destination
          <select disabled>
            <option>All authorized transfers</option>
          </select>
        </label>
        <label>
          Date / discrepancy
          <select disabled>
            <option>All dates and outcomes</option>
          </select>
        </label>
      </div>
      {view.transfers.length === 0 ? (
        <InventoryTransferState state="Empty" />
      ) : (
        <div className="card-list">
          {view.transfers.map((transfer) => (
            <article className="summary-card" key={transfer.transferReference}>
              <div>
                <p className="bop-eyebrow">{transfer.status}</p>
                <h2>
                  <Link to={`/operations/inventory/transfers/${transfer.transferReference}`}>
                    {transfer.transferReference}
                  </Link>
                </h2>
                <p>
                  {transfer.sourceLabel} → {transfer.destinationLabel} · {transfer.itemCount}{" "}
                  item(s)
                </p>
              </div>
              <p>
                Requested {transfer.requestedQuantity} · dispatched {transfer.dispatchedQuantity} ·
                received {transfer.receivedQuantity} · discrepancy {transfer.discrepancyQuantity}
              </p>
              <p>
                Owner {transfer.ownerDisplay} · updated {transfer.updatedAt}
              </p>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
export function InventoryTransferDetail({ view }: { readonly view: InventoryTransferDetailView }) {
  const transfer = view.transfer;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            INV-TRANSFER-DETAIL · immutable revision {transfer.revision}
          </p>
          <h1>Transfer {transfer.transferReference}</h1>
          <p>
            {transfer.sourceLabel} → {transfer.destinationLabel} · {transfer.status} ·{" "}
            {view.freshness}
          </p>
        </div>
        <Link to="/operations/inventory/transfers">Back to Transfers</Link>
      </header>
      {view.freshness !== "Current" || view.partial ? (
        <InventoryTransferState state="Stale" />
      ) : null}
      <section className="detail-section">
        <h2>Lines and in-transit quantities</h2>
        <div className="card-list">
          {transfer.lines.map((line) => (
            <article className="summary-card" key={line.lineReference}>
              <h3>{line.itemDisplay}</h3>
              <p>
                Lot {line.lotReference ?? "No lot"} · expiry {line.expiryDate ?? "—"}
              </p>
              <p>
                Requested {line.requestedQuantity} · dispatched {line.dispatchedQuantity} · received{" "}
                {line.receivedQuantity} · In Transit {line.inTransitQuantity} · discrepancy{" "}
                {line.discrepancyQuantity} {line.unitCode}
                {line.cancelledQuantity !== "0" ? ` · cancelled ${line.cancelledQuantity}` : ""}
                {line.warnings.length ? ` · warnings ${line.warnings.join(", ")}` : ""}
              </p>
            </article>
          ))}
        </div>
      </section>
      <section className="detail-section">
        <h2>Approval and actions</h2>
        <p>
          Owner {transfer.ownerDisplay} · submitter {transfer.submittedByDisplay ?? "—"} · approver{" "}
          {transfer.approvedByDisplay ?? "—"}
        </p>
        <div className="card-actions">
          <button disabled>Revise before dispatch</button>
          <button disabled>Approve</button>
          <button disabled>Dispatch partial</button>
          <button disabled>Receive partial</button>
          <button disabled>Report discrepancy</button>
          <button disabled>Cancel remaining by policy</button>
          <button disabled>Close</button>
        </div>
      </section>
      <section className="detail-section">
        <h2>Immutable timeline</h2>
        <ol>
          {transfer.timeline.map((entry, index) => (
            <li key={`${entry.occurredAt}-${index}`}>
              {entry.occurredAt} · {entry.action} · {entry.actorDisplay} · {entry.reasonCode}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
export function InventoryTransferListPage({
  client = unavailableInventoryTransferClient,
}: {
  readonly client?: InventoryTransferProjectionClient;
}) {
  const [state, setState] = useState<LoadState<InventoryTransferListView>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .list()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseInventoryTransferListView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof InventoryTransferClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <InventoryTransferList view={state.view} />
  ) : (
    <InventoryTransferState state={state.kind} />
  );
}
export function InventoryTransferDetailPage({
  client = unavailableInventoryTransferClient,
}: {
  readonly client?: InventoryTransferProjectionClient;
}) {
  const { id = "" } = useParams();
  const [state, setState] = useState<LoadState<InventoryTransferDetailView>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .detail(id)
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseInventoryTransferDetailView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof InventoryTransferClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client, id]);
  return state.kind === "Found" ? (
    <InventoryTransferDetail view={state.view} />
  ) : (
    <InventoryTransferState state={state.kind} />
  );
}
