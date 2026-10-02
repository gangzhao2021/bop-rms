import { DiningHostTransferAction } from "./DiningHostTransferAction.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppFrame } from "@bop-rms/ui";
import {
  createDiningSessionClient,
  DiningSessionClientError,
  type StaffDiningTable,
} from "./dining-session-client.js";
import { serviceOperationReference } from "./service-control-client.js";
type Operation = ReturnType<ReturnType<typeof createDiningSessionClient>["prepareStart"]>;
type AvailabilityOperation = ReturnType<
  ReturnType<typeof createDiningSessionClient>["prepareAvailability"]
>;
export function DiningSessionWorkspace({
  csrf,
  storeLabel,
  navigation,
}: {
  readonly csrf: string;
  readonly storeLabel: string;
  readonly navigation?: ReactNode;
}) {
  const [tables, setTables] = useState<StaffDiningTable[]>([]),
    [next, setNext] = useState<string | null>(null),
    [selected, setSelected] = useState<StaffDiningTable | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [code, setCode] = useState<string | null>(null),
    [message, setMessage] = useState(""),
    [state, setState] = useState<"Idle" | "Loading" | "Submitting" | "Unknown">("Idle");
  const pending = useRef<AbortController | null>(null),
    operation = useRef<Operation | null>(null),
    availabilityOperation = useRef<AvailabilityOperation | null>(null);
  const [canOperateTables, setCanOperateTables] = useState(false),
    [blockReasonCode, setBlockReasonCode] = useState(""),
    [unknownAction, setUnknownAction] = useState<"Session" | "Availability" | null>(null);
  const [hostLocked, setHostLocked] = useState(false);
  const [search, setSearch] = useState("");
  const [areaFilter, setAreaFilter] = useState("All");
  const [stateFilter, setStateFilter] = useState("All");
  const locked = state !== "Idle" || hostLocked;
  const load = async (more = false) => {
    if ((pending.current && !pending.current.signal.aborted) || state === "Unknown" || hostLocked)
      return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Loading");
    setCode(null);
    setSelected(null);
    setConfirmed(false);
    setMessage("");
    operation.current = null;
    availabilityOperation.current = null;
    setUnknownAction(null);
    try {
      const result = await createDiningSessionClient().tables(
        csrf,
        more ? next : null,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setTables((prior) => (more ? [...prior, ...result.items] : result.items));
        setNext(result.next);
        setCanOperateTables(result.canOperateTables);
        if (result.items.length === 0 && !more)
          setMessage("No tables are available in this Store.");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setTables([]);
        setNext(null);
        setCanOperateTables(false);
        setMessage(
          error instanceof DiningSessionClientError && error.code === "Denied"
            ? "Your current permissions do not allow table operations."
            : "Tables unavailable. Check your connection and refresh.",
        );
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setState("Idle");
      }
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
    return () => {
      const controller = pending.current;
      controller?.abort();
      if (pending.current === controller) pending.current = null;
    };
  }, []);
  const execute = async () => {
    if (
      hostLocked ||
      (state === "Unknown" && unknownAction !== "Session") ||
      !selected ||
      pending.current ||
      (!operation.current && (!confirmed || locked))
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    setCode(null);
    setMessage("");
    try {
      const client = createDiningSessionClient();
      if (!operation.current) {
        if (selected.currentDiningSessionReference === null) {
          operation.current = client.prepareStart(selected, serviceOperationReference());
        } else {
          const current = await client.joinState(
            selected.currentDiningSessionReference,
            csrf,
            controller.signal,
          );
          if (current.tableReference !== selected.tableReference)
            throw new DiningSessionClientError("Denied");
          operation.current = client.prepareRegenerate(current, serviceOperationReference());
        }
      }
      const result = await operation.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        const elapsedMinutes = result.status === "Issued" ? 0 : null;
        setSelected({
          ...selected,
          currentDiningSessionReference: result.diningSessionReference,
          elapsedMinutes,
        });
        setTables((rows) =>
          rows.map((t) =>
            t.tableReference === selected.tableReference
              ? {
                  ...t,
                  currentDiningSessionReference: result.diningSessionReference,
                  elapsedMinutes,
                }
              : t,
          ),
        );
        setCode(result.joinCredential);
        setConfirmed(false);
        operation.current = null;
        setUnknownAction(null);
        setState("Idle");
        setMessage(
          result.joinCredential
            ? "Share this one-time code with the party at this table."
            : "The request already completed. Its code cannot be displayed again. Confirm replacement to generate a new code.",
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const unknown = error instanceof DiningSessionClientError && error.code === "Unknown";
        setState(unknown ? "Unknown" : "Idle");
        setUnknownAction(unknown ? "Session" : null);
        if (!unknown) {
          operation.current = null;
          setConfirmed(false);
        }
        setMessage(
          unknown
            ? "The result is unknown. Retry the same request before starting another operation."
            : "The request was not confirmed. Refresh the table and check your permissions.",
        );
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  const executeAvailability = async (action: "SetBlock" | "ClearBlock") => {
    if (
      !canOperateTables ||
      hostLocked ||
      !selected ||
      pending.current ||
      (state === "Unknown" && unknownAction !== "Availability") ||
      (action === "SetBlock" && !/^[A-Z][A-Z0-9_-]{0,63}$/.test(blockReasonCode))
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    setCode(null);
    setMessage("");
    try {
      const client = createDiningSessionClient();
      if (!availabilityOperation.current)
        availabilityOperation.current = client.prepareAvailability(
          selected,
          action,
          action === "SetBlock" ? blockReasonCode : null,
          serviceOperationReference(),
        );
      const result = await availabilityOperation.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        const updated: StaffDiningTable = {
          ...selected,
          operationalState: result.operationalState,
          aggregateVersion: result.aggregateVersion,
        };
        setSelected(updated);
        setTables((rows) =>
          rows.map((row) => (row.tableReference === updated.tableReference ? updated : row)),
        );
        availabilityOperation.current = null;
        setUnknownAction(null);
        setBlockReasonCode("");
        setState("Idle");
        setMessage(
          action === "SetBlock"
            ? "Table marked temporarily unavailable."
            : "Table marked available.",
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const unknown = error instanceof DiningSessionClientError && error.code === "Unknown";
        setState(unknown ? "Unknown" : "Idle");
        setUnknownAction(unknown ? "Availability" : null);
        if (!unknown) availabilityOperation.current = null;
        setMessage(
          unknown
            ? "The result is unknown. Retry the same table request before starting another operation."
            : "The table request was not confirmed. Refresh and check current permissions.",
        );
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  const eligible = selected?.lifecycle === "Published" && selected.operationalState === "Available";
  const areas = useMemo(() => [...new Set(tables.map((table) => table.areaCode))].sort(), [tables]);
  const visibleTables = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return tables.filter(
      (table) =>
        (!query || table.stableLabel.toLocaleLowerCase().includes(query)) &&
        (areaFilter === "All" || table.areaCode === areaFilter) &&
        (stateFilter === "All" || table.operationalState === stateFilter),
    );
  }, [areaFilter, search, stateFilter, tables]);
  const visibleAreas = useMemo(
    () => [...new Set(visibleTables.map((table) => table.areaCode))],
    [visibleTables],
  );
  return (
    <AppFrame title="OPERATIONS" description="" navigation={navigation}>
      <div className="dining-workspace">
        <header className="screen-heading dining-floor-heading">
          <div>
            <h2>Dining</h2>
            <p className="bop-eyebrow">DIN-FLOOR-BOARD · FLOOR</p>
            <p className="dining-store-label">{storeLabel}</p>
          </div>
          <div className="dining-floor-toolbar">
            <button disabled={locked} onClick={() => void load()}>
              Refresh tables
            </button>
            {next ? (
              <button disabled={locked} onClick={() => void load(true)}>
                Load more tables
              </button>
            ) : null}
          </div>
        </header>
        <aside className="dining-projection-limits" aria-label="Dining data availability">
          <strong>Table and current-session data</strong>
          <p>
            Party, Order, payment, reservation, waitlist and attention details are not available
            from this source.
          </p>
        </aside>
        <section className="dining-table-browser" aria-labelledby="dining-table-browser-title">
          <h3 id="dining-table-browser-title">Tables and sessions</h3>
          <p>Search and filters use fields in the current table projection.</p>
          <div className="dining-floor-filters" role="search">
            <label>
              Table
              <input
                placeholder="Search labels"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </label>
            <label>
              Area
              <select
                value={areaFilter}
                onChange={(event) => setAreaFilter(event.currentTarget.value)}
              >
                <option>All</option>
                {areas.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              Table state
              <select
                value={stateFilter}
                onChange={(event) => setStateFilter(event.currentTarget.value)}
              >
                <option>All</option>
                <option>Available</option>
                <option>TemporarilyBlocked</option>
              </select>
            </label>
          </div>
        </section>
        <div className="dining-floor-layout">
          <section className="dining-floor-board" aria-label="Dining tables by area">
            {visibleAreas.length === 0 ? (
              <p role="status">
                {tables.length === 0
                  ? state === "Loading"
                    ? "Loading tables…"
                    : message || "No tables have been loaded."
                  : "No tables match the current filters."}
              </p>
            ) : (
              visibleAreas.map((area) => {
                const areaTables = visibleTables.filter((table) => table.areaCode === area);
                return (
                  <section className="dining-area-lane" key={area} aria-label={`${area} area`}>
                    <header>
                      <h3>{area}</h3>
                      <span>{areaTables.length}</span>
                    </header>
                    <div className="dining-table-grid">
                      {areaTables.map((table) => (
                        <article
                          className="dining-table-tile"
                          key={table.tableReference}
                          data-selected={selected?.tableReference === table.tableReference}
                          data-state={table.operationalState}
                          data-session={table.currentDiningSessionReference ? "linked" : "none"}
                        >
                          <div className="dining-table-tile__identity">
                            <h4>{table.stableLabel}</h4>
                            <span>
                              {table.operationalState === "TemporarilyBlocked"
                                ? "Temporarily blocked"
                                : table.operationalState}
                            </span>
                          </div>
                          <hr className="dining-table-tile__divider" />
                          <p className="dining-table-tile__capacity">Seats {table.capacity}</p>
                          <p className="dining-table-tile__session">
                            {table.currentDiningSessionReference
                              ? table.elapsedMinutes === null
                                ? "Session elapsed time unavailable"
                                : `${table.elapsedMinutes} min elapsed`
                              : "No active session"}
                          </p>
                          <button
                            disabled={locked}
                            aria-pressed={selected?.tableReference === table.tableReference}
                            onClick={() => {
                              setSelected(table);
                              setConfirmed(false);
                              setCode(null);
                              setMessage("");
                              operation.current = null;
                              availabilityOperation.current = null;
                              setBlockReasonCode("");
                            }}
                          >
                            Select {table.stableLabel}
                          </button>
                        </article>
                      ))}
                    </div>
                  </section>
                );
              })
            )}
          </section>
          <aside
            className="dining-session-detail"
            aria-label="Selected table details"
            aria-live="polite"
          >
            {selected ? (
              <>
                <p className="bop-eyebrow">
                  {selected.areaCode} · {selected.operationalState}
                </p>
                <h3>Table {selected.stableLabel}</h3>
                <dl>
                  <div>
                    <dt>Capacity</dt>
                    <dd>{selected.capacity}</dd>
                  </div>
                  <div>
                    <dt>Session</dt>
                    <dd>
                      {selected.currentDiningSessionReference
                        ? selected.elapsedMinutes === null
                          ? "Linked · elapsed time unavailable"
                          : `Linked · ${selected.elapsedMinutes} min elapsed`
                        : "None"}
                    </dd>
                  </div>
                  <div>
                    <dt>Lifecycle</dt>
                    <dd>{selected.lifecycle}</dd>
                  </div>
                </dl>
                <section aria-label="Dining session action">
                  <p>
                    {selected.currentDiningSessionReference
                      ? "Replacing the entry code invalidates the previous code. Existing participants remain joined."
                      : "Start a new dining session for this party."}
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={locked}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    I confirm the selected table and session action
                  </label>
                  <button
                    disabled={
                      hostLocked ||
                      state === "Loading" ||
                      state === "Submitting" ||
                      (state === "Unknown" && unknownAction !== "Session") ||
                      (state !== "Unknown" && (!confirmed || !eligible))
                    }
                    onClick={() => void execute()}
                  >
                    {state === "Unknown" && unknownAction === "Session"
                      ? "Retry same session request"
                      : state === "Submitting"
                        ? "Submitting…"
                        : selected.currentDiningSessionReference
                          ? "Replace entry code"
                          : "Start dining session"}
                  </button>
                  {selected.currentDiningSessionReference ? (
                    <DiningHostTransferAction
                      key={selected.currentDiningSessionReference}
                      diningSessionReference={selected.currentDiningSessionReference}
                      csrf={csrf}
                      disabled={state !== "Idle"}
                      onLocked={setHostLocked}
                    />
                  ) : null}
                </section>
                {canOperateTables ? (
                  <section aria-label="Table availability action">
                    <p>Change availability using the current Store permission.</p>
                    {selected.operationalState === "Available" ? (
                      <>
                        <label className="dining-table-reason">
                          Block reason code
                          <input
                            value={blockReasonCode}
                            maxLength={64}
                            pattern="[A-Z][A-Z0-9_-]{0,63}"
                            autoComplete="off"
                            aria-describedby="dining-table-reason-help"
                            disabled={locked}
                            onChange={(event) => setBlockReasonCode(event.target.value)}
                          />
                          <small id="dining-table-reason-help">
                            Required; use uppercase letters, numbers, underscores or hyphens.
                          </small>
                        </label>
                        <button
                          disabled={
                            hostLocked ||
                            state === "Loading" ||
                            state === "Submitting" ||
                            (state === "Unknown" && unknownAction !== "Availability") ||
                            (state !== "Unknown" &&
                              !/^[A-Z][A-Z0-9_-]{0,63}$/.test(blockReasonCode))
                          }
                          onClick={() => void executeAvailability("SetBlock")}
                        >
                          {state === "Unknown" && unknownAction === "Availability"
                            ? "Retry same availability request"
                            : state === "Submitting"
                              ? "Updating availability…"
                              : "Mark table unavailable"}
                        </button>
                      </>
                    ) : (
                      <button
                        disabled={
                          hostLocked ||
                          state === "Loading" ||
                          state === "Submitting" ||
                          (state === "Unknown" && unknownAction !== "Availability")
                        }
                        onClick={() => void executeAvailability("ClearBlock")}
                      >
                        {state === "Unknown" && unknownAction === "Availability"
                          ? "Retry same availability request"
                          : state === "Submitting"
                            ? "Updating availability…"
                            : "Mark table available"}
                      </button>
                    )}
                  </section>
                ) : null}
                {code ? (
                  <div className="dining-entry-code">
                    <p>
                      Entry code: <strong>{code}</strong>
                    </p>
                    <button onClick={() => setCode(null)}>Hide entry code</button>
                  </div>
                ) : null}
              </>
            ) : (
              <p>Select a table to review its current state and available session action.</p>
            )}
          </aside>
        </div>
        <p role="status">{state === "Loading" ? "Loading tables…" : message}</p>
      </div>
    </AppFrame>
  );
}
