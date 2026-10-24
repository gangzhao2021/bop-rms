import { systemText, t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime, StaffTime, StoreTimeZoneContext, storeDate } from "./StoreTime.js";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./operation-reference.js";
import {
  StoreWastePageError,
  availableQuantityText,
  wasteTakesHeldStock,
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
  Loading: t("Loading waste…"),
  PermissionDenied: t("You do not have permission for this waste action."),
  NotFound: t("This waste record does not exist for the selected Store."),
  Conflict: t("This was already recorded. Refresh and check before trying again."),
  NotEnoughStock: t(
    "The highlighted line asks for more than is in stock there. If the stock figure is wrong, count the item first.",
  ),
  AlreadyReviewed: t("This record has already been reviewed."),
  NotIndependent: t("The person who recorded the waste cannot review it."),
  LineInvalid: t(
    "The highlighted line is not valid: check item, location, lot, quantity precision and reason (a note is needed for Other).",
  ),
  Invalid: t("The waste record is not valid."),
  Offline: t("Offline. Nothing was confirmed; retry sends the same request again."),
  Unavailable: t("Waste is unavailable."),
};
/**
 * DEC-INV-COUNT-SHORT amendment (2026-10-18): staff see what is physically there and what open
 * orders hold. Waste up to what is there is recordable; taking held stock leaves those orders short.
 */
const stockText = (row: { readonly onHand: string; readonly reserved: string }) =>
  t("{onHand} in stock", { onHand: availableQuantityText(row.onHand) }) +
  (/^0(?:\.0+)?$/u.test(row.reserved)
    ? ""
    : t(", {reserved} held for open orders", { reserved: availableQuantityText(row.reserved) }));
const heldStockNote = (available: string) =>
  available.startsWith("-")
    ? t(
        "Held for open orders — recording this waste makes the shortage bigger; receive stock or recount.",
      )
    : /^0(?:\.0+)?$/u.test(available)
      ? t(
          "Held for open orders — recording this waste leaves those orders short; receive stock or recount.",
        )
      : t(
          "Only {available} is not held for open orders — recording more leaves those orders short; receive stock or recount.",
          { available: availableQuantityText(available) },
        );
