import { useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import type { CurrentOrderQueue } from "./current-order-queue-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { browserOffline } from "./stale-read.js";
import { storeTime } from "./StoreTime.js";
import { orderMoney } from "./order-money.js";

type Order = CurrentOrderQueue["items"][number];

type State =
  | "Idle"
  | "Pending"
  | "Unknown"
  | "Recordable"
  | "Invalid"
  | "Used"
  | "Lower"
  | "Changed"
  | "Denied"
  | "Failed";

/** DEC-PAPER-ORDER-NEVER-RELEASED: the server's answer, as what the screen says next. */
export function paperReentryOutcome(status: number, error: unknown): Exclude<State, "Idle"> {
  if (status === 403 || status === 401) return "Denied";
  if (error === "paper_order_still_recordable") return "Recordable";
  if (error === "paper_reentry_invalid") return "Invalid";
  if (error === "paper_reentry_used") return "Used";
  if (error === "paper_reentry_amount_lower") return "Lower";
  if (status === 409 || status === 404) return "Changed";
  if (status >= 500 || status === 0) return "Unknown";
  return "Failed";
}

/** The paper order's sale and the new paper orders it may be linked to, as the server read them. */
export type PaperReentryChoices = Readonly<{
  paperOrder: Readonly<{ orderNumber: string; saleMinor: string; currencyCode: string }>;
  candidates: readonly Readonly<{
    orderReference: string;
    orderNumber: string;
    submittedAt: string;
    saleMinor: string;
    paidMinor: string;
    coversSale: boolean;
  }>[];
}>;

const minor = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/u.test(value);
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** DEC-PAPER-ORDER-NEVER-RELEASED: the server's read of what may be linked (strict). */
export function parsePaperReentryChoices(value: unknown): PaperReentryChoices {
  const bad = () => {
    throw new Error("paper re-entry choices are invalid");
  };
  const record = (input: unknown, keys: readonly string[]) => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return bad();
    const found = Object.keys(input);
    if (found.length !== keys.length || !keys.every((key) => found.includes(key))) return bad();
    return input as Record<string, unknown>;
  };
  const raw = record(value, ["paperOrder", "candidates"]);
  const paper = record(raw.paperOrder, ["orderNumber", "saleMinor", "currencyCode"]);
  if (
    typeof paper.orderNumber !== "string" ||
    !minor(paper.saleMinor) ||
    typeof paper.currencyCode !== "string" ||
    !/^[A-Z]{3}$/u.test(paper.currencyCode) ||
    !Array.isArray(raw.candidates) ||
    raw.candidates.length > 50
  )
    return bad();
  const candidates = raw.candidates.map((item: unknown) => {
    const candidate = record(item, [
      "orderReference",
      "orderNumber",
      "submittedAt",
      "saleMinor",
      "paidMinor",
      "coversSale",
    ]);
    if (
      typeof candidate.orderReference !== "string" ||
      !reference.test(candidate.orderReference) ||
      typeof candidate.orderNumber !== "string" ||
      typeof candidate.submittedAt !== "string" ||
      Number.isNaN(Date.parse(candidate.submittedAt)) ||
      !minor(candidate.saleMinor) ||
      !minor(candidate.paidMinor) ||
      typeof candidate.coversSale !== "boolean"
    )
      return bad();
    return Object.freeze({
      orderReference: candidate.orderReference,
      orderNumber: candidate.orderNumber,
      submittedAt: candidate.submittedAt,
      saleMinor: candidate.saleMinor,
      paidMinor: candidate.paidMinor,
      coversSale: candidate.coversSale,
    });
  });
  return Object.freeze({
    paperOrder: Object.freeze({
      orderNumber: paper.orderNumber,
      saleMinor: paper.saleMinor,
      currencyCode: paper.currencyCode,
    }),
    candidates: Object.freeze(candidates),
  });
}

type Read = "Loading" | "Ready" | "Unknown" | "Denied" | "Changed";

/**
 * DEC-PAPER-ORDER-NEVER-RELEASED: a paper order whose payment could not be recorded before its
 * time ended stays open (its sale is never released). Once staff entered it again from the paper
 * slip as a new paper order with its payment, a manager closes this one as entered again, naming
 * the new order; the sale then counts once, as the new order. A lost answer is sent again with the
 * same reference, so it never closes twice.
 */
