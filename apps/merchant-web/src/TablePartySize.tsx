import { useEffect, useRef, useState } from "react";
import { t, saidTable } from "./i18n/i18n.js";
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
  constructor(
    /** Offline: the request never left this device. Unavailable: the system answered it is busy. */
    readonly code: "Changed" | "TableClosed" | "Denied" | "Offline" | "Unavailable",
  ) {
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
      throw new TablePartySizeError("Offline");
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
  readonly problem:
    | "NeedsManager"
    | "CheckingOut"
    | "AlreadyServed"
    | "Changed"
    | "NotAddedBack"
    | "Unavailable"
    | null;
  /** The guests counted (the party size), when the server says. */
  readonly guests?: number | null;
  /** A tea count staff set for other than the guests, and why. */
  readonly override?: {
    readonly teaQuantity: number;
    readonly reason: "ChildNotCharged" | "GuestDeclined" | "Other";
  } | null;
  readonly overrideVersion?: number;
  /** How a settled bill closed: guests paid, or it was recorded as left without paying. */
  readonly settledBy?: "Paid" | "WrittenOff" | null;
  /** The item the Store charges per head, in the staff member's language. */
  readonly itemName?: string | null;
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
      throw new TablePartySizeError("Offline");
    }
    if (response.status === 401 || response.status === 403) throw new TablePartySizeError("Denied");
    const raw = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    // Someone else set the count first: not a busy system, so staff are told to check it.
    if (response.status === 409) throw new TablePartySizeError("Changed");
    const statuses = ["Charged", "NoTeaCharge", "PaysEachRound", "NoPartySize", "Paid", "Mismatch"];
    if (
      !response.ok ||
      raw === null ||
      !statuses.includes(String(raw.status)) ||
      !Number.isSafeInteger(raw.charged) ||
      (raw.expected !== null && !Number.isSafeInteger(raw.expected)) ||
      (raw.settledBy !== undefined &&
        raw.settledBy !== null &&
        raw.settledBy !== "Paid" &&
        raw.settledBy !== "WrittenOff") ||
      (raw.problem !== null &&
        ![
          "NeedsManager",
          "CheckingOut",
          "AlreadyServed",
          "Changed",
          "NotAddedBack",
          "Unavailable",
        ].includes(String(raw.problem)))
    )
      throw new TablePartySizeError("Unavailable");
    return raw as unknown as TableTeaView;
  };
}

/** Why the charge on the bill isn't known to be right: the request never left, or the system is busy. */
export type TableTeaFailure = "Offline" | "Unavailable";
type TeaProblem = TableTeaFailure | "Denied" | "Changed" | "TableClosed";
function teaProblemOf(error: unknown): TeaProblem {
  return error instanceof TablePartySizeError ? error.code : "Unavailable";
}
/**
 * The Store charges this table per head (any answer but "no per-head charge"). Only then is a
 * failure said: a Store that never charges per head is never warned about a charge it doesn't have.
 */
export function chargesPerHead(tea: TableTeaView | null): tea is TableTeaView {
  return tea !== null && tea.status !== "NoTeaCharge";
}
/** The per-head item's own name on every line: a hotpot's sauce is not tea. */
export function teaItemName(tea: TableTeaView | null): string {
  return tea?.itemName ?? t("Per-head charge");
}
/** Said wherever the charge can't be confirmed: it is money, so it never goes quiet. */
export function teaNotConfirmed(tea: TableTeaView | null, failure: TableTeaFailure): string {
  return failure === "Offline"
    ? t("{item} on the bill isn't confirmed: this device is offline. Match it once it's back.", {
        item: teaItemName(tea),
      })
    : t("{item} on the bill isn't confirmed: the system is busy. Try again in a moment.", {
        item: teaItemName(tea),
      });
}
/** Inside a sentence the item's own name, or plain words when the server didn't give one. */
function matchLabel(tea: TableTeaView | null): string {
  return tea?.itemName
    ? t("Match {item} to the guests", { item: tea.itemName })
    : t("Match the per-head charge to the guests");
}
function needsManagerLabel(tea: TableTeaView | null): string {
  return tea?.itemName
    ? t(
        "Fewer guests than {item} on the bill: a manager takes the extra off (it is recorded who and why).",
        { item: tea.itemName },
      )
    : t(
        "Fewer guests than per-head charges on the bill: a manager takes the extra off (it is recorded who and why).",
      );
}
/**
 * M29: why the charge could not be matched, in staff words, for a refusal that is not "a manager
 * takes it off" or a busy system. Null for those (said by their own lines).
 */
