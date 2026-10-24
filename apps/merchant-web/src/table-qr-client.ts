/**
 * WP-2423 Q11 (DIN-TABLE-LIST): table QR codes — list, issue/replace, turn off and the printable
 * sheet. Strict readers; nothing from the server is trusted beyond the fields named here.
 */
export class TableQrClientError extends Error {
  constructor(readonly code: "PermissionDenied" | "Changed" | "Unavailable" | "Unknown") {
    super(code);
    this.name = "TableQrClientError";
  }
}
export type TableQrCodeState = "SetupIncomplete" | "None" | "Active" | "NotPrintable" | "TurnedOff";
export interface TableQrRow {
  readonly tableReference: string;
  readonly stableLabel: string;
  readonly areaCode: string;
  readonly aggregateVersion: number;
  readonly seated: boolean;
  readonly codeState: TableQrCodeState;
  readonly issuedAt: string | null;
  readonly validUntil: string | null;
}
const states: readonly TableQrCodeState[] = [
  "SetupIncomplete",
  "None",
  "Active",
  "NotPrintable",
  "TurnedOff",
];
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new TableQrClientError("Unavailable");
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
const text = (value: unknown, maximum = 120) =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= maximum &&
  !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    ? value
    : fail();
const optionalInstant = (value: unknown) =>
  value === null ? null : typeof value === "string" && instant.test(value) ? value : fail();

export function parseTableQrRow(value: unknown): TableQrRow {
  const raw = record(value);
  if (
    typeof raw.tableReference !== "string" ||
    !reference.test(raw.tableReference) ||
    typeof raw.aggregateVersion !== "number" ||
    !Number.isSafeInteger(raw.aggregateVersion) ||
    raw.aggregateVersion < 1 ||
    typeof raw.seated !== "boolean" ||
    !states.includes(raw.codeState as TableQrCodeState)
  )
    return fail();
  const issuedAt = optionalInstant(raw.issuedAt),
    validUntil = optionalInstant(raw.validUntil);
  if ((raw.codeState === "Active") !== (issuedAt !== null && validUntil !== null)) return fail();
  return Object.freeze({
    tableReference: raw.tableReference,
    stableLabel: text(raw.stableLabel),
    areaCode: text(raw.areaCode, 64),
    aggregateVersion: raw.aggregateVersion,
    seated: raw.seated,
    codeState: raw.codeState as TableQrCodeState,
    issuedAt,
    validUntil,
  });
}

export function createTableQrClient(csrf: string, fetcher: typeof fetch = fetch) {
  const send = async (
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    mutation: boolean,
    maximum = 200_000,
  ) => {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        ...(signal ? { signal } : {}),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TableQrClientError(mutation ? "Unknown" : "Unavailable");
    }
    if (response.status === 401 || response.status === 403)
      throw new TableQrClientError("PermissionDenied");
    if (response.status === 409) throw new TableQrClientError("Changed");
    if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json"))
      throw new TableQrClientError(mutation && response.status >= 500 ? "Unknown" : "Unavailable");
    try {
      const value = await response.text();
      if (value.length > maximum) return fail();
      return record(JSON.parse(value));
    } catch {
      throw new TableQrClientError(mutation ? "Unknown" : "Unavailable");
    }
  };
  return Object.freeze({
    async list(signal?: AbortSignal): Promise<readonly TableQrRow[]> {
      const data = await send("/merchant/dining/table-qr", {}, signal, false);
      if (!Array.isArray(data.items) || data.items.length > 500) return fail();
      return Object.freeze(data.items.map(parseTableQrRow));
    },
    async command(input: {
      readonly action: "Issue" | "TurnOff";
      readonly table: TableQrRow;
      readonly operationReference: string;
    }): Promise<TableQrRow> {
      const data = await send(
        "/merchant/dining/table-qr/command",
        {
          action: input.action,
          tableReference: input.table.tableReference,
          expectedAggregateVersion: input.table.aggregateVersion,
          operationReference: input.operationReference,
        },
        undefined,
        true,
      );
      if (data.status !== "Applied" && data.status !== "AlreadyApplied") return fail();
      const row = parseTableQrRow(data.item);
      if (row.tableReference !== input.table.tableReference) return fail();
      return row;
    },
    async sheet(tableReferences: readonly string[]): Promise<{ fileName: string; html: string }> {
      const data = await send(
        "/merchant/dining/table-qr/sheet",
        { tableReferences },
        undefined,
        false,
        20_000_000,
      );
      if (
        typeof data.fileName !== "string" ||
        !/^table-qr-codes-\d{4}-\d{2}-\d{2}\.html$/u.test(data.fileName) ||
        typeof data.html !== "string" ||
        !data.html.startsWith("<!doctype html>")
      )
        return fail();
      return { fileName: data.fileName, html: data.html };
    },
  });
}
