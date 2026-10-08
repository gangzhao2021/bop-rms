import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./RoleAdministrationPages.js";
import {
  StockCountPageError,
  parseStockCountListView,
  parseStockCountWorkbenchView,
  unavailableStockCountClient,
  validCountedQuantity,
  type StockCountClient,
  type StockCountCommand,
  type StockCountErrorCode,
  type StockCountListView,
} from "./stock-count-pages.js";

/** WP-2423 / DEC-INV-STOCK-COUNT: Store stock counts — blind counting, review and posting. */
const copy: Record<StockCountErrorCode | "Loading", string> = {
  Loading: "Loading stock counts…",
  PermissionDenied: "You do not have permission for this count action.",
  NotFound: "This count does not exist for the selected Store.",
  Conflict: "The count changed meanwhile. Refresh and check before trying again.",
  AlreadyOpen: "This location already has an open count. Finish or cancel it first.",
  StockChanged:
    "Stock moved on the highlighted lines after they were counted (sales, receipts or waste). Send the count back; the counter refreshes those lines and counts them again.",
  Incomplete:
    "Every line needs a count before submitting, and every difference needs a reason before approval.",
  NotIndependent: "The person who submitted the count cannot review or approve it.",
  State: "This step is not possible in the count's current state.",
  LineInvalid: "The highlighted count is not valid for the item's unit precision.",
  Invalid: "The request is not valid.",
  Offline: "Offline. Nothing was confirmed; retry sends the same request again.",
  Unavailable: "Stock counts are unavailable.",
};
const statusText: Record<string, string> = {
  Draft: "Draft",
  Assigned: "Assigned",
  InProgress: "Counting",
  Submitted: "Submitted for review",
  Approved: "Approved",
  Cancelled: "Cancelled",
  Posted: "Posted",
};
const reasonText = (code: string) =>
  code.charAt(0) + code.slice(1).toLowerCase().replaceAll("_", " ");

type State<V> =
  { readonly kind: "Loading" | StockCountErrorCode } | { readonly kind: "Found"; readonly view: V };