export function teaRefusalText(tea: TableTeaView | null): string | null {
  if (tea === null || tea.status !== "Mismatch") return null;
  const item = teaItemName(tea);
  if (tea.problem === "CheckingOut")
    return t("The bill is being paid, so {item} can't change now.", { item });
  if (tea.problem === "AlreadyServed")
    return t("{item} is already served for {count} guests. To charge fewer, comp the extra.", {
      item,
      count: String(tea.charged),
    });
  if (tea.problem === "Changed") return t("Someone else changed the guest count. Check it again.");
  // M28: the change took the charge off and could not put it back; the bill charges fewer now.
  if (tea.problem === "NotAddedBack")
    return t(
      "{item} was taken off but could not be added back: {charged} charged, {expected} wanted. Try again.",
      { item, charged: String(tea.charged), expected: String(tea.expected ?? 0) },
    );
  return null;
}
/**
 * M29 (v15 batch 5): a settled table's guest count can still be corrected, for the day's guest
 * numbers, but its bill stays as settled. Said whenever the count and the charge differ, so a
 * change never looks as if the bill followed it, and worded for what actually happened: a refund
 * only when guests paid and the count went down; an extra guest's charge is not on the bill; a
 * written-off table took no money, so nothing is refunded.
 */
export function teaPaidText(tea: TableTeaView | null): string | null {
  if (tea === null || tea.status !== "Paid" || tea.expected === null) return null;
  if (tea.expected === tea.charged) return null;
  const words = { item: teaItemName(tea), charged: String(tea.charged) };
  if (tea.settledBy === "WrittenOff")
    return t(
      "This table was recorded as left without paying, so {item} on the bill stays at {charged}. Nothing is charged or refunded for the change.",
      words,
    );
  if (tea.settledBy !== "Paid")
    return t("This table's bill is settled, so {item} on the bill stays at {charged}.", words);
  return tea.expected < tea.charged
    ? t(
        "This table has paid, so {item} on the bill stays at {charged}. If a guest should get money back, a manager refunds it on the order.",
        words,
      )
    : t(
        "This table has paid, so {item} on the bill stays at {charged} and the extra guests' {item} isn't charged. To charge it, take a new order for it.",
        words,
      );
}
// A read that fails is tried again quietly, sooner at first (a busy moment passes).
const teaReadRetryMs = (attempt: number) => (attempt < 6 ? 5_000 : 15_000);
/**
 * The table's per-head charge as staff see it: read when the panel opens (a busy moment is read
 * once more at once, then again every few seconds until it answers), and matched to the guests from
 * here. A failure is said once the Store is known to charge per head, with the way to match it; a
 * change that is refused says why, and the charge is read again so the next try carries what is
 * there now.
 */
function useTableTea(
  client: TableTeaClient,
  csrf: string,
  diningSessionReference: string,
  revision: number,
  onChanged: (() => void) | undefined,
) {
  const [tea, setTea] = useState<TableTeaView | null>(null);
  // Where it failed: a read that answers clears its own failure, never a change's (a sync that
  // didn't go through stays said until one does).
  const [failure, setFailure] = useState<{
    kind: TableTeaFailure;
    from: "Read" | "Change";
  } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reread, setReread] = useState(0);
  // One reference per sync until it is answered (a retry repeats its steps, never adds).
  const operation = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => client(csrf, { action: "Read", diningSessionReference });
    const attempt = (count: number) => {
      read()
        .catch((error: unknown) => {
          if (count > 0 || teaProblemOf(error) !== "Unavailable") throw error;
          return read();
        })
        .then((value) => {
          if (!active) return;
          setTea(value);
          setFailure((now) => (now?.from === "Read" ? null : now));
        })
        .catch((error: unknown) => {
          if (!active) return;
          const problem = teaProblemOf(error);
          if (problem !== "Offline" && problem !== "Unavailable") return;
          setFailure((now) => (now?.from === "Change" ? now : { kind: problem, from: "Read" }));
          timer = setTimeout(() => attempt(count + 1), teaReadRetryMs(count));
        });
    };
    attempt(0);
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, csrf, diningSessionReference, revision, reread]);
  const change = async (
    command: (operationReference: string) => Parameters<TableTeaClient>[1],
  ): Promise<"Saved" | "Changed" | "Failed"> => {
    if (busy) return "Failed";
    operation.current ??= newOperationReference();
    setBusy(true);
    setRefused(null);
    try {
      const next = await client(csrf, command(operation.current));
      operation.current = null;
      setTea(next);
      setFailure(null);
      setRefused(null);
      onChanged?.();
      return "Saved";
    } catch (error) {
      const problem = teaProblemOf(error);
      if (problem === "Offline" || problem === "Unavailable") {
        // The same reference again: a reply lost on the way is not charged twice.
        setFailure({ kind: problem, from: "Change" });
        setRefused(null);
      } else {
        operation.current = null;
        setRefused(
          problem === "Changed"
            ? t(
                "Someone else changed the per-head count on this table. It has been read again: check it.",
              )
            : problem === "TableClosed"
              ? t("This table is closed, so the per-head charge can't change.")
              : t(
                  "This wasn't saved: your access doesn't allow it, or you have been signed out. Sign in again or ask a manager.",
                ),
        );
      }
      // Read what is there now, so the next try carries the current count.
      setReread((value) => value + 1);
      return problem === "Changed" ? "Changed" : "Failed";
    } finally {
      setBusy(false);
    }
  };
  const sync = () =>
    change((operationReference) => ({
      action: "Sync",
      diningSessionReference,
      operationReference,
    }));
  // Said only where the Store is known to charge per head (a busy read of a Store without one stays quiet).
  const unconfirmed: TableTeaFailure | null = !chargesPerHead(tea)
    ? null
    : (failure?.kind ??
      (tea.status === "Mismatch" && tea.problem === "Unavailable" ? "Unavailable" : null));
  return { tea, unconfirmed, refused, busy, change, sync };
}

