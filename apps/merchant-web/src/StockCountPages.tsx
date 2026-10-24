import { systemText, t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime, StaffTime, StoreDate } from "./StoreTime.js";
import { unitText } from "./recipe-pages.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./operation-reference.js";
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
  type StockShortageView,
} from "./stock-count-pages.js";

/** WP-2423 / DEC-INV-STOCK-COUNT: Store stock counts — blind counting, review and posting. */
const copy: Record<StockCountErrorCode | "Loading", string> = {
  Loading: t("Loading stock counts…"),
  PermissionDenied: t("You do not have permission for this count action."),
  NotFound: t("This count does not exist for the selected Store."),
  // Only an actual concurrent change: someone saved another step of this count first.
  Conflict: t(
    "Someone else changed this count meanwhile. Reload the page and check it before trying again.",
  ),
  AlreadyOpen: t("This location already has an open count. Finish or cancel it first."),
  StockChanged: t(
    "Stock moved on the highlighted lines after they were counted (sales, receipts or waste). Send the count back; the counter refreshes those lines and counts them again.",
  ),
  Incomplete: t(
    "Every line needs a count before submitting, and every difference needs a reason before approval.",
  ),
  NotIndependent: t("The person who submitted the count cannot review or approve it."),
  State: t("This step is not possible in the count's current state."),
  LineInvalid: t("The highlighted count is not valid for the item's unit precision."),
  Invalid: t("The request is not valid."),
  Offline: t("Offline. Nothing was confirmed; retry sends the same request again."),
  Unavailable: t(
    "This could not be done right now and nothing was changed. Try again in a moment; if it keeps failing, keep your count sheet and tell the manager.",
  ),
};
const countTypeText: Record<"Full" | "Cycle" | "Spot", string> = {
  Cycle: t("Cycle count"),
  Full: t("Full count"),
  Spot: t("Spot check"),
};
const statusText: Record<string, string> = {
  Draft: t("Draft"),
  Assigned: t("Assigned"),
  InProgress: t("Counting"),
  Submitted: t("Submitted for review"),
  Approved: t("Approved"),
  Cancelled: t("Cancelled"),
  Posted: t("Posted"),
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
/**
 * v15 run: a person's name as staff know it ("You" for themselves, their role when no name is
 * recorded), never an identifier fragment such as "Staff 0100". People who are not on the Store's
 * staff list come in `people`.
 */
export function staffName(
  view: {
    readonly staff: readonly { readonly actorReference: string; readonly label: string }[];
    readonly people?: readonly { readonly actorReference: string; readonly label: string }[];
  },
  reference: string | null,
): string {
  if (reference === null) return "—";
  const label = [...view.staff, ...(view.people ?? [])].find(
    (item) => item.actorReference === reference,
  )?.label;
  return label === undefined ? t("Staff member") : systemText(label);
}

const quantityText = (quantity: string, unitCode: string) => `${quantity} ${unitText(unitCode)}`;
/**
 * DEC-INV-COUNT-SHORT (2026-10-18): what a manager acts on after a count. A count is posted even
 * when it finds less than open orders already hold (and waste up to what is there is recorded, the
 * 2026-10-18 amendment); those orders keep their ingredients and are
 * listed here so staff can get more stock, make them with what is there, or cancel them. Items the
 * kitchen then used beyond the count are listed until they are counted again.
 */
export function StockShortageNotice({
  view,
}: {
  readonly view: {
    readonly shortages?: readonly StockShortageView[];
    readonly items: readonly { readonly itemReference: string; readonly name: string }[];
    readonly locations: readonly { readonly locationReference: string; readonly name: string }[];
  };
}) {
  const shortages = view.shortages ?? [];
  if (shortages.length === 0) return null;
  const name = (entry: StockShortageView) =>
    (view.items.find((item) => item.itemReference === entry.itemReference)?.name ?? "Item") +
    (entry.lotCode === null ? "" : t(" (lot {lotCode})", { lotCode: entry.lotCode }));
  const place = (entry: StockShortageView) =>
    view.locations.find((item) => item.locationReference === entry.locationReference)?.name ??
    t("its location");
  const short = shortages.filter((entry) => entry.shortQuantity !== "0");
  const used = shortages.filter((entry) => entry.usedBeyondCount !== "0");
  return (
    <section className="detail-section" aria-labelledby="stock-shortage-heading">
      {short.length > 0 ? (
        <>
          <h3 id="stock-shortage-heading">{t("Less in stock than open orders need")}</h3>
          <p>
            {t(
              "These orders were taken before stock ran short (a count found less, or waste was recorded) and keep their ingredients. New orders can't use these items until it is fixed. For each order: get more and record the delivery under",
            )}{" "}
            <Link to="/operations/receiving/new">{t("Receiving")}</Link>
            {t(
              ", make it with what you have and count the item again afterwards, or cancel it (the guest is refunded).",
            )}
          </p>
          <ul>
            {short.map((entry) => (
              <li key={`${entry.itemReference}:${entry.locationReference}:${entry.lotCode ?? ""}`}>
                <strong>{name(entry)}</strong>{" "}
                {t("at {entry}: {onHand} in stock, {reserved} held for open orders —", {
                  entry: place(entry),
                  onHand: quantityText(entry.onHand, entry.unitCode),
                  reserved: quantityText(entry.reserved, entry.unitCode),
                })}{" "}
                <strong>
                  {t("short by {shortQuantity}", {
                    shortQuantity: quantityText(entry.shortQuantity, entry.unitCode),
                  })}
                </strong>
                .
                {entry.orders.length > 0 ? (
                  <>
                    {" "}
                    {t("Held by:")}{" "}
                    {entry.orders.map((order, index) => (
                      <span key={order.orderReference}>
                        {index > 0 ? ", " : ""}
                        <Link to={`/operations/orders/${order.orderReference}`}>
                          {t("Order {orderNumber}", { orderNumber: order.orderNumber })}
                        </Link>{" "}
                        ({order.orderType === "DineIn" ? "dine-in" : t("pickup")},{" "}
                        {quantityText(order.quantity, entry.unitCode)}
                        {order.ended
                          ? t(", already finished — release its ingredients on Orders")
                          : ""}
                        )
                      </span>
                    ))}
                    .
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {used.length > 0 ? (
        <>
          <h3 id={short.length > 0 ? undefined : "stock-shortage-heading"}>
            {t("Used more than was counted")}
          </h3>
          <p>
            {t(
              "The kitchen finished orders with more than the last count found, so the count missed some stock or a delivery was not recorded. Count these items again to correct the stock.",
            )}
          </p>
          <ul>
            {used.map((entry) => (
              <li
                key={`used:${entry.itemReference}:${entry.locationReference}:${entry.lotCode ?? ""}`}
              >
                <strong>{name(entry)}</strong>{" "}
                {t("at {entry}: used {usedBeyondCount} more than counted.", {
                  entry: place(entry),
                  usedBeyondCount: quantityText(entry.usedBeyondCount, entry.unitCode),
                })}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function Failure({ code }: { code: StockCountErrorCode | "Loading" }) {
  return (
    <StatePanel
      heading={code === "PermissionDenied" ? noAccessHeading : t("Stock counts")}
      tone={code === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{code === "PermissionDenied" ? pageAccessDeniedText : copy[code]}</p>
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
  const person = (reference: string | null) => staffName(view, reference);
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
    <AppFrame title={t("Stock counts")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Stock counts")}</p>
          <h2>{t("Stock counts")}</h2>
          <p>
            {t(
              "Count one storage location at a time, ideally while the Store is closed. Counters count blind; a manager explains the differences and posts them. Source as of",
            )}{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
      </header>
      <StockShortageNotice view={view} />
      {view.permissions.mayCreate ? (
        <form
          className="detail-section"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <h3>{t("Start a count")}</h3>
          <label>
            {t("Location")}
            <select value={location} onChange={(e) => setLocation(e.currentTarget.value)}>
              {view.locations.map((item) => (
                <option key={item.locationReference} value={item.locationReference}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Type")}
            <select
              value={countType}
              onChange={(e) => setCountType(e.currentTarget.value as "Full" | "Cycle" | "Spot")}
            >
              <option value="Cycle">{t("Cycle count (routine)")}</option>
              <option value="Full">{t("Full count (period end)")}</option>
              <option value="Spot">{t("Spot check")}</option>
            </select>
          </label>
          <label>
            {t("Counted by")}
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
          <button disabled={busy || view.locations.length === 0}>{t("Start count")}</button>
          {error ? (
            <StatePanel heading={t("Not started")} tone="error" status>
              <p>{copy[error]}</p>
            </StatePanel>
          ) : null}
        </form>
      ) : null}
      {view.counts.length === 0 ? (
        <StatePanel heading={t("No counts yet")} status>
          <p>{t("Counts appear here once started.")}</p>
        </StatePanel>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("Started")}</th>
              <th>{t("Location")}</th>
              <th>{t("Type")}</th>
              <th>{t("Counted by")}</th>
              <th>{t("Progress")}</th>
              <th>{t("Status")}</th>
            </tr>
          </thead>
          <tbody>
            {view.counts.map((count) => (
              <tr key={count.countReference}>
                <td>
                  <Link to={`/operations/inventory/counts/${count.countReference}`}>
                    <StaffTime instant={count.createdAt} />
                  </Link>
                </td>
                <td>{place(count.locationReference)}</td>
                <td>{countTypeText[count.countType]}</td>
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
  const person = (reference: string | null) => staffName(view, reference);
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
  // v15 2026-10-18 D2: only lines whose stock moved since their snapshot can be refreshed; a count
  // just started has none, so the refresh is not offered (it used to answer "not possible").
  const moved = new Set(counting ? (view.movedLineReferences ?? []) : []);
  return (
    <AppFrame
      title={t("Count · {location}", { location: location })}
      description={t("Stock count")}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            {t("Stock count · {value}", { value: countTypeText[count.countType] })}
          </p>
          <h2>{t("Count · {location}", { location: location })}</h2>
          <p>
            {statusText[count.status]} {t("· counted by")} {person(count.assigneeReference)} ·{" "}
            {counted} {t("of")} {count.lines.length} {t("lines counted")}
            {count.submittedBy
              ? t(" · submitted by {submittedBy}", { submittedBy: person(count.submittedBy) })
              : ""}
            {count.approvedBy
              ? t(" · approved by {approvedBy}", { approvedBy: person(count.approvedBy) })
              : ""}
          </p>
        </div>
        <Link to="/operations/inventory/counts">{t("All counts")}</Link>
      </header>
      {error ? (
        <StatePanel heading={t("Not recorded")} tone="error" status>
          <p>{copy[error.code]}</p>
        </StatePanel>
      ) : null}
      {count.status === "Posted" ? <StockShortageNotice view={view} /> : null}
      {count.status === "Assigned" && isAssignee && view.permissions.mayCount ? (
        <button disabled={busy} onClick={() => void run([base("Start")])}>
          {t("Start counting")}
        </button>
      ) : null}
      {count.status === "Assigned" && !isAssignee ? (
        <p>
          {t("Waiting for {assigneeReference} to start counting.", {
            assigneeReference: person(count.assigneeReference),
          })}
        </p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>{t("Item")}</th>
            <th>{t("Lot")}</th>
            <th>{t("Unit")}</th>
            {count.lines.some((line) => line.expectedQuantity !== null) ? (
              <th>{t("Expected")}</th>
            ) : null}
            <th>{t("Counted")}</th>
            {count.lines.some((line) => line.variance !== null) ? <th>{t("Difference")}</th> : null}
            {count.status !== "InProgress" ? <th>{t("Reason")}</th> : null}
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
                <td>
                  {item?.name ?? t("Item")}
                  {moved.has(line.lineReference) ? t(" · stock moved") : ""}
                </td>
                <td>
                  {lot ? (
                    <>
                      {lot.lotCode}
                      {lot.expiryDate ? (
                        <>
                          {" "}
                          {t("(exp.")} <StoreDate value={lot.expiryDate} />)
                        </>
                      ) : null}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{unitText(line.unitCode)}</td>
                {count.lines.some((other) => other.expectedQuantity !== null) ? (
                  <td>{line.expectedQuantity ?? ""}</td>
                ) : null}
                <td>
                  {counting ? (
                    <input
                      aria-label={t("Counted {value}{value2}", {
                        value: item?.name ?? "item",
                        value2: lot ? " " + lot.lotCode : "",
                      })}
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
                        aria-label={t("Reason {value}", { value: item?.name ?? "item" })}
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
                        <option value="">{t("Choose a reason")}</option>
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
            {t("Save counts")}
          </button>{" "}
          <button
            disabled={busy || counted < count.lines.length}
            onClick={() => void run([base("Submit")])}
          >
            {t("Submit for review")}
          </button>{" "}
          {moved.size > 0 ? (
            <button disabled={busy} onClick={() => void run([base("Refresh")])}>
              {t("Refresh lines where stock moved")}
            </button>
          ) : null}
        </p>
      ) : null}
      {counting && moved.size > 0 ? (
        <p role="note">
          {t(
            "Stock moved on {value} since counting started (sales, deliveries or waste). Refresh them and count them again.",
            { value: moved.size === 1 ? t("1 line") : t("{size} lines", { size: moved.size }) },
          )}
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
            {t("Approve and post differences")}
          </button>{" "}
          <button disabled={busy} onClick={() => void run([base("SendBack")])}>
            {t("Send back for recount")}
          </button>
        </p>
      ) : null}
      {count.status === "Submitted" && count.submittedBy === view.viewer ? (
        <p>{t("Submitted. Another manager reviews and posts the differences.")}</p>
      ) : null}
      {["Draft", "Assigned", "InProgress"].includes(count.status) && view.permissions.mayCreate ? (
        <button disabled={busy} onClick={() => void run([base("Cancel")])}>
          {t("Cancel count")}
        </button>
      ) : null}
    </AppFrame>
  );
}
