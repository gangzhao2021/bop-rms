import { displayLocale, t } from "./i18n/i18n.js";
import { StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { serviceOperationReference } from "./service-control-client.js";
import { createTableQrClient, TableQrClientError, type TableQrRow } from "./table-qr-client.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";

/**
 * WP-2423 Q11 (Section 88 DIN-TABLE-LIST): the Store Manager prints each table's QR code once,
 * reprints a damaged sticker unchanged, and replaces a lost or copied code for one table without
 * reprinting the others. The old code stops admitting guests the moment it is replaced.
 */
type Load =
  | { readonly kind: "Loading" }
  | { readonly kind: "Ready"; readonly rows: readonly TableQrRow[] }
  | { readonly kind: "PermissionDenied" | "Unavailable" };
interface Pending {
  readonly action: "Issue" | "TurnOff";
  readonly table: TableQrRow;
  readonly operationReference: string;
  readonly unknown: boolean;
}
const soonDays = 30;
const day = 24 * 60 * 60 * 1000;
const date = (instant: string, timeZone: string | undefined) =>
  new Intl.DateTimeFormat(displayLocale(), {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(instant));
const codeText: Record<TableQrRow["codeState"], string> = {
  Active: t("Ready to print"),
  None: t("No code yet"),
  NotPrintable: t("No printable code"),
  TurnedOff: t("Turned off"),
  SetupIncomplete: t("Table setup not finished"),
};

export function TableQrCodesPage({
  csrf,
  storeLabel,
  timeZone,
  fetcher,
  now = () => Date.now(),
}: {
  readonly csrf: string;
  readonly storeLabel: string;
  readonly timeZone?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
  readonly now?: () => number;
}) {
  const client = useMemo(() => createTableQrClient(csrf, fetcher), [csrf, fetcher]);
  const [load, setLoad] = useState<Load>({ kind: "Loading" });
  const [pending, setPending] = useState<Pending | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "neutral" | "error"; text: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    void client
      .list(controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setLoad({ kind: "Ready", rows });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoad({
            kind:
              error instanceof TableQrClientError && error.code === "PermissionDenied"
                ? "PermissionDenied"
                : "Unavailable",
          });
      });
  }, [client]);
  useEffect(() => {
    refresh();
    return () => active.current?.abort();
  }, [refresh]);

  const rows = load.kind === "Ready" ? load.rows : [];
  const printable = rows.filter((row) => row.codeState === "Active");
  const expiring = printable.filter(
    (row) => row.validUntil !== null && Date.parse(row.validUntil) - now() < soonDays * day,
  );

  const print = async (tables: readonly TableQrRow[]) => {
    if (busy || tables.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const sheet = await client.sheet(tables.map((table) => table.tableReference));
      const url = URL.createObjectURL(new Blob([sheet.html], { type: "text/html" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = sheet.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage({
        tone: "neutral",
        text:
          t("Downloaded {fileName} with {value}. ", {
            fileName: sheet.fileName,
            value:
              tables.length === 1
                ? "the code for table " + (tables[0]?.stableLabel ?? "")
                : String(tables.length) + " table codes",
          }) + t("Open it and print at 100% scale."),
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof TableQrClientError && error.code === "Changed"
            ? t("A code changed since this page loaded. The list is refreshed; print again.")
            : error instanceof TableQrClientError && error.code === "PermissionDenied"
              ? t("You don't have permission to print table codes.")
              : t("The codes could not be downloaded. Nothing changed; try again."),
      });
      if (error instanceof TableQrClientError && error.code === "Changed") refresh();
    } finally {
      setBusy(false);
    }
  };

  const start = (action: Pending["action"], table: TableQrRow) => {
    setPending({ action, table, operationReference: serviceOperationReference(), unknown: false });
    setUnderstood(false);
    setMessage(null);
  };
  const confirm = async () => {
    if (pending === null || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const row = await client.command(pending);
      setLoad((current) =>
        current.kind === "Ready"
          ? {
              kind: "Ready",
              rows: current.rows.map((item) =>
                item.tableReference === row.tableReference ? row : item,
              ),
            }
          : current,
      );
      const replaced = pending.table.codeState === "Active";
      setPending(null);
      setMessage({
        tone: "neutral",
        text:
          pending.action === "TurnOff"
            ? t(
                "The code for table {stableLabel} is turned off. Guests who scan it are asked to see a staff member.",
                { stableLabel: row.stableLabel },
              )
            : replaced
              ? t(
                  "Table {stableLabel} has a new code. The old code no longer works. Print the new one now.",
                  { stableLabel: row.stableLabel },
                )
              : t("Table {stableLabel} has a code. Print it now.", {
                  stableLabel: row.stableLabel,
                }),
      });
    } catch (error) {
      const code = error instanceof TableQrClientError ? error.code : "Unknown";
      if (code === "Unknown") {
        setPending({ ...pending, unknown: true });
        setMessage({
          tone: "error",
          text: t(
            "We couldn't confirm whether this was done. Try again: the same request is sent, so it won't happen twice.",
          ),
        });
      } else {
        setPending(null);
        setMessage({
          tone: "error",
          text:
            code === "Changed"
              ? t(
                  "This table changed since the page loaded. The list is refreshed; check it and try again.",
                )
              : code === "PermissionDenied"
                ? t("You don't have permission to change table codes.")
                : t("Nothing changed. Try again."),
        });
        refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmation = pending ? (
    <form
      className="table-qr__confirm"
      aria-labelledby="table-qr-confirm-title"
      onSubmit={(event) => {
        event.preventDefault();
        void confirm();
      }}
    >
      <h2 id="table-qr-confirm-title">
        {pending.action === "TurnOff"
          ? t("Turn off the code for table {stableLabel}?", {
              stableLabel: pending.table.stableLabel,
            })
          : pending.table.codeState === "Active"
            ? t("Replace the code for table {stableLabel}?", {
                stableLabel: pending.table.stableLabel,
              })
            : t("Create a code for table {stableLabel}?", {
                stableLabel: pending.table.stableLabel,
              })}
      </h2>
      <p>
        {pending.action === "TurnOff"
          ? t(
              "Guests who scan this table's code will be asked to see a staff member. Use this when a table is taken out of service. You can create a new code later.",
            )
          : pending.table.codeState === "Active"
            ? t(
                "Use this when a code is lost, stolen or copied. The old code stops working at once; only this table changes. If the sticker is only damaged, print it again instead.",
              )
            : t("The new code works as soon as it is printed and placed on the table.")}
      </p>
      {pending.table.seated && pending.table.codeState === "Active" ? (
        <p className="table-qr__warning" role="note">
          {pending.action === "TurnOff"
            ? t(
                "Guests are seated at this table now. Their phones stop working with this table's code and there is no new code to scan: they ask a staff member to order or pay. Their orders and bill are not affected.",
              )
            : t(
                "Guests are seated at this table now. Their phones stop working with the old code: they scan the new code and enter the table's joining code again. Their orders and bill are not affected.",
              )}
        </p>
      ) : null}
      {pending.table.codeState === "Active" ? (
        <label>
          <input
            type="checkbox"
            checked={understood || pending.unknown}
            disabled={busy || pending.unknown}
            onChange={(event) => setUnderstood(event.currentTarget.checked)}
          />
          {pending.action === "TurnOff"
            ? t("I understand this table's code stops working")
            : t("I understand the old code stops working")}
        </label>
      ) : null}
      <div className="table-qr__confirm-actions">
        <button
          type="submit"
          disabled={
            busy || (pending.table.codeState === "Active" && !understood && !pending.unknown)
          }
        >
          {busy
            ? t("Working…")
            : pending.unknown
              ? t("Try again")
              : pending.action === "TurnOff"
                ? t("Turn off code")
                : pending.table.codeState === "Active"
                  ? t("Replace code")
                  : t("Create code")}
        </button>
        {pending.unknown ? null : (
          <button type="button" disabled={busy} onClick={() => setPending(null)}>
            {t("Cancel")}
          </button>
        )}
      </div>
    </form>
  ) : null;

  return (
    <WorkspacePage
      title={t("Table QR codes")}
      meta={storeLabel}
      actions={
        <>
          <button
            type="button"
            disabled={busy || printable.length === 0 || pending !== null}
            onClick={() => void print(printable)}
          >
            {t("Print all codes")}
          </button>
          <button type="button" disabled={busy} onClick={refresh}>
            {t("Refresh")}
          </button>
        </>
      }
    >
      <p className="table-qr__intro">
        {t(
          "Guests scan the code on their table to order and pay. Print each code once. If a sticker is damaged, print it again — the code stays the same. If a code is lost or copied, replace it: the old one stops working at once, and only that table needs a new sticker.",
        )}
      </p>
      {message ? (
        <StatePanel
          heading={message.tone === "error" ? t("Not done") : t("Done")}
          tone={message.tone}
          status
        >
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      {expiring.length > 0 ? (
        <StatePanel heading={t("Codes stop working soon")} tone="offline" status>
          <p>
            {t("{value}: {value2} working on {value3}. Replace and print {value4} before then.", {
              value: expiring.map((row) => row.stableLabel).join(", "),
              value2: expiring.length === 1 ? t("this code stops") : t("these codes stop"),
              value3: date(
                expiring
                  .flatMap((row) => (row.validUntil === null ? [] : [row.validUntil]))
                  .sort()[0] ?? "",
                timeZone,
              ),
              value4: expiring.length === 1 ? t("it") : t("them"),
            })}
          </p>
        </StatePanel>
      ) : null}
      {confirmation}
      {load.kind === "Loading" ? (
        <p role="status">{t("Loading tables…")}</p>
      ) : load.kind === "PermissionDenied" ? (
        <StatePanel heading={noAccessHeading} tone="error" status>
          <p>{pageAccessDeniedText}</p>
        </StatePanel>
      ) : load.kind === "Unavailable" ? (
        <StatePanel heading={t("Tables unavailable")} tone="error" status>
          <p>{t("Check your connection and refresh. Codes already on the tables keep working.")}</p>
        </StatePanel>
      ) : rows.length === 0 ? (
        <StatePanel heading={t("No tables")} status>
          <p>{t("This Store has no tables yet.")}</p>
        </StatePanel>
      ) : (
        <table className="table-qr__list">
          <thead>
            <tr>
              <th scope="col">{t("Table")}</th>
              <th scope="col">{t("Area")}</th>
              <th scope="col">{t("Code")}</th>
              <th scope="col">{t("Works until")}</th>
              <th scope="col" aria-label={t("Actions")} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.tableReference}>
                <th scope="row">{row.stableLabel}</th>
                <td data-label={t("Area")}>{row.areaCode}</td>
                <td data-label={t("Code")}>
                  {codeText[row.codeState]}
                  {row.seated ? t(" · Guests seated") : ""}
                </td>
                <td data-label={t("Works until")}>
                  {row.validUntil === null ? "—" : date(row.validUntil, timeZone)}
                </td>
                <td className="table-qr__actions">
                  {row.codeState === "Active" ? (
                    <>
                      <button
                        type="button"
                        disabled={busy || pending !== null}
                        onClick={() => void print([row])}
                      >
                        {t("Print")}
                      </button>
                      <button
                        type="button"
                        disabled={busy || pending !== null}
                        onClick={() => start("Issue", row)}
                      >
                        {t("Replace")}
                      </button>
                      <button
                        type="button"
                        disabled={busy || pending !== null}
                        onClick={() => start("TurnOff", row)}
                      >
                        {t("Turn off")}
                      </button>
                    </>
                  ) : row.codeState === "SetupIncomplete" ? null : (
                    <button
                      type="button"
                      disabled={busy || pending !== null}
                      onClick={() => start("Issue", row)}
                    >
                      {t("Create code")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </WorkspacePage>
  );
}
