import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  parsePurchaseOrderView,
  PurchaseOrderClientError,
  unavailablePurchaseOrderClient,
  type PurchaseOrderClientErrorCode,
  type PurchaseOrderProjectionClient,
  type PurchaseOrderView,
} from "./purchase-order-pages.js";
type LoadState =
  | { readonly kind: "Loading" | PurchaseOrderClientErrorCode }
  | { readonly kind: "Found"; readonly view: PurchaseOrderView };
export function PurchaseOrderState({
  state,
}: {
  readonly state: Exclude<LoadState["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Purchase Order facts…", "neutral"],
    Empty: ["No purchase orders", "No PO matches these Brand-scoped filters.", "neutral"],
    PermissionDenied: ["Permission denied", "This Purchase Order view is unavailable.", "error"],
    NotFound: ["Purchase Order not found", "The PO is unavailable in this Brand.", "neutral"],
    FeatureDisabled: ["Purchase Orders disabled", "This capability is unavailable.", "neutral"],
    Stale: [
      "Projection stale",
      "Refresh source facts before approval, Issue, Revision or close.",
      "offline",
    ],
    Conflict: ["Purchase Order changed", "Refresh Expected Version before retrying.", "offline"],
    ValidationFailed: [
      "Validation required",
      "Resolve scope, Offering, price, quantity, terms or approval blockers.",
      "error",
    ],
    CommandFailed: [
      "Command failed",
      "No Supplier commitment, receipt or closure was inferred.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached PO facts cannot authorize a mutation.", "offline"],
    Unavailable: [
      "Purchase Order unavailable",
      "No restricted cost, response, receipt or discrepancy is inferred.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}
export function PurchaseOrderList({ view }: { readonly view: PurchaseOrderView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">PROC-PO-LIST · Buyer / Approver / Receiving read</p>
          <h1>Purchase Orders</h1>
          <p>
            {view.brandLabel} · {view.freshness} · {view.asOfUtc}
          </p>
        </div>
        {view.permissions.mayManage ? (
          <button disabled={readOnly}>Create from approved need</button>
        ) : null}
      </header>
      <p role="note">Approved is internal. Only explicit Issue creates a Supplier commitment.</p>
      {readOnly ? <PurchaseOrderState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          PO ref / Supplier / Item
          <input disabled placeholder="Exact or prefix search" />
        </label>
        <label>
          Workflow / Fulfillment / Closure
          <select disabled>
            <option>All state dimensions</option>
          </select>
        </label>
        <label>
          Store / Buyer / Date / Overdue / Discrepancy
          <select disabled>
            <option>All registered filters</option>
          </select>
        </label>
      </div>
      {view.rows.length === 0 ? (
        <PurchaseOrderState state="Empty" />
      ) : (
        <div className="card-list">
          {view.rows.map((po) => (
            <article className="summary-card" key={po.purchaseOrderReference}>
              <div>
                <p className="bop-eyebrow">
                  {po.workflow} · {po.fulfillment} · {po.closure}
                </p>
                <h2>{po.purchaseOrderReference}</h2>
                <p>
                  {po.supplierName} · {po.buyerEntityName} · {po.shipToLabel}
                </p>
              </div>
              <p>
                Expected {po.expectedDeliveryUtc} · {po.overdue ? "Overdue" : "On schedule"}
              </p>
              {view.permissions.mayViewCost ? (
                <p>
                  Ordered {po.orderedAmount ?? "Partial"} · received{" "}
                  {po.receivedAmount ?? "Partial"} · open {po.openAmount ?? "Partial"} {po.currency}
                </p>
              ) : null}
              {view.permissions.mayViewDiscrepancy ? (
                <p>Discrepancies {po.discrepancyCount ?? "Partial"}</p>
              ) : null}
              <div className="card-actions">
                <Link to={`/app/supply/purchase-orders/${po.purchaseOrderReference}`}>View PO</Link>
                {view.permissions.mayManage &&
                ["Draft", "Submitted", "Approved"].includes(po.workflow) ? (
                  <Link to={`/app/supply/purchase-orders/${po.purchaseOrderReference}/edit`}>
                    Open editor
                  </Link>
                ) : null}
                {view.permissions.mayApprove ? (
                  <button disabled={readOnly || po.workflow !== "Submitted"}>Approve</button>
                ) : null}
                {view.permissions.mayIssue ? (
                  <button disabled={readOnly || po.workflow !== "Approved"}>Issue PO</button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
      {view.nextCursor ? <button disabled>Load next page</button> : null}
    </main>
  );
}
export function PurchaseOrderEditor({ view }: { readonly view: PurchaseOrderView }) {
  const po = view.rows[0];
  const editor = view.editor;
  if (!po || !editor) return <PurchaseOrderState state="NotFound" />;
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            PROC-PO-EDITOR · {editor.pendingRevisionLifecycle} · Revision{" "}
            {editor.pendingRevisionNumber}
          </p>
          <h1>{editor.purchaseOrderReference}</h1>
          <p>
            Supplier {editor.supplierReference} · Buyer {editor.buyerEntityReference} · Ship-To{" "}
            {editor.shipToStockSiteReference} · {editor.currency}
          </p>
        </div>
      </header>
      {readOnly ? <PurchaseOrderState state="Stale" /> : null}
      <p role="note">
        Supplier, Buyer Entity, currency or Ship-To changes require a new PO. Arbitrary line price
        is unavailable.
      </p>
      <section className="detail-section">
        <h2>Offering-based lines and source allocations</h2>
        {editor.lines.map((line) => (
          <article key={line.lineReference}>
            <h3>{line.itemName}</h3>
            <p>
              {line.supplierItemSummary} · {line.orderedQuantity} {line.purchaseUnit} · expected{" "}
              {line.expectedDeliveryUtc}
            </p>
            <p>
              Unit cost {line.unitCost} · discount {line.discount} · total {line.lineTotal}{" "}
              {editor.currency}
            </p>
            <p>Approved Requisition allocations: {line.sourceAllocationReferences.join(", ")}</p>
          </article>
        ))}
      </section>
      <section className="detail-section">
        <h2>Validation and impact</h2>
        {editor.validationIssues.length === 0 ? (
          <p>No current blockers</p>
        ) : (
          editor.validationIssues.map((issue) => (
            <p key={issue.code}>
              {issue.severity} · {issue.code} · {issue.message}
            </p>
          ))
        )}
      </section>
      <div className="card-actions">
        {view.permissions.mayManage ? (
          <button disabled={readOnly || editor.pendingRevisionLifecycle !== "Draft"}>
            Save Draft / Revision
          </button>
        ) : null}
        {view.permissions.mayManage ? (
          <button
            disabled={
              readOnly ||
              editor.pendingRevisionLifecycle !== "Draft" ||
              editor.validationIssues.some((issue) => issue.severity === "Blocking")
            }
          >
            Validate and submit
          </button>
        ) : null}
        {view.permissions.mayApprove ? (
          <button disabled={readOnly || editor.pendingRevisionLifecycle !== "Submitted"}>
            Approve
          </button>
        ) : null}
        {view.permissions.mayIssue ? (
          <button disabled={readOnly || editor.pendingRevisionLifecycle !== "Approved"}>
            Issue with Buyer authority
          </button>
        ) : null}
      </div>
      <p>
        Issue freezes the Supplier, Buyer, address, terms, Offering, price and conversion snapshot.
      </p>
    </main>
  );
}
export function PurchaseOrderDetail({ view }: { readonly view: PurchaseOrderView }) {
  const po = view.rows[0];
  const detail = view.detail;
  if (!po || !detail) return <PurchaseOrderState state="NotFound" />;
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            PROC-PO-DETAIL · {po.workflow} · {po.fulfillment} · {po.closure}
          </p>
          <h1>{detail.purchaseOrderReference}</h1>
          <p>
            Issued snapshot {detail.issuedSnapshotReference} · Revision{" "}
            {detail.effectiveRevisionNumber}
          </p>
        </div>
      </header>
      {readOnly ? <PurchaseOrderState state="Stale" /> : null}
      <section className="detail-section">
        <h2>Supplier response and immutable revisions</h2>
        {view.permissions.mayViewSupplierResponse ? (
          <p>
            Response {detail.supplierResponse?.response ?? "Pending"}{" "}
            {detail.supplierResponse?.recordedAt ?? ""}
          </p>
        ) : (
          <p>Supplier response restricted</p>
        )}
        {detail.revisions?.map((revision) => (
          <p key={revision.revisionReference}>
            Revision {revision.revisionNumber} · {revision.lifecycle} ·{" "}
            {revision.reasonCode ?? "Original"}
          </p>
        ))}
      </section>
      <section className="detail-section">
        <h2>Line completion</h2>
        {detail.lineCompletion.map((line) => (
          <p key={line.lineReference}>
            Ordered {line.orderedQuantity} · received {line.receivedQuantity ?? "Restricted"} ·
            cancelled {line.cancelledQuantity} · {line.final ? "Final" : "Open"}
          </p>
        ))}
        {view.permissions.mayViewReceipt ? (
          <p>Receipts: {detail.receiptReferences?.join(", ") || "None"}</p>
        ) : null}
        {view.permissions.mayViewDiscrepancy ? (
          <p>Discrepancies: {detail.discrepancyReferences?.join(", ") || "None"}</p>
        ) : null}
      </section>
      <section className="detail-section">
        <h2>Performance timeline</h2>
        {detail.timeline.map((event) => (
          <p key={`${event.action}-${event.occurredAt}`}>
            {event.occurredAt} · {event.action}
          </p>
        ))}
      </section>
      <div className="card-actions">
        {view.permissions.mayRecordResponse ? (
          <button disabled={readOnly || po.workflow !== "Issued"}>
            Record acknowledgement / decline
          </button>
        ) : null}
        {view.permissions.mayManage ? (
          <button
            disabled={
              readOnly ||
              !["Issued", "Acknowledged", "SupplierDeclined"].includes(po.workflow) ||
              po.closure === "Closed"
            }
          >
            Create Revision
          </button>
        ) : null}
        {view.permissions.mayCancel ? (
          <button disabled={readOnly || po.closure === "Closed"}>Cancel eligible remainder</button>
        ) : null}
        {view.permissions.mayClose ? (
          <button
            disabled={
              readOnly ||
              po.closure === "Closed" ||
              detail.lineCompletion.some((line) => !line.final) ||
              (detail.discrepancyReferences?.length ?? 0) > 0
            }
          >
            Close PO
          </button>
        ) : null}
      </div>
      <p role="note">
        Goods Receipt and Stock Ledger facts belong to Inventory. This page cannot override received
        quantity.
      </p>
    </main>
  );
}
function Loader({
  client,
  purchaseOrderReference,
  editor,
}: {
  readonly client: PurchaseOrderProjectionClient;
  readonly purchaseOrderReference: string | null;
  readonly editor: boolean;
}) {
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load({ purchaseOrderReference, editor })
      .then((value) => {
        if (active) setState({ kind: "Found", view: parsePurchaseOrderView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof PurchaseOrderClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client, purchaseOrderReference, editor]);
  if (state.kind !== "Found") return <PurchaseOrderState state={state.kind} />;
  return purchaseOrderReference === null ? (
    <PurchaseOrderList view={state.view} />
  ) : editor ? (
    <PurchaseOrderEditor view={state.view} />
  ) : (
    <PurchaseOrderDetail view={state.view} />
  );
}
export function PurchaseOrderListPage({
  client = unavailablePurchaseOrderClient,
}: {
  readonly client?: PurchaseOrderProjectionClient;
}) {
  return <Loader client={client} purchaseOrderReference={null} editor={false} />;
}
export function PurchaseOrderEditorPage({
  client = unavailablePurchaseOrderClient,
}: {
  readonly client?: PurchaseOrderProjectionClient;
}) {
  const { id = null } = useParams();
  return <Loader client={client} purchaseOrderReference={id} editor />;
}
export function PurchaseOrderDetailPage({
  client = unavailablePurchaseOrderClient,
}: {
  readonly client?: PurchaseOrderProjectionClient;
}) {
  const { id = null } = useParams();
  return <Loader client={client} purchaseOrderReference={id} editor={false} />;
}
