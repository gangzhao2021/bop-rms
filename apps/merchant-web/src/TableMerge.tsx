import { useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";
import type { StaffDiningTable } from "./dining-session-client.js";
import { createTableTeaClient, type TableTeaClient } from "./TablePartySize.js";

export type TableMergeProblem =
  | "Denied"
  | "Changed"
  | "NotSeated"
  | "PaysEachRound"
  | "CheckingOut"
  | "PaymentStarted"
  | "TargetNotOrdered"
  | "UnsentCart"
  | "TooManyGuests"
  | "Unavailable";
export class TableMergeError extends Error {
  constructor(readonly code: TableMergeProblem) {
    super("table merge " + code);
    this.name = "TableMergeError";
  }
}
const problems: Readonly<Record<string, TableMergeProblem>> = {
  table_merge_changed: "Changed",
  table_merge_not_seated: "NotSeated",
  table_merge_pays_each_round: "PaysEachRound",
  table_merge_checking_out: "CheckingOut",
  table_merge_payment_started: "PaymentStarted",
  table_merge_target_not_ordered: "TargetNotOrdered",
  table_merge_unsent_cart: "UnsentCart",
  table_merge_too_many_guests: "TooManyGuests",
};

export interface TableMergeClient {
  merge(
    csrf: string,
    command: {
      readonly operationReference: string;
      readonly tableReference: string;
      readonly expectedTableVersion: number;
      readonly targetTableReference: string;
      readonly expectedTargetTableVersion: number;
    },
  ): Promise<{
    readonly diningSessionReference: string;
    readonly tableLabel: string;
    readonly fromTableLabel: string;
    readonly partySize: number;
  }>;
}

export function createTableMergeClient(fetcher: typeof fetch = fetch): TableMergeClient {
  const client: TableMergeClient = {
    async merge(csrf, command) {
      let response: Response;
      try {
        response = await fetcher("/merchant/dining/table-merge", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: { "content-type": "application/json", "x-bop-csrf": csrf },
          body: JSON.stringify({ action: "Merge", ...command }),
        });
      } catch {
        throw new TableMergeError("Unavailable");
      }
      if (response.status === 401 || response.status === 403) throw new TableMergeError("Denied");
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.status === 409)
        throw new TableMergeError(problems[String(payload?.error)] ?? "Changed");
      if (
        !response.ok ||
        payload === null ||
        typeof payload.diningSessionReference !== "string" ||
        typeof payload.tableLabel !== "string" ||
        typeof payload.fromTableLabel !== "string" ||
        typeof payload.partySize !== "number"
      )
        throw new TableMergeError("Unavailable");
      return {
        diningSessionReference: payload.diningSessionReference,
        tableLabel: payload.tableLabel,
        fromTableLabel: payload.fromTableLabel,
        partySize: payload.partySize,
      };
    },
  };
  return Object.freeze(client);
}

/** Why this table can't be merged into another now, in staff words (null: it can). */
export function mergeSourceProblem(table: StaffDiningTable): string | null {
  if (table.paymentTiming !== "PayLater") return t("this table pays for each round");
  if (table.session?.phase === "Closing") return t("this table is checking out");
  if (table.session?.paymentStarted === true)
    return t("something on this table's bill was paid or split");
  return null;
}

/** Why the party can't be merged into another table, in staff words (null: it can). */
export function mergeTargetProblem(
  table: StaffDiningTable,
  other: StaffDiningTable,
): string | null {
  const session = other.session;
  if (other.currentDiningSessionReference === null || session === null || session === undefined)
    return t("no party");
  if (other.paymentTiming !== "PayLater") return t("pays for each round");
  if (session.phase === "Closing") return t("checking out");
  if (session.paymentStarted === true) return t("paid or split already");
  if (table.session?.orderReference != null && session.orderReference === null)
    return t("hasn't ordered yet (merge it into this table instead)");
  return null;
}

/**
 * WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): merge the party at this table into the party seated
 * at another — both pay at the end, still ordering, nothing paid or split. Its rounds, bill and
 * guests join that table (the tea follows the guests); this table then waits for cleaning and its
 * phones scan the other table's code. Each other table says why it can't be chosen. There is no
 * un-merge: a table merged by mistake pays its own rounds with "Each pays own rounds".
 */
