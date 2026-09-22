import { DiningHostTransferAction } from "./DiningHostTransferAction.js";
import { useEffect, useRef, useState } from "react";
import { AppFrame } from "@bop-rms/ui";
import {
  createDiningSessionClient,
  DiningSessionClientError,
  type StaffDiningTable,
} from "./dining-session-client.js";
import { serviceOperationReference } from "./service-control-client.js";
type Operation = ReturnType<ReturnType<typeof createDiningSessionClient>["prepareStart"]>;
export function DiningSessionWorkspace({
  csrf,
  storeLabel,
}: {
  readonly csrf: string;
  readonly storeLabel: string;
}) {
  const [tables, setTables] = useState<StaffDiningTable[]>([]),
    [next, setNext] = useState<string | null>(null),
    [selected, setSelected] = useState<StaffDiningTable | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [code, setCode] = useState<string | null>(null),
    [message, setMessage] = useState(""),
    [state, setState] = useState<"Idle" | "Loading" | "Submitting" | "Unknown">("Idle");
  const pending = useRef<AbortController | null>(null),
    operation = useRef<Operation | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const [hostLocked, setHostLocked] = useState(false);
  const locked = state !== "Idle" || hostLocked;
  const load = async (more = false) => {
    if (pending.current || state === "Unknown" || hostLocked) return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Loading");
    setCode(null);
    setSelected(null);
    setConfirmed(false);
    setMessage("");
    operation.current = null;
    try {
      const result = await createDiningSessionClient().tables(
        csrf,
        more ? next : null,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setTables((prior) => (more ? [...prior, ...result.items] : result.items));
        setNext(result.next);
        if (result.items.length === 0 && !more)
          setMessage("No tables are available in this Store.");
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(
          error instanceof DiningSessionClientError && error.code === "Denied"
            ? "Your current permissions do not allow table operations."
            : "Tables unavailable. Check your connection and refresh.",
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setState("Idle");
      }
    }
  };
  const execute = async () => {
    if (
      hostLocked ||
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
        setSelected({ ...selected, currentDiningSessionReference: result.diningSessionReference });
        setTables((rows) =>
          rows.map((t) =>
            t.tableReference === selected.tableReference
              ? { ...t, currentDiningSessionReference: result.diningSessionReference }
              : t,
          ),
        );
        setCode(result.joinCredential);
        setConfirmed(false);
        operation.current = null;
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
  const eligible = selected?.lifecycle === "Published" && selected.operationalState === "Available";
  return (
    <AppFrame title="Dining Floor Board" description={storeLabel}>
      <section aria-label="Staff dining sessions">
        <h2>Tables and dining sessions</h2>
        <p>
          Select a table to start a session or replace its entry code. Order, payment and
          reservation summaries are not available in this view.
        </p>
        <button disabled={locked} onClick={() => void load()}>
          Refresh tables
        </button>
        {next ? (
          <button disabled={locked} onClick={() => void load(true)}>
            Load more tables
          </button>
        ) : null}
        <ul>
          {tables.map((table) => (
            <li key={table.tableReference}>
              <strong>{table.stableLabel}</strong> · {table.areaCode} · Seats {table.capacity} ·{" "}
              {table.currentDiningSessionReference ? "Session linked" : "No linked session"} ·{" "}
              {table.operationalState}
              <button
                disabled={
                  locked ||
                  table.lifecycle !== "Published" ||
                  table.operationalState !== "Available"
                }
                onClick={() => {
                  setSelected(table);
                  setConfirmed(false);
                  setCode(null);
                  setMessage("");
                  operation.current = null;
                }}
              >
                Select {table.stableLabel}
              </button>
            </li>
          ))}
        </ul>
        {selected ? (
          <section aria-label="Selected table">
            <h3>Table {selected.stableLabel}</h3>
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
                (state !== "Unknown" && (!confirmed || !eligible))
              }
              onClick={() => void execute()}
            >
              {state === "Unknown"
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
        ) : null}
        {code ? (
          <div>
            <p>
              Entry code: <strong>{code}</strong>
            </p>
            <button onClick={() => setCode(null)}>Hide entry code</button>
          </div>
        ) : null}
        <p role="status">{state === "Loading" ? "Loading tables…" : message}</p>
      </section>
    </AppFrame>
  );
}
