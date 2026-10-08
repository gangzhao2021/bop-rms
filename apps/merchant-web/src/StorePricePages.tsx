import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./RoleAdministrationPages.js";
import {
  PricePageError,
  dollarsToMinor,
  minorToDollars,
  parsePriceBookEditorView,
  parsePriceBookListView,
  parsePriceRouteReference,
  suggestPriceBookCode,
  unavailablePriceClient,
  type PriceBookEditorView,
  type PriceBookListView,
  type PriceClient,
  type PriceCommand,
  type PriceErrorCode,
  type PriceSellable,
} from "./store-price-pages.js";

/** WP-2423 / DEC-PRICE-STORE-ASSIGNMENT: Brand price books and the price book this Store charges. */
const copy: Record<PriceErrorCode | "Loading", string> = {
  Loading: "Loading prices…",
  PermissionDenied: "You do not have permission for this price action at Brand level.",
  NotFound: "This price book does not exist for the Brand.",
  Conflict: "The price book changed since you opened it. Refresh and check again.",
  CodeTaken: "Another price book of the Brand already uses this code.",
  ApprovalRequired:
    "Publishing needs someone other than the person who last changed the draft, holding price approval.",
  NotCovered:
    "Some items on this Store's menu have no price in this book for pickup or dine-in. Price them first.",
  NotPublished: "Only a published price book can be used at a Store.",
  AlreadyAssigned: "This Store already uses this price book.",
  Lifecycle: "This step is not possible in the price book's current state.",
  Invalid: "The prices are not valid. Enter amounts like 4.50 (up to 99,999.99).",
  Offline: "Offline. Nothing was confirmed; retry sends the same request again.",
  Unavailable: "Prices are unavailable.",
};
const lifecycleText: Record<string, string> = {
  Draft: "Draft",
  Published: "Published",
  Archived: "Discarded",
};
type State<V> =
  { readonly kind: "Loading" | PriceErrorCode } | { readonly kind: "Found"; readonly view: V };