export function TableMerge({
  table,
  tables,
  csrf,
  locked,
  onMerged,
  client: provided,
  tea: providedTea,
}: {
  readonly table: StaffDiningTable;
  readonly tables: readonly StaffDiningTable[];
  readonly csrf: string;
  readonly locked: boolean;
  /** After a merge: read the tables again (the guests are at the other table now). */
  readonly onMerged: (message: string, targetReference: string | null) => void;
  readonly client?: TableMergeClient;
  readonly tea?: TableTeaClient;
}) {
  const [client] = useState(() => provided ?? createTableMergeClient());
  const [tea] = useState(() => providedTea ?? createTableTeaClient());
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One reference per intended merge until it is answered (a retry is recorded once).
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const blocked = mergeSourceProblem(table);
  const others = tables
    .filter(
      (other) =>
        other.tableReference !== table.tableReference &&
        other.currentDiningSessionReference !== null,
    )
    .sort((a, b) => a.stableLabel.localeCompare(b.stableLabel, undefined, { numeric: true }));
  const chosen = others.find((other) => other.tableReference === target) ?? null;
  const merge = async () => {
    if (chosen === null || busy || locked || blocked !== null) return;
    if (mergeTargetProblem(table, chosen) !== null) return;
    const key = `${table.aggregateVersion}:${chosen.tableReference}:${chosen.aggregateVersion}`;
    if (operation.current?.key !== key)
      operation.current = { key, reference: newOperationReference() };
    setBusy(true);
    setProblem(null);
    try {
      const merged = await client.merge(csrf, {
        operationReference: operation.current.reference,
        tableReference: table.tableReference,
        expectedTableVersion: table.aggregateVersion,
        targetTableReference: chosen.tableReference,
        expectedTargetTableVersion: chosen.aggregateVersion,
      });
      operation.current = null;
      // The tea follows the guests now at the table (the same sync as a party size change).
      await tea(csrf, {
        action: "Sync",
        diningSessionReference: merged.diningSessionReference,
        operationReference: newOperationReference(),
      }).catch(() => null);
      onMerged(
        t(
          "Merged into table {table}: {count} guests. Phones from table {from} scan the code on table {table} to keep ordering; table {from} is marked for cleaning.",
          {
            table: merged.tableLabel,
            from: merged.fromTableLabel,
            count: String(merged.partySize),
          },
        ),
        chosen.tableReference,
      );
    } catch (error) {
      const code = error instanceof TableMergeError ? error.code : "Unavailable";
      if (code !== "Unavailable") operation.current = null;
      setProblem(
        code === "PaymentStarted"
          ? t("Something on one of the bills was paid or split. Those tables can't be merged.")
          : code === "TargetNotOrdered"
            ? t("That table hasn't ordered yet. Merge that table into this one instead.")
            : code === "UnsentCart"
              ? t(
                  "This table's guests have dishes in their cart they haven't sent. Ask them to send or clear the cart first.",
                )
              : code === "TooManyGuests"
                ? t("Together the parties would be more than 99 guests.")
                : code === "PaysEachRound"
                  ? t("Only tables that pay at the end can be merged.")
                  : code === "CheckingOut"
                    ? t("One of the tables is checking out. Merge before checking out.")
                    : code === "Denied"
                      ? t("You don't have permission to merge tables.")
                      : code === "Changed" || code === "NotSeated"
                        ? t("The tables changed meanwhile. They are read again: check and retry.")
                        : t("The merge wasn't confirmed. Check the connection and retry."),
      );
      if (code === "Changed" || code === "NotSeated") onMerged("", null);
    } finally {
      setBusy(false);
    }
  };
  if (others.length === 0) return null;
  return (
    <section className="table-move" aria-label={t("Merge this party into another table")}>
      {blocked !== null ? (
        <p className="table-move__note">
          {t("Merging isn't available: {reason}.", { reason: blocked })}
        </p>
      ) : (
        <>
          <label className="table-move__field">
            <span>{t("Merge into…")}</span>
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
                const why = mergeTargetProblem(table, other);
                return (
                  <option
                    key={other.tableReference}
                    value={other.tableReference}
                    disabled={why !== null}
                  >
                    {why === null
                      ? other.stableLabel
                      : t("{table} — {reason}", { table: other.stableLabel, reason: why })}
                  </option>
                );
              })}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || locked || chosen === null}
            onClick={() => void merge()}
          >
            {busy
              ? t("Merging…")
              : chosen === null
                ? t("Merge")
                : t("Merge into table {table}", { table: chosen.stableLabel })}
          </button>
        </>
      )}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
