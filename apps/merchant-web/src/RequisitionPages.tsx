import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  parseRequisitionView,
  RequisitionClientError,
  unavailableRequisitionClient,
  type RequisitionClientErrorCode,
  type RequisitionProjectionClient,
  type RequisitionView,
} from "./requisition-pages.js";
type LoadState =
  | { readonly kind: "Loading" | RequisitionClientErrorCode }
  | { readonly kind: "Found"; readonly view: RequisitionView };
export function RequisitionState({
  state,
}: {
  readonly state: Exclude<LoadState["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Requisitions…", "neutral"],
    Empty: ["No requisitions", "No Requisition matches these Brand-scoped filters.", "neutral"],
    PermissionDenied: ["Permission denied", "This Requisition view is unavailable.", "error"],
    NotFound: ["Requisition not found", "The Requisition is unavailable in this Brand.", "neutral"],
    FeatureDisabled: ["Requisitions disabled", "This capability is unavailable.", "neutral"],
    Stale: [
      "Projection stale",
      "Refresh source facts before any workflow or allocation action.",
      "offline",
    ],
    Conflict: ["Requisition changed", "Refresh its Expected Version before retrying.", "offline"],
    ValidationFailed: [
      "Validation required",
      "Resolve line quantities, reasons and approvals.",
      "error",
    ],
    CommandFailed: ["Command failed", "No approval, PO issue or receipt was inferred.", "error"],
    Offline: ["Offline read-only", "Cached facts cannot authorize an operation.", "offline"],
    Unavailable: [
      "Requisition unavailable",
      "No restricted amount, approval or PO reference is inferred.",
      "error",
    ],
  };
  const item = values[state];
  return (
    <StatePanel heading={item[0]} tone={item[2]} status>
      <p>{item[1]}</p>
    </StatePanel>
  );
}
export function RequisitionList({ view }: { readonly view: RequisitionView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">PROC-REQUISITION-LIST · Procurement / Approver</p>
          <h1>Purchase Requisitions</h1>
          <p>
            {view.brandLabel} · {view.freshness} · {view.asOfUtc}
          </p>
        </div>
        {view.permissions.mayManage ? (
          <button disabled={readOnly}>Create Requisition draft</button>
        ) : null}
      </header>
      <p role="note">
        Approval is internal work only. A Supplier commitment requires a separate Purchase Order
        issue.
      </p>
      {readOnly ? <RequisitionState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Reference / Item
          <input disabled placeholder="Exact or prefix search" />
        </label>
        <label>
          Status / Store / Requester
          <select disabled>
            <option>All authorized requisitions</option>
          </select>
        </label>
        <label>
          Urgency / Unallocated / Required date
          <select disabled>
            <option>All registered filters</option>
          </select>
        </label>
      </div>
      {view.rows.length === 0 ? (
        <RequisitionState state="Empty" />
      ) : (
        <div className="card-list">
          {view.rows.map((item) => (
            <article className="summary-card" key={item.requisitionReference}>
              <div>
                <p className="bop-eyebrow">
                  {item.urgency} · {item.workflow} · {item.allocationStatus}
                </p>
                <h2>{item.requisitionReference}</h2>
                <p>
                  {item.requestingScopeLabel} · required {item.requiredByUtc} · {item.lineCount}{" "}
                  lines
                </p>
              </div>
              {view.permissions.mayViewAmount ? (
                <p>
                  Estimate {item.amountEstimate ?? "Partial"} {item.currency ?? ""}
                </p>
              ) : null}
              <p>
                Requester {item.requesterReference} · Approver{" "}
                {item.approverReference ?? "Pending / restricted"}
              </p>
              <div className="card-actions">
                <Link to={`/app/supply/requisitions/${item.requisitionReference}`}>
                  View Requisition
                </Link>
                {view.permissions.mayManage ? (
                  <button disabled={readOnly || item.workflow !== "Draft"}>Submit</button>
                ) : null}
                {view.permissions.mayApprove ? (
                  <button disabled={readOnly || item.workflow !== "InReview"}>
                    Approve / reject
                  </button>
                ) : null}
                {view.permissions.mayAllocate ? (
                  <button
                    disabled={
                      readOnly || item.workflow !== "Approved" || item.closureStatus === "Closed"
                    }
                  >
                    Allocate to PO drafts
                  </button>
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
export function RequisitionDetail({ view }: { readonly view: RequisitionView }) {
  const row = view.rows[0];
  const detail = view.detail;
  if (!row || !detail) return <RequisitionState state="NotFound" />;
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            PROC-REQUISITION-DETAIL · {row.workflow} · v{detail.requisitionVersion}
          </p>
          <h1>{detail.requisitionReference}</h1>
          <p>
            {row.requestingScopeLabel} · {row.allocationStatus} · {row.closureStatus}
          </p>
        </div>
      </header>
      {readOnly ? <RequisitionState state="Stale" /> : null}
      <section className="detail-section">
        <h2>Need sources and requested lines</h2>
        <p>Need sources: {detail.needSourceReferences.join(", ") || "Manual draft"}</p>
        {detail.lines.map((line) => (
          <article key={line.lineReference}>
            <h3>{line.itemName}</h3>
            <p>
              {line.requestedQuantity} {line.requestedUnit} · required {line.requiredByUtc}
            </p>
            <p>
              Candidate Suppliers: {line.candidateSupplierSummaries.join(", ") || "None validated"}
            </p>
            {view.permissions.mayViewAllocationReferences ? (
              <p>PO Draft allocations: {line.allocationReferences?.join(", ") || "None"}</p>
            ) : null}
          </article>
        ))}
      </section>
      <section className="detail-section">
        <h2>Approval and timeline</h2>
        {view.permissions.mayViewApprovalIdentity ? (
          <p>
            Approver {detail.approverReference ?? "Pending"} · approval{" "}
            {detail.approvalReference ?? "Pending"}
          </p>
        ) : (
          <p>Approval identity restricted</p>
        )}
        {detail.timeline.map((event) => (
          <p key={`${event.action}-${event.occurredAt}`}>
            {event.occurredAt} · {event.action}
          </p>
        ))}
      </section>
      <div className="card-actions">
        {view.permissions.mayManage ? (
          <button disabled={readOnly || row.workflow !== "Draft"}>Edit draft</button>
        ) : null}
        {view.permissions.mayManage ? (
          <button disabled={readOnly || row.workflow !== "Draft"}>Submit</button>
        ) : null}
        {view.permissions.mayReview ? (
          <button disabled={readOnly || row.workflow !== "Submitted"}>Start review</button>
        ) : null}
        {view.permissions.mayApprove ? (
          <button disabled={readOnly || row.workflow !== "InReview"}>Approve / reject</button>
        ) : null}
        {view.permissions.mayAllocate ? (
          <button
            disabled={readOnly || row.workflow !== "Approved" || row.closureStatus === "Closed"}
          >
            Split / allocate to PO drafts
          </button>
        ) : null}
        {view.permissions.mayApprove ? (
          <button
            disabled={readOnly || row.workflow !== "Approved" || row.closureStatus === "Closed"}
          >
            Cancel remainder with approval
          </button>
        ) : null}
      </div>
      <p role="note">
        Allocation never changes approval. Receipt belongs to Inventory and cannot close this
        screen.
      </p>
    </main>
  );
}
function Loader({
  client,
  requisitionReference,
}: {
  readonly client: RequisitionProjectionClient;
  readonly requisitionReference: string | null;
}) {
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load({ requisitionReference })
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseRequisitionView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof RequisitionClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, requisitionReference]);
  return state.kind === "Found" ? (
    requisitionReference === null ? (
      <RequisitionList view={state.view} />
    ) : (
      <RequisitionDetail view={state.view} />
    )
  ) : (
    <RequisitionState state={state.kind} />
  );
}
export function RequisitionListPage({
  client = unavailableRequisitionClient,
}: {
  readonly client?: RequisitionProjectionClient;
}) {
  return <Loader client={client} requisitionReference={null} />;
}
export function RequisitionDetailPage({
  client = unavailableRequisitionClient,
}: {
  readonly client?: RequisitionProjectionClient;
}) {
  const { id = null } = useParams();
  return <Loader client={client} requisitionReference={id} />;
}