function useView<V>(
  client: StockCountClient,
  reference: string | null,
  parse: (value: unknown) => V,
) {
  const [state, setState] = useState<State<V>>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load(reference)
      .then((value) => {
        if (active) setState({ kind: "Found", view: parse(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof StockCountPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, reference, parse, generation]);
  return { state, reload };
}
function Failure({ code }: { code: StockCountErrorCode | "Loading" }) {
  return (
    <StatePanel heading="Stock counts" tone={code === "Loading" ? "neutral" : "error"} status>
      <p>{copy[code]}</p>
    </StatePanel>
  );
}

export function StockCountListPage({
  client = unavailableStockCountClient,
}: {
  readonly client?: StockCountClient;
}) {
  const { state } = useView(client, null, parseStockCountListView);
  const navigate = useNavigate();
  const [location, setLocation] = useState(""),
    [countType, setCountType] = useState<"Full" | "Cycle" | "Spot">("Cycle"),
    [assignee, setAssignee] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<StockCountErrorCode | null>(null),
    [operation] = useState(newOperationReference);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: StockCountListView = state.view;
  const place = (reference: string) =>
    view.locations.find((item) => item.locationReference === reference)?.name ?? "Location";
  const person = (reference: string | null) =>
    reference === null
      ? "—"
      : (view.staff.find((item) => item.actorReference === reference)?.label ??
        "Staff " + reference.slice(-4));
  const create = async () => {
    if (!client.command) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await client.command({
        action: "Create",
        operationReference: operation,
        locationReference: location || (view.locations[0]?.locationReference ?? ""),
        countType,
        assigneeReference: assignee || view.viewer,
      })) as { countReference: string };
      navigate(`/operations/inventory/counts/${result.countReference}`);
    } catch (failure) {
      setError(failure instanceof StockCountPageError ? failure.code : "Unavailable");
    } finally {
      setBusy(false);
    }
  };
  return (
    <AppFrame title="Stock counts" description="INV-COUNT-LIST">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-COUNT-LIST</p>
          <h2>Stock counts</h2>
          <p>
            Count one storage location at a time, ideally while the Store is closed. Counters count
            blind; a manager explains the differences and posts them. Source as of{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
      </header>
      {view.permissions.mayCreate ? (
        <form
          className="detail-section"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <h3>Start a count</h3>
          <label>
            Location
            <select value={location} onChange={(e) => setLocation(e.currentTarget.value)}>
              {view.locations.map((item) => (
                <option key={item.locationReference} value={item.locationReference}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Type
            <select
              value={countType}
              onChange={(e) => setCountType(e.currentTarget.value as "Full" | "Cycle" | "Spot")}
            >
              <option value="Cycle">Cycle count (routine)</option>
              <option value="Full">Full count (period end)</option>
              <option value="Spot">Spot check</option>
            </select>
          </label>
          <label>
            Counted by
            <select value={assignee} onChange={(e) => setAssignee(e.currentTarget.value)}>
              {view.staff.map((item) => (
                <option
                  key={item.actorReference}
                  value={item.actorReference === view.viewer ? "" : item.actorReference}
                >
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy || view.locations.length === 0}>Start count</button>
          {error ? (
            <StatePanel heading="Not started" tone="error" status>
              <p>{copy[error]}</p>
            </StatePanel>
          ) : null}
        </form>
      ) : null}
      {view.counts.length === 0 ? (
        <StatePanel heading="No counts yet" status>
          <p>Counts appear here once started.</p>
        </StatePanel>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Location</th>
              <th>Type</th>
              <th>Counted by</th>
              <th>Progress</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {view.counts.map((count) => (
              <tr key={count.countReference}>
                <td>
                  <Link to={`/operations/inventory/counts/${count.countReference}`}>
                    {count.createdAt}
                  </Link>
                </td>
                <td>{place(count.locationReference)}</td>
                <td>{count.countType}</td>
                <td>{person(count.assigneeReference)}</td>
                <td>
                  {count.countedLines} / {count.lineCount}
                </td>
                <td>{statusText[count.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AppFrame>
  );
}

export function StockCountWorkbenchPage({
  client = unavailableStockCountClient,
}: {
  readonly client?: StockCountClient;
}) {
  const params = useParams();
  const { state, reload } = useView(client, params.id ?? null, parseStockCountWorkbenchView);
  const [entries, setEntries] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<{ code: StockCountErrorCode; lines: readonly string[] } | null>(
      null,
    );
  const view = state.kind === "Found" ? state.view : null;
  const items = useMemo(
    () => new Map((view?.items ?? []).map((item) => [item.itemReference, item])),
    [view],
  );
  const run = useCallback(
    async (commands: readonly StockCountCommand[] | ((version: number) => StockCountCommand)[]) => {
      if (!client.command || !view) return;
      setBusy(true);
      setError(null);
      try {
        let version = view.count.aggregateVersion;
        for (const make of commands) {
          const command = typeof make === "function" ? make(version) : make;
          const result = (await client.command(command)) as { version?: number };
          if (typeof result.version === "number") version = result.version;
        }
        setEntries({});
        reload();
      } catch (failure) {
        setError(
          failure instanceof StockCountPageError
            ? { code: failure.code, lines: failure.lineReferences }
            : { code: "Unavailable", lines: [] },
        );
        reload();
      } finally {
        setBusy(false);
      }
    },
    [client, view, reload],
  );
  if (state.kind !== "Found" || !view)
    return <Failure code={state.kind === "Found" ? "Unavailable" : state.kind} />;
  const count = view.count;
  const location =
    view.locations.find((item) => item.locationReference === count.stockScope.scopeReference)
      ?.name ?? "Location";
  const person = (reference: string | null) =>
    reference === null
      ? "—"
      : (view.staff.find((item) => item.actorReference === reference)?.label ??
        "Staff " + reference.slice(-4));
  const isAssignee = count.assigneeReference === view.viewer;
  const counting = count.status === "InProgress" && isAssignee && view.permissions.mayCount;
  const reviewing =
    count.status === "Submitted" &&
    view.permissions.mayApprove &&
    count.submittedBy !== view.viewer;
  const base =
    (action: "Start" | "Submit" | "Refresh" | "SendBack" | "Cancel") => (version: number) =>
      ({
        action,
        operationReference: newOperationReference(),
        countReference: count.countReference,
        expectedVersion: version,
      }) as const;
  const save = () => {
    const changed = count.lines.filter((line) => (entries[line.lineReference] ?? "").trim() !== "");
    for (const line of changed) {
      const item = items.get(line.itemReference);
      if (!validCountedQuantity(entries[line.lineReference] ?? "", item?.ledgerPrecision ?? 0)) {
        setError({ code: "LineInvalid", lines: [line.lineReference] });
        return;
      }
    }
    void run(
      changed.map((line) => (version: number) => ({
        action: "SaveLine" as const,
        operationReference: newOperationReference(),
        countReference: count.countReference,
        expectedVersion: version,
        lineReference: line.lineReference,
        countedQuantity: (entries[line.lineReference] ?? "").trim(),
      })),
    );
  };
  const counted = count.lines.filter((line) => line.countedQuantity !== null).length;
  return (
    <AppFrame title={`Count · ${location}`} description="INV-COUNT-WORKBENCH">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-COUNT-WORKBENCH · {count.countType}</p>
          <h2>Count · {location}</h2>
          <p>
            {statusText[count.status]} · counted by {person(count.assigneeReference)} · {counted} of{" "}
            {count.lines.length} lines counted
            {count.submittedBy ? ` · submitted by ${person(count.submittedBy)}` : ""}
            {count.approvedBy ? ` · approved by ${person(count.approvedBy)}` : ""}
          </p>
        </div>
        <Link to="/operations/inventory/counts">All counts</Link>
      </header>
      {error ? (
        <StatePanel heading="Not recorded" tone="error" status>
          <p>{copy[error.code]}</p>
        </StatePanel>
      ) : null}
      {count.status === "Assigned" && isAssignee && view.permissions.mayCount ? (
        <button disabled={busy} onClick={() => void run([base("Start")])}>
          Start counting
        </button>
      ) : null}
      {count.status === "Assigned" && !isAssignee ? (
        <p>Waiting for {person(count.assigneeReference)} to start counting.</p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Lot</th>
            <th>Unit</th>
            {count.lines.some((line) => line.expectedQuantity !== null) ? <th>Expected</th> : null}
            <th>Counted</th>
            {count.lines.some((line) => line.variance !== null) ? <th>Difference</th> : null}
            {count.status !== "InProgress" ? <th>Reason</th> : null}
          </tr>
        </thead>
        <tbody>
          {count.lines.map((line) => {
            const item = items.get(line.itemReference);
            const lot = line.lotReference ? view.lots[line.lotReference] : undefined;
            const flagged = error?.lines.includes(line.lineReference) ?? false;
            return (
              <tr
                key={line.lineReference}
                aria-invalid={flagged}
                style={flagged ? { outline: "2px solid #b42318" } : undefined}
              >
                <td>{item?.name ?? "Item"}</td>
                <td>
                  {lot ? `${lot.lotCode}${lot.expiryDate ? ` (exp. ${lot.expiryDate})` : ""}` : "—"}
                </td>
                <td>{line.unitCode}</td>
                {count.lines.some((other) => other.expectedQuantity !== null) ? (
                  <td>{line.expectedQuantity ?? ""}</td>
                ) : null}
                <td>
                  {counting ? (
                    <input
                      aria-label={`Counted ${item?.name ?? "item"}${lot ? " " + lot.lotCode : ""}`}
                      inputMode="decimal"
                      placeholder={line.countedQuantity ?? ""}
                      value={entries[line.lineReference] ?? ""}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setEntries((current) => ({ ...current, [line.lineReference]: value }));
                      }}
                    />
                  ) : (
                    (line.countedQuantity ?? "")
                  )}
                </td>
                {count.lines.some((other) => other.variance !== null) ? (
                  <td>{line.variance ?? ""}</td>
                ) : null}
                {count.status !== "InProgress" ? (
                  <td>
                    {reviewing && line.variance !== null && line.variance !== "0" ? (
                      <select
                        aria-label={`Reason ${item?.name ?? "item"}`}
                        value={line.varianceReasonCode ?? ""}
                        disabled={busy}
                        onChange={(event) => {
                          const reason = event.currentTarget.value;
                          if (reason)
                            void run([
                              (version: number) => ({
                                action: "ExplainVariance" as const,
                                operationReference: newOperationReference(),
                                countReference: count.countReference,
                                expectedVersion: version,
                                lineReference: line.lineReference,
                                varianceReasonCode: reason,
                              }),
                            ]);
                        }}
                      >
                        <option value="">Choose a reason</option>
                        {view.varianceReasons.map((reason) => (
                          <option key={reason} value={reason}>
                            {reasonText(reason)}
                          </option>
                        ))}
                      </select>
                    ) : line.varianceReasonCode ? (
                      reasonText(line.varianceReasonCode)
                    ) : (
                      ""
                    )}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {counting ? (
        <p>
          <button disabled={busy} onClick={save}>
            Save counts
          </button>{" "}
          <button
            disabled={busy || counted < count.lines.length}
            onClick={() => void run([base("Submit")])}
          >
            Submit for review
          </button>{" "}
          <button disabled={busy} onClick={() => void run([base("Refresh")])}>
            Refresh lines where stock moved
          </button>
        </p>
      ) : null}
      {reviewing ? (
        <p>
          <button
            disabled={
              busy ||
              count.lines.some((line) => line.variance !== "0" && line.varianceReasonCode === null)
            }
            onClick={() =>
              void run([
                (version: number) => ({
                  action: "ApproveAndPost" as const,
                  operationReference: newOperationReference(),
                  postOperationReference: newOperationReference(),
                  countReference: count.countReference,
                  expectedVersion: version,
                }),
              ])
            }
          >
            Approve and post differences
          </button>{" "}
          <button disabled={busy} onClick={() => void run([base("SendBack")])}>
            Send back for recount
          </button>
        </p>
      ) : null}
      {count.status === "Submitted" && count.submittedBy === view.viewer ? (
        <p>Submitted. Another manager reviews and posts the differences.</p>
      ) : null}
      {["Draft", "Assigned", "InProgress"].includes(count.status) && view.permissions.mayCreate ? (
        <button disabled={busy} onClick={() => void run([base("Cancel")])}>
          Cancel count
        </button>
      ) : null}
    </AppFrame>
  );
}