export function PaperReentryAction({
  order,
  csrf,
  timeZone,
  fetcher = fetch,
  onClosed,
}: {
  readonly order: Order;
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
  readonly onClosed: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<string | null>(null);
  const [chosen, setChosen] = useState("");
  const [state, setState] = useState<State>("Idle");
  // The choices are read from the server when the dialog opens (any business day: the new order
  // may already be made and gone from this page's list).
  const [read, setRead] = useState<Read>("Loading");
  const [choices, setChoices] = useState<PaperReentryChoices | null>(null);
  const batch = order.batches[0];
  const load = async () => {
    setRead("Loading");
    if (browserOffline()) {
      setRead("Unknown");
      return;
    }
    try {
      const response = await fetcher(
        "/merchant/counter/orders/paper-reentry?order=" + encodeURIComponent(order.orderReference),
        { method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store" },
      );
      if (response.ok) {
        const parsed = parsePaperReentryChoices(await response.json());
        setChoices(parsed);
        setChosen((value) =>
          parsed.candidates.some(
            (candidate) => candidate.orderReference === value && candidate.coversSale,
          )
            ? value
            : "",
        );
        setRead("Ready");
        return;
      }
      setRead(
        response.status === 403 || response.status === 401
          ? "Denied"
          : response.status === 404
            ? "Changed"
            : "Unknown",
      );
    } catch {
      setRead("Unknown");
    }
  };
  const open = () => {
    dialog.current?.showModal();
    void load();
  };
  const submit = async () => {
    if (chosen === "" || state === "Pending" || batch === undefined) return;
    if (browserOffline()) {
      setState("Unknown");
      return;
    }
    operation.current ??= serviceOperationReference();
    setState("Pending");
    let next: Exclude<State, "Idle">;
    try {
      const response = await fetcher("/merchant/counter/orders/cancel-unpaid", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify({
          operationReference: operation.current,
          orderReference: order.orderReference,
          orderBatchReference: batch.orderBatchReference,
          expectedOrderVersion: order.currentVersion,
          reasonCode: "COUNTER_PAPER_REENTERED",
          reenteredOrderReference: chosen,
        }),
      });
      if (response.ok) {
        dialog.current?.close();
        operation.current = null;
        setState("Idle");
        onClosed();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      next = paperReentryOutcome(response.status, body?.error);
    } catch {
      next = "Unknown";
    }
    if (next !== "Unknown") operation.current = null;
    setState(next);
    // Another manager may have used that order, or it may have changed: read the choices again.
    if (next === "Used" || next === "Invalid" || next === "Lower") void load();
  };
  const retrying = state === "Unknown" && operation.current !== null;
  const message: Partial<Record<State, string>> = {
    Pending: t("Linking…"),
    Unknown: t("No answer from the system. Try again: it is never closed twice."),
    Recordable: t("Its payment can still be recorded on it. Record it here instead."),
    Invalid: t(
      "That order isn't a paper order sent after this one with its payment recorded. Choose another.",
    ),
    Used: t("That new order already stands for another paper order. Choose another."),
    Lower: t(
      "That new order's dishes come to less than this paper order's, so it can't carry this sale. Enter the paper slip again in full, then link that order.",
    ),
    Changed: t("This order changed. The list will update."),
    Denied: t("Only a manager or the owner links it."),
    Failed: t("Not linked. Try again."),
  };
  const id = "paper-reentry-" + order.orderReference;
  return (
    <>
      <button type="button" onClick={open}>
        {t("Link the re-entered order")}
      </button>
      <dialog
        ref={dialog}
        className="order-cancel-dialog"
        aria-labelledby={id}
        onCancel={(event) => {
          if (state === "Pending") event.preventDefault();
        }}
      >
        <h2 id={id}>
          {t("Paper order {orderNumber} was entered again", { orderNumber: order.orderNumber })}
        </h2>
        <p>
          {t(
            "Choose the new paper order this one was entered again as. This order then closes as entered again, and its sale counts once, as the new order.",
          )}
        </p>
        {choices === null ? null : (
          <p>
            {t("Paper order {orderNumber}: dishes {amount} with tax, before tip.", {
              orderNumber: choices.paperOrder.orderNumber,
              amount: orderMoney({
                amountMinor: choices.paperOrder.saleMinor,
                currencyCode: choices.paperOrder.currencyCode,
              }),
            })}
          </p>
        )}
        {read !== "Ready" || choices === null ? (
          <>
            <p role="status">
              {read === "Loading"
                ? t("Reading the new paper orders…")
                : read === "Denied"
                  ? t("Only a manager or the owner links it.")
                  : read === "Changed"
                    ? t("This order changed. The list will update.")
                    : t("No answer from the system. Try again.")}
            </p>
            <div className="card-actions">
              {read === "Unknown" ? (
                <button type="button" onClick={() => void load()}>
                  {t("Try again")}
                </button>
              ) : null}
              <button type="button" onClick={() => dialog.current?.close()}>
                {t("Close")}
              </button>
            </div>
          </>
        ) : choices.candidates.length === 0 ? (
          <>
            <p role="status">
              {t(
                "No new paper order with its payment recorded yet. Enter this one again from its paper slip as a paper order first, then link it here.",
              )}
            </p>
            <div className="card-actions">
              <button type="button" onClick={() => void load()}>
                {t("Read again")}
              </button>
              <button type="button" onClick={() => dialog.current?.close()}>
                {t("Close")}
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {/* A lost answer is retried with the same reference and order: the first try may
                have closed it already. */}
            <fieldset disabled={state === "Pending" || retrying}>
              <legend>{t("New paper order")}</legend>
              {choices.candidates.map((candidate) => (
                <label key={candidate.orderReference}>
                  <input
                    type="radio"
                    name={id + "-order"}
                    value={candidate.orderReference}
                    checked={chosen === candidate.orderReference}
                    disabled={!candidate.coversSale}
                    onChange={() => setChosen(candidate.orderReference)}
                  />
                  {t("Order {orderNumber} · sent {sentAt} · dishes {sale} · paid {paid}", {
                    orderNumber: candidate.orderNumber,
                    sentAt: storeTime(candidate.submittedAt, timeZone),
                    sale: orderMoney({
                      amountMinor: candidate.saleMinor,
                      currencyCode: choices.paperOrder.currencyCode,
                    }),
                    paid: orderMoney({
                      amountMinor: candidate.paidMinor,
                      currencyCode: choices.paperOrder.currencyCode,
                    }),
                  })}
                  {candidate.coversSale ? null : (
                    <span className="bop-muted">
                      {" "}
                      {t("Less than this paper order: it can't carry this sale.")}
                    </span>
                  )}
                </label>
              ))}
            </fieldset>
            {message[state] === undefined ? null : <p role="status">{message[state]}</p>}
            <div className="card-actions">
              <button type="submit" disabled={chosen === "" || state === "Pending"}>
                {t("Close as entered again")}
              </button>
              <button
                type="button"
                disabled={state === "Pending"}
                onClick={() => dialog.current?.close()}
              >
                {t("Keep it")}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