function usePriceView<V>(
  client: PriceClient,
  priceBookReference: string | null,
  parse: (value: unknown) => V,
) {
  const [state, setState] = useState<State<V>>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load(priceBookReference)
      .then((value) => {
        if (active) setState({ kind: "Found", view: parse(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof PricePageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, priceBookReference, parse, generation]);
  return { state, reload };
}
function Failure({ code }: { readonly code: PriceErrorCode | "Loading" }) {
  return (
    <StatePanel heading="Prices" tone={code === "Loading" ? "neutral" : "error"} status>
      <p>{copy[code]}</p>
    </StatePanel>
  );
}
const itemName = (sellable: PriceSellable | undefined, reference: string) =>
  sellable ? `${sellable.productName} — ${sellable.sizeName}` : "Item " + reference.slice(-4);
const localTime = (instant: string) => instant.replace("T", " ").slice(0, 16) + " UTC";

/** One command at a time; an unconfirmed attempt is retried with the same operation. */
function useCommand(client: PriceClient, onDone: (result: unknown, command: PriceCommand) => void) {
  const [pending, setPending] = useState<PriceCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "error" | "neutral";
    text: string;
    sellables: readonly string[];
  } | null>(null);
  const send = async (fresh: PriceCommand) => {
    if (!client.command) return;
    const command = pending !== null && pending.action === fresh.action ? pending : fresh;
    setBusy(true);
    setMessage(null);
    setPending(command);
    try {
      const result = await client.command(command);
      setPending(null);
      onDone(result, command);
    } catch (error) {
      const code = error instanceof PricePageError ? error.code : "Unavailable";
      if (code !== "Offline" && code !== "Unavailable") setPending(null);
      setMessage({
        tone: "error",
        text: copy[code],
        sellables: error instanceof PricePageError ? error.sellableReferences : [],
      });
    } finally {
      setBusy(false);
    }
  };
  return { send, busy, pending, message, setMessage };
}

export function StorePriceListPage({
  client = unavailablePriceClient,
}: {
  readonly client?: PriceClient;
}) {
  const navigate = useNavigate();
  const { state } = usePriceView(client, null, parsePriceBookListView);
  const [code, setCode] = useState("");
  const [copyFrom, setCopyFrom] = useState<string | null | undefined>(undefined);
  const { send, busy, pending, message } = useCommand(client, (result) => {
    const book = (result as { priceBookReference?: string }).priceBookReference;
    if (book) void navigate(`/app/commerce/pricing/${book}`);
  });
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: PriceBookListView = state.view;
  const current = view.storeAssignment;
  const source = copyFrom === undefined ? (current?.priceBookReference ?? null) : copyFrom;
  const stableCode = (code || suggestPriceBookCode(view.sourceAsOf.slice(0, 10)))
    .trim()
    .toUpperCase();
  return (
    <AppFrame title="Prices" description="PRICE-BOOK-LIST">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">PRICE-BOOK-LIST · Brand</p>
          <h2>Prices</h2>
          <p>
            A price book holds a price for each size. A published book never changes: to change
            prices, start a new book (usually a copy of the current one), have someone else publish
            it, then use it at this Store. Source as of {view.sourceAsOf}
          </p>
        </div>
      </header>
      <section className="detail-section" aria-labelledby="store-prices">
        <h3 id="store-prices">This Store charges</h3>
        {current ? (
          <p>
            <Link to={`/app/commerce/pricing/${current.priceBookReference}`}>
              {current.stableCode}
            </Link>{" "}
            since {localTime(current.effectiveFrom)}
          </p>
        ) : (
          <p>No price book is in use: customers cannot be quoted until one is used here.</p>
        )}
      </section>
      {message ? (
        <StatePanel heading="Not created" tone="error" status>
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      {view.permissions.mayEdit ? (
        <form
          className="detail-section"
          aria-labelledby="new-book"
          onSubmit={(event) => {
            event.preventDefault();
            if (!/^[A-Z][A-Z0-9_-]{0,63}$/u.test(stableCode) || busy) return;
            void send({
              action: "CreateDraft",
              operationReference: newOperationReference(),
              stableCode,
              copyFrom: source,
            });
          }}
        >
          <h3 id="new-book">New price book</h3>
          <label>
            Code
            <input
              value={code || suggestPriceBookCode(view.sourceAsOf.slice(0, 10))}
              maxLength={64}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
          </label>
          <label>
            Start from
            <select
              value={source ?? ""}
              onChange={(event) =>
                setCopyFrom(event.target.value === "" ? null : event.target.value)
              }
            >
              <option value="">Empty</option>
              {view.books
                .filter((book) => book.lifecycle !== "Archived")
                .map((book) => (
                  <option key={book.priceBookReference} value={book.priceBookReference}>
                    {`Copy of ${book.stableCode}${book.priceBookReference === current?.priceBookReference ? " (in use here)" : ""}`}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit" disabled={busy}>
            {pending ? "Retry" : "Create draft"}
          </button>
        </form>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>Price book</th>
            <th>Status</th>
            <th>Prices</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {view.books.map((book) => (
            <tr key={book.priceBookReference}>
              <td>
                <Link to={`/app/commerce/pricing/${book.priceBookReference}`}>
                  {book.stableCode}
                </Link>
                {book.priceBookReference === current?.priceBookReference
                  ? " (in use at this Store)"
                  : ""}
              </td>
              <td>{lifecycleText[book.lifecycle] ?? book.lifecycle}</td>
              <td>{book.entries}</td>
              <td>{localTime(book.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.assignmentHistory.length > 0 ? (
        <section className="detail-section" aria-labelledby="history">
          <h3 id="history">Price books used at this Store</h3>
          <ul>
            {view.assignmentHistory.map((item) => (
              <li key={item.assignmentReference}>
                {item.stableCode}: {localTime(item.effectiveFrom)}
                {item.endedAt ? ` – ${localTime(item.endedAt)}` : " – now"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppFrame>
  );
}

export function StorePriceEditorPage({
  client = unavailablePriceClient,
}: {
  readonly client?: PriceClient;
}) {
  const params = useParams();
  const reference = parsePriceRouteReference(params.id);
  if (reference === null) return <Failure code="NotFound" />;
  return <PriceBookEditor key={reference} client={client} priceBookReference={reference} />;
}

function PriceBookEditor({
  client,
  priceBookReference,
}: {
  readonly client: PriceClient;
  readonly priceBookReference: string;
}) {
  const { state, reload } = usePriceView(client, priceBookReference, parsePriceBookEditorView);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { send, busy, pending, message, setMessage } = useCommand(client, (_result, command) => {
    setNotice(
      {
        CreateDraft: "Created.",
        SaveDraft: "Prices saved.",
        Publish: "Published.",
        Discard: "Draft discarded.",
        AssignToStore: "This Store now charges these prices.",
      }[command.action],
    );
    setLoadedVersion(null);
    reload();
  });
  useEffect(() => {
    if (state.kind !== "Found" || loadedVersion === state.view.book.aggregateVersion) return;
    setLoadedVersion(state.view.book.aggregateVersion);
    setAmounts(
      Object.fromEntries(
        state.view.book.prices.map((price) => [
          price.sellableReference,
          minorToDollars(price.amountMinor),
        ]),
      ),
    );
  }, [state, loadedVersion]);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: PriceBookEditorView = state.view;
  const book = view.book;
  const draft = book.lifecycle === "Draft";
  const editable = draft && view.permissions.mayEdit;
  const inUse = view.storeAssignment?.priceBookReference === book.priceBookReference;
  const onMenu = new Set(view.menuSellables);
  const byReference = new Map(view.sellables.map((item) => [item.sellableReference, item]));
  // Selling sizes and every size already priced, grouped by product.
  const rows = view.sellables.filter(
    (item) =>
      item.active || book.prices.some((p) => p.sellableReference === item.sellableReference),
  );
  const parsed = Object.entries(amounts)
    .filter(([, text]) => text.trim() !== "")
    .map(([sellableReference, text]) => ({ sellableReference, amountMinor: dollarsToMinor(text) }));
  const valid = parsed.every((price) => price.amountMinor !== null);
  const changed =
    parsed.length !== book.prices.length ||
    parsed.some(
      (price) =>
        book.prices.find((p) => p.sellableReference === price.sellableReference)?.amountMinor !==
        price.amountMinor,
    );
  const highlight = new Set([...view.uncovered, ...(message?.sellables ?? [])]);
  const authorIsViewer = view.draftAuthor !== null && view.draftAuthor === view.viewer;
  return (
    <AppFrame title={book.stableCode} description="PRICE-BOOK-EDITOR">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">PRICE-BOOK-EDITOR · Brand</p>
          <h2>{book.stableCode}</h2>
          <p>
            {lifecycleText[book.lifecycle] ?? book.lifecycle} · version {book.aggregateVersion}
            {inUse ? " · in use at this Store" : ""} · prices in {view.currencyCode}, before tax,
            the same for pickup and dine-in
          </p>
        </div>
        <Link to="/app/commerce/pricing">Back to prices</Link>
      </header>
      {notice && !message ? (
        <StatePanel heading="Done" status>
          <p>{notice}</p>
        </StatePanel>
      ) : null}
      {message ? (
        <StatePanel heading="Not done" tone="error" status>
          <p>{message.text}</p>
          {message.sellables.length > 0 ? (
            <ul>
              {message.sellables.map((reference) => (
                <li key={reference}>{itemName(byReference.get(reference), reference)}</li>
              ))}
            </ul>
          ) : null}
        </StatePanel>
      ) : null}
      {view.uncovered.length > 0 && book.lifecycle !== "Archived" ? (
        <StatePanel heading="Missing prices" status>
          <p>
            These items are on this Store's menu but have no price in this book; it cannot be used
            here until they do:
          </p>
          <ul>
            {view.uncovered.map((reference) => (
              <li key={reference}>{itemName(byReference.get(reference), reference)}</li>
            ))}
          </ul>
        </StatePanel>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!editable || !valid || !changed || busy) return;
          void send({
            action: "SaveDraft",
            operationReference: newOperationReference(),
            priceBookReference: book.priceBookReference,
            expectedAggregateVersion: book.aggregateVersion,
            prices: parsed.map((price) => ({
              sellableReference: price.sellableReference,
              amountMinor: price.amountMinor ?? "",
            })),
          });
        }}
      >
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Size</th>
              <th>Code</th>
              <th>Price ({view.currencyCode})</th>
              <th>On this Store's menu</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => {
              const text = amounts[item.sellableReference] ?? "";
              const bad = text.trim() !== "" && dollarsToMinor(text) === null;
              return (
                <tr
                  key={item.sellableReference}
                  data-missing={highlight.has(item.sellableReference) ? "true" : undefined}
                >
                  <td>{item.productName}</td>
                  <td>{item.sizeName}</td>
                  <td>{item.skuCode}</td>
                  <td>
                    {editable ? (
                      <input
                        aria-label={`Price of ${item.productName} ${item.sizeName}`}
                        inputMode="decimal"
                        value={text}
                        aria-invalid={bad ? "true" : undefined}
                        onChange={(event) =>
                          setAmounts((current) => ({
                            ...current,
                            [item.sellableReference]: event.target.value,
                          }))
                        }
                      />
                    ) : text === "" ? (
                      "—"
                    ) : (
                      text
                    )}
                  </td>
                  <td>{onMenu.has(item.sellableReference) ? "Yes" : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {editable ? <p>Leave a price empty to leave that size out of this book.</p> : null}
        {editable ? (
          <button type="submit" disabled={!valid || !changed || busy}>
            {pending?.action === "SaveDraft" ? "Retry" : "Save prices"}
          </button>
        ) : null}
      </form>
      {draft ? (
        <section className="detail-section" aria-labelledby="publish">
          <h3 id="publish">Publish</h3>
          <p>
            Publishing fixes these prices for good. It must be done by someone other than the person
            who last changed the draft, who holds price approval.
          </p>
          {changed ? <p>Save your changes first.</p> : null}
          {view.permissions.mayApprove && !authorIsViewer ? (
            <button
              type="button"
              disabled={busy || changed || book.prices.length === 0}
              onClick={() => {
                setMessage(null);
                void send({
                  action: "Publish",
                  operationReference: newOperationReference(),
                  priceBookReference: book.priceBookReference,
                  expectedAggregateVersion: book.aggregateVersion,
                });
              }}
            >
              {pending?.action === "Publish" ? "Retry publish" : "Publish"}
            </button>
          ) : (
            <p>
              {authorIsViewer
                ? "You last changed this draft: someone else must publish it."
                : "You do not hold price approval."}
            </p>
          )}
          {view.permissions.mayEdit ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void send({
                  action: "Discard",
                  operationReference: newOperationReference(),
                  priceBookReference: book.priceBookReference,
                  expectedAggregateVersion: book.aggregateVersion,
                })
              }
            >
              Discard draft
            </button>
          ) : null}
        </section>
      ) : null}
      {book.lifecycle === "Published" && !inUse && view.permissions.mayApprove ? (
        <section className="detail-section" aria-labelledby="use-here">
          <h3 id="use-here">Use at this Store</h3>
          <p>
            From now on, new orders at this Store are priced from this book
            {view.storeAssignment ? ` instead of ${view.storeAssignment.stableCode}` : ""}. Orders
            already quoted keep their prices.
          </p>
          <button
            type="button"
            disabled={busy || view.uncovered.length > 0}
            onClick={() =>
              void send({
                action: "AssignToStore",
                operationReference: newOperationReference(),
                priceBookReference: book.priceBookReference,
              })
            }
          >
            {pending?.action === "AssignToStore" ? "Retry" : "Use at this Store"}
          </button>
        </section>
      ) : null}
    </AppFrame>
  );
}
