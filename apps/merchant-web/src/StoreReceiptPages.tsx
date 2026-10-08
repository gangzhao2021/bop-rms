import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./RoleAdministrationPages.js";
import { centsToDollars, dollarsToCents } from "./opening-count-pages.js";
import {
  StoreReceiptPageError,
  lineCostCents,
  parseStoreReceiptPageView,
  unavailableStoreReceiptClient,
  type ReceiptLine,
  type StoreReceiptClient,
  type StoreReceiptErrorCode,
  type StoreReceiptPageView,
} from "./store-receipt-pages.js";

const copy: Record<StoreReceiptErrorCode | "Loading", string> = {
  Loading: "Loading receiving…",
  PermissionDenied: "You do not have permission for this receiving action.",
  NotFound: "This receipt does not exist for the selected Store.",
  Conflict: "The receipt changed or was already recorded. Refresh and check before trying again.",
  AlreadyVoided: "This receipt has already been voided.",
  StockUsed:
    "Stock from the highlighted line has already been used or reserved; void is not possible. Record an adjustment or waste instead.",
  LineInvalid:
    "The highlighted line is not valid: check item, location, quantities, lot/expiry, reason and cost.",
  Invalid: "The receipt is not valid. A supplier name and at least one line are required.",
  Offline: "Offline. The receipt was not confirmed; retry sends the same request again.",
  Unavailable: "Receiving is unavailable.",
};
const reasonLabel = (reason: string) =>
  reason.charAt(0) + reason.slice(1).toLowerCase().replaceAll("_", " ");
type State =
  | { readonly kind: "Loading" | StoreReceiptErrorCode }
  | { readonly kind: "Found"; readonly view: StoreReceiptPageView };
function useReceipts(
  client: StoreReceiptClient,
  screenId: StoreReceiptPageView["screenId"],
  receiptReference: string | null,
) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load({ receiptReference, before: null })
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseStoreReceiptPageView(value, screenId) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof StoreReceiptPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, screenId, receiptReference, generation]);
  return { state, reload };
}
function Failure({ code }: { code: StoreReceiptErrorCode | "Loading" }) {
  return (
    <StatePanel heading="Receiving" tone={code === "Loading" ? "neutral" : "error"} status>
      <p>{copy[code]}</p>
    </StatePanel>
  );
}
const totalCents = (lines: readonly ReceiptLine[]) =>
  lines.reduce((sum, line) => sum + lineCostCents(line.acceptedQuantity, line.unitCostMinor), 0);

