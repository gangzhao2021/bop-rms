import { t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./operation-reference.js";
import { SoleOperatorSelfApproval } from "./SoleOperatorSelfApproval.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED, FULL_SIGN_IN_REQUIRED_TEXT } from "./full-sign-in.js";
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
  Loading: t("Loading prices…"),
  PermissionDenied: t("You do not have permission for this price action at Brand level."),
  NotFound: t("This price book does not exist for the Brand."),
  Conflict: t("The price book changed since you opened it. Refresh and check again."),
  CodeTaken: t("Another price book of the Brand already uses this code."),
  ApprovalRequired: t(
    "Publishing needs someone other than the person who last changed the draft, holding price approval.",
  ),
  NotCovered: t(
    "Some items on this Store's menu have no price in this book for pickup or dine-in. Price them first.",
  ),
  NotPublished: t("Only a published price book can be used at a Store."),
  AlreadyAssigned: t("This Store already uses this price book."),
  Lifecycle: t("This step is not possible in the price book's current state."),
  Invalid: t("The prices are not valid. Enter amounts like 4.50 (up to 99,999.99)."),
  SoleOperatorNotInEffect: t(
    "Someone else now holds price approval, so they must publish this. Refresh to see who.",
  ),
  NeedsReverification: t("Confirm it is you with your authenticator code, then publish again."),
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  Offline: t("Offline. Nothing was confirmed; retry sends the same request again."),
  Unavailable: t("Prices are unavailable."),
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
/** The refusal of a PIN sign-in gets the verification step instead of a "Not done" panel. */
export function PriceCommandMessage({
  message,
  csrf,
  fetcher,
  heading,
  children,
}: {
  readonly message: { readonly text: string; readonly fullSignIn: boolean };
  readonly csrf: string | undefined;
  readonly fetcher: typeof fetch | undefined;
  readonly heading: string;
  readonly children?: ReactNode;
}) {
  if (message.fullSignIn && csrf !== undefined)
    return <FullSignInPrompt csrf={csrf} fetcher={fetcher} />;
  return (
    <StatePanel heading={heading} tone="error" status>
      <p>{message.text}</p>
      {children}
    </StatePanel>
  );
}
function Failure({ code }: { readonly code: PriceErrorCode | "Loading" }) {
  return (
    <StatePanel
      heading={code === "PermissionDenied" ? noAccessHeading : t("Prices")}
      tone={code === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{code === "PermissionDenied" ? pageAccessDeniedText : copy[code]}</p>
    </StatePanel>
  );
}
/** The app's money prefix: "$" for the Store's CAD; any other currency shows its code. */
const currencyPrefix = (code: string) => (code === "CAD" ? "$" : code + " ");
const itemName = (sellable: PriceSellable | undefined, reference: string) =>
  sellable ? `${sellable.productName} — ${sellable.sizeName}` : "Item " + reference.slice(-4);
/** A price book's state in staff words, with the Store's book named as in use here. */
export function priceBookStatus(lifecycle: string, inUseHere: boolean): string {
  if (lifecycle === "Draft") return t("Draft, not published yet");
  if (lifecycle === "Published") return inUseHere ? t("In use at this Store") : "Published";
  return lifecycleText[lifecycle] ?? "Discarded";
}

/**
 * Discarding a draft cannot be undone, so the button only opens a question; the draft is discarded
 * from the dialog, and "Keep draft" closes it with nothing sent.
 */
export function DiscardDraftAction({
  stableCode,
  busy,
  retry,
  onDiscard,
}: {
  readonly stableCode: string;
  readonly busy: boolean;
  /** The last discard was not confirmed by the server; the same request is sent again. */
  readonly retry: boolean;
  readonly onDiscard: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" disabled={busy} onClick={() => dialog.current?.showModal()}>
        {retry ? t("Retry discard") : t("Discard draft")}
      </button>
      <dialog
        ref={dialog}
        className="order-cancel-dialog"
        aria-labelledby="discard-draft-title"
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DiscardDraftQuestion
          stableCode={stableCode}
          busy={busy}
          onDiscard={() => {
            dialog.current?.close();
            onDiscard();
          }}
          onKeep={() => dialog.current?.close()}
        />
      </dialog>
    </>
  );
}

/** The confirmation itself (no state of its own). */
export function DiscardDraftQuestion({
  stableCode,
  busy,
  onDiscard,
  onKeep,
}: {
  readonly stableCode: string;
  readonly busy: boolean;
  readonly onDiscard: () => void;
  readonly onKeep: () => void;
}) {
  return (
    <>
      <h2 id="discard-draft-title">
        {t("Discard draft {stableCode}?", { stableCode: stableCode })}
      </h2>
      <p>
        {t(
          "Its prices are thrown away and it cannot be published or used at a Store. This cannot be undone. Its code stays taken, so a new price book needs a different code.",
        )}
      </p>
      <div className="card-actions">
        <button type="button" data-variant="destructive" disabled={busy} onClick={onDiscard}>
          {t("Discard draft")}
        </button>
        <button type="button" disabled={busy} onClick={onKeep}>
          {t("Keep draft")}
        </button>
      </div>
    </>
  );
}

/** One command at a time; an unconfirmed attempt is retried with the same operation. */
function useCommand(client: PriceClient, onDone: (result: unknown, command: PriceCommand) => void) {
  const [pending, setPending] = useState<PriceCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "error" | "neutral";
    text: string;
    sellables: readonly string[];
    /** A PIN sign-in must confirm it is the staff member; the same request is retried after. */
    fullSignIn: boolean;
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
      // Nothing was done when the request was refused for a PIN sign-in, so the same request is
      // sent again after the person confirms it is them.
      if (code !== "Offline" && code !== "Unavailable" && code !== FULL_SIGN_IN_REQUIRED)
        setPending(null);
      setMessage({
        tone: "error",
        text: copy[code],
        sellables: error instanceof PricePageError ? error.sellableReferences : [],
        fullSignIn: code === FULL_SIGN_IN_REQUIRED,
      });
    } finally {
      setBusy(false);
    }
  };
  return { send, busy, pending, message, setMessage };
}

