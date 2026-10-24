import { AppFrame, StatePanel } from "@bop-rms/ui";
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

function PurchaseOrderUnavailable() {
  return (
    <AppFrame
      className="purchase-order-unavailable-shell"
      title="Purchase orders"
      description="PROC-PO-LIST · Brand, Buyer and Store scope unavailable"
    >
      <div className="purchase-order-unavailable">
        <p className="bop-eyebrow">PROC-PO-LIST · PHASE 3</p>
        <h2>Purchase Order workspace</h2>
        <section
          className="purchase-order-source-boundary"
          role="status"
          aria-label="Purchase Order projection unavailable"
        >
          <h3>Procurement Purchase Order projection unavailable</h3>
          <p>
            No authorized Purchase Order projection is connected. No Supplier, order, cost, receipt
            or discrepancy facts are shown.
          </p>
        </section>
        <h2>Order status</h2>
        <section
          aria-label="Purchase Order status dimensions"
          className="purchase-order-status-grid"
        >
          {["Workflow status", "Fulfillment status", "Closure status"].map((label) => (
            <article className="purchase-order-status-card" key={label}>
              <p>{label}</p>
              <strong>Unavailable</strong>
              <small>Authorized source not connected</small>
            </article>
          ))}
        </section>
        <h2 id="purchase-order-filter-title">Search and filters</h2>
        <fieldset
          aria-labelledby="purchase-order-filter-title"
          className="purchase-order-filter-panel"
          disabled
        >
          <p>Unavailable until the scoped projection is connected.</p>
          <div className="purchase-order-filters-desktop">
            <input
              aria-label="PO reference, Supplier or Item filter unavailable"
              placeholder="PO ref / Supplier / Item · unavailable"
            />
            <input
              aria-label="Workflow, Fulfillment or Closure filter unavailable"
              placeholder="Workflow / Fulfillment / Closure · unavailable"
            />
            <input
              aria-label="Store, Buyer or Date filter unavailable"
              placeholder="Store / Buyer / Date · unavailable"
            />
            <input
              aria-label="Overdue or Discrepancy filter unavailable"
              placeholder="Overdue / Discrepancy · unavailable"
            />
          </div>
          <div className="purchase-order-filters-mobile">
            <label>
              PO ref / Supplier / Item
              <input
                aria-label="PO reference, Supplier or Item filter unavailable"
                placeholder="Unavailable"
              />
            </label>
            <label>
              Workflow · Store · Buyer · Date · Overdue / Discrepancy
              <input
                aria-label="Workflow, Store, Buyer, Date, Overdue or Discrepancy filters unavailable"
                placeholder="Unavailable"
              />
            </label>
          </div>
        </fieldset>
        <section
          className="purchase-order-empty-panel"
          aria-labelledby="purchase-order-empty-title"
        >
          <h3 id="purchase-order-empty-title">Purchase Orders unavailable</h3>
          <p>
            No authorized rows are available to display. Cost, Supplier response, receipt and
            discrepancy details remain independently permission-gated.
          </p>
        </section>
        <section
          className="purchase-order-fields-panel"
          aria-labelledby="purchase-order-fields-title"
        >
          <h3 id="purchase-order-fields-title">
            Registered list fields when the authorized source is available
          </h3>
          <p>
            PO reference · Supplier · Buyer Entity · Ship-To · Currency · Workflow / Fulfillment /
            Closure · ordered / received / open amounts · expected delivery · cost and receiving
            fields by permission
          </p>
        </section>
        <p className="purchase-order-ownership-note">
          Only an explicit Issue creates a Supplier commitment. Inventory owns Goods Receipt and
          Stock Ledger facts.
        </p>
      </div>
    </AppFrame>
  );
}