export function StoreReceiptListPage({
  client = unavailableStoreReceiptClient,
}: {
  readonly client?: StoreReceiptClient;
}) {
  const { state } = useReceipts(client, "INV-RECEIPT-LIST", null);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view = state.view;
  return (
    <AppFrame title="Receiving" description="INV-RECEIPT-LIST">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-RECEIPT-LIST</p>
          <h2>Receiving</h2>
          <p>
            Goods received at this Store. Source as of <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
        {view.permissions.mayReceive ? (
          <Link to="/operations/receiving/new">Receive goods</Link>
        ) : null}
      </header>
      {view.receipts.length === 0 ? (
        <StatePanel heading="No receipts yet" status>
          <p>Record deliveries and store purchases here as they arrive.</p>
        </StatePanel>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Received</th>
              <th>Supplier</th>
              <th>Document</th>
              <th>Lines</th>
              <th>Accepted value (CAD)</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {view.receipts.map((receipt) => (
              <tr key={receipt.receiptReference}>
                <td>
                  <Link to={`/operations/receiving/${receipt.receiptReference}`}>
                    {receipt.receivedAt}
                  </Link>
                </td>
                <td>{receipt.supplierName}</td>
                <td>{receipt.supplierDocument ?? ""}</td>
                <td>{receipt.lines.length}</td>
                <td>{centsToDollars(totalCents(receipt.lines))}</td>
                <td>{receipt.voided ? "Voided" : "Posted"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AppFrame>
  );
}

interface EditableLine {
  readonly lineReference: string;
  itemReference: string;
  locationReference: string;
  lotCode: string;
  expiryDate: string;
  accepted: string;
  rejected: string;
  damaged: string;
  reason: string;
  unitCost: string;
  temperature: string;
}
const blank = (view: StoreReceiptPageView): EditableLine => ({
  lineReference: newOperationReference(),
  itemReference: view.items[0]?.itemReference ?? "",
  locationReference: view.locations[0]?.locationReference ?? "",
  lotCode: "",
  expiryDate: "",
  accepted: "",
  rejected: "0",
  damaged: "0",
  reason: "",
  unitCost: "",
  temperature: "",
});
const isZero = (value: string) => /^0*(?:\.0*)?$/u.test(value.trim()) || value.trim() === "";

export function StoreReceiptFormPage({
  client = unavailableStoreReceiptClient,
}: {
  readonly client?: StoreReceiptClient;
}) {
  const { state } = useReceipts(client, "INV-RECEIPT-LIST", null);
  const navigate = useNavigate();
  const [supplier, setSupplier] = useState(""),
    [document, setDocument] = useState(""),
    [lines, setLines] = useState<EditableLine[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<{ code: StoreReceiptErrorCode; line: string | null } | null>(null),
    [receiptReference] = useState(newOperationReference),
    [operationReference] = useState(newOperationReference);
  const view = state.kind === "Found" ? state.view : null;
  const items = useMemo(
    () => new Map((view?.items ?? []).map((item) => [item.itemReference, item])),
    [view],
  );
  useEffect(() => {
    if (view && lines.length === 0 && view.items.length > 0 && view.locations.length > 0)
      setLines([blank(view)]);
  }, [view, lines.length]);
  if (state.kind !== "Found" || !view)
    return <Failure code={state.kind === "Found" ? "Unavailable" : state.kind} />;
  if (!view.permissions.mayReceive) return <Failure code="PermissionDenied" />;
  const update = (index: number, patch: Partial<EditableLine>) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  const submit = async () => {
    if (!client.command) return;
    const payload: ReceiptLine[] = [];
    for (const line of lines) {
      const cost = dollarsToCents(line.unitCost);
      if (cost === null) {
        setError({ code: "LineInvalid", line: line.lineReference });
        return;
      }
      const discrepancy = !isZero(line.rejected) || !isZero(line.damaged);
      payload.push({
        lineReference: line.lineReference,
        itemReference: line.itemReference,
        locationReference: line.locationReference,
        lotCode: line.lotCode.trim() === "" ? null : line.lotCode.trim(),
        expiryDate: line.expiryDate === "" ? null : line.expiryDate,
        acceptedQuantity: line.accepted.trim() === "" ? "0" : line.accepted.trim(),
        rejectedQuantity: line.rejected.trim() === "" ? "0" : line.rejected.trim(),
        damagedQuantity: line.damaged.trim() === "" ? "0" : line.damaged.trim(),
        discrepancyReason: discrepancy ? line.reason || null : null,
        unitCostMinor: cost,
        temperatureCelsius: line.temperature.trim() === "" ? null : line.temperature.trim(),
      });
    }
    setBusy(true);
    setError(null);
    try {
      await client.command({
        action: "Post",
        operationReference,
        receiptReference,
        supplierName: supplier.trim(),
        supplierDocument: document.trim() === "" ? null : document.trim(),
        lines: payload,
      });
      navigate(`/operations/receiving/${receiptReference}`);
    } catch (failure) {
      setError(
        failure instanceof StoreReceiptPageError
          ? { code: failure.code, line: failure.lineReference }
          : { code: "Unavailable", line: null },
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <AppFrame title="Receive goods" description="INV-GOODS-RECEIPT">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-GOODS-RECEIPT · Store direct</p>
          <h2>Receive goods</h2>
          <p>
            Record what arrived. Only accepted quantities enter stock; rejected and damaged
            quantities are kept with a reason. A posted receipt cannot be edited, only voided.
          </p>
        </div>
      </header>
      <form
        className="detail-section"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          Supplier
          <input
            required
            maxLength={120}
            value={supplier}
            onChange={(e) => setSupplier(e.currentTarget.value)}
          />
        </label>
        <label>
          Invoice or delivery note number (optional)
          <input
            maxLength={64}
            value={document}
            onChange={(e) => setDocument(e.currentTarget.value)}
          />
        </label>
        {view.items.length === 0 || view.locations.length === 0 ? (
          <p>Activate stock-tracked inventory items and set up stock locations first.</p>
        ) : null}
        {lines.map((line, index) => {
          const item = items.get(line.itemReference);
          const mode = item?.lotTracking ?? "NoLot";
          const discrepancy = !isZero(line.rejected) || !isZero(line.damaged);
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
                  onChange={(e) => update(index, { itemReference: e.currentTarget.value })}
                >
                  {view.items.map((option) => (
                    <option key={option.itemReference} value={option.itemReference}>
                      {option.name} ({option.unitCode})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Put away at
                <select
                  value={line.locationReference}
                  onChange={(e) => update(index, { locationReference: e.currentTarget.value })}
                >
                  {view.locations.map((option) => (
                    <option key={option.locationReference} value={option.locationReference}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
              {mode !== "NoLot" ? (
                <>
                  <label>
                    Lot code{mode === "LotOptional" ? " (optional)" : ""}
                    <input
                      maxLength={64}
                      required={mode !== "LotOptional" && !isZero(line.accepted)}
                      value={line.lotCode}
                      onChange={(e) => update(index, { lotCode: e.currentTarget.value })}
                    />
                  </label>
                  <label>
                    Expiry date{mode === "LotExpiryRequired" ? "" : " (optional)"}
                    <input
                      type="date"
                      required={mode === "LotExpiryRequired" && !isZero(line.accepted)}
                      value={line.expiryDate}
                      onChange={(e) => update(index, { expiryDate: e.currentTarget.value })}
                    />
                  </label>
                </>
              ) : null}
              <label>
                Accepted ({item?.unitCode})
                <input
                  inputMode="decimal"
                  value={line.accepted}
                  onChange={(e) => update(index, { accepted: e.currentTarget.value })}
                />
              </label>
              <label>
                Rejected
                <input
                  inputMode="decimal"
                  value={line.rejected}
                  onChange={(e) => update(index, { rejected: e.currentTarget.value })}
                />
              </label>
              <label>
                Damaged
                <input
                  inputMode="decimal"
                  value={line.damaged}
                  onChange={(e) => update(index, { damaged: e.currentTarget.value })}
                />
              </label>
              {discrepancy ? (
                <label>
                  Reason
                  <select
                    required
                    value={line.reason}
                    onChange={(e) => update(index, { reason: e.currentTarget.value })}
                  >
                    <option value="">Choose a reason</option>
                    {view.discrepancyReasons.map((reason) => (
                      <option key={reason} value={reason}>
                        {reasonLabel(reason)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                Unit cost (CAD per {item?.unitCode})
                <input
                  required
                  inputMode="decimal"
                  value={line.unitCost}
                  onChange={(e) => update(index, { unitCost: e.currentTarget.value })}
                />
              </label>
              <label>
                Delivery temperature °C (optional)
                <input
                  inputMode="decimal"
                  value={line.temperature}
                  onChange={(e) => update(index, { temperature: e.currentTarget.value })}
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
          disabled={busy || view.items.length === 0}
          onClick={() => setLines((current) => [...current, blank(view)])}
        >
          Add line
        </button>{" "}
        <button disabled={busy || lines.length === 0}>Post receipt</button>{" "}
        <Link to="/operations/receiving">Cancel</Link>
        {error ? (
          <StatePanel heading="Not recorded" tone="error" status>
            <p>{copy[error.code]}</p>
            {error.code === "Offline" ? (
              <button type="button" disabled={busy} onClick={() => void submit()}>
                Retry
              </button>
            ) : null}
          </StatePanel>
        ) : null}
      </form>
    </AppFrame>
  );
}

export function StoreReceiptDetailPage({
  client = unavailableStoreReceiptClient,
}: {
  readonly client?: StoreReceiptClient;
}) {
  const { id } = useParams();
  const reference =
    id && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)
      ? id
      : null;
  const { state, reload } = useReceipts(client, "INV-RECEIPT-DETAIL", reference);
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<{ code: StoreReceiptErrorCode; line: string | null } | null>(null);
  if (reference === null) return <Failure code="NotFound" />;
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view = state.view;
  const receipt = view.receipts[0];
  if (!receipt) return <Failure code="NotFound" />;
  const items = new Map(view.items.map((item) => [item.itemReference, item]));
  const locations = new Map(
    view.locations.map((location) => [location.locationReference, location]),
  );
  const voidReceipt = async () => {
    if (!client.command) return;
    setBusy(true);
    setError(null);
    try {
      await client.command({
        action: "Void",
        operationReference: newOperationReference(),
        receiptReference: receipt.receiptReference,
        reasonCode: reason,
      });
      reload();
    } catch (failure) {
      setError(
        failure instanceof StoreReceiptPageError
          ? { code: failure.code, line: failure.lineReference }
          : { code: "Unavailable", line: null },
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <AppFrame title="Receipt" description="INV-RECEIPT-DETAIL">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-RECEIPT-DETAIL</p>
          <h2>
            {receipt.supplierName} {receipt.supplierDocument ? `· ${receipt.supplierDocument}` : ""}
          </h2>
          <p>
            Received {receipt.receivedAt} ·{" "}
            {receipt.voided ? `Voided (${reasonLabel(receipt.voided.reasonCode)})` : "Posted"} ·
            accepted value CAD {centsToDollars(totalCents(receipt.lines))}
          </p>
        </div>
        <Link to="/operations/receiving">Back to receiving</Link>
      </header>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Location</th>
            <th>Lot / expiry</th>
            <th>Accepted</th>
            <th>Rejected</th>
            <th>Damaged</th>
            <th>Reason</th>
            <th>Unit cost</th>
            <th>°C</th>
          </tr>
        </thead>
        <tbody>
          {receipt.lines.map((line) => (
            <tr
              key={line.lineReference}
              style={
                error?.line === line.lineReference ? { outline: "2px solid #b42318" } : undefined
              }
            >
              <td>{items.get(line.itemReference)?.name ?? line.itemReference}</td>
              <td>{locations.get(line.locationReference)?.name ?? line.locationReference}</td>
              <td>{[line.lotCode, line.expiryDate].filter(Boolean).join(" · ")}</td>
              <td>
                {line.acceptedQuantity} {items.get(line.itemReference)?.unitCode}
              </td>
              <td>{line.rejectedQuantity}</td>
              <td>{line.damagedQuantity}</td>
              <td>{line.discrepancyReason ? reasonLabel(line.discrepancyReason) : ""}</td>
              <td>{centsToDollars(line.unitCostMinor)}</td>
              <td>{line.temperatureCelsius ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!receipt.voided && view.permissions.mayVoid ? (
        <section className="detail-section">
          <h3>Void this receipt</h3>
          <p>
            Voiding removes the received quantities from stock. It is refused once that stock was
            used or reserved.
          </p>
          <label>
            Reason
            <select value={reason} onChange={(e) => setReason(e.currentTarget.value)}>
              <option value="">Choose a reason</option>
              {view.voidReasons.map((value) => (
                <option key={value} value={value}>
                  {reasonLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy || reason === ""} onClick={() => void voidReceipt()}>
            Void receipt
          </button>
        </section>
      ) : null}
      {error ? (
        <StatePanel heading="Not voided" tone="error" status>
          <p>{copy[error.code]}</p>
        </StatePanel>
      ) : null}
    </AppFrame>
  );
}
