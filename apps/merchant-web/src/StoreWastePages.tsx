import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./RoleAdministrationPages.js";
import {
  StoreWastePageError,
  centsText,
  parseStoreWasteView,
  unavailableStoreWasteClient,
  wasteQuantityAllowed,
  type StoreWasteClient,
  type StoreWasteErrorCode,
  type StoreWasteView,
  type WasteRecordView,
} from "./store-waste-pages.js";

/** WP-2423 / DEC-INV-WASTE: record waste as it happens; managers review high-value records. */
const copy: Record<StoreWasteErrorCode | "Loading", string> = {
  Loading: "Loading waste…",
  PermissionDenied: "You do not have permission for this waste action.",
  NotFound: "This waste record does not exist for the selected Store.",
  Conflict: "This was already recorded. Refresh and check before trying again.",
  NotEnoughStock:
    "The highlighted line asks for more than the available stock there (stock reserved for orders cannot be wasted).",
  AlreadyReviewed: "This record has already been reviewed.",
  NotIndependent: "The person who recorded the waste cannot review it.",
  LineInvalid:
    "The highlighted line is not valid: check item, location, lot, quantity precision and reason (a note is needed for Other).",
  Invalid: "The waste record is not valid.",
  Offline: "Offline. Nothing was confirmed; retry sends the same request again.",
  Unavailable: "Waste is unavailable.",
};
const reasonText = (code: string) =>
  code.charAt(0) + code.slice(1).toLowerCase().replaceAll("_", " ");
type State =
  | { readonly kind: "Loading" | StoreWasteErrorCode }
  | { readonly kind: "Found"; readonly view: StoreWasteView };
function useWaste(
  client: StoreWasteClient,
  screenId: StoreWasteView["screenId"],
  wasteReference: string | null,
  needsReviewOnly: boolean,
) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load({ wasteReference, needsReviewOnly })
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseStoreWasteView(value, screenId) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof StoreWastePageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, screenId, wasteReference, needsReviewOnly, generation]);
  return { state, reload };
}
function Failure({ code }: { code: StoreWasteErrorCode | "Loading" }) {
  return (
    <StatePanel heading="Waste" tone={code === "Loading" ? "neutral" : "error"} status>
      <p>{copy[code]}</p>
    </StatePanel>
  );
}
const statusOf = (record: WasteRecordView) =>
  record.review
    ? record.review.decision === "Voided"
      ? "Voided"
      : "Reviewed"
    : record.needsReview
      ? "Needs review"
      : "Recorded";