function PurchaseOrderDetailUnavailable() {
  const snapshotFields = [
    "PO reference",
    "Supplier",
    "Buyer Entity",
    "Ship-To",
    "Currency",
    "Effective revision",
  ];
  const historyFields = [
    "Supplier acknowledgement / decline",
    "Pending or effective Revision",
    "Receipt / discrepancy timeline",
  ];
  const actions = [
    "Record acknowledgement / decline",
    "Create Revision",
    "Cancel eligible remainder",
    "Close Purchase Order",
  ];
  return (
    <AppFrame
      className="purchase-order-detail-unavailable-shell"
      title="Purchase Order"
      description="Procurement · Brand scope unavailable"
    >
      <div className="purchase-order-detail-unavailable">
        <p className="bop-eyebrow">PROC-PO-DETAIL · PHASE 3</p>
        <h2>Purchase Order detail</h2>
        <section
          className="purchase-order-detail-source-boundary"
          role="status"
          aria-label="Purchase Order detail projection unavailable"
        >
          <h3>Purchase Order detail projection unavailable</h3>
          <p>
            No authorized Purchase Order detail facts are available from the current read. No
            Supplier, order, cost, response, receipt or discrepancy data are shown.
          </p>
        </section>

        <section aria-labelledby="purchase-order-detail-states-title">
          <h3 id="purchase-order-detail-states-title">Order states</h3>
          <div className="purchase-order-detail-state-grid">
            {["Workflow status", "Fulfillment status", "Closure status"].map((label) => (
              <article className="purchase-order-detail-card" key={label}>
                <span>{label}</span>
                <strong>Unavailable</strong>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="purchase-order-detail-snapshot-title">
          <h3 id="purchase-order-detail-snapshot-title">Issued Purchase Order snapshot</h3>
          <dl className="purchase-order-detail-snapshot">
            {snapshotFields.map((label) => (
              <div className="purchase-order-detail-card" key={label}>
                <dt>{label}</dt>
                <dd>Unavailable</dd>
              </div>
            ))}
          </dl>
        </section>

        <section
          className="purchase-order-detail-fulfillment"
          aria-labelledby="purchase-order-detail-fulfillment-title"
        >
          <div>
            <h3 id="purchase-order-detail-fulfillment-title">Line receipt and completion</h3>
            <p>Line items and completion quantities unavailable</p>
          </div>
          <div className="purchase-order-detail-quantities">
            {["Ordered amount", "Received amount", "Open amount"].map((label) => (
              <article className="purchase-order-detail-card" key={label}>
                <span>{label}</span>
                <strong>Unavailable</strong>
              </article>
            ))}
          </div>
          <small>Inventory owns Goods Receipt facts; receipt entry is unavailable here.</small>
        </section>

        <section aria-labelledby="purchase-order-detail-history-title">
          <h3 id="purchase-order-detail-history-title">Supplier response and change history</h3>
          <div className="purchase-order-detail-history-grid">
            {historyFields.map((label) => (
              <article className="purchase-order-detail-card" key={label}>
                <span>{label}</span>
                <strong>Unavailable</strong>
              </article>
            ))}
          </div>
        </section>

        <section
          className="purchase-order-detail-actions"
          aria-labelledby="purchase-order-detail-actions-title"
        >
          <h3 id="purchase-order-detail-actions-title">Registered actions</h3>
          <p>
            Actions are unavailable until authorized projection, role and command composition are
            connected.
          </p>
          <div>
            {actions.map((label) => (
              <button disabled key={label} type="button">
                {label}
              </button>
            ))}
          </div>
        </section>

        <p className="purchase-order-detail-invariant">
          Close only after every line has a final received or cancelled outcome, with no pending
          Revision or discrepancy.
        </p>

        <section aria-labelledby="purchase-order-detail-performance-title">
          <h3 id="purchase-order-detail-performance-title">Supplier performance timeline</h3>
          <article className="purchase-order-detail-card">
            <span>Supplier performance timeline</span>
            <strong>Unavailable</strong>
          </article>
        </section>
      </div>
    </AppFrame>
  );
}

function PurchaseOrderEditorUnavailable() {
  const scopeFields = ["Supplier", "Buyer Entity", "Ship-To", "Currency"];
  const revisionFields = ["Draft / Revision state", "Pending revision number"];
  const lineFields = [
    "Approved Offering / Item",
    "Supplier item and unit conversion",
    "Ordered quantity",
    "Purchase unit",
    "Resolved unit price",
    "Expected delivery",
    "Approved Requisition allocation",
  ];
  const termsFields = ["Delivery terms", "Payment terms", "Quantity / price tolerance"];
  const totalFields = ["Subtotal", "Discount", "Total"];
  const actions = [
    "Save Draft / Revision",
    "Validate current snapshot",
    "Submit for approval",
    "Approve as authorized actor",
    "Issue with Buyer authority",
  ];
  const renderFields = (fields: readonly string[], className = "") => (
    <dl className={`purchase-order-detail-snapshot ${className}`.trim()}>
      {fields.map((label) => (
        <div className="purchase-order-detail-card" key={label}>
          <dt>{label}</dt>
          <dd>Unavailable</dd>
        </div>
      ))}
    </dl>
  );
  const renderLineFields = (fields: readonly string[]) => (
    <dl className="purchase-order-editor-line-fields">
      {fields.map((label) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>Unavailable</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <AppFrame
      className="purchase-order-detail-unavailable-shell"
      title="Purchase Order"
      description="Procurement · Brand scope unavailable"
    >
      <div className="purchase-order-detail-unavailable purchase-order-editor-unavailable">
        <p className="bop-eyebrow">PROC-PO-EDITOR · PHASE 3</p>
        <h2>Purchase Order editor</h2>
        <section
          className="purchase-order-detail-source-boundary"
          role="status"
          aria-label="Purchase Order editor projection unavailable"
        >
          <h3>Purchase Order editor projection unavailable</h3>
          <p>Supplier, Offering, pricing, quantity, terms and allocation facts are unavailable.</p>
        </section>

        <section aria-labelledby="purchase-order-editor-scope-title">
          <h3 id="purchase-order-editor-scope-title">Supplier / Buyer / Ship-To / currency</h3>
          {renderFields(
            scopeFields,
            "purchase-order-editor-scope-grid purchase-order-editor-value-grid",
          )}
        </section>

        <section aria-labelledby="purchase-order-editor-revision-title">
          <h3 id="purchase-order-editor-revision-title">Workflow and revision</h3>
          <div className="purchase-order-detail-state-grid purchase-order-editor-revision-grid">
            {revisionFields.map((label) => (
              <article className="purchase-order-detail-card" key={label}>
                <span>{label}</span>
                <strong>Unavailable</strong>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="purchase-order-editor-lines-title">
          <h3 id="purchase-order-editor-lines-title">
            Offering-based lines and source allocations
          </h3>
          <div className="purchase-order-editor-line-boundary">
            <p>No authorized Offering-based lines are available.</p>
            {renderLineFields(lineFields)}
            <p className="purchase-order-editor-receipt-boundary">
              Inventory owns Goods Receipt; receipt entry is unavailable here.
            </p>
          </div>
        </section>

        <section aria-labelledby="purchase-order-editor-terms-title">
          <h3 id="purchase-order-editor-terms-title">Terms and tolerance</h3>
          {renderFields(termsFields, "purchase-order-editor-value-grid")}
        </section>

        <section aria-labelledby="purchase-order-editor-totals-title">
          <h3 id="purchase-order-editor-totals-title">Totals and validation impact</h3>
          <div className="purchase-order-detail-quantities purchase-order-editor-total-grid">
            {totalFields.map((label) => (
              <article className="purchase-order-detail-card" key={label}>
                <span>{label}</span>
                <strong>Unavailable</strong>
              </article>
            ))}
          </div>
          <p className="purchase-order-editor-validation">Validation and impact: Unavailable</p>
        </section>

        <section
          className="purchase-order-detail-actions"
          aria-labelledby="purchase-order-editor-actions-title"
        >
          <h3 id="purchase-order-editor-actions-title">Registered actions</h3>
          <p>
            Actions are unavailable until the authorized projection, role and command composition
            are connected.
          </p>
          <div>
            {actions.map((label) => (
              <button disabled key={label} type="button">
                {label}
              </button>
            ))}
          </div>
        </section>

        <p className="purchase-order-detail-invariant">
          Approval is separate from Issue. Only explicit Issue creates a Supplier commitment;
          arbitrary line price is unavailable.
        </p>
      </div>
    </AppFrame>
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
  if (state.kind !== "Found") {
    if (state.kind === "Unavailable" && purchaseOrderReference === null)
      return <PurchaseOrderUnavailable />;
    if (state.kind === "Unavailable" && purchaseOrderReference !== null && !editor)
      return <PurchaseOrderDetailUnavailable />;
    if (state.kind === "Unavailable" && purchaseOrderReference !== null && editor)
      return <PurchaseOrderEditorUnavailable />;
    return <PurchaseOrderState state={state.kind} />;
  }
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