export function StorePriceListPage({
  client = unavailablePriceClient,
  csrf,
  fetcher,
}: {
  readonly client?: PriceClient;
  /** For confirming a PIN sign-in before a price change. */
  readonly csrf?: string;
  /** For the authenticator check (tests). */
  readonly fetcher?: typeof fetch;
}) {
  const { state } = usePriceView(client, null, parsePriceBookListView);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  return <StorePriceList view={state.view} client={client} csrf={csrf} fetcher={fetcher} />;
}

/** The loaded price book list: this Store's book, a new draft, and every book of the Brand. */
export function StorePriceList({
  view,
  client,
  csrf,
  fetcher,
}: {
  readonly view: PriceBookListView;
  readonly client: PriceClient;
  readonly csrf: string | undefined;
  readonly fetcher: typeof fetch | undefined;
}) {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [copyFrom, setCopyFrom] = useState<string | null | undefined>(undefined);
  const { send, busy, pending, message } = useCommand(client, (result) => {
    const book = (result as { priceBookReference?: string }).priceBookReference;
    if (book) void navigate(`/app/commerce/pricing/${book}`);
  });
  const current = view.storeAssignment;
  const source = copyFrom === undefined ? (current?.priceBookReference ?? null) : copyFrom;
  const stableCode = (code || suggestPriceBookCode(view.sourceAsOf.slice(0, 10)))
    .trim()
    .toUpperCase();
  return (
    <AppFrame title={t("Prices")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Prices · Brand")}</p>
          <h2>{t("Prices")}</h2>
          <p>
            {t(
              "A price book holds a price for each size. A published book never changes: to change prices, start a new book (usually a copy of the current one), {value}, then use it at this Store. Source as of",
              {
                value:
                  view.soleOperator?.status === "Effective"
                    ? t(
                        "check it and publish it yourself (Sole operator is on and you are the only person who holds price approval, so you verify with your authenticator code first)",
                      )
                    : t("have someone else who holds price approval publish it"),
              },
            )}{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
      </header>
      <section className="detail-section" aria-labelledby="store-prices">
        <h3 id="store-prices">{t("This Store charges")}</h3>
        {current ? (
          <p>
            <Link to={`/app/commerce/pricing/${current.priceBookReference}`}>
              {current.stableCode}
            </Link>{" "}
            {t("since")} <SourceTime instant={current.effectiveFrom} />
          </p>
        ) : (
          <p>{t("No price book is in use: customers cannot be quoted until one is used here.")}</p>
        )}
      </section>
      {message ? (
        <PriceCommandMessage
          message={message}
          csrf={csrf}
          fetcher={fetcher}
          heading={t("Not created")}
        />
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
          <h3 id="new-book">{t("New price book")}</h3>
          <label>
            {t("Code")}
            <input
              value={code || suggestPriceBookCode(view.sourceAsOf.slice(0, 10))}
              maxLength={64}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
          </label>
          <label>
            {t("Start from")}
            <select
              value={source ?? ""}
              onChange={(event) =>
                setCopyFrom(event.target.value === "" ? null : event.target.value)
              }
            >
              <option value="">{t("Empty")}</option>
              {view.books
                .filter((book) => book.lifecycle === "Published")
                .map((book) => (
                  <option key={book.priceBookReference} value={book.priceBookReference}>
                    {t("Copy of {stableCode}{value}", {
                      stableCode: book.stableCode,
                      value:
                        book.priceBookReference === current?.priceBookReference
                          ? " (in use here)"
                          : "",
                    })}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit" disabled={busy}>
            {pending ? t("Retry") : t("Create draft")}
          </button>
        </form>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>{t("Price book")}</th>
            <th>{t("Status")}</th>
            <th>{t("Prices")}</th>
            <th>{t("Updated")}</th>
            <th>
              <span className="visually-hidden">{t("Next step")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {view.books.map((book) => (
            <tr key={book.priceBookReference}>
              <td>
                <Link to={`/app/commerce/pricing/${book.priceBookReference}`}>
                  {book.stableCode}
                </Link>
              </td>
              <td>
                {priceBookStatus(
                  book.lifecycle,
                  book.priceBookReference === current?.priceBookReference,
                )}
              </td>
              <td>{book.entries}</td>
              <td>
                <SourceTime instant={book.updatedAt} />
              </td>
              <td>
                {book.lifecycle === "Draft" &&
                (view.permissions.mayEdit || view.permissions.mayApprove) ? (
                  <Link
                    to={`/app/commerce/pricing/${book.priceBookReference}`}
                    aria-label={`${view.permissions.mayEdit ? "Continue draft" : "Review draft"} ${book.stableCode}`}
                  >
                    {view.permissions.mayEdit ? t("Continue draft") : t("Review draft")}
                  </Link>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.assignmentHistory.length > 0 ? (
        <section className="detail-section" aria-labelledby="history">
          <h3 id="history">{t("Price books used at this Store")}</h3>
          <ul>
            {view.assignmentHistory.map((item) => (
              <li key={item.assignmentReference}>
                {item.stableCode}: <SourceTime instant={item.effectiveFrom} />
                {item.endedAt ? (
                  <>
                    {" – "}
                    <SourceTime instant={item.endedAt} />
                  </>
                ) : (
                  t(" – now")
                )}
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
  csrf,
  fetcher,
}: {
  readonly client?: PriceClient;
  /** For the second-factor check of a sole operator's own publication. */
  readonly csrf?: string;
  /** For the authenticator check (tests). */
  readonly fetcher?: typeof fetch;
}) {
  const params = useParams();
  const reference = parsePriceRouteReference(params.id);
  if (reference === null) return <Failure code="NotFound" />;
  return (
    <PriceBookEditor
      key={reference}
      client={client}
      priceBookReference={reference}
      csrf={csrf}
      fetcher={fetcher}
    />
  );
}

function PriceBookEditor({
  client,
  priceBookReference,
  csrf,
  fetcher,
}: {
  readonly client: PriceClient;
  readonly priceBookReference: string;
  readonly csrf: string | undefined;
  readonly fetcher: typeof fetch | undefined;
}) {
  const { state, reload } = usePriceView(client, priceBookReference, parsePriceBookEditorView);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { send, busy, pending, message, setMessage } = useCommand(client, (_result, command) => {
    setNotice(
      {
        CreateDraft: "Created.",
        SaveDraft: t("Prices saved."),
        Publish: "Published.",
        Discard: t("Draft discarded."),
        AssignToStore: t("This Store now charges these prices."),
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
    <AppFrame title={book.stableCode} description={t("Price book")}>
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Price book · Brand")}</p>
          <h2>{book.stableCode}</h2>
          <p>
            {t(
              "{value} · version {aggregateVersion}{value2} · prices{value3} before tax, the same for pickup and dine-in",
              {
                value: lifecycleText[book.lifecycle] ?? book.lifecycle,
                aggregateVersion: book.aggregateVersion,
                value2: inUse ? t(" · in use at this Store") : "",
                value3:
                  view.currencyCode === "CAD"
                    ? ""
                    : t(" in {currencyCode},", { currencyCode: view.currencyCode }),
              },
            )}
          </p>
        </div>
        <Link to="/app/commerce/pricing">{t("Back to prices")}</Link>
      </header>
      {notice && !message ? (
        <StatePanel heading={t("Done")} status>
          <p>{notice}</p>
        </StatePanel>
      ) : null}
      {message ? (
        <PriceCommandMessage
          message={message}
          csrf={csrf}
          fetcher={fetcher}
          heading={t("Not done")}
        >
          {message.sellables.length > 0 ? (
            <ul>
              {message.sellables.map((reference) => (
                <li key={reference}>{itemName(byReference.get(reference), reference)}</li>
              ))}
            </ul>
          ) : null}
        </PriceCommandMessage>
      ) : null}
      {view.uncovered.length > 0 && book.lifecycle !== "Archived" ? (
        <StatePanel heading={t("Missing prices")} status>
          <p>
            {t(
              "These items are on this Store's menu but have no price in this book; it cannot be used here until they do:",
            )}
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
              <th>{t("Product")}</th>
              <th>{t("Size")}</th>
              <th>{t("Code")}</th>
              <th>{t("Price")}</th>
              <th>{t("On this Store's menu")}</th>
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
                      <>
                        <span aria-hidden="true">{currencyPrefix(view.currencyCode)}</span>
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
                      </>
                    ) : text === "" ? (
                      "—"
                    ) : (
                      currencyPrefix(view.currencyCode) + text
                    )}
                  </td>
                  <td>{onMenu.has(item.sellableReference) ? t("Yes") : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {editable ? <p>{t("Leave a price empty to leave that size out of this book.")}</p> : null}
        {editable ? (
          <button type="submit" disabled={!valid || !changed || busy}>
            {pending?.action === "SaveDraft" ? t("Retry") : t("Save prices")}
          </button>
        ) : null}
      </form>
      {draft ? (
        <section className="detail-section" aria-labelledby="publish">
          <h3 id="publish">{t("Publish")}</h3>
          <p>
            {t("Publishing fixes these prices for good. {value}", {
              value:
                view.soleOperator?.status === "Effective"
                  ? t(
                      "Sole operator is on and you are the only person who holds price approval, so you may publish your own draft after checking it and verifying it is you.",
                    )
                  : t(
                      "It must be done by someone other than the person who last changed the draft, who holds price approval.",
                    ),
            })}
          </p>
          {changed ? <p>{t("Save your changes first.")}</p> : null}
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
              {pending?.action === "Publish" ? t("Retry publish") : t("Publish")}
            </button>
          ) : view.permissions.mayApprove && authorIsViewer ? (
            <SoleOperatorSelfApproval
              gate={view.soleOperator}
              csrf={csrf}
              what={t("these prices")}
              permissionName={t("price approval")}
              busy={busy || changed || book.prices.length === 0}
              actionLabel={
                pending?.action === "Publish" ? t("Retry publish") : t("Publish on my own")
              }
              summary={
                <p>
                  {t(
                    "{stableCode}: {length} price{value}{value2}, fixed for good once published.",
                    {
                      stableCode: book.stableCode,
                      length: book.prices.length,
                      value: book.prices.length === 1 ? "" : "s",
                      value2: view.currencyCode === "CAD" ? "" : ` in ${view.currencyCode}`,
                    },
                  )}
                </p>
              }
              onApprove={() => {
                setMessage(null);
                void send({
                  action: "Publish",
                  operationReference: newOperationReference(),
                  priceBookReference: book.priceBookReference,
                  expectedAggregateVersion: book.aggregateVersion,
                  approvalMode: "SoleOperator",
                });
              }}
            />
          ) : (
            <p>{t("You do not hold price approval.")}</p>
          )}
          {view.permissions.mayEdit ? (
            <DiscardDraftAction
              stableCode={book.stableCode}
              busy={busy}
              retry={pending?.action === "Discard"}
              onDiscard={() => {
                setMessage(null);
                void send({
                  action: "Discard",
                  operationReference: newOperationReference(),
                  priceBookReference: book.priceBookReference,
                  expectedAggregateVersion: book.aggregateVersion,
                });
              }}
            />
          ) : null}
        </section>
      ) : null}
      {book.lifecycle === "Published" && !inUse && view.permissions.mayApprove ? (
        <section className="detail-section" aria-labelledby="use-here">
          <h3 id="use-here">{t("Use at this Store")}</h3>
          <p>
            {t(
              "From now on, new orders at this Store are priced from this book{value}. Orders already quoted keep their prices.",
              {
                value: view.storeAssignment
                  ? t(" instead of {stableCode}", { stableCode: view.storeAssignment.stableCode })
                  : "",
              },
            )}
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
            {pending?.action === "AssignToStore" ? t("Retry") : t("Use at this Store")}
          </button>
        </section>
      ) : null}
    </AppFrame>
  );
}
