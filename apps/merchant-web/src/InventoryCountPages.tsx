import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  InventoryCountClientError,
  parseInventoryCountView,
  unavailableInventoryCountClient,
  type InventoryCountClientErrorCode,
  type InventoryCountProjectionClient,
  type InventoryCountScreenId,
  type InventoryCountView,
  type InventoryCountViewRow,
} from "./inventory-count-pages.js";

type State =
  | { readonly kind: "Loading" | InventoryCountClientErrorCode }
  | { readonly kind: "Found"; readonly view: InventoryCountView };

export function InventoryCountState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Count work…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Count action permission and Stock Scope are required.",
      "error",
    ],
    NotFound: ["Count unavailable", "No Count exists in the authorized scope.", "neutral"],
    FeatureDisabled: ["Counting disabled", "Stock Count is not enabled for this Store.", "neutral"],
    Stale: ["Stock projection stale", "Refresh the snapshot before Count posting.", "offline"],
    Conflict: [
      "Count or balance changed",
      "Refresh the aggregate and Balance versions before retrying.",
      "offline",
    ],
    CommandFailed: ["Count command failed", "No Count or Movement fact is assumed.", "error"],
    Offline: ["Offline read-only", "Cached Count work cannot submit, approve or post.", "offline"],
    Unavailable: [
      "Count service unavailable",
      "No expected quantity or Ledger result is inferred.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
      <Link to="/operations/inventory">Return to Stock Overview</Link>
    </StatePanel>
  );
}

function CountCard({ count }: { readonly count: InventoryCountViewRow }) {
  return (
    <article className="store-card">
      <header>
        <div>
          <p className="bop-eyebrow">
            {count.countReference} · {count.countType}
          </p>
          <h3>{count.status}</h3>
        </div>
        <strong>
          {count.countedLines}/{count.totalLines}
        </strong>
      </header>
      <p>
        {count.assigneeDisplay ?? "Unassigned"} · due {count.dueAt ?? "Not set"}
      </p>
      <p>
        {count.expectedQuantityVisibility} · {count.movementControl} · snapshot{" "}
        {count.snapshotCapturedAt}
      </p>
      <p>
        Variance lines: {count.varianceLines ?? "Hidden until submit"} · {count.approvalPolicy}
      </p>
      <div className="card-actions">
        <Link to={`/operations/inventory/counts/${count.countReference}`}>Open workbench</Link>
        <button disabled>Assign</button>
        <button disabled>Start / Continue</button>
        <button disabled>Cancel with reason</button>
      </div>
    </article>
  );
}

export function InventoryCountScreen({ view }: { readonly view: InventoryCountView }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const selected = view.counts.find(
    (entry) => entry.countReference === view.selectedCountReference,
  );
  const normalized = query.trim().toUpperCase();
  const counts = view.counts.filter(
    (entry) =>
      (status === "All" || entry.status === status) &&
      (normalized.length === 0 || entry.countReference.toUpperCase().includes(normalized)),
  );
  const title = view.screenId === "INV-COUNT-WORKBENCH" ? "Stock Count Workbench" : "Stock Counts";
  return (
    <AppFrame title={title} description={`${view.screenId} · ${view.projectionName}`}>
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Inventory Count · immutable snapshot and Movement posting</p>
          <h2>{title}</h2>
          <p>
            {view.stockScope.scopeType} · {view.stockScope.scopeLabel} · {view.freshness} ·{" "}
            {view.asOfUtc}
          </p>
        </div>
        <div className="card-actions">
          <button disabled>Create Count</button>
          <Link to="/app/supply/movements">Movement Explorer</Link>
        </div>
      </header>
      {view.freshness !== "Current" || view.partial ? (
        <StatePanel heading="Projection stale / partial — posting disabled" tone="offline" status>
          <p>
            Count entry may remain read-only; posting requires current Balance versions and atomic
            Ledger access.
          </p>
        </StatePanel>
      ) : null}
      {view.screenId === "INV-COUNT-WORKBENCH" && selected ? (
        <>
          <CountCard count={selected} />
          <section className="detail-section">
            <h3>Blind count lines and variance</h3>
            <p>
              Snapshot {selected.snapshotReference} · {selected.movementControl}. Expected
              quantities stay hidden for BlindUntilSubmit until submission.
            </p>
            <div className="store-card-grid">
              {selected.lines.map((line) => (
                <article className="store-card" key={line.lineReference}>
                  <header>
                    <div>
                      <p className="bop-eyebrow">{line.internalCode}</p>
                      <h3>{line.itemName}</h3>
                    </div>
                    <strong>{line.conflict}</strong>
                  </header>
                  <p>
                    {line.locationLabel} · lot {line.lotReference ?? "Not applicable"} ·{" "}
                    {line.unitCode}
                  </p>
                  <p>
                    Expected: {line.expectedQuantity ?? "Blind — hidden"} · Counted:{" "}
                    {line.countedQuantity ?? "Missing"} · Variance: {line.variance ?? "Hidden"}
                  </p>
                  <p>
                    Reason: {line.varianceReasonCode ?? "Required when variance is non-zero"} ·
                    recount {line.recountNumber}
                  </p>
                  <div className="card-actions">
                    <button disabled>Enter / scan quantity</button>
                    <button disabled>Save progress</button>
                    <button disabled>Recount</button>
                  </div>
                </article>
              ))}
            </div>
            <div className="card-actions">
              <button disabled>Submit complete count</button>
              <button disabled>Approve (segregated)</button>
              <button disabled>Reject for recount</button>
              <button disabled>Post idempotent Movements</button>
            </div>
          </section>
        </>
      ) : (
        <>
          <div className="list-filters" role="search">
            <label>
              Count reference
              <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
            </label>
            <label>
              Status
              <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
                <option>All</option>
                <option>Draft</option>
                <option>Assigned</option>
                <option>InProgress</option>
                <option>Submitted</option>
                <option>Approved</option>
                <option>Cancelled</option>
                <option>Posted</option>
              </select>
            </label>
            <label>
              Scope
              <input disabled readOnly value={view.stockScope.scopeLabel} />
            </label>
          </div>
          {counts.length === 0 ? (
            <StatePanel heading="No matching Stock Counts" status>
              <p>No Count matches the authorized filters.</p>
            </StatePanel>
          ) : (
            <div className="store-card-grid">
              {counts.map((count) => (
                <CountCard key={count.countReference} count={count} />
              ))}
            </div>
          )}
        </>
      )}
    </AppFrame>
  );
}

function Page({
  screenId,
  client = unavailableInventoryCountClient,
}: {
  readonly screenId: InventoryCountScreenId;
  readonly client?: InventoryCountProjectionClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        const view = parseInventoryCountView(value);
        if (view.screenId !== screenId) throw new InventoryCountClientError("Unavailable");
        if (active) setState({ kind: "Found", view });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof InventoryCountClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client, screenId]);
  return state.kind === "Found" ? (
    <InventoryCountScreen view={state.view} />
  ) : (
    <InventoryCountState state={state.kind} />
  );
}

export const InventoryCountListPage = (props: {
  readonly client?: InventoryCountProjectionClient;
}) => <Page {...props} screenId="INV-COUNT-LIST" />;
export const InventoryCountWorkbenchPage = (props: {
  readonly client?: InventoryCountProjectionClient;
}) => <Page {...props} screenId="INV-COUNT-WORKBENCH" />;
