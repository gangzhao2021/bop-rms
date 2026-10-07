import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./RoleAdministrationPages.js";
import {
  OpeningCountPageError,
  centsToDollars,
  dollarsToCents,
  parseOpeningCountPageView,
  unavailableOpeningCountClient,
  type OpeningCountClient,
  type OpeningCountErrorCode,
  type OpeningCountPageView,
  type OpeningLine,
} from "./opening-count-pages.js";

const copy: Record<OpeningCountErrorCode | "Loading", string> = {
  Loading: "Loading the opening count…",
  PermissionDenied: "You do not have permission for this step of the opening count.",
  NotFound: "This opening count does not exist for the selected Store.",
  Conflict: "The count changed since you opened it. Refresh and try again.",
  AlreadyPosted:
    "The Store's opening stock has already been posted. Later stock arrives through receipts and counts.",
  StockExists:
    "Stock has already been recorded for the highlighted line, so it cannot receive an opening balance.",
  LineInvalid:
    "The highlighted line is not valid: check the item, location, quantity precision, lot and expiry.",
  Invalid: "The count is not valid. A count needs at least one line before it is submitted.",
  Offline: "Offline. The change was not confirmed; retry sends the same request again.",
  Unavailable: "The opening count is unavailable.",
};
type State =
  | { readonly kind: "Loading" | OpeningCountErrorCode }
  | { readonly kind: "Found"; readonly view: OpeningCountPageView };
interface EditableLine {
  readonly lineReference: string;
  itemReference: string;
  locationReference: string;
  lotCode: string;
  expiryDate: string;
  quantity: string;
  unitCost: string;
}
const editable = (line: OpeningLine): EditableLine => ({
  lineReference: line.lineReference,
  itemReference: line.itemReference,
  locationReference: line.locationReference,
  lotCode: line.lotCode ?? "",
  expiryDate: line.expiryDate ?? "",
  quantity: line.quantity,
  unitCost: centsToDollars(line.unitCostMinor),
});

function useCount(client: OpeningCountClient, countReference: string | null) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load(countReference)
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseOpeningCountPageView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof OpeningCountPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, countReference, generation]);
  return { state, reload };
}

