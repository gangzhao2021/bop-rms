import { useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";
import type { StaffDiningTable } from "./dining-session-client.js";

export type TableMoveProblem =
  | "Denied"
  | "Changed"
  | "NotSeated"
  | "CheckingOut"
  | "TargetOccupied"
  | "TargetUnavailable"
  | "TargetNoCode"
  | "TargetTooSmall"
  | "Unavailable";
export class TableMoveError extends Error {
  constructor(readonly code: TableMoveProblem) {
    super("table move " + code);
    this.name = "TableMoveError";
  }
}
const problems: Readonly<Record<string, TableMoveProblem>> = {
  table_move_changed: "Changed",
  table_move_not_seated: "NotSeated",
  table_move_checking_out: "CheckingOut",
  table_move_target_occupied: "TargetOccupied",
  table_move_target_unavailable: "TargetUnavailable",
  table_move_target_no_code: "TargetNoCode",
  table_move_target_too_small: "TargetTooSmall",
};

export interface TableMoveClient {
  move(
    csrf: string,
    command: {
      readonly operationReference: string;
      readonly tableReference: string;
      readonly expectedTableVersion: number;
      readonly targetTableReference: string;
      readonly expectedTargetTableVersion: number;
    },
  ): Promise<{ readonly tableLabel: string; readonly fromTableLabel: string }>;
}

export function createTableMoveClient(fetcher: typeof fetch = fetch): TableMoveClient {
  const client: TableMoveClient = {
    async move(csrf, command) {
      let response: Response;
      try {
        response = await fetcher("/merchant/dining/table-move", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: { "content-type": "application/json", "x-bop-csrf": csrf },
          body: JSON.stringify({ action: "Move", ...command }),
        });
      } catch {
        throw new TableMoveError("Unavailable");
      }
      if (response.status === 401 || response.status === 403) throw new TableMoveError("Denied");
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.status === 409)
        throw new TableMoveError(problems[String(payload?.error)] ?? "Changed");
      if (
        !response.ok ||
        payload === null ||
        typeof payload.tableLabel !== "string" ||
        typeof payload.fromTableLabel !== "string"
      )
        throw new TableMoveError("Unavailable");
      return { tableLabel: payload.tableLabel, fromTableLabel: payload.fromTableLabel };
    },
  };
  return Object.freeze(client);
}

/** Why another table can't take the party, in staff words (null: it can). */
export function moveTargetProblem(table: StaffDiningTable): string | null {
  if (table.currentDiningSessionReference !== null)
    return t("has a party (two parties can't share a table)");
  if (table.lifecycle !== "Published" || table.operationalState !== "Available")
    return table.blockReasonCode === "CLEANING" ? t("being cleaned") : t("not in use");
  if (table.qrCodeValidUntil === null) return t("no table code");
  return null;
}

/**
 * WP-2423 item 8 ⑧ (Owner decision 3): move the party at this table to another table — one that
 * is free, in use and has a table code. Everything the party has (rounds, bill, guests, tea,
 * payments, host, shared cart) goes with it; this table then waits for cleaning. A table with a
 * party can't be chosen (joining two tables is not available yet), and each other table says why.
 */
export function TableMove({
  table,
  tables,
  csrf,
  locked,
  onMoved,
  client: provided,
}: {
  readonly table: StaffDiningTable;
  readonly tables: readonly StaffDiningTable[];
  readonly csrf: string;
  readonly locked: boolean;
  /** After a move: read the tables again (the party sits at the other table now). */
  readonly onMoved: (message: string, targetReference: string | null) => void;
  readonly client?: TableMoveClient;
}) {
  const [client] = useState(() => provided ?? createTableMoveClient());
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One reference per intended move until it is answered (a retry is recorded once).
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const others = tables
    .filter((other) => other.tableReference !== table.tableReference)
    .sort((a, b) => a.stableLabel.localeCompare(b.stableLabel, undefined, { numeric: true }));
  const chosen = others.find((other) => other.tableReference === target) ?? null;
  const move = async () => {
    if (chosen === null || busy || locked || moveTargetProblem(chosen) !== null) return;
    const key = `${table.aggregateVersion}:${chosen.tableReference}:${chosen.aggregateVersion}`;
    if (operation.current?.key !== key)
      operation.current = { key, reference: newOperationReference() };
    setBusy(true);
    setProblem(null);
    try {
      const moved = await client.move(csrf, {
        operationReference: operation.current.reference,
        tableReference: table.tableReference,
        expectedTableVersion: table.aggregateVersion,
        targetTableReference: chosen.tableReference,
        expectedTargetTableVersion: chosen.aggregateVersion,
      });
      operation.current = null;
      onMoved(
        t(
          "Moved to table {table}. Guests scan the code on table {table} to keep ordering; table {from} is marked for cleaning.",
          { table: moved.tableLabel, from: moved.fromTableLabel },
        ),
        chosen.tableReference,
      );
    } catch (error) {
      const code = error instanceof TableMoveError ? error.code : "Unavailable";
      if (code !== "Unavailable") operation.current = null;
      setProblem(
        code === "TargetOccupied"
          ? t("That table has a party now. Two parties can't share a table; choose a free one.")
          : code === "TargetUnavailable"
            ? t("That table is not free to use now (being cleaned or not in use).")
            : code === "TargetNoCode"
              ? t("That table has no table code guests can scan. Choose another table.")
              : code === "TargetTooSmall"
                ? t("That table seats fewer guests than this party. Choose a bigger table.")
                : code === "CheckingOut"
                  ? t("This table is checking out, so it stays where it is.")
                  : code === "Denied"
                    ? t("You don't have permission to move tables.")
                    : code === "Changed" || code === "NotSeated"
                      ? t("The tables changed meanwhile. They are read again: check and retry.")
                      : t("The move wasn't confirmed. Check the connection and retry."),
      );
      if (code === "Changed" || code === "NotSeated") onMoved("", null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="table-move" aria-label={t("Move this party to another table")}>
      <label className="table-move__field">
        <span>{t("Move to…")}</span>
        <select
          value={target}
          disabled={busy || locked}
          onChange={(event) => {
            setTarget(event.currentTarget.value);
            setProblem(null);
          }}
        >
          <option value="">{t("Choose a table")}</option>
          {others.map((other) => {
            const why = moveTargetProblem(other);
            return (
              <option
                key={other.tableReference}
                value={other.tableReference}
                disabled={why !== null}
              >
                {why === null
                  ? t("{table} · seats {count}", {
                      table: other.stableLabel,
                      count: String(other.capacity),
                    })
                  : t("{table} — {reason}", { table: other.stableLabel, reason: why })}
              </option>
            );
          })}
        </select>
      </label>
      <button
        type="button"
        disabled={busy || locked || chosen === null}
        onClick={() => void move()}
      >
        {busy
          ? t("Moving…")
          : chosen === null
            ? t("Move")
            : t("Move to table {table}", { table: chosen.stableLabel })}
      </button>
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