export function StoreWasteListPage({
  client = unavailableStoreWasteClient,
}: {
  readonly client?: StoreWasteClient;
}) {
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const { state } = useWaste(client, "INV-WASTE-LIST", null, needsReviewOnly);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view = state.view;
  const itemName = (reference: string) =>
    view.items.find((item) => item.itemReference === reference)?.name ?? "Item";
  return (
    <AppFrame title="Waste" description="INV-WASTE-RECORD">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-WASTE-RECORD</p>
          <h2>Waste</h2>
          <p>
            Record waste when it happens; it leaves stock at once. Records worth CAD{" "}
            {centsText(view.reviewThresholdMinor)} or more, or without a known cost, are reviewed by
            a manager. Source as of {view.sourceAsOf}
          </p>
        </div>
        {view.permissions.mayRecord ? (
          <Link to="/operations/inventory/waste/new">Record waste</Link>
        ) : null}
      </header>
      {view.permissions.mayRead || view.permissions.mayReview ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={needsReviewOnly}
              onChange={(event) => setNeedsReviewOnly(event.currentTarget.checked)}
            />{" "}
            Only records waiting for review
          </label>
          {view.records.length === 0 ? (
            <StatePanel heading="No waste records" status>
              <p>Nothing to show.</p>
            </StatePanel>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Recorded</th>
                  <th>By</th>
                  <th>What</th>
                  <th>Value (CAD)</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {view.records.map((record) => (
                  <tr key={record.wasteReference}>
                    <td>
                      <Link to={`/operations/inventory/waste/${record.wasteReference}`}>
                        {record.recordedAt}
                      </Link>
                    </td>
                    <td>
                      {view.people[record.recordedBy] ?? "Staff " + record.recordedBy.slice(-4)}
                    </td>
                    <td>
                      {record.lines
                        .map(
                          (line) =>
                            `${itemName(line.itemReference)} ${line.quantity} ${line.unitCode}`,
                        )
                        .join(", ")}
                    </td>
                    <td>
                      {centsText(record.valueMinor)}
                      {record.costUnknown ? " (cost unknown)" : ""}
                    </td>
                    <td>{statusOf(record)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <p>Use “Record waste” to log what was thrown away.</p>
      )}
    </AppFrame>
  );
}

interface EditableLine {
  readonly lineReference: string;
  itemReference: string;
  locationReference: string;
  lotReference: string;
  quantity: string;
  reasonCode: string;
  note: string;
}
export function StoreWasteFormPage({
  client = unavailableStoreWasteClient,
}: {
  readonly client?: StoreWasteClient;
}) {
  const { state } = useWaste(client, "INV-WASTE-LIST", null, false);
  const navigate = useNavigate();
  const [lines, setLines] = useState<EditableLine[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<{ code: StoreWasteErrorCode; line: string | null } | null>(null),
    [wasteReference] = useState(newOperationReference),
    [operationReference] = useState(newOperationReference);
  const view = state.kind === "Found" ? state.view : null;
  const items = useMemo(
    () => new Map((view?.items ?? []).map((item) => [item.itemReference, item])),
    [view],
  );
  const stockItems = useMemo(
    () =>
      view
        ? view.items.filter((item) =>
            view.stock.some((row) => row.itemReference === item.itemReference),
          )
        : [],
    [view],
  );
  const blank = useCallback((): EditableLine => {
    const first = view?.stock[0];
    return {
      lineReference: newOperationReference(),
      itemReference: first?.itemReference ?? "",
      locationReference: first?.locationReference ?? "",
      lotReference: first?.lotReference ?? "",
      quantity: "",
      reasonCode: "",
      note: "",
    };
  }, [view]);
  useEffect(() => {
    if (view && lines.length === 0 && view.stock.length > 0) setLines([blank()]);
  }, [view, lines.length, blank]);
  if (state.kind !== "Found" || !view)
    return <Failure code={state.kind === "Found" ? "Unavailable" : state.kind} />;
  if (!view.permissions.mayRecord) return <Failure code="PermissionDenied" />;
  const update = (index: number, patch: Partial<EditableLine>) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  const rowsFor = (line: EditableLine) =>
    view.stock.filter((row) => row.itemReference === line.itemReference);
  const placeName = (reference: string) =>
    view.locations.find((item) => item.locationReference === reference)?.name ?? "Location";
  const submit = async () => {
    if (!client.command) return;
    for (const line of lines) {
      const row = view.stock.find(
        (candidate) =>
          candidate.itemReference === line.itemReference &&
          candidate.locationReference === line.locationReference &&
          (candidate.lotReference ?? "") === line.lotReference,
      );
      const item = items.get(line.itemReference);
      if (
        !row ||
        !item ||
        !line.reasonCode ||
        !wasteQuantityAllowed(line.quantity, item.ledgerPrecision, row.available) ||
        (line.reasonCode === "OTHER" && line.note.trim() === "")
      ) {
        setError({ code: row ? "LineInvalid" : "NotEnoughStock", line: line.lineReference });
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      await client.command({
        action: "Record",
        operationReference,
        wasteReference,
        lines: lines.map((line) => ({
          lineReference: line.lineReference,
          itemReference: line.itemReference,
          locationReference: line.locationReference,
          lotReference: line.lotReference === "" ? null : line.lotReference,
          quantity: line.quantity.trim(),
          reasonCode: line.reasonCode,
          note: line.note.trim() === "" ? null : line.note.trim(),
        })),
      });
      navigate(`/operations/inventory/waste/${wasteReference}`);
    } catch (failure) {
      setError(
        failure instanceof StoreWastePageError
          ? { code: failure.code, line: failure.lineReference }
          : { code: "Unavailable", line: null },
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <AppFrame title="Record waste" description="INV-WASTE-WIZARD">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-WASTE-WIZARD</p>
          <h2>Record waste</h2>
          <p>What was thrown away, where, and why. It leaves stock as soon as you record it.</p>
        </div>
        <Link to="/operations/inventory/waste">Waste records</Link>
      </header>
      {view.stock.length === 0 ? <p>No stock is available to waste in this Store.</p> : null}
      <form
        className="detail-section"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {lines.map((line, index) => {
          const rows = rowsFor(line);
          const places = [...new Set(rows.map((row) => row.locationReference))];
          const lots = rows.filter((row) => row.locationReference === line.locationReference);
          const selected = lots.find((row) => (row.lotReference ?? "") === line.lotReference);
          const item = items.get(line.itemReference);
          const flagged = error?.line === line.lineReference;
          return (
            <fieldset
              key={line.lineReference}
              aria-invalid={flagged}
              style={flagged ? { outline: "2px solid #b42318" } : undefined}
            >
              <legend>Line {index + 1}</legend>
              <label>
                Item
                <select
                  value={line.itemReference}
                  onChange={(event) => {
                    const itemReference = event.currentTarget.value;
                    const first = view.stock.find((row) => row.itemReference === itemReference);
                    update(index, {
                      itemReference,
                      locationReference: first?.locationReference ?? "",
                      lotReference: first?.lotReference ?? "",
                    });
                  }}
                >
                  {stockItems.map((option) => (
                    <option key={option.itemReference} value={option.itemReference}>
                      {option.name} ({option.unitCode})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Where
                <select
                  value={line.locationReference}
                  onChange={(event) => {
                    const locationReference = event.currentTarget.value;
                    const first = rows.find((row) => row.locationReference === locationReference);
                    update(index, { locationReference, lotReference: first?.lotReference ?? "" });
                  }}
                >
                  {places.map((place) => (
                    <option key={place} value={place}>
                      {placeName(place)}
                    </option>
                  ))}
                </select>
              </label>
              {lots.some((row) => row.lotReference !== null) ? (
                <label>
                  Lot
                  <select
                    value={line.lotReference}
                    onChange={(event) => update(index, { lotReference: event.currentTarget.value })}
                  >
                    {lots.map((row) => (
                      <option key={row.lotReference ?? "none"} value={row.lotReference ?? ""}>
                        {row.lotCode}
                        {row.expiryDate ? ` (exp. ${row.expiryDate})` : ""} · {row.available}{" "}
                        available
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                Quantity ({item?.unitCode}){selected ? ` — ${selected.available} available` : ""}
                <input
                  required
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) => update(index, { quantity: event.currentTarget.value })}
                />
              </label>
              <label>
                Reason
                <select
                  required
                  value={line.reasonCode}
                  onChange={(event) => update(index, { reasonCode: event.currentTarget.value })}
                >
                  <option value="">Choose a reason</option>
                  {view.reasons.map((reason) => (
                    <option key={reason} value={reason}>
                      {reasonText(reason)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Note{line.reasonCode === "OTHER" ? "" : " (optional)"}
                <input
                  maxLength={200}
                  value={line.note}
                  onChange={(event) => update(index, { note: event.currentTarget.value })}
                />
              </label>
              {lines.length > 1 ? (
                <button
                  type="button"
                  onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                >
                  Remove line
                </button>
              ) : null}
            </fieldset>
          );
        })}
        <button
          type="button"
          disabled={busy || view.stock.length === 0}
          onClick={() => setLines((current) => [...current, blank()])}
        >
          Add line
        </button>{" "}
        <button disabled={busy || lines.length === 0}>Record waste</button>
        {error ? (
          <StatePanel heading="Not recorded" tone="error" status>
            <p>{copy[error.code]}</p>
          </StatePanel>
        ) : null}
      </form>
    </AppFrame>
  );
}

export function StoreWasteDetailPage({
  client = unavailableStoreWasteClient,
}: {
  readonly client?: StoreWasteClient;
}) {
  const params = useParams();
  const { state, reload } = useWaste(client, "INV-WASTE-DETAIL", params.id ?? null, false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<StoreWasteErrorCode | null>(null),
    [voidReason, setVoidReason] = useState("");
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view = state.view;
  const record = view.records[0] as WasteRecordView;
  const itemName = (reference: string) =>
    view.items.find((item) => item.itemReference === reference)?.name ?? "Item";
  const placeName = (reference: string) =>
    view.locations.find((item) => item.locationReference === reference)?.name ?? "Location";
  const person = (reference: string) => view.people[reference] ?? "Staff " + reference.slice(-4);
  const review = async (decision: "Accepted" | "Voided", reasonCode: string) => {
    if (!client.command) return;
    setBusy(true);
    setError(null);
    try {
      await client.command({
        action: "Review",
        operationReference: newOperationReference(),
        wasteReference: record.wasteReference,
        decision,
        reasonCode,
      });
      reload();
    } catch (failure) {
      setError(failure instanceof StoreWastePageError ? failure.code : "Unavailable");
    } finally {
      setBusy(false);
    }
  };
  const mayReview =
    view.permissions.mayReview && record.review === null && record.recordedBy !== view.viewer;
  return (
    <AppFrame title="Waste record" description="INV-WASTE-DETAIL">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-WASTE-DETAIL · {statusOf(record)}</p>
          <h2>Waste recorded {record.recordedAt}</h2>
          <p>
            By {person(record.recordedBy)} · value CAD {centsText(record.valueMinor)}
            {record.costUnknown ? " (some costs unknown)" : ""}
            {record.review
              ? ` · ${record.review.decision === "Voided" ? "voided" : "reviewed"} by ${person(record.review.reviewedBy)} (${reasonText(record.review.reasonCode)})`
              : ""}
          </p>
        </div>
        <Link to="/operations/inventory/waste">Waste records</Link>
      </header>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Where</th>
            <th>Quantity</th>
            <th>Reason</th>
            <th>Value (CAD)</th>
          </tr>
        </thead>
        <tbody>
          {record.lines.map((line) => (
            <tr key={line.lineReference}>
              <td>{itemName(line.itemReference)}</td>
              <td>{placeName(line.locationReference)}</td>
              <td>
                {line.quantity} {line.unitCode}
              </td>
              <td>
                {reasonText(line.reasonCode)}
                {line.note ? ` — ${line.note}` : ""}
              </td>
              <td>{line.unitCostMinor === null ? "unknown" : centsText(line.valueMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {mayReview ? (
        <StatePanel heading="Review">
          <p>
            Accept the record, or void it if the waste did not happen (the quantity returns to
            stock).
          </p>
          <button disabled={busy} onClick={() => void review("Accepted", "REVIEWED_OK")}>
            Accept
          </button>{" "}
          <label>
            Void reason
            <select
              value={voidReason}
              onChange={(event) => setVoidReason(event.currentTarget.value)}
            >
              <option value="">Choose a reason</option>
              {view.voidReasons.map((reason) => (
                <option key={reason} value={reason}>
                  {reasonText(reason)}
                </option>
              ))}
            </select>
          </label>{" "}
          <button disabled={busy || !voidReason} onClick={() => void review("Voided", voidReason)}>
            Void record
          </button>
        </StatePanel>
      ) : null}
      {record.review === null && record.recordedBy === view.viewer && record.needsReview ? (
        <p>Waiting for another manager to review.</p>
      ) : null}
      {error ? (
        <StatePanel heading="Not recorded" tone="error" status>
          <p>{copy[error]}</p>
        </StatePanel>
      ) : null}
    </AppFrame>
  );
}