function Editor({
  view,
  selected,
  client,
  reload,
}: {
  view: OpeningCountPageView;
  selected: NonNullable<OpeningCountPageView["selected"]>;
  client: OpeningCountClient;
  reload: () => void;
}) {
  const draft = selected.lifecycle === "Draft" && view.permissions.mayCount;
  const [lines, setLines] = useState<EditableLine[]>(() => selected.lines.map(editable));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<{ code: OpeningCountErrorCode; line: string | null } | null>(null),
    [confirmPost, setConfirmPost] = useState(false);
  const items = useMemo(
    () => new Map(view.items.map((item) => [item.itemReference, item])),
    [view.items],
  );
  const locations = useMemo(
    () => new Map(view.locations.map((location) => [location.locationReference, location])),
    [view.locations],
  );
  const send = async (
    action: "SaveLines" | "Submit" | "Reopen" | "Cancel" | "Post",
    expectedVersion: number,
    payload: readonly OpeningLine[] | null = null,
  ) => {
    if (!client.command) return false;
    setBusy(true);
    setError(null);
    try {
      await client.command({
        action,
        operationReference: newOperationReference(),
        countReference: selected.countReference,
        expectedVersion,
        lines: payload,
      });
      return true;
    } catch (failure) {
      setError(
        failure instanceof OpeningCountPageError
          ? { code: failure.code, line: failure.lineReference }
          : { code: "Unavailable", line: null },
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const toPayload = (): OpeningLine[] | null => {
    const payload: OpeningLine[] = [];
    for (const line of lines) {
      const cost = line.unitCost.trim() === "" ? null : dollarsToCents(line.unitCost);
      if (cost === null && line.unitCost.trim() !== "") {
        setError({ code: "LineInvalid", line: line.lineReference });
        return null;
      }
      payload.push({
        lineReference: line.lineReference,
        itemReference: line.itemReference,
        locationReference: line.locationReference,
        lotCode: line.lotCode.trim() === "" ? null : line.lotCode.trim(),
        expiryDate: line.expiryDate === "" ? null : line.expiryDate,
        quantity: line.quantity.trim(),
        unitCostMinor: cost,
      });
    }
    return payload;
  };
  const save = async () => {
    const payload = toPayload();
    if (payload === null) return false;
    return send("SaveLines", selected.version, payload);
  };
  const update = (index: number, patch: Partial<EditableLine>) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  return (
    <section className="detail-section">
      <h3>
        Opening count · {selected.lifecycle} · version {selected.version}
      </h3>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Location</th>
            <th>Lot code</th>
            <th>Expiry</th>
            <th>Quantity</th>
            <th>Unit cost (CAD)</th>
            {draft ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const item = items.get(line.itemReference);
            const mode = item?.lotTracking ?? "NoLot";
            const flagged = error?.line === line.lineReference;
            return (
              <tr
                key={line.lineReference}
                aria-invalid={flagged}
                style={flagged ? { outline: "2px solid #b42318" } : undefined}
              >
                <td>
                  {draft ? (
                    <select
                      aria-label="Item"
                      value={line.itemReference}
                      onChange={(e) => update(index, { itemReference: e.currentTarget.value })}
                    >
                      {view.items.map((option) => (
                        <option key={option.itemReference} value={option.itemReference}>
                          {option.name} ({option.unitCode})
                        </option>
                      ))}
                    </select>
                  ) : (
                    `${item?.name ?? line.itemReference} (${item?.unitCode ?? ""})`
                  )}
                </td>
                <td>
                  {draft ? (
                    <select
                      aria-label="Location"
                      value={line.locationReference}
                      onChange={(e) => update(index, { locationReference: e.currentTarget.value })}
                    >
                      {view.locations.map((option) => (
                        <option key={option.locationReference} value={option.locationReference}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    (locations.get(line.locationReference)?.name ?? line.locationReference)
                  )}
                </td>
                <td>
                  {draft && mode !== "NoLot" ? (
                    <input
                      aria-label="Lot code"
                      required={mode !== "LotOptional"}
                      maxLength={64}
                      value={line.lotCode}
                      onChange={(e) => update(index, { lotCode: e.currentTarget.value })}
                    />
                  ) : (
                    line.lotCode || (mode === "NoLot" ? "Not tracked" : "")
                  )}
                </td>
                <td>
                  {draft && mode !== "NoLot" ? (
                    <input
                      aria-label="Expiry date"
                      type="date"
                      required={mode === "LotExpiryRequired"}
                      value={line.expiryDate}
                      onChange={(e) => update(index, { expiryDate: e.currentTarget.value })}
                    />
                  ) : (
                    line.expiryDate
                  )}
                </td>
                <td>
                  {draft ? (
                    <input
                      aria-label="Quantity"
                      inputMode="decimal"
                      required
                      value={line.quantity}
                      onChange={(e) => update(index, { quantity: e.currentTarget.value })}
                    />
                  ) : (
                    line.quantity
                  )}{" "}
                  {item?.unitCode}
                </td>
                <td>
                  {draft ? (
                    <input
                      aria-label="Unit cost"
                      inputMode="decimal"
                      value={line.unitCost}
                      onChange={(e) => update(index, { unitCost: e.currentTarget.value })}
                    />
                  ) : (
                    line.unitCost
                  )}
                </td>
                {draft ? (
                  <td>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                    >
                      Remove
                    </button>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {draft ? (
        <div className="card-actions">
          <button
            type="button"
            disabled={busy || view.items.length === 0 || view.locations.length === 0}
            onClick={() =>
              setLines((current) => [
                ...current,
                {
                  lineReference: newOperationReference(),
                  itemReference: view.items[0]?.itemReference ?? "",
                  locationReference: view.locations[0]?.locationReference ?? "",
                  lotCode: "",
                  expiryDate: "",
                  quantity: "",
                  unitCost: "",
                },
              ])
            }
          >
            Add line
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save().then((ok) => ok && reload())}
          >
            Save count
          </button>
          <button
            type="button"
            disabled={busy || lines.length === 0}
            onClick={() =>
              void save().then(async (ok) => {
                if (ok && (await send("Submit", selected.version + 1))) reload();
                else if (ok) reload();
              })
            }
          >
            Save and submit for posting
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void send("Cancel", selected.version).then((ok) => ok && reload())}
          >
            Cancel count
          </button>
          {view.items.length === 0 ? (
            <p>Create and activate stock-tracked inventory items first.</p>
          ) : null}
          {view.locations.length === 0 ? <p>Set up the Store's stock locations first.</p> : null}
        </div>
      ) : null}
      {selected.lifecycle === "Submitted" ? (
        <div className="card-actions">
          {view.permissions.mayCount ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void send("Reopen", selected.version).then((ok) => ok && reload())}
            >
              Reopen for changes
            </button>
          ) : null}
          {view.permissions.mayPost ? (
            confirmPost ? (
              <>
                <p>
                  Posting sets the Store's opening stock from these {selected.lines.length} lines.
                  It happens once per Store and cannot be edited afterwards; later changes go
                  through receipts, counts and waste.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void send("Post", selected.version).then((ok) => ok && reload())}
                >
                  Post opening stock
                </button>{" "}
                <button type="button" disabled={busy} onClick={() => setConfirmPost(false)}>
                  Back
                </button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={() => setConfirmPost(true)}>
                Review and post
              </button>
            )
          ) : (
            <p>Waiting for an Owner to post the opening stock.</p>
          )}
        </div>
      ) : null}
      {selected.lifecycle === "Posted" ? (
        <p>Posted. These quantities are the Store's opening stock.</p>
      ) : null}
      {error ? (
        <StatePanel heading="Change not applied" tone="error" status>
          <p>{copy[error.code]}</p>
          <button type="button" onClick={reload}>
            Refresh
          </button>
        </StatePanel>
      ) : null}
    </section>
  );
}

export function OpeningCountPage({
  client = unavailableOpeningCountClient,
}: {
  readonly client?: OpeningCountClient;
}) {
  const { id } = useParams();
  const navigate = useNavigate();
  const reference =
    id && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)
      ? id
      : null;
  const { state, reload } = useCount(client, reference);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<OpeningCountErrorCode | null>(null);
  if (state.kind !== "Found")
    return (
      <StatePanel
        heading="Opening count"
        tone={state.kind === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{copy[state.kind]}</p>
      </StatePanel>
    );
  const view = state.view;
  const open = view.counts.find(
    (count) => count.lifecycle === "Draft" || count.lifecycle === "Submitted",
  );
  const start = async () => {
    if (!client.command) return;
    setBusy(true);
    setError(null);
    const countReference = newOperationReference();
    try {
      await client.command({
        action: "Create",
        operationReference: newOperationReference(),
        countReference,
        expectedVersion: null,
        lines: null,
      });
      navigate(`/app/supply/opening-count/${countReference}`);
    } catch (failure) {
      setError(failure instanceof OpeningCountPageError ? failure.code : "Unavailable");
    } finally {
      setBusy(false);
    }
  };
  return (
    <AppFrame title="Opening count" description="INV-OPENING-COUNT">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-OPENING-COUNT</p>
          <h2>Opening stock count</h2>
          <p>
            Count what the Store holds before it opens. Posting turns the count into the Store's
            opening stock, once. Source as of {view.sourceAsOf}
          </p>
        </div>
      </header>
      {view.postedCountReference ? (
        <StatePanel heading="Opening stock posted" status>
          <p>The Store's opening stock is set. New stock arrives through receipts and counts.</p>
          {reference !== view.postedCountReference ? (
            <Link to={`/app/supply/opening-count/${view.postedCountReference}`}>
              View the posted count
            </Link>
          ) : null}
        </StatePanel>
      ) : null}
      {!view.postedCountReference && !open && view.permissions.mayCount ? (
        <button disabled={busy} onClick={() => void start()}>
          Start opening count
        </button>
      ) : null}
      {open && reference !== open.countReference ? (
        <p>
          <Link to={`/app/supply/opening-count/${open.countReference}`}>
            Continue the {open.lifecycle.toLowerCase()} count ({open.lineCount} lines)
          </Link>
        </p>
      ) : null}
      {view.selected ? (
        <Editor
          key={`${view.selected.countReference}:${view.selected.version}`}
          view={view}
          selected={view.selected}
          client={client}
          reload={reload}
        />
      ) : null}
      {error ? (
        <StatePanel heading="Not started" tone="error" status>
          <p>{copy[error]}</p>
        </StatePanel>
      ) : null}
    </AppFrame>
  );
}