/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE: where the money is taken. Once a table has an order its guests
 * panel sits inside "Manage this table", so a short charge would pay and leave with nobody seeing
 * it. Directly above the payment: the charge when it doesn't match the guests, or when it can't be
 * confirmed, with the way to match it. No dialog and no block on paying, and it is never added by
 * itself here, because staff may have taken it off on purpose.
 */
export function TableTeaCheck({
  diningSessionReference,
  csrf,
  locked,
  client: provided,
  revision = 0,
  onChanged,
}: {
  readonly diningSessionReference: string;
  readonly csrf: string;
  readonly locked: boolean;
  readonly client?: TableTeaClient;
  readonly revision?: number;
  readonly onChanged?: () => void;
}) {
  const [client] = useState(() => provided ?? createTableTeaClient());
  const { tea, unconfirmed, refused, busy, sync } = useTableTea(
    client,
    csrf,
    diningSessionReference,
    revision,
    onChanged,
  );
  if (unconfirmed === null && refused === null && tea?.status !== "Mismatch") return null;
  return (
    <section className="table-panel__tea-check" aria-label={teaItemName(tea)}>
      {tea?.status === "Mismatch" ? (
        <p className="table-panel__tea">
          {t("{item} on the bill: {charged} · guests: {expected}", {
            item: teaItemName(tea),
            charged: tea.charged,
            expected: tea.expected ?? 0,
          })}{" "}
          <button type="button" disabled={busy || locked} onClick={() => void sync()}>
            {busy ? t("Saving…") : matchLabel(tea)}
          </button>
        </p>
      ) : null}
      {refused !== null ? <p role="alert">{refused}</p> : null}
      {unconfirmed !== null ? (
        <p role="alert">
          {teaNotConfirmed(tea, unconfirmed)}{" "}
          {tea?.status === "Mismatch" ? null : (
            <button type="button" disabled={busy || locked} onClick={() => void sync()}>
              {busy ? t("Saving…") : matchLabel(tea)}
            </button>
          )}
        </p>
      ) : tea?.problem === "NeedsManager" ? (
        <p role="alert">{needsManagerLabel(tea)}</p>
      ) : teaRefusalText(tea) !== null ? (
        <p role="alert">{teaRefusalText(tea)}</p>
      ) : null}
    </section>
  );
}