const reasonText = (code: string) =>
  code === "KITCHEN_REMAKE_OPENED_BY_MISTAKE"
    ? t("Remake cancelled — opened by mistake")
    : code.charAt(0) + code.slice(1).toLowerCase().replaceAll("_", " ");
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
    <StatePanel
      heading={code === "PermissionDenied" ? noAccessHeading : t("Waste")}
      tone={code === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{code === "PermissionDenied" ? pageAccessDeniedText : copy[code]}</p>
    </StatePanel>
  );
}
const statusOf = (record: WasteRecordView) =>
  record.review
    ? record.review.decision === "Voided"
      ? t("Voided")
      : t("Reviewed")
    : record.needsReview
      ? t("Needs review")
      : t("Recorded");

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
    <AppFrame title={t("Waste")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Waste")}</p>
          <h2>{t("Waste")}</h2>
          <p>
            {t(
              "Record waste when it happens; it leaves stock at once. Records worth ${reviewThresholdMinor} or more, or without a known cost, are reviewed by a manager. Source as of",
              { reviewThresholdMinor: centsText(view.reviewThresholdMinor) },
            )}{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
        {view.permissions.mayRecord ? (
          <Link to="/operations/inventory/waste/new">{t("Record waste")}</Link>
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
            {t("Only records waiting for review")}
          </label>
          {view.records.length === 0 ? (
            <StatePanel heading={t("No waste records")} status>
              <p>{t("Nothing to show.")}</p>
            </StatePanel>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("Recorded")}</th>
                  <th>{t("By")}</th>
                  <th>{t("What")}</th>
                  <th>{t("Value")}</th>
                  <th>{t("Status")}</th>
                </tr>
              </thead>
              <tbody>
                {view.records.map((record) => (
                  <tr key={record.wasteReference}>
                    <td>
                      <Link to={`/operations/inventory/waste/${record.wasteReference}`}>
                        <StaffTime instant={record.recordedAt} />
                      </Link>
                    </td>
                    <td>{view.people[record.recordedBy] ?? t("Staff member")}</td>
                    <td>
                      {[
                        ...record.lines.map(
                          (line) =>
                            `${itemName(line.itemReference)} ${line.quantity} ${line.unitCode}`,
                        ),
                        ...(record.shortfalls ?? [])
                          .filter((short) => short.recordedQuantity === "0")
                          .map(
                            (short) =>
                              `${itemName(short.itemReference)} ${short.wastedQuantity} ${short.unitCode}`,
                          ),
                      ].join(", ")}
                      {record.shortfalls?.length ? t(" · stock was short, count needed") : ""}
                    </td>
                    <td>
                      ${centsText(record.valueMinor)}
                      {record.costUnknown ? t(" (cost unknown)") : ""}
                    </td>
                    <td>{statusOf(record)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <p>{t("Use “Record waste” to log what was thrown away.")}</p>
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
  const timeZone = useContext(StoreTimeZoneContext);
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
        !wasteQuantityAllowed(line.quantity, item.ledgerPrecision, row.onHand) ||
        (line.reasonCode === "OTHER" && line.note.trim() === "")
      ) {
        // A well-formed quantity above what is there is "not enough stock", not an invalid line.
        const tooMuch =
          !row ||
          (item !== undefined &&
            wasteQuantityAllowed(line.quantity, item.ledgerPrecision, "999999999999") &&
            !wasteQuantityAllowed(line.quantity, item.ledgerPrecision, row.onHand));
        setError({ code: tooMuch ? "NotEnoughStock" : "LineInvalid", line: line.lineReference });
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
    <AppFrame title={t("Record waste")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Record waste")}</p>
          <h2>{t("Record waste")}</h2>
          <p>
            {t("What was thrown away, where, and why. It leaves stock as soon as you record it.")}
          </p>
        </div>
        <Link to="/operations/inventory/waste">{t("Waste records")}</Link>
      </header>
      {view.stock.length === 0 ? (
        <p>{t("Nothing is in stock in this Store to record as waste.")}</p>
      ) : null}
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
              <legend>{t("Line {value}", { value: index + 1 })}</legend>
              <label>
                {t("Item")}
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
                      {option.name} ({systemText(option.unitCode)})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("Where")}
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
                  {t("Lot")}
                  <select
                    value={line.lotReference}
                    onChange={(event) => update(index, { lotReference: event.currentTarget.value })}
                  >
                    {lots.map((row) => (
                      <option key={row.lotReference ?? "none"} value={row.lotReference ?? ""}>
                        {row.lotCode}
                        {row.expiryDate
                          ? t(" (exp. {expiryDate})", {
                              expiryDate: storeDate(row.expiryDate, timeZone),
                            })
                          : ""}{" "}
                        · {stockText(row)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                {t("Quantity (")}
                {systemText(item?.unitCode)}){selected ? ` — ${stockText(selected)}` : ""}
                <input
                  required
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) => update(index, { quantity: event.currentTarget.value })}
                />
              </label>
              {selected && wasteTakesHeldStock(line.quantity, selected.available) ? (
                <p role="note">{heldStockNote(selected.available)}</p>
              ) : null}
              <label>
                {t("Reason")}
                <select
                  required
                  value={line.reasonCode}
                  onChange={(event) => update(index, { reasonCode: event.currentTarget.value })}
                >
                  <option value="">{t("Choose a reason")}</option>
                  {view.reasons.map((reason) => (
                    <option key={reason} value={reason}>
                      {reasonText(reason)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("Note{value}", { value: line.reasonCode === "OTHER" ? "" : t(" (optional)") })}
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
                  {t("Remove line")}
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
          {t("Add line")}
        </button>{" "}
        <button disabled={busy || lines.length === 0}>{t("Record waste")}</button>
        {error ? (
          <StatePanel heading={t("Not recorded")} tone="error" status>
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
  const person = (reference: string) => view.people[reference] ?? t("Staff member");
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
    <AppFrame title={t("Waste record")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            {t("Waste record · {record}", { record: statusOf(record) })}
          </p>
          <h2>
            {t("Waste recorded")} <StaffTime instant={record.recordedAt} />
          </h2>
          <p>
            {t("By {recordedBy} · value ${valueMinor}{value}{value2}", {
              recordedBy: person(record.recordedBy),
              valueMinor: centsText(record.valueMinor),
              value: record.costUnknown ? t(" (some costs unknown)") : "",
              value2: record.review
                ? t(" · {value} by {reviewedBy} ({reasonCode})", {
                    value: record.review.decision === "Voided" ? "voided" : "reviewed",
                    reviewedBy: person(record.review.reviewedBy),
                    reasonCode: reasonText(record.review.reasonCode),
                  })
                : "",
            })}
          </p>
        </div>
        <Link to="/operations/inventory/waste">{t("Waste records")}</Link>
      </header>
      <table>
        <thead>
          <tr>
            <th>{t("Item")}</th>
            <th>{t("Where")}</th>
            <th>{t("Quantity")}</th>
            <th>{t("Reason")}</th>
            <th>{t("Value")}</th>
          </tr>
        </thead>
        <tbody>
          {record.lines.map((line) => (
            <tr key={line.lineReference}>
              <td>{itemName(line.itemReference)}</td>
              <td>{placeName(line.locationReference)}</td>
              <td>
                {line.quantity} {systemText(line.unitCode)}
              </td>
              <td>
                {reasonText(line.reasonCode)}
                {line.note ? ` — ${line.note}` : ""}
              </td>
              <td>
                {line.unitCostMinor === null ? t("unknown") : "$" + centsText(line.valueMinor)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {record.shortfalls?.length ? (
        <StatePanel heading={t("Stock was short — count these items")} tone="error">
          <p>
            {t(
              "A kitchen remake used more than stock showed as available. The food was thrown away; only what was in stock was taken off. Count these items and correct the count.",
            )}
          </p>
          <ul>
            {record.shortfalls.map((short) => (
              <li key={`${short.itemReference}|${short.locationReference}`}>
                {t(
                  "{itemReference} ({locationReference}): used {wastedQuantity} {unitCode}, taken off stock {recordedQuantity} {unitCode2}, not in stock {missingQuantity} {unitCode3}",
                  {
                    itemReference: itemName(short.itemReference),
                    locationReference: placeName(short.locationReference),
                    wastedQuantity: short.wastedQuantity,
                    unitCode: short.unitCode,
                    recordedQuantity: short.recordedQuantity,
                    unitCode2: short.unitCode,
                    missingQuantity: short.missingQuantity,
                    unitCode3: short.unitCode,
                  },
                )}
              </li>
            ))}
          </ul>
        </StatePanel>
      ) : null}
      {mayReview ? (
        <StatePanel heading={t("Review")}>
          <p>
            {t(
              "Accept the record, or void it if the waste did not happen (the quantity returns to stock).",
            )}
          </p>
          <button disabled={busy} onClick={() => void review("Accepted", "REVIEWED_OK")}>
            {t("Accept")}
          </button>{" "}
          <label>
            {t("Void reason")}
            <select
              value={voidReason}
              onChange={(event) => setVoidReason(event.currentTarget.value)}
            >
              <option value="">{t("Choose a reason")}</option>
              {view.voidReasons.map((reason) => (
                <option key={reason} value={reason}>
                  {reasonText(reason)}
                </option>
              ))}
            </select>
          </label>{" "}
          <button disabled={busy || !voidReason} onClick={() => void review("Voided", voidReason)}>
            {t("Void record")}
          </button>
        </StatePanel>
      ) : null}
      {record.review === null && record.recordedBy === view.viewer && record.needsReview ? (
        <p>{t("Waiting for another manager to review.")}</p>
      ) : null}
      {error ? (
        <StatePanel heading={t("Not recorded")} tone="error" status>
          <p>{copy[error]}</p>
        </StatePanel>
      ) : null}
    </AppFrame>
  );
}
