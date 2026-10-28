/**
 * WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN: the phones at a table (numbered in the order they joined,
 * no names), whether guests may join by scanning the table's QR code, and which phone sent each
 * round. Staff pause or resume joining by scan and take a phone off the table.
 */
export type TablePhonesErrorCode = "PermissionDenied" | "Unavailable" | "OutcomeUnknown";
export class TablePhonesError extends Error {
  constructor(readonly code: TablePhonesErrorCode) {
    super("table phones " + code);
    this.name = "TablePhonesError";
  }
}

export interface TablePhone {
  readonly participantReference: string;
  readonly phoneNumber: number;
  readonly joinedAt: string;
  readonly left: boolean;
  readonly removed: boolean;
}
export interface TablePhones {
  readonly diningSessionReference: string;
  readonly paused: boolean;
  readonly phones: readonly TablePhone[];
  /** Which phone sent each round; null for a round staff entered. */
  readonly rounds: ReadonlyMap<string, number | null>;
}

const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new TablePhonesError("Unavailable");
};
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) return fail();
  return value as Record<string, unknown>;
}
const ref = (value: unknown) =>
  typeof value === "string" && reference.test(value) ? value : fail();
const phoneNumber = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 200
    ? Number(value)
    : fail();

export function parseTablePhones(value: unknown): TablePhones {
  const raw = exact(value, ["diningSessionReference", "paused", "phones", "rounds"]);
  if (typeof raw.paused !== "boolean" || !Array.isArray(raw.phones) || !Array.isArray(raw.rounds))
    return fail();
  const phones = raw.phones.map((entry: unknown, index) => {
    const phone = exact(entry, [
      "participantReference",
      "phoneNumber",
      "joinedAt",
      "left",
      "removed",
    ]);
    if (
      phoneNumber(phone.phoneNumber) !== index + 1 ||
      typeof phone.joinedAt !== "string" ||
      !instant.test(phone.joinedAt) ||
      typeof phone.left !== "boolean" ||
      typeof phone.removed !== "boolean" ||
      (phone.removed && !phone.left)
    )
      return fail();
    return Object.freeze({
      participantReference: ref(phone.participantReference),
      phoneNumber: index + 1,
      joinedAt: phone.joinedAt,
      left: phone.left,
      removed: phone.removed,
    });
  });
  const rounds = new Map<string, number | null>();
  for (const entry of raw.rounds as unknown[]) {
    const round = exact(entry, ["orderBatchReference", "phoneNumber"]);
    rounds.set(
      ref(round.orderBatchReference),
      round.phoneNumber === null ? null : phoneNumber(round.phoneNumber),
    );
  }
  return Object.freeze({
    diningSessionReference: ref(raw.diningSessionReference),
    paused: raw.paused,
    phones: Object.freeze(phones),
    rounds,
  });
}

export function createTablePhonesClient(fetcher: typeof fetch = fetch) {
  const post = async (csrf: string, body: unknown, signal?: AbortSignal) => {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) throw new TablePhonesError("Unavailable");
    let response: Response;
    try {
      response = await fetcher("/merchant/dining/sessions/qr-join", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: signal ?? null,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TablePhonesError("OutcomeUnknown");
    }
    if (response.status === 401 || response.status === 403)
      throw new TablePhonesError("PermissionDenied");
    if (!response.ok || response.headers.get("cache-control") !== "no-store")
      throw new TablePhonesError(response.status >= 500 ? "OutcomeUnknown" : "Unavailable");
    return parseTablePhones(await response.json().catch(() => null));
  };
  return Object.freeze({
    read: (csrf: string, diningSessionReference: string, signal?: AbortSignal) =>
      post(csrf, { action: "State", diningSessionReference }, signal),
    setPaused: (
      csrf: string,
      command: {
        readonly diningSessionReference: string;
        readonly paused: boolean;
        readonly operationReference: string;
      },
    ) =>
      post(csrf, {
        action: command.paused ? "Pause" : "Resume",
        diningSessionReference: command.diningSessionReference,
        operationReference: command.operationReference,
      }),
    remove: (
      csrf: string,
      command: {
        readonly diningSessionReference: string;
        readonly participantReference: string;
        readonly operationReference: string;
      },
    ) => post(csrf, { action: "Remove", ...command }),
  });
}