export function TablePartySize({
  diningSessionReference,
  tableLabel,
  csrf,
  locked,
  client: provided,
  tea: providedTea,
  onRecorded,
  teaRevision = 0,
  onTeaChanged,
}: {
  readonly diningSessionReference: string;
  readonly tableLabel: string;
  readonly csrf: string;
  readonly locked: boolean;
  readonly client?: TablePartySizeClient;
  readonly tea?: TableTeaClient;
  /** v15 2026-10-29: the number just recorded, so the table list shows it without a reload. */
  readonly onRecorded?: (partySize: number) => void;
  /** The charge was changed elsewhere on this table's panel: read it again. */
  readonly teaRevision?: number;
  readonly onTeaChanged?: () => void;
}) {
  const [client] = useState(() => provided ?? createTablePartySizeClient());
  const [teaClient] = useState(() => providedTea ?? createTableTeaClient());
  const {
    tea,
    unconfirmed: teaUnconfirmed,
    refused: teaRefused,
    busy: teaBusy,
    change: changeTea,
    sync: syncTea,
  } = useTableTea(teaClient, csrf, diningSessionReference, teaRevision, onTeaChanged);
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
    const outcome = await changeTea((operationReference) => ({
      action: "SetTeaCount",
      diningSessionReference,
      operationReference,
      expectedVersion: tea.overrideVersion ?? 0,
      teaQuantity: quantity,
      reason: teaCount.reason,
    }));
    // Saved, or someone else's count is there now (read again): the form closes on what is current.
    if (outcome !== "Failed") setTeaCount(null);
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
  // WP-2423 live minor 0: the guests just saved, while the per-head charge follows them (the bill
  // still shows the old count until Sync answers, which takes seconds under load).
  const [teaSyncing, setTeaSyncing] = useState<number | null>(null);
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
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setReadProblem(
            error instanceof TablePartySizeError && error.code === "Offline"
              ? t("The number of guests could not be read: this device is offline.")
              : t("The number of guests could not be read: the system is busy."),
          );
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
      onRecorded?.(saved.partySize);
      // The tea follows the guests now counted (tables that pay at the end); until it has, the
      // old count is not shown as what is on the bill.
      setTeaSyncing(saved.partySize);
      void syncTea().finally(() => setTeaSyncing(null));
      setEditing(false);
      setDraft("");
    } catch (error) {
      const code = error instanceof TablePartySizeError ? error.code : "Unavailable";
      if (code !== "Unavailable" && code !== "Offline") operation.current = null;
      setProblem(
        code === "Changed"
          ? t("Someone else changed the number of guests. It has been read again: check it.")
          : code === "TableClosed"
            ? t("This table is closed, so the number of guests can't change.")
            : code === "Denied"
              ? t("Your access doesn't allow this. Ask a manager.")
              : code === "Offline"
                ? t("The number of guests wasn't saved: this device is offline. Save again.")
                : t("The number of guests wasn't saved: the system is busy. Save again."),
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
              ? t("How many guests at table {table}?", { table: saidTable(tableLabel) })
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
      tea.status === "NoPartySize" ? null : teaSyncing !== null ? (
        <p className="table-panel__tea" role="status">
          {t("Updating {item} on the bill for {count} guests…", {
            item: teaItemName(tea),
            count: teaSyncing,
          })}
        </p>
      ) : (
        <p className="table-panel__tea">
          {tea.status === "Mismatch" || teaPaidText(tea) !== null
            ? t("{item} on the bill: {charged} · guests: {expected}", {
                item: teaItemName(tea),
                charged: tea.charged,
                expected: tea.expected ?? 0,
              })
            : t("{item} on the bill: {charged}", {
                item: teaItemName(tea),
                charged: tea.charged,
              })}{" "}
          {tea.status === "Mismatch" ? (
            <button type="button" disabled={teaBusy || locked} onClick={() => void syncTea()}>
              {teaBusy ? t("Saving…") : matchLabel(tea)}
            </button>
          ) : null}
          {tea.override ? (
            <span className="dish-editor__note">
              {" "}
              {t("{item} for {count} instead of {guests} guests: {reason}", {
                item: teaItemName(tea),
                count: tea.override.teaQuantity,
                guests: tea.guests ?? 0,
                reason:
                  tea.override.reason === "ChildNotCharged"
                    ? t("child not charged")
                    : tea.override.reason === "GuestDeclined"
                      ? t("guest declined it")
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
              {tea.itemName
                ? t("Change {item} count", { item: tea.itemName })
                : t("Change the per-head count")}
            </button>
          ) : null}
        </p>
      )}
      {teaCount !== null && tea !== null && teaSyncing === null ? (
        <form
          className="table-panel__tea-count"
          onSubmit={(event) => {
            event.preventDefault();
            void saveTeaCount();
          }}
        >
          <label>
            {t("{item} to charge", { item: teaItemName(tea) })}
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
              <option value="GuestDeclined">{t("Guest declined it")}</option>
              <option value="Other">{t("Other reason")}</option>
            </select>
          </label>
          <button type="submit" disabled={teaBusy || locked}>
            {teaBusy
              ? t("Saving…")
              : tea.itemName
                ? t("Save {item} count", { item: tea.itemName })
                : t("Save the per-head count")}
          </button>
          <button type="button" disabled={teaBusy} onClick={() => setTeaCount(null)}>
            {t("Cancel")}
          </button>
        </form>
      ) : null}
      {teaSyncing !== null ? null : tea?.status === "Mismatch" && tea.problem === "NeedsManager" ? (
        <p role="alert">{needsManagerLabel(tea)}</p>
      ) : teaRefusalText(tea) !== null ? (
        <p role="alert">{teaRefusalText(tea)}</p>
      ) : teaPaidText(tea) !== null ? (
        <p role="status">{teaPaidText(tea)}</p>
      ) : teaUnconfirmed !== null ? (
        <p role="alert">
          {teaNotConfirmed(tea, teaUnconfirmed)}{" "}
          {tea?.status === "Mismatch" ? null : (
            <button type="button" disabled={teaBusy || locked} onClick={() => void syncTea()}>
              {teaBusy ? t("Saving…") : matchLabel(tea)}
            </button>
          )}
        </p>
      ) : null}
      {teaRefused !== null ? <p role="alert">{teaRefused}</p> : null}
    </section>
  );
}
