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
  /** The party size of each of these tables (absent: none recorded). */
  readMany?(
    csrf: string,
    diningSessionReferences: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, number>>;
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
    async readMany(csrf: string, diningSessionReferences: readonly string[], signal?: AbortSignal) {
      const raw = await post(
        csrf,
        { action: "Read", diningSessionReferences: [...diningSessionReferences] },
        signal,
      );
      const entries = Array.isArray(raw.partySizes)
        ? (raw.partySizes as Record<string, unknown>[])
        : [];
      const found = new Map<string, number>();
      for (const entry of entries) {
        const value = size(entry.partySize);
        if (typeof entry.diningSessionReference === "string" && value !== null)
          found.set(entry.diningSessionReference, value);
      }
      return found;
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

/** WP-2423 item 8 ⑦ 4b-2: the table's per-head tea charge (read, or bring it to the party size). */
export interface TableTeaView {
  readonly status:
    "Charged" | "NoTeaCharge" | "PaysEachRound" | "NoPartySize" | "Paid" | "Mismatch";
  readonly charged: number;
  readonly expected: number | null;
  readonly problem: "NeedsManager" | "Unavailable" | null;
  /** The guests counted (the party size), when the server says. */
  readonly guests?: number | null;
  /** A tea count staff set for other than the guests, and why. */
  readonly override?: {
    readonly teaQuantity: number;
    readonly reason: "ChildNotCharged" | "GuestDeclined" | "Other";
  } | null;
  readonly overrideVersion?: number;
}
export type TableTeaClient = (
  csrf: string,
  command:
    | { action: "Read"; diningSessionReference: string }
    | { action: "Sync"; diningSessionReference: string; operationReference: string }
    | {
        action: "SetTeaCount";
        diningSessionReference: string;
        operationReference: string;
        expectedVersion: number;
        teaQuantity: number;
        reason: "ChildNotCharged" | "GuestDeclined" | "Other";
      },
) => Promise<TableTeaView>;
export function createTableTeaClient(fetcher: typeof fetch = fetch): TableTeaClient {
  return async (csrf, command) => {
    let response: Response;
    try {
      response = await fetcher("/merchant/dining/tea-charge", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(command),
      });
    } catch {
      throw new TablePartySizeError("Unavailable");
    }
    if (response.status === 401 || response.status === 403) throw new TablePartySizeError("Denied");
    const raw = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const statuses = ["Charged", "NoTeaCharge", "PaysEachRound", "NoPartySize", "Paid", "Mismatch"];
    if (
      !response.ok ||
      raw === null ||
      !statuses.includes(String(raw.status)) ||
      !Number.isSafeInteger(raw.charged) ||
      (raw.expected !== null && !Number.isSafeInteger(raw.expected)) ||
      (raw.problem !== null && raw.problem !== "NeedsManager" && raw.problem !== "Unavailable")
    )
      throw new TablePartySizeError("Unavailable");
    return raw as unknown as TableTeaView;
  };
}

export function TablePartySize({
  diningSessionReference,
  tableLabel,
  csrf,
  locked,
  client: provided,
  tea: providedTea,
}: {
  readonly diningSessionReference: string;
  readonly tableLabel: string;
  readonly csrf: string;
  readonly locked: boolean;
  readonly client?: TablePartySizeClient;
  readonly tea?: TableTeaClient;
}) {
  const [client] = useState(() => provided ?? createTablePartySizeClient());
  const [teaClient] = useState(() => providedTea ?? createTableTeaClient());
  const [tea, setTea] = useState<TableTeaView | null>(null);
  const [teaBusy, setTeaBusy] = useState(false);
  // One reference per sync until it is answered (a retry repeats its steps, never adds).
  const teaOperation = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    teaClient(csrf, { action: "Read", diningSessionReference })
      .then((value) => {
        if (active) setTea(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [teaClient, csrf, diningSessionReference]);
  // Staff charge tea for other than the guests (a child not charged…), with the reason.
  const [teaCount, setTeaCount] = useState<{
    quantity: string;
    reason: "ChildNotCharged" | "GuestDeclined" | "Other";
  } | null>(null);
  const saveTeaCount = async () => {
    if (teaBusy || teaCount === null || tea === null) return;
    const quantity = /^(0|[1-9][0-9]?)$/u.test(teaCount.quantity.trim())
      ? Number(teaCount.quantity.trim())
      : null;
    if (quantity === null) return;
    teaOperation.current ??= newOperationReference();
    setTeaBusy(true);
    try {
      setTea(
        await teaClient(csrf, {
          action: "SetTeaCount",
          diningSessionReference,
          operationReference: teaOperation.current,
          expectedVersion: tea.overrideVersion ?? 0,
          teaQuantity: quantity,
          reason: teaCount.reason,
        }),
      );
      teaOperation.current = null;
      setTeaCount(null);
    } catch {
      setTea((current) => (current === null ? null : { ...current, problem: "Unavailable" }));
    } finally {
      setTeaBusy(false);
    }
  };
  const syncTea = async () => {
    if (teaBusy) return;
    teaOperation.current ??= newOperationReference();
    setTeaBusy(true);
    try {
      setTea(
        await teaClient(csrf, {
          action: "Sync",
          diningSessionReference,
          operationReference: teaOperation.current,
        }),
      );
      teaOperation.current = null;
    } catch {
      setTea((current) => (current === null ? null : { ...current, problem: "Unavailable" }));
    } finally {
      setTeaBusy(false);
    }
  };
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
  // v15 live check (4a): a table just opened asks at once, with the number keyboard up.
  const firstAsk = useRef<HTMLInputElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || view === null || !view.askPartySize || view.partySize !== null) return;
    focused.current = true;
    firstAsk.current?.focus();
  }, [view]);
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
      // The tea follows the guests now counted (tables that pay at the end).
      void syncTea();
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
              ref={view.partySize === null ? firstAsk : undefined}
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
      {tea === null ||
      tea.status === "NoTeaCharge" ||
      tea.status === "PaysEachRound" ||
      tea.status === "NoPartySize" ? null : (
        <p className="table-panel__tea">
          {tea.status === "Mismatch"
            ? t("Tea on the bill: {charged} · guests: {expected}", {
                charged: tea.charged,
                expected: tea.expected ?? 0,
              })
            : t("Tea on the bill: {charged}", { charged: tea.charged })}{" "}
          {tea.status === "Mismatch" ? (
            <button type="button" disabled={teaBusy || locked} onClick={() => void syncTea()}>
              {teaBusy ? t("Saving…") : t("Match the tea to the guests")}
            </button>
          ) : null}
          {tea.override ? (
            <span className="dish-editor__note">
              {" "}
              {t("Tea for {count} instead of {guests} guests: {reason}", {
                count: tea.override.teaQuantity,
                guests: tea.guests ?? 0,
                reason:
                  tea.override.reason === "ChildNotCharged"
                    ? t("child not charged")
                    : tea.override.reason === "GuestDeclined"
                      ? t("guest declined tea")
                      : t("other reason"),
              })}
            </span>
          ) : null}{" "}
          {tea.status !== "Paid" && teaCount === null ? (
            <button
              type="button"
              className="table-panel__text-step"
              disabled={teaBusy || locked}
              onClick={() =>
                setTeaCount({
                  quantity: String(tea.expected ?? tea.charged),
                  reason: "ChildNotCharged",
                })
              }
            >
              {t("Change tea count")}
            </button>
          ) : null}
        </p>
      )}
      {teaCount !== null && tea !== null ? (
        <form
          className="table-panel__tea-count"
          onSubmit={(event) => {
            event.preventDefault();
            void saveTeaCount();
          }}
        >
          <label>
            {t("Tea to charge")}
            <input
              inputMode="numeric"
              autoComplete="off"
              value={teaCount.quantity}
              onChange={(event) =>
                setTeaCount({ ...teaCount, quantity: event.currentTarget.value })
              }
            />
          </label>
          <label>
            {t("Why")}
            <select
              value={teaCount.reason}
              onChange={(event) =>
                setTeaCount({
                  ...teaCount,
                  reason: event.currentTarget.value as
                    "ChildNotCharged" | "GuestDeclined" | "Other",
                })
              }
            >
              <option value="ChildNotCharged">{t("Child not charged")}</option>
              <option value="GuestDeclined">{t("Guest declined tea")}</option>
              <option value="Other">{t("Other reason")}</option>
            </select>
          </label>
          <button type="submit" disabled={teaBusy || locked}>
            {teaBusy ? t("Saving…") : t("Save tea count")}
          </button>
          <button type="button" disabled={teaBusy} onClick={() => setTeaCount(null)}>
            {t("Cancel")}
          </button>
        </form>
      ) : null}
      {tea?.status === "Mismatch" && tea.problem === "NeedsManager" ? (
        <p role="alert">
          {t(
            "Fewer guests than tea on the bill: a manager takes the extra tea off (it is recorded who and why).",
          )}
        </p>
      ) : tea?.status === "Mismatch" && tea.problem === "Unavailable" ? (
        <p role="alert">{t("The tea wasn't changed. Check the connection and try again.")}</p>
      ) : null}
    </section>
  );
}
