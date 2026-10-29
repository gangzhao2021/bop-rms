import { useEffect, useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 2): how many guests sit at the
 * table. Only while the Store asks for it ("Ask how many guests when opening a table"): a table
 * just opened asks at once; later it shows the number and staff change it when guests arrive or
 * leave. Each change is recorded against the number staff saw (another change first: read again).
 */
export interface TablePartySizeClient {
  read(
    csrf: string,
    diningSessionReference: string,
    signal?: AbortSignal,
  ): Promise<{ askPartySize: boolean; partySize: number | null; version: number }>;
  record(
    csrf: string,
    command: {
      diningSessionReference: string;
      operationReference: string;
      expectedVersion: number;
      partySize: number;
    },
  ): Promise<{ partySize: number; version: number }>;
}
export class TablePartySizeError extends Error {
  constructor(readonly code: "Changed" | "TableClosed" | "Denied" | "Unavailable") {
    super("party size " + code);
    this.name = "TablePartySizeError";
  }
}

const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const size = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 99
    ? (value as number)
    : null;

export function createTablePartySizeClient(fetcher: typeof fetch = fetch): TablePartySizeClient {
  const post = async (csrf: string, body: unknown, signal?: AbortSignal) => {
    let response: Response;
    try {
      response = await fetcher("/merchant/dining/party-size", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        ...(signal ? { signal } : {}),
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TablePartySizeError("Unavailable");
    }
    if (response.status === 401 || response.status === 403) throw new TablePartySizeError("Denied");
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.status === 409)
      throw new TablePartySizeError(
        payload?.error === "party_size_table_closed" ? "TableClosed" : "Changed",
      );
    if (!response.ok || payload === null) throw new TablePartySizeError("Unavailable");
    return payload;
  };
  return Object.freeze({
    async read(csrf: string, diningSessionReference: string, signal?: AbortSignal) {
      const raw = await post(
        csrf,
        { action: "Read", diningSessionReferences: [diningSessionReference] },
        signal,
      );
      const entries = raw.partySizes;
      if (typeof raw.askPartySize !== "boolean" || !Array.isArray(entries))
        throw new TablePartySizeError("Unavailable");
      const found = (entries as Record<string, unknown>[]).find(
        (entry) => entry.diningSessionReference === diningSessionReference,
      );
      if (
        found !== undefined &&
        (size(found.partySize) === null || !Number.isSafeInteger(found.version))
      )
        throw new TablePartySizeError("Unavailable");
      return {
        askPartySize: raw.askPartySize,
        partySize: found === undefined ? null : (found.partySize as number),
        version: found === undefined ? 0 : (found.version as number),
      };
    },
    async record(csrf: string, command: Parameters<TablePartySizeClient["record"]>[1]) {
      if (!reference.test(command.diningSessionReference))
        throw new TablePartySizeError("Unavailable");
      const raw = await post(csrf, { action: "Record", ...command });
      const partySize = size(raw.partySize);
      if (partySize === null || !Number.isSafeInteger(raw.version))
        throw new TablePartySizeError("Unavailable");
      return { partySize, version: raw.version as number };
    },
  });
}

export function TablePartySize({
  diningSessionReference,
  tableLabel,
  csrf,
  locked,
  client: provided,
}: {
  readonly diningSessionReference: string;
  readonly tableLabel: string;
  readonly csrf: string;
  readonly locked: boolean;
  readonly client?: TablePartySizeClient;
}) {
  const [client] = useState(() => provided ?? createTablePartySizeClient());
  const [view, setView] = useState<{
    askPartySize: boolean;
    partySize: number | null;
    version: number;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Reading the number, and saving it, fail apart: a re-read keeps why a save didn't go through.
  const [readProblem, setReadProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // One reference per intended number, kept until it is answered (a retry is recorded once).
  const operation = useRef<{ key: string; reference: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    client
      .read(csrf, diningSessionReference, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setView(value);
        setReadProblem(null);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setReadProblem(t("The number of guests could not be read. Check the connection."));
      });
    return () => controller.abort();
  }, [client, csrf, diningSessionReference, reload]);

  if (view === null)
    return readProblem ? (
      <p className="table-panel__notice" role="alert">
        {readProblem}{" "}
        <button type="button" onClick={() => setReload((value) => value + 1)}>
          {t("Try again")}
        </button>
      </p>
    ) : null;
  // The Store doesn't ask: nothing to show (a number recorded earlier is still kept).
  if (!view.askPartySize && view.partySize === null) return null;
  const asking = view.partySize === null || editing;
  const typed = /^[1-9][0-9]?$/u.test(draft.trim()) ? Number(draft.trim()) : null;
  const save = async () => {
    if (typed === null || busy || locked) return;
    const key = `${view.version}:${typed}`;
    if (operation.current?.key !== key)
      operation.current = { key, reference: newOperationReference() };
    setBusy(true);
    setProblem(null);
    try {
      const saved = await client.record(csrf, {
        diningSessionReference,
        operationReference: operation.current.reference,
        expectedVersion: view.version,
        partySize: typed,
      });
      operation.current = null;
      setView({ ...view, ...saved });
      setEditing(false);
      setDraft("");
    } catch (error) {
      const code = error instanceof TablePartySizeError ? error.code : "Unavailable";
      if (code !== "Unavailable") operation.current = null;
      setProblem(
        code === "Changed"
          ? t("Someone else changed the number of guests. It has been read again: check it.")
          : code === "TableClosed"
            ? t("This table is closed, so the number of guests can't change.")
            : code === "Denied"
              ? t("Your access doesn't allow this. Ask a manager.")
              : t("The number of guests wasn't saved. Check the connection and save again."),
      );
      if (code === "Changed") {
        // The number now recorded is shown; staff change it again from there.
        setEditing(false);
        setDraft("");
        setReload((value) => value + 1);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="table-panel__party" aria-label={t("Guests at this table")}>
      {asking ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            {view.partySize === null
              ? t("How many guests at table {table}?", { table: tableLabel })
              : t("Number of guests")}
            <input
              inputMode="numeric"
              autoComplete="off"
              value={draft}
              disabled={busy || locked}
              aria-invalid={draft !== "" && typed === null}
              onChange={(event) => {
                operation.current = null;
                setDraft(event.currentTarget.value);
              }}
            />
          </label>
          <button type="submit" disabled={busy || locked || typed === null}>
            {busy ? t("Saving…") : t("Save")}
          </button>
          {editing ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraft("");
              }}
            >
              {t("Cancel")}
            </button>
          ) : null}
        </form>
      ) : (
        <p>
          {view.partySize === 1
            ? t("1 guest")
            : t("{count} guests", { count: view.partySize ?? 0 })}{" "}
          <button
            type="button"
            className="table-panel__text-step"
            disabled={locked}
            onClick={() => {
              setDraft(String(view.partySize));
              setEditing(true);
            }}
          >
            {t("Change")}
          </button>
        </p>
      )}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
